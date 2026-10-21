import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { CheckContext } from "../../types.js";
import traceRetentionCheck from "../trace-retention.js";

/**
 * Minimal mock CheckContext builder for trace-retention tests.
 * Mirrors the shape used by attachment-cleanup/tier-maintenance tests.
 */
function buildContext(overrides: {
  agentName?: string;
  agentConfig?: unknown;
  traceStore?: { pruneOlderThan?: ReturnType<typeof vi.fn> } | undefined;
} = {}): CheckContext {
  const agentName = overrides.agentName ?? "test-agent";
  const agentConfig =
    "agentConfig" in overrides ? overrides.agentConfig : { perf: { traceRetentionDays: 7 } };

  const getTraceStore = vi.fn().mockReturnValue(overrides.traceStore ?? undefined);

  const sessionManager = {
    getAgentConfig: vi.fn().mockReturnValue(agentConfig),
    getTraceStore,
    // Stubs for unused SessionManager surface:
    getRunningAgents: vi.fn().mockReturnValue([agentName]),
    startAgent: vi.fn(),
    dispatchTurn: vi.fn(),
    streamFromAgent: vi.fn(),
    forwardToAgent: vi.fn(),
    forkSession: vi.fn(),
    stopAgent: vi.fn(),
    restartAgent: vi.fn(),
    startAll: vi.fn(),
    stopAll: vi.fn(),
    reconcileRegistry: vi.fn(),
    getMemoryStore: vi.fn(),
    getCompactionManager: vi.fn(),
    getContextFillProvider: vi.fn(),
    getEmbedder: vi.fn(),
    getSessionLogger: vi.fn(),
    getUsageTracker: vi.fn(),
    getTierManager: vi.fn(),
    saveContextSummary: vi.fn(),
    warmupEmbeddings: vi.fn(),
    setSkillsCatalog: vi.fn(),
    setAllAgentConfigs: vi.fn(),
  } as unknown as CheckContext["sessionManager"];

  return {
    agentName,
    sessionManager,
    registry: { entries: [], updatedAt: Date.now() },
    config: {
      enabled: true,
      intervalSeconds: 60,
      checkTimeoutSeconds: 10,
      contextFill: { warningThreshold: 0.7, criticalThreshold: 0.9 },
    },
  };
}

describe("trace-retention check", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-13T00:00:00.000Z"));
  });

  it("module exports name 'trace-retention'", () => {
    expect(traceRetentionCheck.name).toBe("trace-retention");
  });

  it("returns healthy with 'No config' when agentConfig is missing", async () => {
    const ctx = buildContext({ agentConfig: undefined });
    const result = await traceRetentionCheck.execute(ctx);
    expect(result.status).toBe("healthy");
    expect(result.message.toLowerCase()).toContain("no config");
  });

  it("returns healthy with 'No trace store' when getTraceStore returns undefined", async () => {
    const ctx = buildContext({ traceStore: undefined });
    const result = await traceRetentionCheck.execute(ctx);
    expect(result.status).toBe("healthy");
    expect(result.message.toLowerCase()).toContain("no trace store");
  });

  it("calls store.pruneOlderThan with cutoff equal to now minus traceRetentionDays", async () => {
    const pruneOlderThan = vi.fn().mockReturnValue(5);
    const ctx = buildContext({
      agentConfig: { perf: { traceRetentionDays: 3 } },
      traceStore: { pruneOlderThan },
    });

    await traceRetentionCheck.execute(ctx);

    expect(pruneOlderThan).toHaveBeenCalledOnce();
    const cutoffArg = pruneOlderThan.mock.calls[0]![0];
    // Frozen system time = 2026-04-13T00:00:00Z; 3 days ago = 2026-04-10T00:00:00Z.
    expect(new Date(cutoffArg).toISOString()).toBe("2026-04-10T00:00:00.000Z");
  });

  it("defaults to 7 days when perf.traceRetentionDays is absent", async () => {
    const pruneOlderThan = vi.fn().mockReturnValue(0);
    const ctx = buildContext({
      agentConfig: {}, // no `perf` sub-object
      traceStore: { pruneOlderThan },
    });

    await traceRetentionCheck.execute(ctx);

    expect(pruneOlderThan).toHaveBeenCalledOnce();
    const cutoffArg = pruneOlderThan.mock.calls[0]![0];
    // 7 days before frozen now = 2026-04-06T00:00:00Z
    expect(new Date(cutoffArg).toISOString()).toBe("2026-04-06T00:00:00.000Z");
  });

  it("metadata includes deleted count and cutoff", async () => {
    const pruneOlderThan = vi.fn().mockReturnValue(12);
    const ctx = buildContext({
      agentConfig: { perf: { traceRetentionDays: 1 } },
      traceStore: { pruneOlderThan },
    });

    const result = await traceRetentionCheck.execute(ctx);
    expect(result.status).toBe("healthy");
    expect(result.metadata).toBeDefined();
    const meta = result.metadata as Record<string, unknown>;
    expect(meta["deleted"] ?? meta["removed"]).toBe(12);
    expect(
      meta["cutoff"] ?? meta["cutoffIso"] ?? meta["cutoff_iso"],
    ).toBeDefined();
  });
});
