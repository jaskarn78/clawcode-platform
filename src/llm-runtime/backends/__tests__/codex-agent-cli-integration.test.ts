/**
 * Phase 137 Plan 03 T-03 — CodexAgentCli end-to-end integration test.
 *
 * Brings together Plan 01 (discovery + factory dispatch), Plan 02
 * (translation), and Plan 03 (spawn + iteration) — the SC1
 * acceptance test: "CodexAgentCli implementation passes the
 * LlmRuntimeService interface; both backends are selectable."
 *
 * Six PLAN T-03 `<behavior>` assertions:
 *   (1) Construct CodexAgentCli with mocked discovery + mocked
 *       spawnFn; loadSdkModule() resolves to a CodexSdkModule.
 *   (2) module.query({prompt, options:{tools}}) reaches the spawn
 *       layer with translated OpenAI-shape tool JSON in argv.
 *   (3) Push an OpenAI-shape Chat-Completions JSON line to the mock
 *       stdout → iterator yields an Anthropic-shape assistant
 *       event (Plan 02 inbound boundary exercised).
 *   (4) All three telemetry log lines fire (phase137-codex-backend
 *       at construction, phase137-codex-spawn at query, and the
 *       inbound event is yielded).
 *   (5) A second CodexAgentCli for a different agent gets its own
 *       CodexSdkModule instance (no cross-agent cache pollution).
 *   (6) loadSdkModule() is idempotent per backend instance (the
 *       cache contract).
 *
 * NO real codex binary; NO real node:child_process.spawn call.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";

import { CodexAgentCli } from "../codex-agent-cli.js";
import { CodexSdkModule } from "../codex-sdk-module.js";
import type { CodexQueryDeps } from "../codex-query.js";
import type { ResolvedAgentConfig } from "../../../shared/types.js";
import type { AnthropicToolBlock } from "../../translation/types.js";
import { OpenAiCredentialsResolver } from "../../credentials/openai-credentials.js";
import type { SecretsResolver } from "../../../manager/secrets-resolver.js";

/**
 * Phase 137 Plan 04 T-03 — stub credentials for Plan 03 integration
 * tests that don't exercise credentials behaviour. The dedicated
 * credentials integration test
 * (`codex-credentials-integration.test.ts`) covers the full path
 * including spawn-env assertion + missing-credentials error.
 */
function makeStubCredentials(): OpenAiCredentialsResolver {
  const mockSecrets = {
    resolve: vi.fn(async () => "sk-stub-integration-key"),
  } as unknown as SecretsResolver;
  return new OpenAiCredentialsResolver({
    secretsResolver: mockSecrets,
    apiKeyPath: "op://example-vault-32/stub/credential",
    agentName: "integration-stub",
  });
}

function makeFakeChild() {
  const stdoutStream = new Readable({ read() {} });
  stdoutStream.setEncoding("utf8");
  const stderrStream = new Readable({ read() {} });
  return {
    emitter: Object.assign(new EventEmitter(), {
      stdin: { write: vi.fn(() => true), destroyed: false },
      stdout: stdoutStream,
      stderr: stderrStream,
      kill: vi.fn(),
    }),
    stdoutStream,
  };
}

type LoggerSpy = {
  info: ReturnType<typeof vi.fn> & ((obj: unknown, msg?: string) => void);
  warn: ReturnType<typeof vi.fn> & ((obj: unknown, msg?: string) => void);
};

function makeLogger(): LoggerSpy {
  return {
    info: vi.fn() as unknown as LoggerSpy["info"],
    warn: vi.fn() as unknown as LoggerSpy["warn"],
  };
}

const baseConfig = {
  name: "research",
  workspace: "/tmp/research",
  memoryPath: "/tmp/research",
  channels: [],
  model: "sonnet",
  effort: "low",
  allowedModels: ["sonnet"],
  greetOnRestart: false,
  greetCoolDownMs: 0,
  autoCompactAt: 0.7,
  memoryRetrievalTopK: 0,
  memoryRetrievalExcludeTags: [],
  memoryScannerEnabled: false,
  memoryFlushIntervalMs: 60_000,
  memoryCueEmoji: "✅",
  autoIngestAttachments: false,
  ingestionPriority: "medium" as const,
  excludeDynamicSections: false,
  cacheBreakpointPlacement: "after-skills" as const,
  autoStart: false,
  skills: [],
  marketplaceSources: [],
  capabilityMode: "open" as const,
  perTurnAllowList: [],
  allowList: [],
  capabilityProbeBatchSize: 4,
  capabilityProbeCacheTtlMs: 300_000,
  capabilityProbeRetryAfterMs: 30_000,
  forkSessionRollbackBehavior: "checkpoint" as const,
  forkSessionTtlMs: 300_000,
  forkSessionCleanupIntervalMs: 60_000,
  mcpServers: [],
  slashCommands: [],
  llmRuntime: { backend: "codex-cli" as const },
} as unknown as ResolvedAgentConfig;

describe("CodexAgentCli — Plan 01+02+03 end-to-end integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("(1)(4) construct + loadSdkModule() → returns a CodexSdkModule; backend log fires", async () => {
    const logger = makeLogger();
    const existsSync = vi.fn(() => true);
    const which = vi.fn(async () => "/usr/local/bin/codex");

    const backend = new CodexAgentCli(
      baseConfig,
      { logger, openaiCredentials: makeStubCredentials() },
      { existsSync, which },
    );

    // phase137-codex-backend fires at construction.
    const backendLogs = (logger.info as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c) => c[1] === "phase137-codex-backend",
    );
    expect(backendLogs.length).toBe(1);

    const mod = await backend.loadSdkModule();
    expect(mod).toBeInstanceOf(CodexSdkModule);
  });

  it("(2)(3)(4) query → spawn args translated + stdout events translated; phase137-codex-spawn fires", async () => {
    const logger = makeLogger();
    const existsSync = vi.fn(() => true);
    const which = vi.fn(async () => "/usr/local/bin/codex");

    // Mock spawnFn — capture argv + return a fake child.
    const fake = makeFakeChild();
    const spawnFn = vi.fn(
      () => fake.emitter as unknown as ReturnType<CodexQueryDeps["spawnFn"]>,
    ) as unknown as CodexQueryDeps["spawnFn"];
    const queryDeps: CodexQueryDeps = {
      spawnFn,
      logger,
      nanoidFn: () => "deadbeef",
    };

    const backend = new CodexAgentCli(
      baseConfig,
      { logger, openaiCredentials: makeStubCredentials() },
      { existsSync, which },
      queryDeps,
    );

    const mod = await backend.loadSdkModule();

    const tools: AnthropicToolBlock[] = [
      {
        name: "search_web",
        description: "Search the web.",
        input_schema: {
          type: "object",
          properties: { q: { type: "string" } },
        },
      },
    ];

    // Tools via the loose cast — see codex-query.ts Deviation #1.
    const q = mod.query({
      prompt: "find me something",
      options: { model: "gpt-5-codex", tools } as unknown as Parameters<
        typeof mod.query
      >[0]["options"],
    });

    // Phase 137 Plan 04 T-03 — spawn is deferred behind the
    // credentials Promise. Flush microtasks so awaitDeferredSpawn
    // resolves before asserting on spawn args.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    // (2) Spawn arg captures translated OpenAI-shape tool JSON.
    const call = (spawnFn as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(call[0]).toBe("/usr/local/bin/codex");
    const args = call[1] as string[];
    const toolsArgIdx = args.indexOf("--tools");
    expect(toolsArgIdx).toBeGreaterThanOrEqual(0);
    const toolsJson = JSON.parse(args[toolsArgIdx + 1]!);
    // Plan 02 outbound translation — the OpenAI function envelope
    // arrived at the spawn boundary.
    expect(toolsJson[0]).toEqual({
      type: "function",
      function: {
        name: "search_web",
        description: "Search the web.",
        parameters: {
          type: "object",
          properties: { q: { type: "string" } },
        },
      },
    });

    // (4) phase137-codex-spawn fires exactly once.
    const spawnLogs = (logger.info as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c) => c[1] === "phase137-codex-spawn",
    );
    expect(spawnLogs.length).toBe(1);
    expect(spawnLogs[0]![0]).toMatchObject({
      agent: "research",
      model: "gpt-5-codex",
      toolCount: 1,
    });

    // (3) Push an OpenAI Chat-Completions SSE streaming response →
    // the new Plan 05 SSE normaliser pipeline yields an
    // Anthropic-shape assistant event.
    fake.stdoutStream.push(
      `data: ${JSON.stringify({
        id: "chatcmpl-integration",
        model: "gpt-5-codex",
        choices: [
          { delta: { role: "assistant", content: "found it" } },
        ],
      })}\n`,
    );
    fake.stdoutStream.push(
      `data: ${JSON.stringify({
        choices: [{ delta: {}, finish_reason: "stop" }],
      })}\n`,
    );
    fake.stdoutStream.push("data: [DONE]\n");
    // Allow stream data events to flush, then signal exit.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    fake.stdoutStream.push(null); // close stdout so end fires
    await new Promise((r) => setImmediate(r));
    (fake.emitter as unknown as EventEmitter).emit("exit", 0);

    const events: unknown[] = [];
    for await (const ev of q) {
      events.push(ev);
    }
    expect(events.length).toBeGreaterThanOrEqual(1);
    const assistantEvent = events.find(
      (e) =>
        typeof e === "object" &&
        e !== null &&
        (e as { type?: unknown }).type === "assistant",
    );
    expect(assistantEvent).toBeDefined();
    expect(assistantEvent).toMatchObject({
      type: "assistant",
      content: "found it",
    });
  });

  it("(5) two CodexAgentCli instances for different agents get independent CodexSdkModule caches", async () => {
    const logger = makeLogger();
    const existsSync = vi.fn(() => true);
    const which = vi.fn(async () => "/usr/local/bin/codex");

    const backendA = new CodexAgentCli(
      { ...baseConfig, name: "research" } as ResolvedAgentConfig,
      { logger, openaiCredentials: makeStubCredentials() },
      { existsSync, which },
    );
    const backendB = new CodexAgentCli(
      { ...baseConfig, name: "projects" } as ResolvedAgentConfig,
      { logger, openaiCredentials: makeStubCredentials() },
      { existsSync, which },
    );

    const modA = await backendA.loadSdkModule();
    const modB = await backendB.loadSdkModule();

    expect(modA).not.toBe(modB);
    expect(modA).toBeInstanceOf(CodexSdkModule);
    expect(modB).toBeInstanceOf(CodexSdkModule);
  });

  it("(6) loadSdkModule() is idempotent per backend instance (cache contract)", async () => {
    const logger = makeLogger();
    const existsSync = vi.fn(() => true);
    const which = vi.fn(async () => "/usr/local/bin/codex");

    const backend = new CodexAgentCli(
      baseConfig,
      { logger, openaiCredentials: makeStubCredentials() },
      { existsSync, which },
    );

    const mod1 = await backend.loadSdkModule();
    const mod2 = await backend.loadSdkModule();
    const mod3 = await backend.loadSdkModule();

    expect(mod1).toBe(mod2);
    expect(mod2).toBe(mod3);
  });
});
