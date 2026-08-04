import { stableStringify, toRecord, truncateInline } from "./common.js";
import type { AutoReviewConfig, ExtensionContextLike, ReviewSubject, TranscriptContextConfig } from "./types.js";

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

// Keep the last `maxLines` lines of a message (most recent content for long
// assistant/user outputs).
function truncateToTailLines(text: string, maxLines: number): string {
  if (maxLines <= 0) {
    return "";
  }
  const lines = text.split("\n");
  return lines.length <= maxLines ? text : lines.slice(-maxLines).join("\n");
}

// Cheap token approximation: whitespace-delimited words. Keeps the last
// `maxTokens` tokens of an assistant response, where the final decisions and
// tool calls are most relevant for authorization review.
function truncateToLastTokens(text: string, maxTokens: number): string {
  if (maxTokens <= 0) {
    return "";
  }
  const tokens = text.trim().split(/\s+/).filter(Boolean);
  return tokens.length <= maxTokens ? text.trim() : tokens.slice(-maxTokens).join(" ");
}

function collectTailByRole(
  entries: unknown[],
  rolePredicate: (role: string) => boolean,
  count: number,
): { role: string; text: string }[] {
  if (count <= 0) {
    return [];
  }
  const collected: { role: string; text: string }[] = [];
  for (const entry of entries.slice().reverse()) {
    const extracted = extractRoleAndData(entry);
    if (!extracted || !rolePredicate(extracted.role)) {
      continue;
    }
    const text = stringifyMessageContent(extracted.data);
    if (!text || !text.trim()) {
      continue;
    }
    collected.push({ role: extracted.role, text });
    if (collected.length >= count) {
      break;
    }
  }
  // Restore chronological order (oldest of the tail first).
  return collected.reverse();
}

function isUserRole(role: string): boolean {
  return role.includes("user");
}

function isAssistantRole(role: string): boolean {
  return role.includes("assistant");
}

function buildTranscriptBlock(entries: unknown[], tc: TranscriptContextConfig): string {
  const userMessages = collectTailByRole(entries, isUserRole, tc.tailUserMessages)
    .map((entry) => truncateToTailLines(entry.text, tc.maxLinesPerUserMessage).trim())
    .filter(Boolean);
  const assistantMessages = collectTailByRole(entries, isAssistantRole, tc.tailAssistantMessages)
    .map((entry) => truncateToLastTokens(entry.text, tc.maxTokensPerAssistantMessage).trim())
    .filter(Boolean);

  const sections: string[] = [];
  if (userMessages.length) {
    sections.push(["Recent user messages:", ...userMessages.map((text) => `user: ${text}`)].join("\n"));
  }
  if (assistantMessages.length) {
    sections.push(["Recent assistant messages:", ...assistantMessages.map((text) => `assistant: ${text}`)].join("\n"));
  }
  if (!sections.length) {
    return "Transcript context:\n<no transcript context available>";
  }
  return `Transcript context:\n${sections.join("\n\n")}`;
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

export function buildProjectedContext(
  ctx: ExtensionContextLike,
  config: AutoReviewConfig,
  subject: ReviewSubject,
): string {
  const entries = ctx.sessionManager?.getBranch?.() ?? ctx.sessionManager?.getEntries?.() ?? [];

  const transcriptBlock = config.transcriptContext.enabled
    ? buildTranscriptBlock(entries, config.transcriptContext)
    : (() => {
        const retained = entries
          .slice(-40)
          .map((entry) => {
            const extracted = extractRoleAndData(entry);
            if (!extracted) {
              return null;
            }
            const text = stringifyMessageContent(extracted.data);
            if (!text) {
              return null;
            }
            if (isUserRole(extracted.role)) {
              return `user: ${truncateInline(text, 1200)}`;
            }
            if (extracted.role.includes("tool") || extracted.role.includes("function")) {
              return `tool: ${truncateInline(text, 1200)}`;
            }
            return null;
          })
          .filter((entry): entry is string => Boolean(entry));
        const latestUserText = findLatestUserText(entries);
        return [
          "Latest user request:",
          latestUserText ?? "<no user request available>",
          "",
          "Retained context:",
          retained.length ? retained.join("\n") : "<no retained session context available>",
        ].join("\n");
      })();

  return [
    "Assess whether the pending tool action is authorized and acceptable.",
    `cwd: ${subject.cwd}`,
    "",
    transcriptBlock,
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
