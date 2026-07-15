export type AutoReviewMode = "fallback" | "auto";

export interface AuthResolution {
  ok: boolean;
  apiKey?: string;
  headers?: Record<string, string>;
  env?: Record<string, string>;
  error?: string;
}

export interface AutoReviewConfig {
  enabled: boolean;
  mode: AutoReviewMode;
  classifierModel: string | null;
  approvalTimeoutSeconds: number;
  classifierTimeoutSeconds: number;
  maxConsecutiveDenials: number;
  safeCommandAllowlist: string[];
  allow: string[];
  deny: string[];
  environment: string;
  audit: boolean;
}

export interface ReviewDecision {
  risk_level?: "low" | "medium" | "high" | "critical";
  user_authorization?: "unknown" | "low" | "medium" | "high";
  outcome: "allow" | "deny";
  rationale?: string;
}

export interface ToolCallEventLike {
  toolCallId?: string;
  tool?: unknown;
  toolName?: unknown;
  name?: unknown;
  input?: unknown;
  arguments?: unknown;
}

export interface ExtensionContextLike {
  cwd?: string;
  mode?: "tui" | "rpc" | "print" | string;
  hasUI?: boolean;
  ui?: {
    select?: (title: string, options: string[], optionsOverride?: unknown) => Promise<string | undefined>;
    input?: (title: string, placeholder?: string, optionsOverride?: unknown) => Promise<string | undefined>;
    custom?: <T>(
      factory: (
        tui: any,
        theme: any,
        keybindings: any,
        done: (result: T) => void,
      ) => unknown | Promise<unknown>,
      optionsOverride?: unknown,
    ) => Promise<T>;
    notify?: (message: string, type?: "info" | "warning" | "error") => void;
    setStatus?: (key: string, value: string | undefined) => void;
  };
  model?: unknown;
  modelRegistry?: {
    refresh?: () => void;
    getError?: () => string | undefined;
    find?: (provider: string, id: string) => unknown;
    getAvailable?: () => unknown[] | Promise<unknown[]>;
    // Resolves request auth (apiKey/headers/env) for a model the way pi's
    // normal model calls do, reading keys/headers from ~/.pi/agent/models.json,
    // auth storage, and provider env. The classifier must inject this into its
    // completeSimple call so custom providers (e.g. a `my-proxy` provider whose
    // apiKey lives in models.json, or an OAuth-backed provider) actually send
    // auth — otherwise the compat completeSimple path only checks the known
    // provider env-var map and bypasses models.json entirely.
    getApiKeyAndHeaders?: (model: unknown) => Promise<AuthResolution>;
  };
  sessionManager?: {
    getEntries?: () => unknown[];
    getBranch?: () => unknown[];
  };
}

export interface ReviewSubject {
  toolName: string;
  input: unknown;
  cwd: string;
  actionSummary: string;
  actionHash: string;
}

export type RouteName =
  | "disabled"
  | "readonly"
  | "workspace_write"
  | "safe_command"
  | "session_approval"
  | "classifier_cache"
  | "classifier"
  | "human"
  | "manual_only";

export interface AuditEntry {
  event: string;
  route: RouteName;
  mode: AutoReviewMode;
  toolName: string;
  actionSummary: string;
  actionHash: string;
  outcome: "allow" | "deny";
  classifierDecision?: ReviewDecision;
  humanDecision?: string;
  reason?: string;
  durationMs?: number;
}
