import type { ExtensionContextLike, ReviewDecision, ReviewSubject } from "./types.js";

export type HumanDecision =
  | { approved: true; persistence: "once" | "exact" }
  | { approved: false; reason?: string; state: "reject" | "timeout" | "unavailable" };

const ALLOW_ONCE = "Allow Once";
const ALLOW_EXACT = "Allow Always This Exact Action";
const REJECT = "Reject";
const REJECT_WITH_REASON = "Reject With Reason";

function formatDecision(decision?: ReviewDecision): string {
  if (!decision) {
    return "";
  }
  return [
    decision.risk_level ? `Risk: ${decision.risk_level}` : null,
    decision.user_authorization ? `Authorization: ${decision.user_authorization}` : null,
    decision.rationale ? `Reason: ${decision.rationale}` : null,
  ].filter(Boolean).join("\n");
}

export async function requestHumanApproval(
  ctx: ExtensionContextLike,
  subject: ReviewSubject,
  options: {
    title?: string;
    classifierDecision?: ReviewDecision;
    failureReason?: string;
    timeoutSeconds: number;
  },
): Promise<HumanDecision> {
  if (!ctx.hasUI || !ctx.ui?.select) {
    return { approved: false, state: "unavailable", reason: "Interactive approval is unavailable." };
  }

  const intro = options.classifierDecision
    ? "AI review recommends blocking this action."
    : "AI review could not complete.";
  const details = [
    intro,
    "",
    `Tool: ${subject.toolName}`,
    `Action: ${subject.actionSummary}`,
    options.failureReason ? `Failure: ${options.failureReason}` : null,
    formatDecision(options.classifierDecision),
    "",
    "Override this decision?",
  ].filter((line) => line !== null).join("\n");

  const selected = await ctx.ui.select(
    `${options.title ?? "Auto Review"}\n${details}`,
    [ALLOW_ONCE, ALLOW_EXACT, REJECT, REJECT_WITH_REASON],
    { timeout: options.timeoutSeconds * 1000 },
  );

  if (selected === ALLOW_ONCE) {
    return { approved: true, persistence: "once" };
  }
  if (selected === ALLOW_EXACT) {
    return { approved: true, persistence: "exact" };
  }
  if (selected === REJECT_WITH_REASON && ctx.ui.input) {
    const reason = await ctx.ui.input("Reject With Reason", "Reason shown back to the agent");
    return { approved: false, state: "reject", reason: reason?.trim() || undefined };
  }
  if (!selected) {
    return { approved: false, state: "timeout", reason: "Manual approval timed out." };
  }
  return { approved: false, state: "reject" };
}
