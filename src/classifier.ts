import type { AutoReviewConfig, ExtensionContextLike, ReviewDecision, ReviewSubject } from "./types.js";
import { buildProjectedContext } from "./context-projection.js";
import { buildSystemPrompt } from "./prompt.js";
import { toRecord } from "./common.js";

export type ClassifierClient = (
  model: unknown,
  context: unknown,
  options: Record<string, unknown>,
) => Promise<unknown>;

async function loadCompleteSimple(): Promise<ClassifierClient> {
  const candidates = [
    "@oh-my-pi/pi-ai",
    "@earendil-works/pi-ai",
  ];
  for (const packageName of candidates) {
    try {
      const mod = await import(packageName);
      if (typeof mod.completeSimple === "function") {
        return mod.completeSimple as ClassifierClient;
      }
    } catch {
      // try next scope
    }
  }
  throw new Error("Could not load completeSimple from @oh-my-pi/pi-ai or @earendil-works/pi-ai.");
}

function extractAssistantText(message: unknown): string | undefined {
  const record = toRecord(message);
  const content = record.content;
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content.map((item) => {
      const itemRecord = toRecord(item);
      return typeof itemRecord.text === "string" ? itemRecord.text : "";
    }).join("");
  }
  if (Array.isArray(record.output)) {
    return record.output.map((item) => toRecord(item).text).filter((text): text is string => typeof text === "string").join("");
  }
  return undefined;
}

export function parseReviewDecision(text: string | undefined): ReviewDecision {
  if (!text) {
    throw new Error("Classifier returned no text.");
  }
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start < 0 || end <= start) {
      throw new Error("Classifier output was not valid JSON.");
    }
    payload = JSON.parse(text.slice(start, end + 1));
  }

  const record = toRecord(payload);
  if (record.outcome !== "allow" && record.outcome !== "deny") {
    throw new Error("Classifier JSON is missing outcome allow/deny.");
  }
  const decision: ReviewDecision = { outcome: record.outcome };
  if (["low", "medium", "high", "critical"].includes(String(record.risk_level))) {
    decision.risk_level = record.risk_level as ReviewDecision["risk_level"];
  }
  if (["unknown", "low", "medium", "high"].includes(String(record.user_authorization))) {
    decision.user_authorization = record.user_authorization as ReviewDecision["user_authorization"];
  }
  if (typeof record.rationale === "string" && record.rationale.trim()) {
    decision.rationale = record.rationale.trim();
  }
  return decision;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`classifier timed out after ${timeoutMs}ms`)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function splitModelRef(modelRef: string, currentModel: Record<string, unknown>): { provider?: string; id: string } {
  const slashIndex = modelRef.indexOf("/");
  if (slashIndex > 0) {
    return {
      provider: modelRef.slice(0, slashIndex),
      id: modelRef.slice(slashIndex + 1),
    };
  }
  return {
    provider: typeof currentModel.provider === "string" ? currentModel.provider : undefined,
    id: modelRef,
  };
}

function resolveClassifierModel(ctx: ExtensionContextLike, config: AutoReviewConfig): unknown {
  const currentModel = ctx.model;
  if (!config.classifierModel) {
    return currentModel;
  }

  const currentModelRecord = toRecord(currentModel);
  const { provider, id } = splitModelRef(config.classifierModel, currentModelRecord);
  const registry = toRecord(ctx.modelRegistry);
  if (provider && typeof registry.find === "function") {
    const found = registry.find(provider, id);
    if (found) {
      return found;
    }
  }

  return provider
    ? { ...currentModelRecord, provider, id }
    : { ...currentModelRecord, id };
}

/**
 * Resolve request auth (apiKey/headers/env) for the classifier model through
 * the same ModelRegistry path pi uses for normal model calls.
 *
 * The compat `completeSimple` the classifier invokes only injects an API key
 * from the known provider env-var map; it never reads ~/.pi/agent/models.json.
 * Custom providers whose apiKey/headers live in models.json (or OAuth-backed
 * providers whose token lives in auth storage) therefore send unauthenticated
 * requests and fail opaquely. By mirroring ModelRegistry.getApiKeyAndHeaders
 * here and passing the result into `completeSimple` as request options, the
 * classifier stays on the same auth chain as the rest of pi.
 */
async function resolveRequestAuth(
  ctx: ExtensionContextLike,
  model: unknown,
): Promise<{ apiKey?: string; headers?: Record<string, string>; env?: Record<string, string> }> {
  const registry = toRecord(ctx.modelRegistry);
  if (typeof registry.getApiKeyAndHeaders !== "function") {
    return {};
  }
  const result = await registry.getApiKeyAndHeaders(model);
  const record = toRecord(result);
  if (record.ok !== true) {
    const error = typeof record.error === "string" && record.error.trim()
      ? record.error.trim()
      : "auth resolution reported failure with no error message";
    throw new Error(`Could not resolve classifier model auth: ${error}`);
  }
  // Only carry defined fields so providers that test `options.apiKey !==
  // undefined` (or iterate option keys) are not handed explicit `undefined`
  // values for an anonymous/local provider that resolved ok:true with no key.
  const auth: { apiKey?: string; headers?: Record<string, string>; env?: Record<string, string> } = {};
  if (typeof record.apiKey === "string") {
    auth.apiKey = record.apiKey;
  }
  if (record.headers && typeof record.headers === "object") {
    auth.headers = record.headers as Record<string, string>;
  }
  if (record.env && typeof record.env === "object") {
    auth.env = record.env as Record<string, string>;
  }
  return auth;
}

export async function classifyAction(
  ctx: ExtensionContextLike,
  config: AutoReviewConfig,
  subject: ReviewSubject,
  client?: ClassifierClient,
): Promise<ReviewDecision> {
  const completeSimple = client ?? await loadCompleteSimple();
  const model = resolveClassifierModel(ctx, config);
  if (!model) {
    throw new Error("No active model is available for auto approval.");
  }

  // Inject request auth resolved through ModelRegistry so custom/OAuth
  // providers whose credentials live in models.json or auth storage are
  // authenticated, just like pi's normal model calls. See resolveRequestAuth.
  const auth = await resolveRequestAuth(ctx, model);

  const response = await withTimeout(
    completeSimple(model, {
      systemPrompt: buildSystemPrompt(config),
      messages: [{
        role: "user",
        content: buildProjectedContext(ctx, subject),
        timestamp: Date.now(),
      }],
    }, {
      temperature: 0,
      ...auth,
    }),
    config.classifierTimeoutSeconds * 1000,
  );

  const responseText = extractAssistantText(response);
  if (!responseText) {
    // The provider may return a content-empty assistant message when the
    // underlying request failed (HTTP 403, auth errors, model setup failures,
    // etc.). pi-ai's lazyStream surfaces such setup failures as an error event
    // with `content: []` plus an `errorMessage` field, which collapses to an
    // empty string here. Surface that upstream errorMessage instead of the
    // generic "Classifier returned no text." so the deny reason points at the
    // real cause rather than masking it.
    const responseRecord = toRecord(response);
    const upstreamError = typeof responseRecord.errorMessage === "string"
      ? responseRecord.errorMessage.trim()
      : "";
    if (upstreamError) {
      throw new Error(`Classifier request failed: ${upstreamError}`);
    }
    throw new Error("Classifier returned no text.");
  }
  return parseReviewDecision(responseText);
}
