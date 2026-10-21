/**
 * Phase 60 Plan 03 Task 2 — task-retention heartbeat check tests.
 *
 * Tests the heartbeat check that purges terminal task rows older than
 * perf.taskRetentionDays and trigger_events older than 2x replayMaxAgeMs.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { CheckContext } from "../../types.js";
import taskRetentionCheck from "../task-retention.js";

/**
 * Build a minimal CheckContext for task-retention tests.
 * taskStore is injected as a new optional field on CheckContext.
 */
function buildContext(overrides: {
  agentName?: string;
  taskStore?: {
    purgeCompleted?: ReturnType<typeof vi.fn>;
    purgeTriggerEvents?: ReturnType<typeof vi.fn>;
  } | undefined;
  runningAgents?: string[];
  agentConfig?: unknown;
} = {}): CheckContext {
  const agentName = overrides.agentName ?? "test-agent";
  const runningAgents = overrides.runningAgents ?? [agentName];
  const agentConfig = overrides.agentConfig ?? { perf: { taskRetentionDays: 7 } };

  const sessionManager = {
    getAgentConfig: vi.fn().mockReturnValue(agentConfig),
    getRunningAgents: vi.fn().mockReturnValue(runningAgents),
    // Stubs for unused SessionManager surface:
    getTraceStore: vi.fn(),
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
    ...(overrides.taskStore !== undefined ? { taskStore: overrides.taskStore as any } : {}),
  };
}

describe("task-retention check", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-17T12:00:00.000Z"));
  });

  it("module exports name 'task-retention'", () => {
    expect(taskRetentionCheck.name).toBe("task-retention");
  });

  it("has interval of 3600 seconds (1 hour)", () => {
    expect(taskRetentionCheck.interval).toBe(3600);
  });

  it("returns healthy with 'No task store' when taskStore is undefined", async () => {
    const ctx = buildContext({ taskStore: undefined });
    const result = await taskRetentionCheck.execute(ctx);
    expect(result.status).toBe("healthy");
    expect(result.message).toContain("No task store");
  });

  it("returns healthy with 'No task store' when taskStore lacks purgeCompleted", async () => {
    const ctx = buildContext({ taskStore: {} as any });
    const result = await taskRetentionCheck.execute(ctx);
    expect(result.status).toBe("healthy");
    expect(result.message).toContain("No task store");
  });

  it("calls purgeCompleted with cutoff based on taskRetentionDays", async () => {
    const purgeCompleted = vi.fn().mockReturnValue(5);
    const purgeTriggerEvents = vi.fn().mockReturnValue(2);
    const ctx = buildContext({
      taskStore: { purgeCompleted, purgeTriggerEvents },
      agentConfig: { perf: { taskRetentionDays: 3 } },
    });

    const result = await taskRetentionCheck.execute(ctx);

    expect(purgeCompleted).toHaveBeenCalledOnce();
    const cutoffMs = purgeCompleted.mock.calls[0]![0] as number;
    // Frozen time is 2026-04-17T12:00:00Z. 3 days before = 2026-04-14T12:00:00Z
    const expectedCutoff = new Date("2026-04-14T12:00:00.000Z").getTime();
    expect(cutoffMs).toBe(expectedCutoff);
    expect(result.status).toBe("healthy");
    expect(result.message).toContain("5");
    expect(result.message).toContain("2");
  });

  it("calls purgeTriggerEvents with cutoff of 2x replayMaxAgeMs", async () => {
    const purgeCompleted = vi.fn().mockReturnValue(0);
    const purgeTriggerEvents = vi.fn().mockReturnValue(10);
    const ctx = buildContext({
      taskStore: { purgeCompleted, purgeTriggerEvents },
    });

    await taskRetentionCheck.execute(ctx);

    expect(purgeTriggerEvents).toHaveBeenCalledOnce();
    const triggerCutoffMs = purgeTriggerEvents.mock.calls[0]![0] as number;
    // Default replayMaxAgeMs = 86_400_000 (24h). 2x = 48h = 172_800_000.
    // Frozen time: 2026-04-17T12:00:00Z. 48h ago = 2026-04-15T12:00:00Z
    const expectedCutoff = Date.now() - 2 * 86_400_000;
    expect(triggerCutoffMs).toBe(expectedCutoff);
  });

  it("defaults to 7 days when perf.taskRetentionDays is absent", async () => {
    const purgeCompleted = vi.fn().mockReturnValue(0);
    const purgeTriggerEvents = vi.fn().mockReturnValue(0);
    const ctx = buildContext({
      taskStore: { purgeCompleted, purgeTriggerEvents },
      agentConfig: {}, // no perf sub-object
    });

    await taskRetentionCheck.execute(ctx);

    const cutoffMs = purgeCompleted.mock.calls[0]![0] as number;
    // 7 days before frozen time
    const expectedCutoff = new Date("2026-04-10T12:00:00.000Z").getTime();
    expect(cutoffMs).toBe(expectedCutoff);
  });

  it("skips when not the first running agent", async () => {
    const purgeCompleted = vi.fn();
    const purgeTriggerEvents = vi.fn();
    const ctx = buildContext({
      agentName: "agent-b",
      runningAgents: ["agent-a", "agent-b"],
      taskStore: { purgeCompleted, purgeTriggerEvents },
    });

    const result = await taskRetentionCheck.execute(ctx);

    expect(result.status).toBe("healthy");
    expect(result.message).toContain("Skipped");
    expect(purgeCompleted).not.toHaveBeenCalled();
  });

  it("runs when this is the first running agent", async () => {
    const purgeCompleted = vi.fn().mockReturnValue(1);
    const purgeTriggerEvents = vi.fn().mockReturnValue(0);
    const ctx = buildContext({
      agentName: "agent-a",
      runningAgents: ["agent-a", "agent-b"],
      taskStore: { purgeCompleted, purgeTriggerEvents },
    });

    const result = await taskRetentionCheck.execute(ctx);
    expect(purgeCompleted).toHaveBeenCalledOnce();
    expect(result.status).toBe("healthy");
  });

  it("reports 'No expired rows' when nothing deleted", async () => {
    const purgeCompleted = vi.fn().mockReturnValue(0);
    const purgeTriggerEvents = vi.fn().mockReturnValue(0);
    const ctx = buildContext({
      taskStore: { purgeCompleted, purgeTriggerEvents },
    });

    const result = await taskRetentionCheck.execute(ctx);
    expect(result.message).toBe("No expired rows");
  });

  it("metadata includes deletedTasks, deletedTriggerEvents, retentionDays", async () => {
    const purgeCompleted = vi.fn().mockReturnValue(8);
    const purgeTriggerEvents = vi.fn().mockReturnValue(3);
    const ctx = buildContext({
      taskStore: { purgeCompleted, purgeTriggerEvents },
      agentConfig: { perf: { taskRetentionDays: 5 } },
    });

    const result = await taskRetentionCheck.execute(ctx);
    expect(result.metadata).toBeDefined();
    const meta = result.metadata as Record<string, unknown>;
    expect(meta.deletedTasks).toBe(8);
    expect(meta.deletedTriggerEvents).toBe(3);
    expect(meta.retentionDays).toBe(5);
  });
});
