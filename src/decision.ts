import type { AutoReviewConfig, ExtensionContextLike, ReviewDecision, ToolCallEventLike } from "./types.js";
import { classifyAction, type ClassifierClient } from "./classifier.js";
import { writeAudit } from "./logging.js";
import { isSafeReadOnlyCommand } from "./safe-command.js";
import { SessionApprovalStore } from "./session-approval-store.js";
import {
  createReviewSubject,
  findToolDefinition,
  getToolInput,
  getToolName,
  isManualOnlyTool,
  isReadOnlyTool,
  isWorkspaceInternalPath,
} from "./tool-routing.js";
import { getString, toRecord } from "./common.js";
import { requestHumanApproval } from "./human-approval.js";

export type ToolCallDecision = {} | { block: true; reason: string };

function deny(reason: string): ToolCallDecision {
  return { block: true, reason };
}

function classifierDenyReason(decision: ReviewDecision): string {
  return [
    "AI auto-review rejected this action.",
    decision.rationale ? `Reason: ${decision.rationale}` : null,
    "Do not retry the same action unless the user explicitly approves it.",
  ].filter(Boolean).join(" ");
}

function failureDenyReason(reason: string): string {
  return `AI auto-review could not approve this action: ${reason}`;
}

async function handleHumanFallback(
  ctx: ExtensionContextLike,
  config: AutoReviewConfig,
  store: SessionApprovalStore,
  subject: ReturnType<typeof createReviewSubject>,
  auditBase: { started: number; route: "classifier" | "manual_only"; classifierDecision?: ReviewDecision; failureReason?: string },
): Promise<ToolCallDecision> {
  const human = await requestHumanApproval(ctx, subject, {
    classifierDecision: auditBase.classifierDecision,
    failureReason: auditBase.failureReason,
    timeoutSeconds: config.approvalTimeoutSeconds,
  });
  if (human.approved) {
    if (human.persistence === "exact") {
      store.approveExact(subject.actionHash);
    } else {
      store.recordNonDenial();
    }
    await writeAudit(config, {
      event: "decision",
      route: "human",
      mode: config.mode,
      toolName: subject.toolName,
      actionSummary: subject.actionSummary,
      actionHash: subject.actionHash,
      outcome: "allow",
      classifierDecision: auditBase.classifierDecision,
      humanDecision: human.persistence,
      durationMs: Date.now() - auditBase.started,
    });
    return {};
  }

  store.recordDenial();
  const reason = human.reason
    ?? auditBase.classifierDecision?.rationale
    ?? auditBase.failureReason
    ?? "Manual approval was rejected.";
  await writeAudit(config, {
    event: "decision",
    route: "human",
    mode: config.mode,
    toolName: subject.toolName,
    actionSummary: subject.actionSummary,
    actionHash: subject.actionHash,
    outcome: "deny",
    classifierDecision: auditBase.classifierDecision,
    humanDecision: human.state,
    reason,
    durationMs: Date.now() - auditBase.started,
  });
  return deny(reason);
}

export async function evaluateToolCall(
  event: ToolCallEventLike,
  ctx: ExtensionContextLike,
  config: AutoReviewConfig,
  store: SessionApprovalStore,
  options: {
    tools?: unknown[];
    classifierClient?: ClassifierClient;
  } = {},
): Promise<ToolCallDecision> {
  const started = Date.now();
  const toolName = getToolName(event);
  if (!config.enabled) {
    return {};
  }
  if (!toolName) {
    return deny("Tool call was blocked because no tool name was provided.");
  }

  const cwd = ctx.cwd || process.cwd();
  const input = getToolInput(event);
  const subject = createReviewSubject(toolName, input, cwd);

  if (isReadOnlyTool(toolName)) {
    await writeAudit(config, {
      event: "decision",
      route: "readonly",
      mode: config.mode,
      toolName,
      actionSummary: subject.actionSummary,
      actionHash: subject.actionHash,
      outcome: "allow",
      durationMs: Date.now() - started,
    });
    return {};
  }

  if ((toolName === "write" || toolName === "edit") && isWorkspaceInternalPath(input, cwd)) {
    await writeAudit(config, {
      event: "decision",
      route: "workspace_write",
      mode: config.mode,
      toolName,
      actionSummary: subject.actionSummary,
      actionHash: subject.actionHash,
      outcome: "allow",
      durationMs: Date.now() - started,
    });
    return {};
  }

  const toolDefinition = findToolDefinition(toolName, options.tools ?? []);
  if (isManualOnlyTool(toolName, toolDefinition)) {
    if (config.mode === "fallback" && ctx.hasUI) {
      return handleHumanFallback(ctx, config, store, subject, {
        started,
        route: "manual_only",
        failureReason: "This tool requires explicit user interaction and cannot be auto-approved.",
      });
    }
    await writeAudit(config, {
      event: "decision",
      route: "manual_only",
      mode: config.mode,
      toolName,
      actionSummary: subject.actionSummary,
      actionHash: subject.actionHash,
      outcome: "deny",
      reason: "Manual-only tool cannot be auto-approved.",
      durationMs: Date.now() - started,
    });
    return deny("This tool requires explicit user approval and cannot be auto-approved.");
  }

  if (toolName === "bash") {
    const command = getString(toRecord(input).command);
    if (command && isSafeReadOnlyCommand(command, config)) {
      store.recordNonDenial();
      await writeAudit(config, {
        event: "decision",
        route: "safe_command",
        mode: config.mode,
        toolName,
        actionSummary: subject.actionSummary,
        actionHash: subject.actionHash,
        outcome: "allow",
        durationMs: Date.now() - started,
      });
      return {};
    }
  }

  if (store.isExactApproved(subject.actionHash)) {
    await writeAudit(config, {
      event: "decision",
      route: "session_approval",
      mode: config.mode,
      toolName,
      actionSummary: subject.actionSummary,
      actionHash: subject.actionHash,
      outcome: "allow",
      durationMs: Date.now() - started,
    });
    return {};
  }

  const cached = store.getCachedDecision(subject.actionHash);
  if (cached) {
    if (cached.outcome === "allow") {
      store.recordNonDenial();
      await writeAudit(config, {
        event: "decision",
        route: "classifier_cache",
        mode: config.mode,
        toolName,
        actionSummary: subject.actionSummary,
        actionHash: subject.actionHash,
        outcome: "allow",
        classifierDecision: cached,
        durationMs: Date.now() - started,
      });
      return {};
    }
    if (config.mode === "fallback" && ctx.hasUI) {
      return handleHumanFallback(ctx, config, store, subject, {
        started,
        route: "classifier",
        classifierDecision: cached,
      });
    }
    store.recordDenial();
    return deny(classifierDenyReason(cached));
  }

  let classifierDecision: ReviewDecision | undefined;
  try {
    classifierDecision = await classifyAction(ctx, config, subject, options.classifierClient);
    store.cacheDecision(subject.actionHash, classifierDecision);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    if (config.mode === "fallback" && ctx.hasUI) {
      return handleHumanFallback(ctx, config, store, subject, {
        started,
        route: "classifier",
        failureReason: reason,
      });
    }
    store.recordDenial();
    await writeAudit(config, {
      event: "decision",
      route: "classifier",
      mode: config.mode,
      toolName,
      actionSummary: subject.actionSummary,
      actionHash: subject.actionHash,
      outcome: "deny",
      reason,
      durationMs: Date.now() - started,
    });
    return deny(failureDenyReason(reason));
  }

  if (classifierDecision.outcome === "allow") {
    store.recordNonDenial();
    await writeAudit(config, {
      event: "decision",
      route: "classifier",
      mode: config.mode,
      toolName,
      actionSummary: subject.actionSummary,
      actionHash: subject.actionHash,
      outcome: "allow",
      classifierDecision,
      durationMs: Date.now() - started,
    });
    return {};
  }

  const denials = store.recordDenial();
  if (config.mode === "fallback" && ctx.hasUI) {
    return handleHumanFallback(ctx, config, store, subject, {
      started,
      route: "classifier",
      classifierDecision,
    });
  }

  await writeAudit(config, {
    event: "decision",
    route: "classifier",
    mode: config.mode,
    toolName,
    actionSummary: subject.actionSummary,
    actionHash: subject.actionHash,
    outcome: "deny",
    classifierDecision,
    reason: classifierDecision.rationale,
    durationMs: Date.now() - started,
  });

  if (denials >= config.maxConsecutiveDenials) {
    return deny(`${classifierDenyReason(classifierDecision)} Auto-review rejected ${denials} consecutive requests; stop and ask the user for guidance.`);
  }
  return deny(classifierDenyReason(classifierDecision));
}
