import { join, dirname } from "node:path";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import type { AutoReviewConfig, ExtensionContextLike, ToolCallEventLike } from "./src/types.js";
import { configPath, DEFAULT_CONFIG, loadConfig, logPath, logsDir, saveConfig } from "./src/extension-config.js";
import { evaluateToolCall } from "./src/decision.js";
import { SessionApprovalStore } from "./src/session-approval-store.js";
import { TraceStore } from "./src/trace-store.js";
import { selectClassifierModel } from "./src/model-selector.js";

type ExtensionAPI = {
  on(event: string, handler: (...args: any[]) => any): void;
  getAllTools?: () => unknown[];
  registerCommand?: (
    name: string,
    definition: {
      description: string;
      getArgumentCompletions?: (argumentPrefix: string) => Array<{ value: string; label?: string; description?: string }> | null | Promise<Array<{ value: string; label?: string; description?: string }> | null>;
      handler: (args: string, ctx: ExtensionContextLike) => Promise<void> | void;
    },
  ) => void;
};

const STATUS_KEY = "pi-auto-approval";

function statusText(config: AutoReviewConfig): string | undefined {
  if (!config.enabled) {
    return undefined;
  }
  return `auto-approval:${config.mode}`;
}

function stateText(config: AutoReviewConfig): "off" | "fallback" | "auto" {
  return config.enabled ? config.mode : "off";
}

function notify(ctx: ExtensionContextLike, message: string, type: "info" | "warning" | "error" = "info"): void {
  ctx.ui?.notify?.(message, type);
}

function setStatus(ctx: ExtensionContextLike, config: AutoReviewConfig): void {
  ctx.ui?.setStatus?.(STATUS_KEY, statusText(config));
}

function parseCommand(args: string): string {
  return args.trim().split(/\s+/)[0]?.toLowerCase() || "status";
}

function parseCommandRest(args: string): string {
  const trimmed = args.trim();
  const firstSpace = trimmed.search(/\s/);
  return firstSpace < 0 ? "" : trimmed.slice(firstSpace).trim();
}

function classifierModelText(config: AutoReviewConfig): string {
  return config.classifierModel ?? "current";
}

const COMMAND_ARGUMENTS = [
  { value: "status", label: "status", description: "Show current state and approval model" },
  { value: "off", label: "off", description: "Disable automatic approval" },
  { value: "fallback", label: "fallback", description: "AI review, then human approval on failure or denial" },
  { value: "auto", label: "auto", description: "AI review only; fail closed on failure or denial" },
  { value: "model", label: "model", description: "Select approval classifier model" },
  { value: "model current", label: "model current", description: "Use the active Pi session model for approval" },
  { value: "trace", label: "trace", description: "Show the last classifier trace" },
  { value: "trace 1", label: "trace 1", description: "Show the most recent classifier trace" },
  { value: "trace 5", label: "trace 5", description: "Show the last 5 classifier traces" },
  { value: "trace clear", label: "trace clear", description: "Clear in-memory traces" },
  { value: "trace export", label: "trace export", description: "Export all traces to a JSON file" },
];

function getAutoReviewArgumentCompletions(argumentPrefix: string): Array<{ value: string; label: string; description: string }> | null {
  const normalized = argumentPrefix.trimStart().toLowerCase();
  const filtered = COMMAND_ARGUMENTS.filter((item) => (
    item.value.startsWith(normalized) || item.label.includes(normalized)
  ));
  return filtered.length ? filtered : null;
}

export default function piAutoApprovalExtension(pi: ExtensionAPI): void {
  let loadResult = loadConfig();
  let config = loadResult.config;
  const approvals = new SessionApprovalStore();
  const traces = new TraceStore();
  let lastContext: ExtensionContextLike | null = null;

  function refresh(ctx?: ExtensionContextLike): void {
    if (ctx) {
      lastContext = ctx;
    }
    loadResult = loadConfig();
    config = loadResult.config;
    if (ctx) {
      setStatus(ctx, config);
      if (loadResult.warning) {
        notify(ctx, loadResult.warning, "warning");
      }
    }
  }

  function persist(next: AutoReviewConfig, ctx: ExtensionContextLike): void {
    const saved = saveConfig(next);
    if (!saved.success) {
      notify(ctx, `Failed to save pi-auto-approval config: ${saved.error ?? "unknown error"}`, "error");
      return;
    }
    config = next;
    setStatus(ctx, config);
  }

  async function runCommand(command: string, rest: string, ctx: ExtensionContextLike): Promise<void> {
    lastContext = ctx;
    refresh(ctx);
    switch (command) {
      case "off":
        persist({ ...config, enabled: false }, ctx);
        approvals.clear();
        notify(ctx, "pi-auto-approval state: off.");
        break;
      case "fallback":
        persist({ ...config, enabled: true, mode: "fallback" }, ctx);
        notify(ctx, "pi-auto-approval state: fallback.");
        break;
      case "auto":
        persist({ ...config, enabled: true, mode: "auto" }, ctx);
        notify(ctx, "pi-auto-approval state: auto.");
        break;
      case "model": {
        if (!rest) {
          const selected = await selectClassifierModel(ctx, config);
          if (selected === undefined) {
            break;
          }
          persist({ ...config, classifierModel: selected }, ctx);
          notify(ctx, `approval classifier model: ${selected ?? "current"}`);
          break;
        }
        if (rest === "current") {
          persist({ ...config, classifierModel: null }, ctx);
          notify(ctx, "approval classifier model: current");
          break;
        }
        notify(ctx, "Use /auto-approval model to select an approval classifier model.", "warning");
        break;
      }
      case "status":
      default:
        notify(
          ctx,
          [
            `state: ${stateText(config)}`,
            `approval classifier model: ${classifierModelText(config)}`,
            `config: ${configPath()}`,
            `audit log: ${logPath()}`,
          ].join("\n"),
        );
        break;
      case "trace": {
        const countArg = rest.trim().toLowerCase();
        if (countArg === "clear") {
          traces.clear();
          notify(ctx, "In-memory traces cleared.");
          break;
        }
        if (countArg === "export") {
          const traceFile = join(logsDir(), "traces-export.json");
          const all = traces.getRecent(1000);
          if (!all.length) {
            notify(ctx, "No traces to export.");
            break;
          }
          try {
            mkdirSync(dirname(traceFile), { recursive: true });
            writeFileSync(traceFile, JSON.stringify(all, null, 2), "utf-8");
            notify(ctx, `Exported ${all.length} trace(s) to ${traceFile}`);
          } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            notify(ctx, `Failed to export traces: ${msg}`, "error");
          }
          break;
        }
        const count = countArg === "" ? 1 : parseInt(countArg, 10);
        const entries = traces.getRecent(Number.isFinite(count) && count > 0 ? count : 1);
        if (!entries.length) {
          notify(ctx, `No traces available. Run a classifier action first.\nFull trace log: ${join(logsDir(), "traces.jsonl")}`);
          break;
        }
        const parts: string[] = [];
        for (const entry of entries) {
          parts.push(
            `\n--- Trace #${entry.id.slice(0, 8)} ---`,
            `tool: ${entry.toolName}`,
            `summary: ${entry.actionSummary}`,
            `outcome: ${entry.outcome}`,
            `duration: ${entry.durationMs ?? "?"}ms`,
            `system: ${entry.systemPrompt.slice(0, 200)}${entry.systemPrompt.length > 200 ? "…" : ""}`,
            `user: ${entry.userMessage.slice(0, 500)}${entry.userMessage.length > 500 ? "…" : ""}`,
          );
          if (entry.classifierDecision) {
            parts.push(`decision: ${JSON.stringify(entry.classifierDecision)}`);
          }
          if (entry.error) {
            parts.push(`error: ${entry.error}`);
          }
        }
        parts.push(`\nFull trace log: ${join(logsDir(), "traces.jsonl")}`);
        notify(ctx, parts.join("\n"));
        break;
      }
    }
  }

  pi.registerCommand?.("auto-approval", {
    description: "args: status | off | fallback | auto | model | trace",
    getArgumentCompletions: getAutoReviewArgumentCompletions,
    handler: async (args, ctx) => {
      await runCommand(parseCommand(args), parseCommandRest(args), ctx);
    },
  });

  pi.on("session_start", async (_event: unknown, ctx: ExtensionContextLike) => {
    approvals.clear();
    traces.clear();
    refresh(ctx);
  });

  pi.on("resources_discover", async (_event: unknown, ctx: ExtensionContextLike) => {
    refresh(ctx ?? lastContext ?? undefined);
  });

  pi.on("session_shutdown", async () => {
    approvals.clear();
    lastContext?.ui?.setStatus?.(STATUS_KEY, undefined);
    lastContext = null;
  });

  pi.on("tool_call", async (event: ToolCallEventLike, ctx: ExtensionContextLike) => {
    lastContext = ctx;
    if (loadResult.created || loadResult.warning) {
      refresh(ctx);
    }
    return evaluateToolCall(event, ctx, config, approvals, traces, {
      tools: pi.getAllTools?.() ?? [],
    });
  });
}

export { DEFAULT_CONFIG };
