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

export function isReadOnlyTool(toolName: string): boolean {
  const normalized = toolName.trim().toLowerCase();
  if (READ_ONLY_TOOLS.has(normalized)) {
    return true;
  }
  const parts = normalized.split(/[^a-z0-9]+/).filter(Boolean);
  return parts.some((part) => READ_ONLY_TOOLS.has(part));
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
