/**
 * Phase 137 Plan 03 T-02 — CodexSdkModule unit tests.
 *
 * Three cases from PLAN T-02 `<behavior>`:
 *   (1) query() returns an SdkQuery-shaped object (AsyncGenerator +
 *       SdkQuery mutators).
 *   (2) forkSession() returns a Promise resolving to { sessionId }
 *       with the pseudo-fork suffix; emits phase137-codex-noop.
 *   (3) Type-level: a CodexSdkModule instance satisfies the
 *       LlmRuntimeSdkModule interface (gated by tsc --noEmit via
 *       the explicit annotation below).
 *
 * spawnFn + nanoidFn are dependency-injected; no real codex binary
 * is spawned.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";

import {
  CodexSdkModule,
  CODEX_DEFAULT_MODEL,
} from "../codex-sdk-module.js";
import type { CodexQueryDeps } from "../codex-query.js";
import type { LlmRuntimeSdkModule, LlmRuntimeDeps } from "../../types.js";
import type { ResolvedAgentConfig } from "../../../shared/types.js";
import { OpenAiCredentialsResolver } from "../../credentials/openai-credentials.js";
import type { SecretsResolver } from "../../../manager/secrets-resolver.js";

/**
 * Phase 137 Plan 04 T-03 — minimal stub OpenAiCredentialsResolver for
 * tests that exercise CodexSdkModule without needing to assert
 * credentials behaviour (covered separately by openai-credentials.test.ts
 * + codex-credentials-integration.test.ts). Returns a fixed value
 * synchronously via a mocked SecretsResolver.
 */
function makeStubCredentials(): OpenAiCredentialsResolver {
  const mockSecrets = {
    resolve: vi.fn(async () => "sk-test-stub-key"),
  } as unknown as SecretsResolver;
  return new OpenAiCredentialsResolver({
    secretsResolver: mockSecrets,
    apiKeyPath: "op://example-vault-32/stub/credential",
    agentName: "test-codex-agent",
  });
}

function makeFakeChild() {
  const stdoutStream = new Readable({ read() {} });
  stdoutStream.setEncoding("utf8");
  const stderrStream = new Readable({ read() {} });
  return Object.assign(new EventEmitter(), {
    stdin: { write: vi.fn(() => true), destroyed: false },
    stdout: stdoutStream,
    stderr: stderrStream,
    kill: vi.fn(),
  });
}

type LoggerSpy = {
  info: ReturnType<typeof vi.fn> & ((obj: unknown, msg?: string) => void);
  warn: ReturnType<typeof vi.fn> & ((obj: unknown, msg?: string) => void);
};

function makeDeps(): {
  spawnFn: CodexQueryDeps["spawnFn"];
  queryDeps: CodexQueryDeps;
  logger: LoggerSpy;
  nanoidFn: ReturnType<typeof vi.fn>;
} {
  const logger = {
    info: vi.fn() as unknown as LoggerSpy["info"],
    warn: vi.fn() as unknown as LoggerSpy["warn"],
  };
  const spawnFn = vi.fn(() => makeFakeChild()) as unknown as CodexQueryDeps["spawnFn"];
  const nanoidFn = vi.fn(() => "abc12345");
  return {
    spawnFn,
    logger,
    nanoidFn,
    queryDeps: { spawnFn, logger, nanoidFn },
  };
}

const baseConfig = {
  name: "test-codex-agent",
  workspace: "/tmp/codex-test",
  memoryPath: "/tmp/codex-test",
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

describe("CodexSdkModule", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("(1) query() returns an SdkQuery-shaped object", () => {
    const { logger, queryDeps } = makeDeps();
    const deps: LlmRuntimeDeps = { logger };
    const mod = new CodexSdkModule(
      baseConfig,
      deps,
      "/usr/local/bin/codex",
      queryDeps,
      makeStubCredentials(),
    );

    const q = mod.query({ prompt: "hello" });

    // SdkQuery is AsyncGenerator + mutators. Verify presence of
    // both halves of the intersection.
    expect(typeof q[Symbol.asyncIterator]).toBe("function");
    expect(typeof q.next).toBe("function");
    expect(typeof q.interrupt).toBe("function");
    expect(typeof q.close).toBe("function");
    expect(typeof q.streamInput).toBe("function");
    expect(typeof q.setModel).toBe("function");
    expect(typeof q.setMaxThinkingTokens).toBe("function");
    expect(typeof q.setPermissionMode).toBe("function");
    expect(typeof q.mcpServerStatus).toBe("function");
    expect(typeof q.setMcpServers).toBe("function");
    expect(typeof q.initializationResult).toBe("function");
    expect(typeof q.supportedCommands).toBe("function");

    // Clean up — don't leak the spawned-but-never-finished child.
    q.close();
  });

  it("(2) forkSession() returns pseudo-id and emits phase137-codex-noop", async () => {
    const { logger, queryDeps, nanoidFn } = makeDeps();
    const deps: LlmRuntimeDeps = { logger };
    const mod = new CodexSdkModule(
      baseConfig,
      deps,
      "/usr/local/bin/codex",
      queryDeps,
      makeStubCredentials(),
    );

    const result = await mod.forkSession("session-original-7");

    expect(result.sessionId).toBe("session-original-7-fork-abc12345");
    expect(nanoidFn).toHaveBeenCalledTimes(1);

    // phase137-codex-noop with the documented payload.
    const noopCalls = logger.info.mock.calls.filter(
      (c) => c[1] === "phase137-codex-noop",
    );
    expect(noopCalls).toHaveLength(1);
    expect(noopCalls[0]![0]).toMatchObject({
      method: "forkSession",
      sourceSessionId: "session-original-7",
      fakeId: "session-original-7-fork-abc12345",
    });
  });

  it("(3) instance satisfies LlmRuntimeSdkModule (TypeScript-gated)", () => {
    const { logger, queryDeps } = makeDeps();
    const deps: LlmRuntimeDeps = { logger };
    const mod = new CodexSdkModule(
      baseConfig,
      deps,
      "/usr/local/bin/codex",
      queryDeps,
      makeStubCredentials(),
    );

    // The type annotation below is the assertion — if CodexSdkModule
    // diverges from LlmRuntimeSdkModule, tsc --noEmit fails. The
    // runtime check is a smoke confirmation.
    const _check: LlmRuntimeSdkModule = mod;
    expect(typeof _check.query).toBe("function");
    expect(typeof _check.forkSession).toBe("function");
  });

  it("uses gpt-5-codex as the default model when options.model unset", async () => {
    const { spawnFn, logger, queryDeps } = makeDeps();
    const deps: LlmRuntimeDeps = { logger };
    const mod = new CodexSdkModule(
      baseConfig,
      deps,
      "/usr/local/bin/codex",
      queryDeps,
      makeStubCredentials(),
    );

    const q = mod.query({ prompt: "hi" });

    // Phase 137 Plan 04 T-03 — spawn is now deferred behind the
    // credentials Promise. Flush microtasks so awaitDeferredSpawn
    // resolves before we inspect spawnFn's calls.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    const call = (
      spawnFn as unknown as ReturnType<typeof vi.fn>
    ).mock.calls[0]!;
    const args = call[1] as string[];
    const modelIdx = args.indexOf("--model");
    expect(args[modelIdx + 1]).toBe(CODEX_DEFAULT_MODEL);
    q.close();
  });

  it("honours options.model override over the default", async () => {
    const { spawnFn, logger, queryDeps } = makeDeps();
    const deps: LlmRuntimeDeps = { logger };
    const mod = new CodexSdkModule(
      baseConfig,
      deps,
      "/usr/local/bin/codex",
      queryDeps,
      makeStubCredentials(),
    );

    const q = mod.query({ prompt: "hi", options: { model: "gpt-5-codex-mini" } });

    // Flush microtasks — see preceding test's comment.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    const call = (
      spawnFn as unknown as ReturnType<typeof vi.fn>
    ).mock.calls[0]!;
    const args = call[1] as string[];
    const modelIdx = args.indexOf("--model");
    expect(args[modelIdx + 1]).toBe("gpt-5-codex-mini");
    q.close();
  });
});
