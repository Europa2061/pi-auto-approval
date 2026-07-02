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

export async function classifyAction(
  ctx: ExtensionContextLike,
  config: AutoReviewConfig,
  subject: ReviewSubject,
  client?: ClassifierClient,
): Promise<ReviewDecision> {
  const completeSimple = client ?? await loadCompleteSimple();
  const model = resolveClassifierModel(ctx, config);
  if (!model) {
    throw new Error("No active model is available for auto review.");
  }

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
    }),
    config.classifierTimeoutSeconds * 1000,
  );

  return parseReviewDecision(extractAssistantText(response));
}
