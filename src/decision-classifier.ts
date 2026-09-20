import { buildApprovalState } from "./decision-context.js";
import { JevDecisionProvider } from "./decision-providers/jev.js";
import type {
  ApprovalClassifier,
  AutoReviewConfig,
  DecisionProvider,
  ExtensionContextLike,
  ReviewDecision,
  ReviewSubject,
} from "./types.js";

export type DecisionProviderRegistry = ReadonlyMap<string, DecisionProvider>;

export function defaultDecisionProviders(): DecisionProviderRegistry {
  return new Map([["jev", new JevDecisionProvider()]]);
}

export class DecisionClassifier implements ApprovalClassifier {
  constructor(private readonly providers: DecisionProviderRegistry = defaultDecisionProviders()) {}

  async classify(
    ctx: ExtensionContextLike,
    config: AutoReviewConfig,
    subject: ReviewSubject,
  ): Promise<ReviewDecision> {
    if (config.classifier.engine !== "decision") {
      throw new Error("DecisionClassifier requires classifier.engine to be 'decision'.");
    }
    const provider = this.providers.get(config.classifier.provider);
    if (!provider) {
      throw new Error(`Unknown decision provider '${config.classifier.provider}'.`);
    }

    const timeoutMs = (config.classifier.timeoutSeconds ?? config.classifierTimeoutSeconds) * 1000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const result = await provider.classify({
        state: buildApprovalState(ctx, config, subject),
        policy: {
          allow: [...config.allow],
          deny: [...config.deny],
        },
      }, {
        model: config.classifier.model,
        timeoutMs,
        signal: controller.signal,
      });
      return {
        outcome: result.outcome,
        ...(result.rationale ? { rationale: result.rationale } : {}),
        metadata: {
          engine: "decision",
          provider: provider.id,
          model: result.model ?? config.classifier.model,
          ...(result.confidence !== undefined ? { confidence: result.confidence } : {}),
          ...(result.probabilities ? { probabilities: result.probabilities } : {}),
          ...(result.signals ? { signals: result.signals } : {}),
        },
      };
    } catch (error) {
      if (controller.signal.aborted) {
        throw new Error(`classifier timed out after ${timeoutMs}ms`);
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}
