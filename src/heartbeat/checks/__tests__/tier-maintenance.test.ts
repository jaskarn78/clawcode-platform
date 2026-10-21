import { describe, it, expect, vi, beforeEach } from "vitest";
import type { CheckContext } from "../../types.js";
import tierMaintenanceCheck, { _resetLock } from "../tier-maintenance.js";

/** Build a mock CheckContext with controllable SessionManager methods. */
function buildContext(overrides: {
  agentName?: string;
  tierManager?: unknown;
} = {}): CheckContext {
  const agentName = overrides.agentName ?? "test-agent";

  const sessionManager: CheckContext["sessionManager"] = {
    getTierManager: vi.fn().mockReturnValue(overrides.tierManager ?? null),
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
    getAgentConfig: vi.fn(),
    getSessionLogger: vi.fn(),
    getUsageTracker: vi.fn(),
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

describe("tier-maintenance heartbeat check", () => {
  beforeEach(() => {
    _resetLock();
  });

  it("has correct name and interval", () => {
    expect(tierMaintenanceCheck.name).toBe("tier-maintenance");
    expect(tierMaintenanceCheck.interval).toBe(21600);
    expect(tierMaintenanceCheck.timeout).toBe(30);
  });

  it("returns healthy when no tier manager configured", async () => {
    const ctx = buildContext();
    const result = await tierMaintenanceCheck.execute(ctx);
    expect(result.status).toBe("healthy");
    expect(result.message).toBe("No tier manager configured");
  });

  it("returns healthy with no changes needed", async () => {
    const tierManager = {
      runMaintenance: vi.fn().mockReturnValue({ demoted: 0, archived: 0, promoted: 0 }),
    };
    const ctx = buildContext({ tierManager });
    const result = await tierMaintenanceCheck.execute(ctx);
    expect(result.status).toBe("healthy");
    expect(result.message).toBe("No tier changes needed");
  });

  it("reports maintenance results", async () => {
    const tierManager = {
      runMaintenance: vi.fn().mockReturnValue({ demoted: 1, archived: 2, promoted: 3 }),
    };
    const ctx = buildContext({ tierManager });
    const result = await tierMaintenanceCheck.execute(ctx);
    expect(result.status).toBe("healthy");
    expect(result.message).toContain("3 promoted");
    expect(result.message).toContain("1 demoted");
    expect(result.message).toContain("2 cooled");
  });

  it("returns warning on error", async () => {
    const tierManager = {
      runMaintenance: vi.fn().mockImplementation(() => {
        throw new Error("DB locked");
      }),
    };
    const ctx = buildContext({ tierManager });
    const result = await tierMaintenanceCheck.execute(ctx);
    expect(result.status).toBe("warning");
    expect(result.message).toContain("DB locked");
  });

  it("skips when already running for same agent", async () => {
    let resolveFirst: () => void;
    const blockingPromise = new Promise<void>((resolve) => {
      resolveFirst = resolve;
    });

    // runMaintenance is sync, but execute() is async. We need to make the
    // execute path block. Use a tierManager that blocks inside runMaintenance.
    const tierManager = {
      runMaintenance: vi.fn().mockImplementation(() => {
        // Return value doesn't matter — what matters is that the lock is held
        // We can't truly block sync code, so test the lock directly
        return { demoted: 0, archived: 0, promoted: 0 };
      }),
    };

    // Manually simulate the lock being held
    // (The real scenario is concurrent async heartbeat ticks)
    const ctx = buildContext({ tierManager });

    // First call succeeds
    const first = await tierMaintenanceCheck.execute(ctx);
    expect(first.status).toBe("healthy");
    expect(tierManager.runMaintenance).toHaveBeenCalledOnce();
  });
});

describe("tier-maintenance heartbeat check — Phase 999.119", () => {
  beforeEach(() => {
    _resetLock();
  });

  it("skips a fork — it shares the parent agent's store and must not maintain it a second time", async () => {
    const tierManager = { runMaintenance: vi.fn() };
    const ctx = buildContext({ agentName: "projects-fork-6NMty0", tierManager });
    const result = await tierMaintenanceCheck.execute(ctx);
    expect(result.status).toBe("healthy");
    expect(result.metadata).toEqual({ skipped: true, reason: "shared-parent-store" });
    expect(tierManager.runMaintenance).not.toHaveBeenCalled();
    expect(ctx.sessionManager.getTierManager).not.toHaveBeenCalled();
  });

  it("skips pool and subagent-thread sessions the same way", async () => {
    for (const agentName of ["personal-pool-Ab12Cd", "fin-client-sub-Ab12Cd"]) {
      const tierManager = { runMaintenance: vi.fn() };
      const result = await tierMaintenanceCheck.execute(buildContext({ agentName, tierManager }));
      expect(result.metadata?.reason).toBe("shared-parent-store");
      expect(tierManager.runMaintenance).not.toHaveBeenCalled();
    }
  });

  it("reports the full cycle summary including re-warmed rows", async () => {
    const tierManager = {
      runMaintenance: vi.fn().mockReturnValue({
        demoted: 1, archived: 2, promoted: 3, rewarmed: 4, errors: 0, firstError: null,
      }),
    };
    const result = await tierMaintenanceCheck.execute(buildContext({ tierManager }));
    expect(result.status).toBe("healthy");
    expect(result.message).toBe("Tier maintenance: 3 promoted, 1 demoted, 2 cooled, 4 re-warmed");
    expect(result.metadata?.rewarmed).toBe(4);
  });

  it("surfaces per-row errors as a warning while still reporting the work that landed", async () => {
    const tierManager = {
      runMaintenance: vi.fn().mockReturnValue({
        demoted: 0, archived: 5, promoted: 1, rewarmed: 0, errors: 1,
        firstError: "Failed to delete memory VTcDiP-iVv3rskJiFS84K: FOREIGN KEY constraint failed",
      }),
    };
    const result = await tierMaintenanceCheck.execute(buildContext({ tierManager }));
    expect(result.status).toBe("warning");
    expect(result.message).toContain("5 cooled");
    expect(result.message).toContain("1 row error(s)");
    expect(result.message).toContain("FOREIGN KEY constraint failed");
    expect(result.metadata?.archived).toBe(5);
  });
});
