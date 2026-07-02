import type { AutoReviewConfig, ExtensionContextLike, ToolCallEventLike } from "./src/types.js";
import { configPath, DEFAULT_CONFIG, loadConfig, logPath, saveConfig } from "./src/extension-config.js";
import { evaluateToolCall } from "./src/decision.js";
import { SessionApprovalStore } from "./src/session-approval-store.js";

type ExtensionAPI = {
  on(event: string, handler: (...args: any[]) => any): void;
  getAllTools?: () => unknown[];
  registerCommand?: (
    name: string,
    definition: {
      description: string;
      handler: (args: string, ctx: ExtensionContextLike) => Promise<void> | void;
    },
  ) => void;
};

const STATUS_KEY = "pi-auto-review";

function statusText(config: AutoReviewConfig): string | undefined {
  if (!config.enabled) {
    return undefined;
  }
  return `auto-review:${config.mode}`;
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

export default function piAutoReviewExtension(pi: ExtensionAPI): void {
  let loadResult = loadConfig();
  let config = loadResult.config;
  const approvals = new SessionApprovalStore();
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
      notify(ctx, `Failed to save pi-auto-review config: ${saved.error ?? "unknown error"}`, "error");
      return;
    }
    config = next;
    setStatus(ctx, config);
  }

  pi.registerCommand?.("auto-review", {
    description: "Configure pi-auto-review automatic approval behavior",
    handler: async (args, ctx) => {
      lastContext = ctx;
      refresh(ctx);
      const command = parseCommand(args);
      switch (command) {
        case "on":
          persist({ ...config, enabled: true }, ctx);
          notify(ctx, `pi-auto-review enabled in ${config.mode} mode.`);
          break;
        case "off":
          persist({ ...config, enabled: false }, ctx);
          approvals.clear();
          notify(ctx, "pi-auto-review disabled.");
          break;
        case "fallback":
          persist({ ...config, enabled: true, mode: "fallback" }, ctx);
          notify(ctx, "pi-auto-review enabled in fallback mode.");
          break;
        case "auto":
          persist({ ...config, enabled: true, mode: "auto" }, ctx);
          notify(ctx, "pi-auto-review enabled in auto mode.");
          break;
        case "status":
        default:
          notify(
            ctx,
            [
              `pi-auto-review: ${config.enabled ? "enabled" : "disabled"}`,
              `mode: ${config.mode}`,
              `config: ${configPath()}`,
              `audit log: ${logPath()}`,
            ].join("\n"),
          );
          break;
      }
    },
  });

  pi.on("session_start", async (_event: unknown, ctx: ExtensionContextLike) => {
    approvals.clear();
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
    return evaluateToolCall(event, ctx, config, approvals, {
      tools: pi.getAllTools?.() ?? [],
    });
  });
}

export { DEFAULT_CONFIG };
