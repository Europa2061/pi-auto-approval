import assert from "node:assert/strict";
import { classifyAction } from "../src/classifier.js";
import { isInstallTelemetryEnabled } from "../src/provider-attribution.js";
import type { AutoReviewConfig, ExtensionContextLike } from "../src/types.js";

const config: AutoReviewConfig = {
  enabled: true,
  mode: "auto",
  classifierModel: "openrouter/some-model",
  approvalTimeoutSeconds: 30,
  classifierTimeoutSeconds: 30,
  maxConsecutiveDenials: 3,
  safeCommandAllowlist: [],
  allow: [],
  deny: [],
  environment: "",
  audit: false,
};

const subject = {
  toolName: "bash",
  input: { command: "pwd" },
  cwd: "/tmp",
  actionSummary: "bash: pwd",
  actionHash: "x",
};

function ctx(headers?: Record<string, string>): ExtensionContextLike {
  return {
    cwd: "/tmp",
    hasUI: false,
    model: { provider: "current", id: "current" },
    sessionManager: { getBranch: () => [] },
    modelRegistry: {
      find: (provider, id) => ({
        id,
        api: "openai-completions",
        provider,
        baseUrl: "https://openrouter.ai/api/v1",
      }),
      getApiKeyAndHeaders: async () => ({
        ok: true,
        apiKey: "openrouter-key",
        ...(headers ? { headers } : {}),
      }),
    },
  };
}

async function withTelemetryEnv(value: string, fn: () => Promise<void>): Promise<void> {
  const previous = process.env.PI_TELEMETRY;
  process.env.PI_TELEMETRY = value;
  try {
    await fn();
  } finally {
    if (previous === undefined) delete process.env.PI_TELEMETRY;
    else process.env.PI_TELEMETRY = previous;
  }
}

async function run(): Promise<void> {
  assert.equal(isInstallTelemetryEnabled({ getEnableInstallTelemetry: () => false }, undefined), false);
  assert.equal(isInstallTelemetryEnabled({ getEnableInstallTelemetry: () => true }, undefined), true);
  assert.equal(isInstallTelemetryEnabled({ getEnableInstallTelemetry: () => false }, "1"), true);
  assert.equal(isInstallTelemetryEnabled({ getEnableInstallTelemetry: () => true }, "0"), false);

  await withTelemetryEnv("0", async () => {
    let capturedOptions: Record<string, unknown> | undefined;
    const decision = await classifyAction(ctx(), config, subject, async (_model, _context, options) => {
      capturedOptions = options;
      return { content: [{ type: "text", text: '{"outcome":"allow"}' }] };
    });
    assert.equal(decision.outcome, "allow");
    assert.equal(Object.hasOwn(capturedOptions ?? {}, "headers"), false);
  });

  await withTelemetryEnv("1", async () => {
    let capturedOptions: Record<string, unknown> | undefined;
    const decision = await classifyAction(ctx(), config, subject, async (_model, _context, options) => {
      capturedOptions = options;
      return { content: [{ type: "text", text: '{"outcome":"allow"}' }] };
    });
    assert.equal(decision.outcome, "allow");
    assert.deepEqual(capturedOptions?.headers, {
      "HTTP-Referer": "https://pi.dev",
      "X-OpenRouter-Title": "pi",
      "X-OpenRouter-Categories": "cli-agent",
    });
  });

  await withTelemetryEnv("0", async () => {
    let capturedOptions: Record<string, unknown> | undefined;
    await classifyAction(ctx({ "X-Custom": "registry" }), config, subject, async (_model, _context, options) => {
      capturedOptions = options;
      return { content: [{ type: "text", text: '{"outcome":"allow"}' }] };
    });
    assert.deepEqual(capturedOptions?.headers, { "X-Custom": "registry" });
  });

  console.log("[PASS] provider attribution respects telemetry opt-out");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
