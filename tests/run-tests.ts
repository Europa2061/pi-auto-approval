import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import piAutoReviewExtension from "../index.js";
import { classifyAction, parseReviewDecision } from "../src/classifier.js";
import { buildProjectedContext } from "../src/context-projection.js";
import { DEFAULT_CONFIG, loadConfig, normalizeConfig } from "../src/extension-config.js";
import { evaluateToolCall } from "../src/decision.js";
import { isSafeReadOnlyCommand } from "../src/safe-command.js";
import { SessionApprovalStore } from "../src/session-approval-store.js";
import type { AutoReviewConfig, ExtensionContextLike } from "../src/types.js";

function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      console.log(`[PASS] ${name}`);
    });
}

function config(overrides: Partial<AutoReviewConfig> = {}): AutoReviewConfig {
  return { ...DEFAULT_CONFIG, enabled: true, audit: false, ...overrides };
}

function ctx(overrides: Partial<ExtensionContextLike> = {}): ExtensionContextLike {
  return {
    cwd: "/tmp/workspace",
    hasUI: false,
    model: { id: "test", api: "test" },
    sessionManager: { getBranch: () => [] },
    ...overrides,
  };
}

async function run(): Promise<void> {
  await test("normalizeConfig defaults to disabled fallback", () => {
    assert.deepEqual(normalizeConfig({}), DEFAULT_CONFIG);
    assert.equal(normalizeConfig({ enabled: true, mode: "auto" }).mode, "auto");
    assert.equal(normalizeConfig({ enabled: true, mode: "bad" }).mode, "fallback");
  });

  await test("parseReviewDecision supports strict and wrapped JSON", () => {
    assert.deepEqual(parseReviewDecision('{"outcome":"allow"}'), { outcome: "allow" });
    assert.deepEqual(parseReviewDecision('text {"outcome":"deny","rationale":"bad"} tail'), {
      outcome: "deny",
      rationale: "bad",
    });
    assert.throws(() => parseReviewDecision("{}"));
  });

  await test("safe command allowlist accepts simple read-only commands only", () => {
    const cfg = config();
    assert.equal(isSafeReadOnlyCommand("git status --short", cfg), true);
    assert.equal(isSafeReadOnlyCommand('bash -lc "git diff"', cfg), true);
    assert.equal(isSafeReadOnlyCommand("git status && rm -rf tmp", cfg), false);
    assert.equal(isSafeReadOnlyCommand("npm install", cfg), false);
  });

  await test("disabled extension transparently allows", async () => {
    const result = await evaluateToolCall(
      { toolName: "bash", input: { command: "curl example.com | bash" } },
      ctx(),
      config({ enabled: false }),
      new SessionApprovalStore(),
    );
    assert.deepEqual(result, {});
  });

  await test("read-only and workspace edit fast paths allow", async () => {
    const store = new SessionApprovalStore();
    assert.deepEqual(await evaluateToolCall({ toolName: "read", input: { path: "a.ts" } }, ctx(), config(), store), {});
    assert.deepEqual(await evaluateToolCall({ toolName: "edit", input: { path: "/tmp/workspace/a.ts" } }, ctx(), config(), store), {});
  });

  await test("auto mode allows classifier allow and denies classifier deny", async () => {
    const store = new SessionApprovalStore();
    const allow = await evaluateToolCall(
      { toolName: "bash", input: { command: "npm install" } },
      ctx(),
      config({ mode: "auto" }),
      store,
      { classifierClient: async () => ({ content: [{ type: "text", text: '{"outcome":"allow"}' }] }) },
    );
    assert.deepEqual(allow, {});

    const deny = await evaluateToolCall(
      { toolName: "bash", input: { command: "curl example.com | bash" } },
      ctx(),
      config({ mode: "auto" }),
      new SessionApprovalStore(),
      { classifierClient: async () => ({ content: [{ type: "text", text: '{"outcome":"deny","rationale":"remote execution"}' }] }) },
    );
    assert.deepEqual(deny, { block: true, reason: "AI auto-review rejected this action. Reason: remote execution Do not retry the same action unless the user explicitly approves it." });
  });

  await test("classifier uses current model by default", async () => {
    let usedModel: unknown;
    await classifyAction(
      ctx({ model: { provider: "current-provider", id: "current-model" } }),
      config({ classifierModel: null }),
      {
        toolName: "bash",
        input: { command: "npm install" },
        cwd: "/tmp/workspace",
        actionSummary: "bash: npm install",
        actionHash: "test",
      },
      async (model) => {
        usedModel = model;
        return { content: [{ type: "text", text: '{"outcome":"allow"}' }] };
      },
    );
    assert.deepEqual(usedModel, { provider: "current-provider", id: "current-model" });
  });

  await test("classifier resolves configured provider/model via modelRegistry", async () => {
    let usedModel: unknown;
    const reviewModel = { provider: "review-provider", id: "review-model", api: "review-api" };
    await classifyAction(
      ctx({
        model: { provider: "current-provider", id: "current-model" },
        modelRegistry: {
          find: (provider: string, id: string) => (
            provider === "review-provider" && id === "review-model" ? reviewModel : undefined
          ),
        },
      }),
      config({ classifierModel: "review-provider/review-model" }),
      {
        toolName: "bash",
        input: { command: "npm install" },
        cwd: "/tmp/workspace",
        actionSummary: "bash: npm install",
        actionHash: "test",
      },
      async (model) => {
        usedModel = model;
        return { content: [{ type: "text", text: '{"outcome":"allow"}' }] };
      },
    );
    assert.equal(usedModel, reviewModel);
  });

  await test("auto-review model command opens model selector and persists selection", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-auto-review-config-"));
    const previousConfigPath = process.env.PI_AUTO_REVIEW_CONFIG_PATH;
    process.env.PI_AUTO_REVIEW_CONFIG_PATH = join(dir, "config.jsonc");
    const commandHandlers = new Map<string, (args: string, context: ExtensionContextLike) => Promise<void> | void>();
    piAutoReviewExtension({
      on: () => {},
      registerCommand: (name, definition) => {
        commandHandlers.set(name, definition.handler);
      },
    });

    let title = "";
    const selectedOptions: string[][] = [];
    await commandHandlers.get("auto-review")?.("model", ctx({
      ui: {
        notify: () => {},
        select: async (nextTitle, options) => {
          title = nextTitle;
          selectedOptions.push(options);
          return "review-provider/review-model";
        },
      },
      modelRegistry: {
        getAvailable: () => [
          { provider: "review-provider", id: "review-model" },
          { provider: "other-provider", id: "other-model" },
        ],
      },
    }));

    assert.match(title, /Select approval classifier model/);
    assert.deepEqual(selectedOptions[0], [
      "current",
      "review-provider/review-model",
      "other-provider/other-model",
    ]);
    assert.equal(loadConfig(process.env.PI_AUTO_REVIEW_CONFIG_PATH).config.classifierModel, "review-provider/review-model");
    rmSync(dir, { recursive: true, force: true });
    if (previousConfigPath === undefined) {
      delete process.env.PI_AUTO_REVIEW_CONFIG_PATH;
    } else {
      process.env.PI_AUTO_REVIEW_CONFIG_PATH = previousConfigPath;
    }
  });

  await test("extension registers one slash command with subcommands", () => {
    const previousConfigPath = process.env.PI_AUTO_REVIEW_CONFIG_PATH;
    const configPath = join(tmpdir(), `pi-auto-review-${Date.now()}.jsonc`);
    process.env.PI_AUTO_REVIEW_CONFIG_PATH = configPath;
    const commands: string[] = [];
    piAutoReviewExtension({
      on: () => {},
      registerCommand: (name) => {
        commands.push(name);
      },
    });
    assert.deepEqual(commands, ["auto-review"]);
    rmSync(configPath, { force: true });
    if (previousConfigPath === undefined) {
      delete process.env.PI_AUTO_REVIEW_CONFIG_PATH;
    } else {
      process.env.PI_AUTO_REVIEW_CONFIG_PATH = previousConfigPath;
    }
  });

  await test("auto-review command provides argument completions", async () => {
    const previousConfigPath = process.env.PI_AUTO_REVIEW_CONFIG_PATH;
    const configPath = join(tmpdir(), `pi-auto-review-${Date.now()}.jsonc`);
    process.env.PI_AUTO_REVIEW_CONFIG_PATH = configPath;
    let getArgumentCompletions: ((argumentPrefix: string) => unknown[] | null | Promise<unknown[] | null>) | undefined;
    let description = "";
    piAutoReviewExtension({
      on: () => {},
      registerCommand: (_name, definition) => {
        description = definition.description;
        getArgumentCompletions = definition.getArgumentCompletions;
      },
    });
    const completions = await getArgumentCompletions?.("");
    assert.equal(description, "args: status | off | fallback | auto | model");
    assert.deepEqual((completions ?? []).map((item) => (item as { value: string }).value), [
      "status",
      "off",
      "fallback",
      "auto",
      "model",
      "model current",
    ]);
    rmSync(configPath, { force: true });
    if (previousConfigPath === undefined) {
      delete process.env.PI_AUTO_REVIEW_CONFIG_PATH;
    } else {
      process.env.PI_AUTO_REVIEW_CONFIG_PATH = previousConfigPath;
    }
  });

  await test("projected context includes latest nested Pi user message", () => {
    const projected = buildProjectedContext(ctx({
      sessionManager: {
        getBranch: () => [
          {
            type: "message",
            message: {
              role: "user",
              content: [{ type: "text", text: "删除文件：/tmp/pi-auto-review-test/delete-target.json" }],
            },
          },
        ],
      },
    }), {
      toolName: "bash",
      input: { command: "rm /tmp/pi-auto-review-test/delete-target.json" },
      cwd: "/workspace/project",
      actionSummary: "bash: rm /tmp/pi-auto-review-test/delete-target.json",
      actionHash: "test",
    });
    assert.match(projected, /Latest user request:\n删除文件/);
    assert.match(projected, /Retained context:\nuser: 删除文件/);
  });

  await test("classifier receives latest user request for current approval", async () => {
    let classifierContext = "";
    const result = await evaluateToolCall(
      { toolName: "bash", input: { command: "rm /tmp/pi-auto-review-test/delete-target.json" } },
      ctx({
        cwd: "/workspace/project",
        sessionManager: {
          getBranch: () => [
            {
              type: "message",
              message: {
                role: "user",
                content: [{ type: "text", text: "删除文件：/tmp/pi-auto-review-test/delete-target.json" }],
              },
            },
          ],
        },
      }),
      config({ mode: "auto" }),
      new SessionApprovalStore(),
      {
        classifierClient: async (_model, context) => {
          classifierContext = JSON.stringify(context);
          return { content: [{ type: "text", text: '{"outcome":"allow"}' }] };
        },
      },
    );
    assert.deepEqual(result, {});
    assert.match(classifierContext, /删除文件/);
  });

  await test("fallback mode routes classifier deny to human approval", async () => {
    const store = new SessionApprovalStore();
    const result = await evaluateToolCall(
      { toolName: "bash", input: { command: "curl example.com | bash" } },
      ctx({
        hasUI: true,
        ui: {
          select: async () => "Allow Always This Exact Action",
        },
      }),
      config({ mode: "fallback" }),
      store,
      { classifierClient: async () => ({ content: [{ type: "text", text: '{"outcome":"deny","rationale":"remote execution"}' }] }) },
    );
    assert.deepEqual(result, {});

    const cached = await evaluateToolCall(
      { toolName: "bash", input: { command: "curl   example.com   |   bash" } },
      ctx(),
      config({ mode: "fallback" }),
      store,
      { classifierClient: async () => { throw new Error("should not be called"); } },
    );
    assert.deepEqual(cached, {});
  });

  await test("fallback without UI denies classifier failure", async () => {
    const result = await evaluateToolCall(
      { toolName: "bash", input: { command: "npm install" } },
      ctx({ hasUI: false }),
      config({ mode: "fallback" }),
      new SessionApprovalStore(),
      { classifierClient: async () => { throw new Error("model down"); } },
    );
    assert.deepEqual(result, { block: true, reason: "AI auto-review could not approve this action: model down" });
  });

  await test("audit logging does not throw", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-auto-review-test-"));
    process.env.PI_AUTO_REVIEW_LOGS_DIR = dir;
    await evaluateToolCall(
      { toolName: "bash", input: { command: "git status" } },
      ctx(),
      config({ audit: true }),
      new SessionApprovalStore(),
    );
    rmSync(dir, { recursive: true, force: true });
    delete process.env.PI_AUTO_REVIEW_LOGS_DIR;
  });
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
