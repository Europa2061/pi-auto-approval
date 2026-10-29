import { getString, isPathWithin, sha256, stableStringify, toRecord, truncateInline } from "./common.js";
import { normalizeCommand } from "./safe-command.js";
import type { ReviewSubject, ToolCallEventLike } from "./types.js";

const READ_ONLY_TOOLS = new Set([
  "read",
  "grep",
  "find",
  "ls",
  "glob",
  "search",
  "web_search",
  "mcp_status",
  "mcp_list",
  "mcp_search",
  "mcp_describe",
]);

const PATH_KEYS = ["path", "file_path", "filepath", "target", "targetPath"];

// Files whose contents are secrets. Reading them is not a harmless read: the
// contents enter the agent's context and can leak through later tool calls.
const SENSITIVE_BASENAMES = [
  /^\.env$/,
  /^\.envrc$/,
  /^\.env\.(?!example$|sample$|template$|dist$).+$/,
  /^\.netrc$/,
  /^\.npmrc$/,
  /^\.pypirc$/,
  /^\.git-credentials$/,
  /^id_(rsa|dsa|ecdsa|ed25519)(_sk)?$/,
  /\.(pem|key|p12|pfx|jks|keystore)$/,
  /^credentials(\.json)?$/,
  /^application_default_credentials\.json$/,
  /^service[-_]?account.*\.json$/,
];

const SENSITIVE_DIRS = new Set([".ssh", ".aws", ".gnupg", ".kube", ".docker", "gcloud"]);

export function isSensitivePath(pathValue: string): boolean {
  const segments = pathValue.split(/[\\/]+/).filter(Boolean);
  if (segments.some((segment) => SENSITIVE_DIRS.has(segment))) {
    return true;
  }
  const base = segments[segments.length - 1] ?? "";
  return SENSITIVE_BASENAMES.some((pattern) => pattern.test(base));
}

// A grep glob such as ".env*" targets secrets even when the path is a directory.
export function readsSensitivePath(input: unknown): boolean {
  const record = toRecord(input);
  const pathValue = getPathFromInput(input);
  if (pathValue && isSensitivePath(pathValue)) {
    return true;
  }
  const glob = getString(record.glob);
  return Boolean(glob && /(^|[\\/])(\.env|\.ssh|\.aws|id_)|\.(pem|key)\b/.test(glob));
}

export function getToolName(event: ToolCallEventLike): string | null {
  const direct = getString(event.toolName) ?? getString(event.name);
  if (direct) {
    return direct;
  }
  const toolRecord = toRecord(event.tool);
  return getString(toolRecord.name) ?? getString(toolRecord.toolName) ?? null;
}

export function getToolInput(event: ToolCallEventLike): unknown {
  return event.input !== undefined ? event.input : event.arguments ?? {};
}

export function isReadOnlyTool(toolName: string, toolDefinition?: unknown): boolean {
  const definition = toRecord(toolDefinition);
  if (typeof definition.isReadOnly === "function") {
    try {
      if (definition.isReadOnly({})) {
        return true;
      }
    } catch {
      return false;
    }
  }
  if (definition.isReadOnly === true || definition.readOnlyHint === true) {
    return true;
  }
  if (toRecord(definition.annotations).readOnlyHint === true) {
    return true;
  }

  const normalized = toolName.trim().toLowerCase();
  return READ_ONLY_TOOLS.has(normalized);
}

export function getPathFromInput(input: unknown): string | null {
  const record = toRecord(input);
  for (const key of PATH_KEYS) {
    const value = getString(record[key]);
    if (value) {
      return value;
    }
  }
  return null;
}

export function isWorkspaceInternalPath(input: unknown, cwd: string): boolean {
  const pathValue = getPathFromInput(input);
  return Boolean(pathValue && isPathWithin(pathValue, cwd));
}

export function isManualOnlyTool(toolName: string, toolDefinition?: unknown): boolean {
  const normalized = toolName.toLowerCase();
  const record = toRecord(toolDefinition);
  if (typeof record.requiresUserInteraction === "function") {
    try {
      if (record.requiresUserInteraction()) {
        return true;
      }
    } catch {
      return true;
    }
  }
  if (record.requiresUserInteraction === true) {
    return true;
  }
  return normalized.includes("computer")
    || normalized.includes("browser_click")
    || normalized.includes("browser_type")
    || normalized.includes("chrome_click")
    || normalized.includes("chrome_type")
    || normalized.includes("install_plugin")
    || normalized.includes("request_plugin_install")
    || normalized.includes("mcp_config")
    || normalized.includes("permission_config");
}

export function findToolDefinition(toolName: string, tools: unknown[]): unknown | undefined {
  return tools.find((tool) => {
    const record = toRecord(tool);
    return record.name === toolName || record.toolName === toolName;
  });
}

export function createReviewSubject(toolName: string, input: unknown, cwd: string): ReviewSubject {
  const record = toRecord(input);
  const command = toolName === "bash" ? getString(record.command) : undefined;
  const path = getPathFromInput(input);
  const normalizedInput = toolName === "bash" && command
    ? { ...record, command: normalizeCommand(command) }
    : record;
  const actionSummary = toolName === "bash" && command
    ? `bash: ${truncateInline(normalizeCommand(command))}`
    : path
      ? `${toolName}: ${truncateInline(path)}`
      : `${toolName}: ${truncateInline(stableStringify(input))}`;
  const hashSource = stableStringify({ toolName, cwd, input: normalizedInput });
  return {
    toolName,
    input: normalizedInput,
    cwd,
    actionSummary,
    actionHash: sha256(hashSource),
  };
}
