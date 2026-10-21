/**
 * Phase 138 Plan 04 T-02 — `SdkSessionAdapter` per-turn SDK load wiring.
 *
 * Proves the per-turn SDK load in `createSession` / `resumeSession`
 * resolves through the INJECTED per-agent `LlmRuntimeService`, and
 * that the no-arg `new SdkSessionAdapter()` falls back to the
 * seam-side default resolver (byte-identical to the pre-138-04
 * `loadSdk()` for the default backend).
 *
 * Cases pinned:
 *   (a) `new SdkSessionAdapter({ getLlmRuntime })` — `createSession`
 *       calls `getLlmRuntime(config.name)` exactly once and uses the
 *       returned service's `loadSdkModule()`.
 *   (b) Same assertion for `resumeSession`.
 *   (c) `new SdkSessionAdapter()` (no args) — the default resolver is
 *       used; `getLlmRuntime` is not required.
 *   (d) The injected `getLlmRuntime` receives the per-agent name
 *       (`config.name`).
 *
 * See `.planning/phases/138-.../138-04-PLAN.md` T-02.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AgentSessionConfig } from "../types.js";

// Mock the Claude Agent SDK so the seam-side default resolver (case c)
// resolves under our control. `mockSdkQuery` yields a single `result`
// message — the minimum `drainInitialQuery` needs.
const mockSdkQuery = vi.fn();
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: mockSdkQuery,
}));

import { SdkSessionAdapter } from "../session-adapter.js";
import type { LlmRuntimeService, LlmRuntimeSdkModule } from "../../llm-runtime/index.js";

function makeConfig(overrides: Partial<AgentSessionConfig> = {}): AgentSessionConfig {
  return {
    name: "wiring-test-agent",
    model: "sonnet",
    effort: "low",
    workspace: "/tmp/agent-workspace",
    systemPrompt: "stable-identity-block",
    channels: [],
    ...overrides,
  } as AgentSessionConfig;
}

/**
 * An async iterator yielding a single `result` message — the minimum
 * payload `drainInitialQuery` consumes to extract a session_id.
 */
function makeMockSdkStream(sessionId: string) {
  async function* gen() {
    yield {
      type: "result",
      subtype: "success",
      session_id: sessionId,
      result: "ok",
    };
  }
  const query: any = gen();
  query.interrupt = vi.fn();
  query.close = vi.fn();
  query.streamInput = vi.fn();
  query.mcpServerStatus = vi.fn();
  query.setMcpServers = vi.fn();
  return query;
}

/**
 * A fake `LlmRuntimeSdkModule` whose `query` returns the mock stream.
 */
function makeFakeSdkModule(): LlmRuntimeSdkModule {
  const query = vi.fn(() => makeMockSdkStream("sess-injected"));
  return {
    query,
    forkSession: vi.fn(async (id: string) => ({ sessionId: `${id}-forked` })),
  } as unknown as LlmRuntimeSdkModule;
}

describe("Phase 138-04 — SdkSessionAdapter resolves per-turn SDK via injected resolver", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    mockSdkQuery.mockReset();
    // The seam backend caches the imported SDK module process-wide.
    // Reset it so the no-arg default-resolver path (case c) resolves
    // under our `vi.mock` rather than a stale cache entry.
    const m = await import("../../llm-runtime/backends/anthropic-agent-sdk.js");
    m.__resetCachedModuleForTests();
  });

  it("(a) createSession resolves the SDK through the injected getLlmRuntime", async () => {
    const fakeModule = makeFakeSdkModule();
    const fakeService: LlmRuntimeService = {
      loadSdkModule: vi.fn(async () => fakeModule),
    };
    const getLlmRuntime = vi.fn(() => fakeService);
    const adapter = new SdkSessionAdapter({ getLlmRuntime });

    await adapter.createSession(makeConfig({ name: "agent-a" }));

    expect(getLlmRuntime).toHaveBeenCalledTimes(1);
    expect(getLlmRuntime).toHaveBeenCalledWith("agent-a");
    expect(fakeService.loadSdkModule).toHaveBeenCalledTimes(1);
  });

  it("(b) resumeSession resolves the SDK through the injected getLlmRuntime", async () => {
    const fakeModule = makeFakeSdkModule();
    const fakeService: LlmRuntimeService = {
      loadSdkModule: vi.fn(async () => fakeModule),
    };
    const getLlmRuntime = vi.fn(() => fakeService);
    const adapter = new SdkSessionAdapter({ getLlmRuntime });

    await adapter.resumeSession("prev-session", makeConfig({ name: "agent-b" }));

    expect(getLlmRuntime).toHaveBeenCalledTimes(1);
    expect(getLlmRuntime).toHaveBeenCalledWith("agent-b");
    expect(fakeService.loadSdkModule).toHaveBeenCalledTimes(1);
  });

  it("(c) no-arg SdkSessionAdapter uses the seam-side default resolver", async () => {
    // createSession drains an initial query then builds an epoch query
    // — `query` is invoked twice; provide a fresh stream for each.
    mockSdkQuery
      .mockReturnValueOnce(makeMockSdkStream("sess-default"))
      .mockReturnValueOnce(makeMockSdkStream("sess-default"));
    const adapter = new SdkSessionAdapter();

    const handle = await adapter.createSession(makeConfig({ name: "agent-c" }));

    expect(handle).toBeDefined();
    expect(mockSdkQuery).toHaveBeenCalled();
  });

  it("(d) the injected getLlmRuntime receives the correct per-agent name", async () => {
    const fakeService: LlmRuntimeService = {
      loadSdkModule: vi.fn(async () => makeFakeSdkModule()),
    };
    const getLlmRuntime = vi.fn(() => fakeService);
    const adapter = new SdkSessionAdapter({ getLlmRuntime });

    await adapter.createSession(makeConfig({ name: "very-specific-agent" }));

    expect(getLlmRuntime).toHaveBeenCalledWith("very-specific-agent");
  });
});
