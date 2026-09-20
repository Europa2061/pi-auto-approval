import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AutoReviewConfig, AutoReviewMode, ClassifierConfig } from "./types.js";
import { toRecord } from "./common.js";

export const EXTENSION_ID = "pi-auto-approval";

export const DEFAULT_CONFIG: AutoReviewConfig = {
  enabled: false,
  mode: "fallback",
  classifierModel: null,
  classifier: {
    engine: "llm",
    model: null,
  },
  approvalTimeoutSeconds: 30,
  classifierTimeoutSeconds: 90,
  maxConsecutiveDenials: 3,
  safeCommandAllowlist: [],
  allow: [],
  deny: [],
  environment: "",
  audit: true,
};

export function extensionRoot(moduleUrl = import.meta.url): string {
  return join(dirname(fileURLToPath(moduleUrl)), "..");
}

export function configPath(): string {
  return process.env.PI_AUTO_APPROVAL_CONFIG_PATH?.trim()
    || process.env.PI_AUTO_REVIEW_CONFIG_PATH?.trim()
    || join(extensionRoot(), "config.jsonc");
}

export function logsDir(): string {
  return process.env.PI_AUTO_APPROVAL_LOGS_DIR?.trim()
    || process.env.PI_AUTO_REVIEW_LOGS_DIR?.trim()
    || join(extensionRoot(), "logs");
}

export function logPath(): string {
  return join(logsDir(), `${EXTENSION_ID}.jsonl`);
}

function stripJsonComments(input: string): string {
  return input
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function positiveNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function normalizeMode(value: unknown): AutoReviewMode {
  return value === "auto" ? "auto" : "fallback";
}

function optionalModel(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function normalizeClassifier(value: unknown, legacyModel: string | null): ClassifierConfig {
  const classifier = toRecord(value);
  if (classifier.engine === "decision") {
    const provider = optionalModel(classifier.provider);
    const model = optionalModel(classifier.model);
    if (provider && model) {
      const timeoutSeconds = typeof classifier.timeoutSeconds === "number"
        && Number.isFinite(classifier.timeoutSeconds)
        && classifier.timeoutSeconds > 0
        ? classifier.timeoutSeconds
        : undefined;
      return {
        engine: "decision",
        provider,
        model,
        ...(timeoutSeconds !== undefined ? { timeoutSeconds } : {}),
      };
    }
  }
  if (classifier.engine === "llm") {
    return {
      engine: "llm",
      model: optionalModel(classifier.model),
    };
  }
  return {
    engine: "llm",
    model: legacyModel,
  };
}

export function normalizeConfig(raw: unknown): AutoReviewConfig {
  const record = toRecord(raw);
  const classifierModel = optionalModel(record.classifierModel);
  return {
    enabled: record.enabled === true,
    mode: normalizeMode(record.mode),
    classifierModel,
    classifier: normalizeClassifier(record.classifier, classifierModel),
    approvalTimeoutSeconds: positiveNumber(record.approvalTimeoutSeconds, DEFAULT_CONFIG.approvalTimeoutSeconds),
    classifierTimeoutSeconds: positiveNumber(record.classifierTimeoutSeconds, DEFAULT_CONFIG.classifierTimeoutSeconds),
    maxConsecutiveDenials: positiveNumber(record.maxConsecutiveDenials, DEFAULT_CONFIG.maxConsecutiveDenials),
    safeCommandAllowlist: stringArray(record.safeCommandAllowlist),
    allow: stringArray(record.allow),
    deny: stringArray(record.deny),
    environment: typeof record.environment === "string" ? record.environment : "",
    audit: record.audit !== false,
  };
}

export function loadConfig(path = configPath()): { config: AutoReviewConfig; warning?: string; created: boolean } {
  let created = false;
  if (!existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`, "utf-8");
    created = true;
  }

  try {
    const parsed = JSON.parse(stripJsonComments(readFileSync(path, "utf-8")));
    return { config: normalizeConfig(parsed), created };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      config: { ...DEFAULT_CONFIG },
      created,
      warning: `Failed to read pi-auto-approval config at '${path}': ${message}; using defaults.`,
    };
  }
}

export function saveConfig(config: AutoReviewConfig, path = configPath()): { success: boolean; error?: string } {
  const normalized = normalizeConfig(config);
  const tmpPath = `${path}.tmp`;
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(tmpPath, `${JSON.stringify(normalized, null, 2)}\n`, "utf-8");
    renameSync(tmpPath, path);
    return { success: true };
  } catch (error) {
    try {
      if (existsSync(tmpPath)) {
        unlinkSync(tmpPath);
      }
    } catch {
      // ignore cleanup
    }
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}
