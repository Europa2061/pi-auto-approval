import type { ApprovalState, AutoReviewConfig, ExtensionContextLike, ReviewSubject } from "./types.js";
import { toRecord } from "./common.js";

const SENSITIVE_KEY = /(?:api[-_]?key|authorization|cookie|credential|password|secret|token)/i;
const SENSITIVE_TEXT = [
  /\b(?:sk|pk)-[A-Za-z0-9_-]{16,}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}\b/gi,
  /\b(?:api[-_]?key|password|secret|token)\s*[:=]\s*[^\s,;]+/gi,
];

function redactText(value: string): string {
  return SENSITIVE_TEXT.reduce((result, pattern) => result.replace(pattern, "[REDACTED]"), value);
}

export function redactDecisionValue(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === "string") {
    return redactText(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactDecisionValue(item, seen));
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  if (seen.has(value)) {
    return "[CIRCULAR]";
  }
  seen.add(value);
  const redacted: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(toRecord(value))) {
    redacted[key] = SENSITIVE_KEY.test(key) ? "[REDACTED]" : redactDecisionValue(item, seen);
  }
  return redacted;
}

function stringifyMessageContent(content: unknown): string | undefined {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    const text = content
      .map((part) => {
        const record = toRecord(part);
        return typeof record.text === "string" ? record.text : "";
      })
      .filter(Boolean)
      .join("\n");
    return text || undefined;
  }
  return undefined;
}

function latestUserRequest(ctx: ExtensionContextLike): string | undefined {
  const entries = ctx.sessionManager?.getBranch?.() ?? ctx.sessionManager?.getEntries?.() ?? [];
  for (const entry of entries.slice().reverse()) {
    const record = toRecord(entry);
    const message = toRecord(record.message);
    const role = String(message.role ?? record.role ?? record.type ?? "");
    if (!role.includes("user")) {
      continue;
    }
    const text = stringifyMessageContent(message.content ?? record.content ?? record.text);
    if (text) {
      return redactText(text.slice(0, 2000));
    }
  }
  return undefined;
}

export function buildApprovalState(
  ctx: ExtensionContextLike,
  config: AutoReviewConfig,
  subject: ReviewSubject,
): ApprovalState {
  const state: ApprovalState = {
    action: {
      tool: subject.toolName,
      input: redactDecisionValue(subject.input),
      cwd: subject.cwd,
      summary: redactText(subject.actionSummary),
    },
  };
  const request = latestUserRequest(ctx);
  if (request) {
    state.latestUserRequest = request;
  }
  if (config.environment.trim()) {
    state.environment = redactText(config.environment.trim());
  }
  return state;
}
