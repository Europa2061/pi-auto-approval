import type { ReviewDecision } from "./types.js";

export class SessionApprovalStore {
  private readonly approvedExactActions = new Set<string>();
  private readonly classifierDecisions = new Map<string, ReviewDecision>();
  private consecutiveDenials = 0;

  approveExact(actionHash: string): void {
    this.approvedExactActions.add(actionHash);
    this.recordNonDenial();
  }

  isExactApproved(actionHash: string): boolean {
    return this.approvedExactActions.has(actionHash);
  }

  getCachedDecision(actionHash: string): ReviewDecision | undefined {
    return this.classifierDecisions.get(actionHash);
  }

  cacheDecision(actionHash: string, decision: ReviewDecision): void {
    this.classifierDecisions.set(actionHash, decision);
  }

  recordDenial(): number {
    this.consecutiveDenials += 1;
    return this.consecutiveDenials;
  }

  recordNonDenial(): void {
    this.consecutiveDenials = 0;
  }

  clear(): void {
    this.approvedExactActions.clear();
    this.classifierDecisions.clear();
    this.consecutiveDenials = 0;
  }
}
