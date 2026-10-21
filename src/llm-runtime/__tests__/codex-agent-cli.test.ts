/**
 * Phase 137 Plan 01 T-03 — CodexAgentCli SHELL + factory dispatch tests.
 *
 * Proves the 5 cases from the PLAN `<behavior>` block:
 *   (1) factory returns a CodexAgentCli instance for backend
 *       === "codex-cli".
 *   (2) factory emits BOTH the phase136-llm-runtime (existing) AND
 *       the new phase137-codex-backend log lines per construction.
 *   (3) loadSdkModule() throws the documented Plan-03 deferral
 *       error string.
 *   (4) backend probes discoverCliBinary with binaryName 'codex' and
 *       the explicit path from config when set.
 *   (5) CODEX_DEFAULT_COMMON_PATHS contains '/usr/local/bin/codex'
 *       AND a home-relative .local/bin/codex entry.
 *
 * All filesystem + child_process access stubbed via
 * DiscoverCliBinaryDeps. Logger is a vitest spy.
 *
 * See:
 *   - src/llm-runtime/backends/codex-agent-cli.ts
 *   - src/llm-runtime/llm-runtime-service.ts (factory switch case)
 *   - .planning/phases/137-.../137-01-PLAN.md T-03 <behavior>
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { homedir } from "node:os";
import path from "node:path";
import type { ResolvedAgentConfig } from "../../shared/types.js";
import { OpenAiCredentialsResolver } from "../credentials/openai-credentials.js";
import type { SecretsResolver } from "../../manager/secrets-resolver.js";

/**
 * Phase 137 Plan 04 T-03 — stub OpenAiCredentialsResolver for tests
 * that need a non-undefined deps.openaiCredentials so the
 * CodexAgentCli `loadSdkModule()` assertion passes. These tests
 * don't exercise credentials behaviour (covered by
 * `openai-credentials.test.ts` + `codex-credentials-integration.test.ts`).
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

// Mirror the anthropic-agent-sdk.test.ts fixture cadence.
const baseConfig: ResolvedAgentConfig = {
  name: "test-codex-agent",
  workspace: "/tmp/clawcode-codex-test",
  memoryPath: "/tmp/clawcode-codex-test",
  channels: [],
  model: "sonnet",
  effort: "low",
  allowedModels: ["haiku", "sonnet", "opus"],
  greetOnRestart: true,
  greetCoolDownMs: 300_000,
  autoCompactAt: 0.7,
  memoryRetrievalTopK: 0,
  memoryRetrievalExcludeTags: [],
  memoryScannerEnabled: false,
  memoryFlushIntervalMs: 60_000,
  memoryCueEmoji: "✅",
  autoIngestAttachments: false,
  ingestionPriority: "medium" as const,
  excludeDynamicSections: false,
  cacheBreakpointPlacement: "after-skills",
  autoStart: false,
  skills: [],
  marketplaceSources: [],
  capabilityMode: "open",
  perTurnAllowList: [],
  allowList: [],
  capabilityProbeBatchSize: 4,
  capabilityProbeCacheTtlMs: 300_000,
  capabilityProbeRetryAfterMs: 30_000,
  bedrockRegion: undefined,
  bedrockAccessKeyId: undefined,
  bedrockSecretAccessKey: undefined,
  bedrockSessionToken: undefined,
  vertexProjectId: undefined,
  vertexLocation: undefined,
  vertexAuthOverride: undefined,
  vertexProxyUrl: undefined,
  forkSessionRollbackBehavior: "checkpoint",
  forkSessionTtlMs: 300_000,
  forkSessionCleanupIntervalMs: 60_000,
  mcpServers: [],
  slashCommands: [],
  llmRuntime: { backend: "codex-cli" },
} as unknown as ResolvedAgentConfig;

describe("CodexAgentCli SHELL", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("(4) probes discoverCliBinary with binaryName 'codex' and the explicit config path", async () => {
    const { CodexAgentCli } = await import(
      "../backends/codex-agent-cli.js"
    );

    const existsSync = vi.fn(
      (p: string) => p === "/operator/custom/codex",
    );
    const which = vi.fn(async () => null);

    const cfg = {
      ...baseConfig,
      llmRuntime: {
        backend: "codex-cli" as const,
        codex: { pathToCodexExecutable: "/operator/custom/codex" },
      },
    } as unknown as ResolvedAgentConfig;

    const backend = new CodexAgentCli(
      cfg,
      {
        logger: { info: vi.fn(), warn: vi.fn() },
        openaiCredentials: makeStubCredentials(),
      },
      { existsSync, which },
    );
    expect(backend.backendId).toBe("codex-cli");

    // Phase 137 Plan 03 T-03 — loadSdkModule now resolves to a
    // CodexSdkModule (the Plan-01 deferral error is replaced).
    // Discovery still runs first — assertions below confirm the
    // probe reached the explicit path.
    const mod = await backend.loadSdkModule();
    expect(mod).toBeDefined();
    expect(typeof mod.query).toBe("function");
    expect(typeof mod.forkSession).toBe("function");
    // existsSync was invoked at least once with the explicit path
    // (tier-1 check fires before tier-2 / tier-3).
    expect(existsSync).toHaveBeenCalledWith("/operator/custom/codex");
    // `which codex` was NOT called — tier-1 hit short-circuits.
    expect(which).not.toHaveBeenCalled();
  });

  it("(3) loadSdkModule() resolves to a CodexSdkModule (Plan-01 deferral replaced by Plan 03)", async () => {
    const { CodexAgentCli } = await import(
      "../backends/codex-agent-cli.js"
    );
    const { CodexSdkModule } = await import(
      "../backends/codex-sdk-module.js"
    );

    // Stub discovery to resolve successfully (binary found on PATH).
    const existsSync = vi.fn(() => false);
    const which = vi.fn(async () => "/usr/local/bin/codex");

    const backend = new CodexAgentCli(
      baseConfig,
      {
        logger: { info: vi.fn(), warn: vi.fn() },
        openaiCredentials: makeStubCredentials(),
      },
      { existsSync, which },
    );

    const mod = await backend.loadSdkModule();
    expect(mod).toBeInstanceOf(CodexSdkModule);

    // The cache contract — subsequent calls return the same
    // reference (one CodexSdkModule per CodexAgentCli per process).
    const mod2 = await backend.loadSdkModule();
    expect(mod2).toBe(mod);
  });

  it("loadSdkModule surfaces CliBinaryNotFoundError when no tier resolves (post-discovery, before Plan-03 deferral)", async () => {
    const { CodexAgentCli } = await import(
      "../backends/codex-agent-cli.js"
    );
    const { CliBinaryNotFoundError } = await import("../discovery.js");

    const existsSync = vi.fn(() => false);
    const which = vi.fn(async () => null);

    const backend = new CodexAgentCli(
      baseConfig,
      {
        logger: { info: vi.fn(), warn: vi.fn() },
        openaiCredentials: makeStubCredentials(),
      },
      { existsSync, which },
    );

    await expect(backend.loadSdkModule()).rejects.toBeInstanceOf(
      CliBinaryNotFoundError,
    );
  });
});

describe("createLlmRuntimeService → codex-cli dispatch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("(1) factory returns a CodexAgentCli instance when backend === 'codex-cli'", async () => {
    const { createLlmRuntimeService } = await import(
      "../llm-runtime-service.js"
    );
    const { CodexAgentCli } = await import(
      "../backends/codex-agent-cli.js"
    );

    const service = createLlmRuntimeService(baseConfig, {
      logger: { info: vi.fn(), warn: vi.fn() },
    });

    expect(service).toBeInstanceOf(CodexAgentCli);
    // backendId surfaces the dispatched class identity.
    expect((service as InstanceType<typeof CodexAgentCli>).backendId).toBe(
      "codex-cli",
    );
  });

  it("(2) factory emits BOTH phase136-llm-runtime AND phase137-codex-backend log lines", async () => {
    const { createLlmRuntimeService } = await import(
      "../llm-runtime-service.js"
    );

    const logKeys: string[] = [];
    const logEntries: Array<{ obj: unknown; key: string | undefined }> = [];
    const logger = {
      info: (obj: unknown, msg?: string) => {
        logKeys.push(msg ?? "");
        logEntries.push({ obj, key: msg });
      },
      warn: vi.fn(),
    };

    createLlmRuntimeService(baseConfig, { logger });

    expect(logKeys).toContain("phase136-llm-runtime");
    expect(logKeys).toContain("phase137-codex-backend");
    // Telemetry payloads carry agent/backend/model identifiers.
    const codexEntry = logEntries.find(
      (e) => e.key === "phase137-codex-backend",
    );
    expect(codexEntry?.obj).toMatchObject({
      agent: "test-codex-agent",
      backend: "codex-cli",
      model: "sonnet",
    });
  });
});

describe("CODEX_DEFAULT_COMMON_PATHS", () => {
  it("(5) contains /usr/local/bin/codex AND ${HOME}/.local/bin/codex", async () => {
    const { CODEX_DEFAULT_COMMON_PATHS } = await import(
      "../backends/codex-agent-cli.js"
    );
    expect(CODEX_DEFAULT_COMMON_PATHS).toContain("/usr/local/bin/codex");
    expect(CODEX_DEFAULT_COMMON_PATHS).toContain(
      path.join(homedir(), ".local", "bin", "codex"),
    );
  });

  it("is frozen (Object.freeze) to prevent runtime mutation", async () => {
    const { CODEX_DEFAULT_COMMON_PATHS } = await import(
      "../backends/codex-agent-cli.js"
    );
    expect(Object.isFrozen(CODEX_DEFAULT_COMMON_PATHS)).toBe(true);
  });
});
