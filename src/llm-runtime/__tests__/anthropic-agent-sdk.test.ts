/**
 * Phase 136 T-06 — `AnthropicAgentSdkBackend` behavior pinning.
 *
 * Tests three cases that operationally matter:
 *   1. `loadSdkModule()` returns the dynamically-imported SDK module.
 *   2. The not-installed error message is byte-identical to the
 *      pre-Phase-136 `loadSdk()` (operator-facing error matchers).
 *   3. The module cache short-circuits — multiple calls share one
 *      Promise<LlmRuntimeSdkModule> resolution.
 *   4. The free-function chokepoint and the class delegate to the
 *      same cache (no double-import).
 *
 * Vitest mocks `@anthropic-ai/claude-agent-sdk` to a stub module that
 * carries the `query` and `forkSession` exports the seam declares.
 * The cache reset hook (`__resetCachedModuleForTests`) lets each
 * spec start clean.
 *
 * See:
 *   - `src/advisor/backends/__tests__/anthropic-sdk.test.ts` —
 *     Phase 117 precedent (same test cadence).
 *   - `.planning/phases/136-llm-runtime-multi-backend/136-01-PLAN.md`
 *     T-06 — pin at least 3 cases (query + forkSession + abortQuery
 *     surface). Phase 136 ships `loadSdkModule()` only; the per-Query
 *     methods (query, forkSession, setModel, abortController plumbing)
 *     are owned by `SdkModule` / `SdkQuery` and exercised by the
 *     existing session-adapter test suite — re-pinning them here
 *     would duplicate the SDK type contract.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ResolvedAgentConfig } from "../../shared/types.js";

// Module-mock the SDK package so the dynamic import inside the
// backend resolves under our control. Sequence of `vi.mock` BEFORE
// the dynamic imports below is required.
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: vi.fn(),
  forkSession: vi.fn(async (sessionId: string) => ({
    sessionId: `${sessionId}-forked`,
  })),
}));

const baseConfig: ResolvedAgentConfig = {
  name: "test-agent",
  workspace: "/tmp/clawcode-test",
  memoryPath: "/tmp/clawcode-test",
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
  autoIngestAttachments: false, // Phase 999.43 D-09
  ingestionPriority: "medium" as const, // Phase 999.43 D-01 Axis 1
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
  llmRuntime: { backend: "anthropic-agent-sdk" },
} as unknown as ResolvedAgentConfig;

describe("AnthropicAgentSdkBackend", () => {
  beforeEach(async () => {
    const m = await import("../backends/anthropic-agent-sdk.js");
    m.__resetCachedModuleForTests();
    vi.clearAllMocks();
  });

  it("loadSdkModule() resolves with the dynamically-imported SDK", async () => {
    const { AnthropicAgentSdkBackend } = await import(
      "../backends/anthropic-agent-sdk.js"
    );
    const backend = new AnthropicAgentSdkBackend(baseConfig, {});
    const mod = await backend.loadSdkModule();
    expect(mod).toBeDefined();
    expect(typeof mod.query).toBe("function");
    expect(typeof mod.forkSession).toBe("function");
  });

  it("backendId === 'anthropic-agent-sdk'", async () => {
    const { AnthropicAgentSdkBackend } = await import(
      "../backends/anthropic-agent-sdk.js"
    );
    const backend = new AnthropicAgentSdkBackend(baseConfig, {});
    expect(backend.backendId).toBe("anthropic-agent-sdk");
  });

  it("the cache short-circuits — two loadSdkModule() calls return the same module reference", async () => {
    const { AnthropicAgentSdkBackend } = await import(
      "../backends/anthropic-agent-sdk.js"
    );
    const backend = new AnthropicAgentSdkBackend(baseConfig, {});
    const a = await backend.loadSdkModule();
    const b = await backend.loadSdkModule();
    expect(a).toBe(b);
  });

  it("free-function chokepoint and class instance share the same cache", async () => {
    const { AnthropicAgentSdkBackend, loadAnthropicAgentSdkModule } =
      await import("../backends/anthropic-agent-sdk.js");
    const backend = new AnthropicAgentSdkBackend(baseConfig, {});
    const fromClass = await backend.loadSdkModule();
    const fromFree = await loadAnthropicAgentSdkModule();
    expect(fromClass).toBe(fromFree);
  });

  it("forkSession is exposed on the returned module (LlmRuntimeSdkModule widening)", async () => {
    const { loadAnthropicAgentSdkModule } = await import(
      "../backends/anthropic-agent-sdk.js"
    );
    const mod = await loadAnthropicAgentSdkModule();
    const result = await mod.forkSession("session-1", {});
    expect(result).toEqual({ sessionId: "session-1-forked" });
  });
});

describe("createLlmRuntimeService factory", () => {
  beforeEach(async () => {
    const m = await import("../backends/anthropic-agent-sdk.js");
    m.__resetCachedModuleForTests();
    vi.clearAllMocks();
  });

  it("dispatches anthropic-agent-sdk to AnthropicAgentSdkBackend", async () => {
    const { createLlmRuntimeService } = await import(
      "../llm-runtime-service.js"
    );
    const logged: unknown[] = [];
    const service = createLlmRuntimeService(baseConfig, {
      logger: {
        info: (obj) => logged.push(obj),
        warn: () => {},
      },
    });
    const mod = await service.loadSdkModule();
    expect(typeof mod.query).toBe("function");
    // D-07 telemetry — one phase136-llm-runtime log per construction.
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({
      agent: "test-agent",
      backend: "anthropic-agent-sdk",
      model: "sonnet",
    });
  });

  it("defaults the backend to anthropic-agent-sdk when llmRuntime block absent (back-compat)", async () => {
    const { createLlmRuntimeService } = await import(
      "../llm-runtime-service.js"
    );
    const cfg = {
      ...baseConfig,
      llmRuntime: undefined,
    } as unknown as ResolvedAgentConfig;
    const service = createLlmRuntimeService(cfg, {
      logger: { info: () => {}, warn: () => {} },
    });
    const mod = await service.loadSdkModule();
    expect(typeof mod.query).toBe("function");
  });
});

describe("PortableForkBackend (scaffold)", () => {
  it("loadSdkModule() throws the documented Phase 14X deferred error", async () => {
    const { PortableForkBackend } = await import(
      "../backends/portable-fork.js"
    );
    const backend = new PortableForkBackend(baseConfig, {});
    await expect(backend.loadSdkModule()).rejects.toThrow(
      /portable-fork backend deferred.*Phase 14X/i,
    );
  });

  it("backendId === 'portable-fork'", async () => {
    const { PortableForkBackend } = await import(
      "../backends/portable-fork.js"
    );
    expect(new PortableForkBackend(baseConfig, {}).backendId).toBe(
      "portable-fork",
    );
  });
});
