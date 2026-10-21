import { describe, it, expect, vi } from "vitest";
import type { CheckContext } from "../../types.js";

import consolidationCheck, { _resetLock } from "../consolidation.js";

/** Build a minimal mock CheckContext. */
function buildContext(): CheckContext {
  const sessionManager: CheckContext["sessionManager"] = {
    getMemoryStore: vi.fn().mockReturnValue({}),
    getEmbedder: vi.fn().mockReturnValue({}),
    getAgentConfig: vi.fn().mockReturnValue({
      workspace: "/tmp/test-workspace",
      memory: {
        consolidation: {
          enabled: true,
          weeklyThreshold: 7,
          monthlyThreshold: 4,
          schedule: "0 3 * * *",
        },
      },
    }),
    dispatchTurn: vi.fn().mockResolvedValue("summarized content"),
    getRunningAgents: vi.fn().mockReturnValue(["test-agent"]),
    getContextFillProvider: vi.fn(),
    getSessionLogger: vi.fn(),
    getCompactionManager: vi.fn(),
    warmupEmbeddings: vi.fn(),
    startAgent: vi.fn(),
    streamFromAgent: vi.fn(),
    forwardToAgent: vi.fn(),
    forkSession: vi.fn(),
    stopAgent: vi.fn(),
    restartAgent: vi.fn(),
    startAll: vi.fn(),
    stopAll: vi.fn(),
    reconcileRegistry: vi.fn(),
    getTierManager: vi.fn(),
    getUsageTracker: vi.fn(),
    saveContextSummary: vi.fn(),
    setSkillsCatalog: vi.fn(),
    setAllAgentConfigs: vi.fn(),
  } as unknown as CheckContext["sessionManager"];

  return {
    agentName: "test-agent",
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

describe("consolidation heartbeat check (deprecated)", () => {
  it("has correct name, interval, and timeout", () => {
    expect(consolidationCheck.name).toBe("consolidation");
    expect(consolidationCheck.interval).toBe(86400);
    expect(consolidationCheck.timeout).toBe(120);
  });

  it("returns healthy with deprecated flag (consolidation moved to scheduler)", async () => {
    const context = buildContext();
    const result = await consolidationCheck.execute(context);
    expect(result.status).toBe("healthy");
    expect(result.message).toContain("moved to TaskScheduler");
    expect(result.metadata).toMatchObject({ deprecated: true });
  });

  it("_resetLock is a no-op for backward compatibility", () => {
    expect(() => _resetLock()).not.toThrow();
  });
});
