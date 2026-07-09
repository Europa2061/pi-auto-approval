import type { AutoReviewConfig } from "./types.js";

const SAFE_GIT_SUBCOMMANDS = new Set(["status", "log", "diff", "show", "rev-parse"]);
const SAFE_GIT_BRANCH_FLAGS = new Set(["--show-current", "--list", "--all", "--merged", "--no-merged", "-a", "-r", "-v", "-vv"]);

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

function tokenizeSimpleCommand(command: string): string[] | null {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | "\"" | null = null;
  let escaped = false;

  for (const char of command) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }
    if (char === "'" || char === "\"") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }

  if (escaped || quote) {
    return null;
  }
  if (current) {
    tokens.push(current);
  }
  return tokens;
}

function isBuiltinSafeCommand(command: string): boolean {
  const tokens = tokenizeSimpleCommand(command);
  if (!tokens?.length) {
    return false;
  }

  const [program, subcommand, ...rest] = tokens;
  if (program === "pwd" && tokens.length === 1) {
    return true;
  }
  if (program !== "git" || !subcommand) {
    return false;
  }
  if (SAFE_GIT_SUBCOMMANDS.has(subcommand)) {
    return true;
  }
  if (subcommand !== "branch") {
    return false;
  }
  return rest.every((arg) => SAFE_GIT_BRANCH_FLAGS.has(arg) || !arg.startsWith("-"));
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
    isBuiltinSafeCommand(part) || isUserAllowlisted(part, config)
  ));
}
