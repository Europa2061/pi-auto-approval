import { stableStringify, toRecord, truncateInline } from "./common.js";
import type { ExtensionContextLike, ReviewSubject } from "./types.js";

function entryToText(entry: unknown): string | null {
  const record = toRecord(entry);
  const type = String(record.type ?? record.role ?? record.customType ?? "");
  if (type === "assistant" || type === "message:assistant") {
    return null;
  }

  const role = String(record.role ?? record.type ?? "entry");
  const data = record.data ?? record.message ?? record.content ?? record.text ?? record.input ?? record.output;
  if (data === undefined) {
    return null;
  }

  if (role.includes("user")) {
    return `user: ${truncateInline(typeof data === "string" ? data : stableStringify(data), 1200)}`;
  }
  if (role.includes("tool") || role.includes("function")) {
    return `tool: ${truncateInline(typeof data === "string" ? data : stableStringify(data), 1200)}`;
  }
  return null;
}

export function buildProjectedContext(ctx: ExtensionContextLike, subject: ReviewSubject): string {
  const entries = ctx.sessionManager?.getBranch?.() ?? ctx.sessionManager?.getEntries?.() ?? [];
  const retained = entries
    .slice(-40)
    .map(entryToText)
    .filter((entry): entry is string => Boolean(entry));

  return [
    "Assess whether the pending tool action is authorized and acceptable.",
    `cwd: ${subject.cwd}`,
    "",
    "Retained context:",
    retained.length ? retained.join("\n") : "<no retained session context available>",
    "",
    "Pending action JSON:",
    stableStringify({
      tool: subject.toolName,
      input: subject.input,
      cwd: subject.cwd,
      summary: subject.actionSummary,
    }),
  ].join("\n");
}
