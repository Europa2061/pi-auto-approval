import type { AutoReviewConfig } from "./types.js";

const BUILTIN_SAFE_PATTERNS: RegExp[] = [
  /^pwd$/,
  /^ls(?:\s|$)/,
  /^cat\s+/,
  /^head(?:\s|$)/,
  /^tail(?:\s|$)/,
  /^grep(?:\s|$)/,
  /^rg(?:\s|$)/,
  /^find(?:\s|$)/,
  /^sed\s+-n(?:\s|$)/,
  /^git\s+status(?:\s|$)/,
  /^git\s+log(?:\s|$)/,
  /^git\s+diff(?:\s|$)/,
  /^git\s+show(?:\s|$)/,
  /^git\s+branch(?:\s|$)/,
  /^git\s+rev-parse(?:\s|$)/,
];

const UNSAFE_SHELL_TOKENS = [
  "|",
  "&&",
  "||",
  ";",
  ">",
  "<",
  "$(",
  "`",
];

export function normalizeCommand(command: string): string {
  return command.replace(/\s+/g, " ").trim();
}

function unwrapBashLc(command: string): string | null {
  const normalized = normalizeCommand(command);
  const match = normalized.match(/^bash\s+-lc\s+(['"])([\s\S]*)\1$/);
  return match ? match[2] : null;
}

function splitSimpleCommands(command: string): string[] | null {
  if (UNSAFE_SHELL_TOKENS.some((token) => command.includes(token))) {
    return null;
  }
  return [normalizeCommand(command)].filter(Boolean);
}

function isUserAllowlisted(command: string, config: AutoReviewConfig): boolean {
  return config.safeCommandAllowlist.some((pattern) => {
    const trimmed = pattern.trim();
    if (!trimmed) {
      return false;
    }
    if (trimmed.endsWith("*")) {
      return command.startsWith(trimmed.slice(0, -1));
    }
    return command === trimmed || command.startsWith(`${trimmed} `);
  });
}

export function isSafeReadOnlyCommand(command: string, config: AutoReviewConfig): boolean {
  const unwrapped = unwrapBashLc(command) ?? command;
  const parts = splitSimpleCommands(unwrapped);
  if (!parts || parts.length === 0) {
    return false;
  }
  return parts.every((part) => (
    BUILTIN_SAFE_PATTERNS.some((pattern) => pattern.test(part)) || isUserAllowlisted(part, config)
  ));
}
