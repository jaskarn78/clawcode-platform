/**
 * Phase 137 Plan 05 T-03 — SC2 acceptance + streaming integration.
 *
 * The end-to-end mocked proof that Phase 137's complete stack —
 * Plan 01 (schema + factory dispatch + discovery + CodexAgentCli),
 * Plan 02 (translation primitives), Plan 03 (CodexSdkModule +
 * CodexQuery spawn), Plan 04 (OpenAiCredentialsResolver + env
 * injection), Plan 05 (streaming normalisation + interceptor-bypass
 * tag) — hangs together at the wire boundary.
 *
 * Per SC2 from CONTEXT acceptance criteria:
 *
 *   "Operator can flip single agent from anthropic-agent-sdk →
 *    codex-cli via config-edit-and-reload; outbound traffic verified
 *    going to OpenAI on next turn."
 *
 * Real-OpenAI smoke testing is operator-side post-deploy via the
 * fleet config flip (CONTEXT D3). This test verifies via mocked
 * wire-capture-style assertions — the structural proof that flipping
 * the config dispatches to the codex binary spawn path with OpenAI
 * credentials.
 *
 * Eleven assertions per PLAN T-03 `<behavior>`:
 *  (a) Build an in-memory clawcode.yaml-shape config with
 *      `llmRuntime.backend: codex-cli` + `providers.openai.apiKeyPath`.
 *  (b) Schema-parse the config (SC6 — backend value accepted).
 *  (c) Resolve through the cascade.
 *  (d) createLlmRuntimeService → CodexAgentCli (NOT
 *      AnthropicAgentSdkBackend).
 *  (e) loadSdkModule() → CodexSdkModule.
 *  (f) module.query() → spawn captured; binary path is the codex
 *      binary, not claude.
 *  (g) Spawn env carries OPENAI_API_KEY (resolved value).
 *  (h) Spawn argv targets the OpenAI provider (model arg present;
 *      no anthropic references).
 *  (i) Push SSE chunks; iteration yields Anthropic-shape events
 *      (`assistant` + `result`).
 *  (j) phase137-codex-interceptor-bypass log fires with
 *      `outboundOrigin: 'api.openai.com'`.
 *  (k) A SECOND agent constructed with
 *      `llmRuntime.backend: anthropic-agent-sdk` returns
 *      `AnthropicAgentSdkBackend` (not broken by Plan 05's changes).
 *
 * Zero new npm deps; no real network; no real binary.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import { Readable, Writable } from "node:stream";

import { createLlmRuntimeService } from "../../llm-runtime-service.js";
import { CodexAgentCli } from "../codex-agent-cli.js";
import { CodexSdkModule } from "../codex-sdk-module.js";
import { AnthropicAgentSdkBackend } from "../anthropic-agent-sdk.js";
import { OpenAiCredentialsResolver } from "../../credentials/openai-credentials.js";
import { llmRuntimeConfigSchema } from "../../../config/schema.js";
import type { CodexQueryDeps } from "../codex-query.js";
import type { ResolvedAgentConfig } from "../../../shared/types.js";
import type { SecretsResolver } from "../../../manager/secrets-resolver.js";

const KNOWN_OPENAI_KEY = "sk-trial-cohort-test-key";

function makeFakeChild() {
  const stdoutStream = new Readable({ read() {} });
  stdoutStream.setEncoding("utf8");
  const stderrStream = new Readable({ read() {} });
  const stdinSink = new Writable({
    write(_c, _e, cb) {
      cb();
    },
  });
  const emitter = Object.assign(new EventEmitter(), {
    stdin: { write: vi.fn(() => stdinSink.write("")), destroyed: false },
    stdout: stdoutStream,
    stderr: stderrStream,
    kill: vi.fn(),
  });
  return { emitter, stdoutStream };
}

function makeLogger() {
  const info = vi.fn<(obj: unknown, msg?: string) => void>();
  const warn = vi.fn<(obj: unknown, msg?: string) => void>();
  return { info, warn };
}

function makeStubCredentials(): OpenAiCredentialsResolver {
  const mockSecrets = {
    resolve: vi.fn(async () => KNOWN_OPENAI_KEY),
  } as unknown as SecretsResolver;
  return new OpenAiCredentialsResolver({
    secretsResolver: mockSecrets,
    apiKeyPath: "op://example-vault-9/openai/credential",
    agentName: "trial-agent",
  });
}

const trialConfigBase = {
  name: "trial-agent",
  workspace: "/tmp/trial-agent",
  memoryPath: "/tmp/trial-agent",
  channels: [],
  model: "gpt-5-codex",
  effort: "low" as const,
  allowedModels: ["gpt-5-codex"] as const,
  greetOnRestart: false,
  greetCoolDownMs: 0,
  autoCompactAt: 0.7,
  memoryRetrievalTopK: 0,
  memoryRetrievalExcludeTags: [] as const,
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
};

describe("SC2 acceptance — flippable backend + streaming integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("(a)–(k) full end-to-end: config-flip → spawn captured → OpenAI events → no Anthropic-target wire surface", async () => {
    // ── (a)(b) Build + schema-parse the llmRuntime config block. ──
    //
    // Mirrors the operator's `clawcode.yaml` edit — adding
    // `llmRuntime: { backend: "codex-cli", codex: { ... } }` to a
    // trial-cohort agent.
    const llmRuntimeYaml = {
      backend: "codex-cli" as const,
      codex: {
        pathToCodexExecutable: "/usr/local/bin/codex",
        model: "gpt-5-codex",
      },
    };
    const parsed = llmRuntimeConfigSchema.parse(llmRuntimeYaml);
    expect(parsed.backend).toBe("codex-cli"); // (b) SC6 — backend value accepted

    // ── (c) Resolve through the cascade.
    //
    // The full daemon cascade is exercised in
    // src/config/__tests__/differ.test.ts; here we construct the
    // resolved-agent-config shape directly with the parsed value to
    // keep the test focused on the runtime-service factory.
    const resolvedConfig: ResolvedAgentConfig = {
      ...trialConfigBase,
      llmRuntime: parsed,
      providers: { openai: { apiKeyPath: "op://example-vault-9/openai/credential" } },
    } as unknown as ResolvedAgentConfig;

    // ── Wire mocked deps: logger + spawnFn + discovery + credentials.
    const logger = makeLogger();
    const fake = makeFakeChild();
    const spawnFn = vi.fn(
      () => fake.emitter as unknown as ReturnType<CodexQueryDeps["spawnFn"]>,
    ) as unknown as CodexQueryDeps["spawnFn"];
    const queryDeps: CodexQueryDeps = {
      spawnFn,
      logger,
      nanoidFn: () => "sc2acceptance",
    };
    const existsSync = vi.fn(() => true);
    const which = vi.fn(async () => "/usr/local/bin/codex");
    const credentials = makeStubCredentials();

    // ── (d) Factory dispatches to CodexAgentCli (NOT Anthropic).
    //
    // The production factory at `createLlmRuntimeService` does NOT
    // accept discoveryDeps / queryDeps — those are passed by the
    // daemon's per-agent loop into the constructor. For this test we
    // assert the factory selects the right CLASS and then construct
    // a parallel CodexAgentCli with the test-injected deps for the
    // remaining wire assertions.
    const serviceFromFactory = createLlmRuntimeService(resolvedConfig, {
      logger,
      openaiCredentials: credentials,
    });
    expect(serviceFromFactory).toBeInstanceOf(CodexAgentCli);
    expect(serviceFromFactory).not.toBeInstanceOf(AnthropicAgentSdkBackend);
    expect((serviceFromFactory as CodexAgentCli).backendId).toBe("codex-cli");

    // Construct an instance with mocked discovery + spawn — same
    // class, mocked seams.
    const backend = new CodexAgentCli(
      resolvedConfig,
      { logger, openaiCredentials: credentials },
      { existsSync, which },
      queryDeps,
    );

    // ── (e) loadSdkModule → CodexSdkModule.
    const mod = await backend.loadSdkModule();
    expect(mod).toBeInstanceOf(CodexSdkModule);

    // ── (f) module.query() → spawn captured.
    const q = mod.query({ prompt: "hello from trial cohort" });

    // Deferred spawn — flush microtasks until awaitDeferredSpawn fires.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    const spawnCall = (spawnFn as unknown as ReturnType<typeof vi.fn>).mock
      .calls[0];
    expect(spawnCall).toBeDefined();
    // Binary path is the codex binary (NOT claude).
    expect(spawnCall![0]).toBe("/usr/local/bin/codex");
    expect(spawnCall![0]).not.toContain("claude");

    // ── (g) Spawn env carries OPENAI_API_KEY.
    const spawnOpts = spawnCall![2] as { env?: Record<string, string> };
    expect(spawnOpts.env).toBeDefined();
    expect(spawnOpts.env!.OPENAI_API_KEY).toBe(KNOWN_OPENAI_KEY);
    // Auth surface separation — no Anthropic-scoped env vars leak.
    expect(spawnOpts.env).not.toHaveProperty("OAUTH_TOKEN");
    expect(spawnOpts.env).not.toHaveProperty("ANTHROPIC_API_KEY");

    // ── (h) Spawn argv targets OpenAI (no anthropic references).
    const argv = spawnCall![1] as string[];
    expect(argv).toContain("--model");
    expect(argv).toContain("gpt-5-codex");
    const argvSerialised = argv.join(" ");
    expect(argvSerialised).not.toContain("anthropic");
    expect(argvSerialised).not.toContain("claude");

    // ── (i) Push SSE chunks → iterate → Anthropic-shape events.
    fake.stdoutStream.push(
      `data: ${JSON.stringify({
        id: "chatcmpl-sc2",
        model: "gpt-5-codex",
        choices: [
          { delta: { role: "assistant", content: "Hello from " } },
        ],
      })}\n`,
    );
    fake.stdoutStream.push(
      `data: ${JSON.stringify({
        choices: [{ delta: { content: "OpenAI" } }],
      })}\n`,
    );
    fake.stdoutStream.push(
      `data: ${JSON.stringify({
        choices: [{ delta: {}, finish_reason: "stop" }],
      })}\n`,
    );
    fake.stdoutStream.push("data: [DONE]\n");
    await new Promise((r) => setImmediate(r));
    fake.stdoutStream.push(null); // close stdout
    await new Promise((r) => setImmediate(r));
    (fake.emitter as unknown as EventEmitter).emit("exit", 0);

    const events: unknown[] = [];
    for await (const ev of q) events.push(ev);

    // Events conform to the SdkStreamMessage union the daemon's
    // session-adapter reads: at least one `assistant` + one `result`.
    const assistantEvents = events.filter(
      (e) =>
        typeof e === "object" &&
        e !== null &&
        (e as { type?: unknown }).type === "assistant",
    );
    const resultEvents = events.filter(
      (e) =>
        typeof e === "object" &&
        e !== null &&
        (e as { type?: unknown }).type === "result",
    );
    expect(assistantEvents.length).toBeGreaterThanOrEqual(1);
    expect(resultEvents.length).toBeGreaterThanOrEqual(1);

    // The accumulated text matches the SSE deltas joined.
    expect(assistantEvents[0]).toMatchObject({
      type: "assistant",
      content: "Hello from OpenAI",
    });

    // ── (j) phase137-codex-interceptor-bypass log fires.
    const bypassLogs = logger.info.mock.calls.filter(
      (c) => c[1] === "phase137-codex-interceptor-bypass",
    );
    expect(bypassLogs).toHaveLength(1);
    expect(bypassLogs[0]![0]).toMatchObject({
      agent: "trial-agent",
      outboundOrigin: "api.openai.com",
    });

    // No log line in the entire lifecycle references api.anthropic.com.
    const allLogArgs = JSON.stringify(logger.info.mock.calls);
    expect(allLogArgs).not.toContain("api.anthropic.com");
    expect(allLogArgs).not.toContain("anthropic");
  });

  it("(k) parallel anthropic-agent-sdk agent in the same process still works (no regression)", () => {
    const anthropicConfig: ResolvedAgentConfig = {
      ...trialConfigBase,
      name: "claude-agent",
      llmRuntime: { backend: "anthropic-agent-sdk" },
    } as unknown as ResolvedAgentConfig;

    const logger = makeLogger();
    const service = createLlmRuntimeService(anthropicConfig, { logger });
    expect(service).toBeInstanceOf(AnthropicAgentSdkBackend);
    expect(service).not.toBeInstanceOf(CodexAgentCli);
    expect((service as AnthropicAgentSdkBackend).backendId).toBe(
      "anthropic-agent-sdk",
    );
  });

  it("schema-level: llmRuntime.backend rejects unknown values (SC6 hardening)", () => {
    expect(() =>
      llmRuntimeConfigSchema.parse({ backend: "not-a-real-backend" }),
    ).toThrow();
  });

  it("integration boundary surfaces all Phase 137 phase tags during one CodexQuery lifecycle", async () => {
    // One CodexQuery construction + query path emits ALL the
    // operator-greppable Phase 137 tags. This is a fence-post for the
    // observability story — if any of these tags silently disappears
    // in a future refactor, ops dashboards break.
    const resolvedConfig: ResolvedAgentConfig = {
      ...trialConfigBase,
      llmRuntime: { backend: "codex-cli" },
      providers: {
        openai: { apiKeyPath: "op://example-vault-9/openai/credential" },
      },
    } as unknown as ResolvedAgentConfig;

    const logger = makeLogger();
    const fake = makeFakeChild();
    const spawnFn = vi.fn(
      () => fake.emitter as unknown as ReturnType<CodexQueryDeps["spawnFn"]>,
    ) as unknown as CodexQueryDeps["spawnFn"];

    const backend = new CodexAgentCli(
      resolvedConfig,
      { logger, openaiCredentials: makeStubCredentials() },
      { existsSync: vi.fn(() => true), which: vi.fn(async () => "/usr/local/bin/codex") },
      { spawnFn, logger, nanoidFn: () => "tags-test" },
    );

    const mod = await backend.loadSdkModule();
    const q = mod.query({ prompt: "hi" });
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    fake.stdoutStream.push("data: [DONE]\n");
    fake.stdoutStream.push(null);
    await new Promise((r) => setImmediate(r));
    (fake.emitter as unknown as EventEmitter).emit("exit", 0);
    for await (const _ev of q) void _ev;

    const keys = logger.info.mock.calls
      .map((c) => (typeof c[1] === "string" ? c[1] : ""))
      .filter((k) => k.startsWith("phase137-"));
    const uniqueKeys = new Set(keys);

    // Required tags per Phase 137 observability spec:
    expect(uniqueKeys.has("phase137-codex-backend")).toBe(true); // Plan 01
    expect(uniqueKeys.has("phase137-codex-spawn")).toBe(true);   // Plan 03
    expect(uniqueKeys.has("phase137-codex-interceptor-bypass")).toBe(true); // Plan 05
    // phase137-codex-sse-event fires per SSE event (≥ 2 for the
    // minimal [DONE] stream: message_start + message_stop).
    const sseEvents = logger.info.mock.calls.filter(
      (c) => c[1] === "phase137-codex-sse-event",
    );
    expect(sseEvents.length).toBeGreaterThanOrEqual(2);
  });
});
