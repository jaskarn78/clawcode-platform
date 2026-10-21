/**
 * Phase 137 Plan 04 T-03 — credentials-integration end-to-end test.
 *
 * Brings together Plan 04's three layers — schema + resolver + spawn
 * env injection — and asserts the SC4 + auth-surface-separation
 * invariants directly at the spawn boundary.
 *
 * Six assertions from the PLAN T-03 `<behavior>` block:
 *   (1) CodexAgentCli with openaiCredentials in deps + mocked execa
 *       resolves loadSdkModule + query without error.
 *   (2) The spawned child env contains OPENAI_API_KEY equal to the
 *       resolved value from SecretsResolver.
 *   (3) The spawned child env DOES NOT contain OAUTH_TOKEN /
 *       ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN / ANTHROPIC_BASE_URL —
 *       auth-surface separation invariant (T4).
 *   (4) Constructing CodexAgentCli WITHOUT openaiCredentials in deps
 *       then calling loadSdkModule() throws the operator-actionable
 *       error directing the operator at clawcode.yaml.
 *   (5) Backwards-compat: an Anthropic-backend agent constructed with
 *       openaiCredentials: undefined still works (zero regression).
 *   (6) SEC-07: the resolved API key never appears in the spawn argv
 *       (argv is a separate disclosure surface from env — `ps` shows
 *       argv but not env, but secrets in argv are a stronger leak).
 *
 * Three layers of mocks (per plan's T-03 `<action>`):
 *   - SecretsResolver — returns a known plaintext value.
 *   - spawnFn (CodexQueryDeps) — captures argv + env from the call.
 *   - discoverCliBinary deps — fixed binary path resolution.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";

import { CodexAgentCli } from "../codex-agent-cli.js";
import { AnthropicAgentSdkBackend } from "../anthropic-agent-sdk.js";
import { OpenAiCredentialsResolver } from "../../credentials/openai-credentials.js";
import type { CodexQueryDeps } from "../codex-query.js";
import type { ResolvedAgentConfig } from "../../../shared/types.js";
import type { SecretsResolver } from "../../../manager/secrets-resolver.js";
import type { LlmRuntimeDeps } from "../../types.js";

const KNOWN_API_KEY = "sk-very-secret-test-key-do-not-leak";

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

function makeLogger() {
  return {
    info: vi.fn() as unknown as (obj: unknown, msg?: string) => void,
    warn: vi.fn() as unknown as (obj: unknown, msg?: string) => void,
  };
}

function makeMockSecretsResolver(value: string = KNOWN_API_KEY): {
  mock: SecretsResolver;
  resolveSpy: ReturnType<typeof vi.fn>;
} {
  const resolveSpy = vi.fn(async () => value);
  const mock = { resolve: resolveSpy } as unknown as SecretsResolver;
  return { mock, resolveSpy };
}

function makeCredentialsResolver(opts: {
  apiKeyPath?: string;
  resolveValue?: string;
  agentName?: string;
} = {}): OpenAiCredentialsResolver {
  const { mock } = makeMockSecretsResolver(opts.resolveValue ?? KNOWN_API_KEY);
  return new OpenAiCredentialsResolver({
    secretsResolver: mock,
    apiKeyPath: opts.apiKeyPath ?? "op://example-vault-9/openai/credential",
    agentName: opts.agentName ?? "trial-agent",
  });
}

const baseCodexConfig = {
  name: "trial-agent",
  workspace: "/tmp/trial-agent",
  memoryPath: "/tmp/trial-agent",
  channels: [],
  model: "sonnet",
  effort: "low" as const,
  allowedModels: ["sonnet"] as const,
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
  llmRuntime: { backend: "codex-cli" as const },
  providers: { openai: { apiKeyPath: "op://example-vault-9/openai/credential" } },
} as unknown as ResolvedAgentConfig;

describe("CodexCredentialsIntegration — Phase 137 Plan 04 T-03", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("(1)(2) spawned child env contains OPENAI_API_KEY with the resolved value", async () => {
    const logger = makeLogger();
    const existsSync = vi.fn(() => true);
    const which = vi.fn(async () => "/usr/local/bin/codex");

    const fake = makeFakeChild();
    const spawnFn = vi.fn(
      () => fake as unknown as ReturnType<CodexQueryDeps["spawnFn"]>,
    ) as unknown as CodexQueryDeps["spawnFn"];
    const queryDeps: CodexQueryDeps = {
      spawnFn,
      logger: logger as unknown as CodexQueryDeps["logger"],
      nanoidFn: () => "deadbeef",
    };

    const credentialsResolver = makeCredentialsResolver();
    const backend = new CodexAgentCli(
      baseCodexConfig,
      {
        logger: logger as unknown as LlmRuntimeDeps["logger"],
        openaiCredentials: credentialsResolver,
      },
      { existsSync, which },
      queryDeps,
    );

    const mod = await backend.loadSdkModule();
    const q = mod.query({ prompt: "hello codex" });

    // Phase 137 Plan 04 T-03 — spawn is deferred; flush microtasks
    // until awaitDeferredSpawn fires the actual spawnFn call.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    const call = (spawnFn as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call).toBeDefined();
    expect(call![0]).toBe("/usr/local/bin/codex");

    const spawnOpts = call![2] as { env?: Record<string, string> };
    expect(spawnOpts.env).toBeDefined();
    expect(spawnOpts.env!.OPENAI_API_KEY).toBe(KNOWN_API_KEY);

    q.close();
  });

  it("(3) auth surface separation: spawn env DOES NOT contain OAUTH_TOKEN / ANTHROPIC_*", async () => {
    const logger = makeLogger();
    const existsSync = vi.fn(() => true);
    const which = vi.fn(async () => "/usr/local/bin/codex");

    // Pollute process.env to simulate the production scenario where
    // the daemon's own env carries Anthropic auth surface. The
    // assertion below proves the codex child env is built from an
    // EXPLICIT allow-list — NOT inherited from process.env.
    const originalEnv = { ...process.env };
    process.env.OAUTH_TOKEN = "anthropic-oauth-must-not-leak";
    process.env.ANTHROPIC_API_KEY = "anthropic-api-key-must-not-leak";
    process.env.ANTHROPIC_AUTH_TOKEN = "anthropic-auth-must-not-leak";
    process.env.ANTHROPIC_BASE_URL = "https://anthropic.example.com";
    process.env.CLAUDE_INTERNAL_FLAG = "internal-flag-must-not-leak";

    try {
      const fake = makeFakeChild();
      const spawnFn = vi.fn(
        () => fake as unknown as ReturnType<CodexQueryDeps["spawnFn"]>,
      ) as unknown as CodexQueryDeps["spawnFn"];
      const queryDeps: CodexQueryDeps = {
        spawnFn,
        logger: logger as unknown as CodexQueryDeps["logger"],
        nanoidFn: () => "deadbeef",
      };

      const credentialsResolver = makeCredentialsResolver();
      const backend = new CodexAgentCli(
        baseCodexConfig,
        {
          logger: logger as unknown as LlmRuntimeDeps["logger"],
          openaiCredentials: credentialsResolver,
        },
        { existsSync, which },
        queryDeps,
      );

      const mod = await backend.loadSdkModule();
      const q = mod.query({ prompt: "hello" });

      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));

      const call = (spawnFn as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
      const spawnOpts = call![2] as { env?: Record<string, string> };
      expect(spawnOpts.env).toBeDefined();

      // The auth-surface-separation invariant: NONE of these
      // Anthropic-scoped env vars should appear in the codex child.
      expect(spawnOpts.env).not.toHaveProperty("OAUTH_TOKEN");
      expect(spawnOpts.env).not.toHaveProperty("ANTHROPIC_API_KEY");
      expect(spawnOpts.env).not.toHaveProperty("ANTHROPIC_AUTH_TOKEN");
      expect(spawnOpts.env).not.toHaveProperty("ANTHROPIC_BASE_URL");
      expect(spawnOpts.env).not.toHaveProperty("CLAUDE_INTERNAL_FLAG");

      // The allow-list MUST contain OPENAI_API_KEY (operator's intent)
      // and the three benign system env vars (PATH/HOME/USER) only.
      const envKeys = Object.keys(spawnOpts.env!).sort();
      const allowList = new Set(["OPENAI_API_KEY", "PATH", "HOME", "USER"]);
      for (const key of envKeys) {
        expect(allowList).toContain(key);
      }

      q.close();
    } finally {
      // Restore process.env to avoid bleeding mock values into other
      // tests in the same vitest worker.
      for (const key of [
        "OAUTH_TOKEN",
        "ANTHROPIC_API_KEY",
        "ANTHROPIC_AUTH_TOKEN",
        "ANTHROPIC_BASE_URL",
        "CLAUDE_INTERNAL_FLAG",
      ]) {
        if (originalEnv[key] === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = originalEnv[key];
        }
      }
    }
  });

  it("(4) CodexAgentCli WITHOUT openaiCredentials throws operator-actionable error at loadSdkModule()", async () => {
    const logger = makeLogger();
    const existsSync = vi.fn(() => true);
    const which = vi.fn(async () => "/usr/local/bin/codex");

    // No openaiCredentials in deps.
    const backend = new CodexAgentCli(
      baseCodexConfig,
      { logger: logger as unknown as LlmRuntimeDeps["logger"] },
      { existsSync, which },
    );

    // Construction MUST succeed (lazy-fail per T3 — daemon boot stays
    // non-blocking).
    expect(backend).toBeDefined();

    // The error surfaces at loadSdkModule() time with an
    // operator-actionable message pointing at clawcode.yaml.
    await expect(backend.loadSdkModule()).rejects.toThrow(
      /providers\.openai\.apiKeyPath/,
    );
    await expect(backend.loadSdkModule()).rejects.toThrow(
      /clawcode\.yaml/,
    );
  });

  it("(5) backwards-compat: Anthropic backend with openaiCredentials: undefined works", () => {
    const anthropicConfig = {
      ...baseCodexConfig,
      llmRuntime: { backend: "anthropic-agent-sdk" as const },
      providers: undefined,
    } as unknown as ResolvedAgentConfig;
    const logger = makeLogger();

    // Construction must succeed with openaiCredentials missing —
    // the Anthropic backend ignores the field entirely.
    const backend = new AnthropicAgentSdkBackend(anthropicConfig, {
      logger: logger as unknown as LlmRuntimeDeps["logger"],
      openaiCredentials: undefined,
    });
    expect(backend).toBeDefined();
    expect(backend.backendId).toBe("anthropic-agent-sdk");
  });

  it("(6) SEC-07: resolved API key NEVER appears in spawn argv", async () => {
    const logger = makeLogger();
    const existsSync = vi.fn(() => true);
    const which = vi.fn(async () => "/usr/local/bin/codex");

    const fake = makeFakeChild();
    const spawnFn = vi.fn(
      () => fake as unknown as ReturnType<CodexQueryDeps["spawnFn"]>,
    ) as unknown as CodexQueryDeps["spawnFn"];
    const queryDeps: CodexQueryDeps = {
      spawnFn,
      logger: logger as unknown as CodexQueryDeps["logger"],
      nanoidFn: () => "deadbeef",
    };

    const credentialsResolver = makeCredentialsResolver();
    const backend = new CodexAgentCli(
      baseCodexConfig,
      {
        logger: logger as unknown as LlmRuntimeDeps["logger"],
        openaiCredentials: credentialsResolver,
      },
      { existsSync, which },
      queryDeps,
    );

    const mod = await backend.loadSdkModule();
    const q = mod.query({ prompt: "hi" });

    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    const call = (spawnFn as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call).toBeDefined();
    const args = call![1] as string[];
    // The spawn argv must not contain the API key anywhere — argv is
    // a separate disclosure surface from env. (`ps` shows argv but
    // typically not env on Linux; a key in argv is a stronger leak.)
    const serialised = args.join(" ");
    expect(serialised).not.toContain(KNOWN_API_KEY);

    // Also assert SEC-07 on logger calls — the structural
    // phase137-codex-spawn line fires, but the resolved key never
    // appears in any log call arg.
    const allLogCalls = [
      ...(logger.info as unknown as ReturnType<typeof vi.fn>).mock.calls,
      ...(logger.warn as unknown as ReturnType<typeof vi.fn>).mock.calls,
    ];
    for (const logCall of allLogCalls) {
      for (const arg of logCall) {
        const ser =
          typeof arg === "string" ? arg : JSON.stringify(arg, (_k, v) => v);
        expect(ser).not.toContain(KNOWN_API_KEY);
      }
    }

    q.close();
  });

  it("(7) missing-credentials at spawn-time: synthetic error event surfaces in iterator", async () => {
    const logger = makeLogger();
    const existsSync = vi.fn(() => true);
    const which = vi.fn(async () => "/usr/local/bin/codex");

    const fake = makeFakeChild();
    const spawnFn = vi.fn(
      () => fake as unknown as ReturnType<CodexQueryDeps["spawnFn"]>,
    ) as unknown as CodexQueryDeps["spawnFn"];
    const queryDeps: CodexQueryDeps = {
      spawnFn,
      logger: logger as unknown as CodexQueryDeps["logger"],
      nanoidFn: () => "deadbeef",
    };

    // Credentials resolver configured with NO apiKeyPath — resolve()
    // will throw OpenAiCredentialsMissingError. The integration path
    // surfaces this as a synthetic error event in the iterator (the
    // daemon's `for await` sees an explicit failure instead of
    // hanging on a never-spawned child).
    const credentialsResolver = new OpenAiCredentialsResolver({
      secretsResolver: makeMockSecretsResolver().mock,
      apiKeyPath: undefined,
      agentName: "trial-agent",
    });
    const backend = new CodexAgentCli(
      baseCodexConfig,
      {
        logger: logger as unknown as LlmRuntimeDeps["logger"],
        openaiCredentials: credentialsResolver,
      },
      { existsSync, which },
      queryDeps,
    );

    const mod = await backend.loadSdkModule();
    const q = mod.query({ prompt: "hi" });

    // Drain the iterator — should yield exactly one synthetic error
    // event then complete.
    const events: unknown[] = [];
    for await (const ev of q) {
      events.push(ev);
    }

    expect(events.length).toBeGreaterThanOrEqual(1);
    const errorEvent = events[0] as {
      type: string;
      subtype: string;
      is_error: boolean;
      result: string;
    };
    expect(errorEvent.type).toBe("result");
    expect(errorEvent.is_error).toBe(true);
    expect(errorEvent.result).toMatch(/providers\.openai\.apiKeyPath/);

    // spawnFn must NOT have been called — credentials missing aborts
    // before the child is spawned.
    expect(spawnFn).not.toHaveBeenCalled();
  });
});
