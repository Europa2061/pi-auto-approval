import { stableStringify, toRecord, truncateInline } from "./common.js";
import type { ExtensionContextLike, ReviewSubject } from "./types.js";

function stringifyMessageContent(content: unknown): string | null {
  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content)) {
    const parts = content.map((part) => {
      const record = toRecord(part);
      if (typeof record.text === "string") {
        return record.text;
      }
      return stableStringify(part);
    }).filter(Boolean);
    return parts.length ? parts.join("\n") : null;
  }

  if (content !== undefined) {
    return stableStringify(content);
  }

  return null;
}

function extractRoleAndData(entry: unknown): { role: string; data: unknown } | null {
  const record = toRecord(entry);
  const message = toRecord(record.message);
  const role = String(message.role ?? record.role ?? record.type ?? "");

  if (!role) {
    return null;
  }

  const data = message.content
    ?? record.data
    ?? record.content
    ?? record.text
    ?? record.input
    ?? record.output;

  return { role, data };
}

function entryToText(entry: unknown): string | null {
  const extracted = extractRoleAndData(entry);
  if (!extracted) {
    return null;
  }

  const { role, data } = extracted;
  const text = stringifyMessageContent(data);
  if (!text) {
    return null;
  }
  if (role.includes("user")) {
    return `user: ${truncateInline(text, 1200)}`;
  }
  if (role.includes("tool") || role.includes("function")) {
    return `tool: ${truncateInline(text, 1200)}`;
  }
  return null;
}

function findLatestUserText(entries: unknown[]): string | null {
  for (const entry of entries.slice().reverse()) {
    const extracted = extractRoleAndData(entry);
    if (!extracted?.role.includes("user")) {
      continue;
    }
    const text = stringifyMessageContent(extracted.data);
    if (text) {
      return truncateInline(text, 1600);
    }
  }
  return null;
}

export function buildProjectedContext(ctx: ExtensionContextLike, subject: ReviewSubject): string {
  const entries = ctx.sessionManager?.getBranch?.() ?? ctx.sessionManager?.getEntries?.() ?? [];
  const retained = entries
    .slice(-40)
    .map(entryToText)
    .filter((entry): entry is string => Boolean(entry));
  const latestUserText = findLatestUserText(entries);

  return [
    "Assess whether the pending tool action is authorized and acceptable.",
    `cwd: ${subject.cwd}`,
    "",
    "Latest user request:",
    latestUserText ?? "<no user request available>",
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
