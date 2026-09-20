import { createHash } from "node:crypto";
import type { AutoReviewConfig, ClassifierIdentity, ExtensionContextLike } from "./types.js";
import { stableStringify, toRecord } from "./common.js";

export const CLASSIFIER_POLICY_VERSION = "1";

function policyVersion(config: AutoReviewConfig): string {
  return createHash("sha256")
    .update(stableStringify({
      version: CLASSIFIER_POLICY_VERSION,
      allow: config.allow,
      deny: config.deny,
      environment: config.environment,
    }))
    .digest("hex")
    .slice(0, 16);
}

export function getClassifierIdentity(
  ctx: ExtensionContextLike,
  config: AutoReviewConfig,
): ClassifierIdentity {
  if (config.classifier.engine === "decision") {
    return {
      engine: "decision",
      provider: config.classifier.provider,
      model: config.classifier.model,
      policyVersion: policyVersion(config),
    };
  }

  const configuredModel = config.classifier.model;
  const currentModel = toRecord(ctx.model);
  const provider = configuredModel?.includes("/")
    ? configuredModel.slice(0, configuredModel.indexOf("/"))
    : typeof currentModel.provider === "string" ? currentModel.provider : undefined;
  const model = configuredModel?.includes("/")
    ? configuredModel.slice(configuredModel.indexOf("/") + 1)
    : configuredModel ?? (typeof currentModel.id === "string" ? currentModel.id : "current");
  return {
    engine: "llm",
    ...(provider ? { provider } : {}),
    model,
    policyVersion: policyVersion(config),
  };
}

export function classifierCacheKey(actionHash: string, identity: ClassifierIdentity): string {
  return createHash("sha256")
    .update(stableStringify({ actionHash, ...identity }))
    .digest("hex");
}
