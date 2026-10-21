/**
 * Phase 999.15 Plan 00 — Wave 0 RED tests for reconcileAllAgents.
 *
 * FIND-123-A.next T-08 — rewritten to exercise the sink-based PID lookup
 * (`deps.getClaudePid`) that replaced the `/proc`-walk
 * `discoverClaudeSubprocessPid` rediscovery. Behavior contract changes are
 * called out per-test below.
 *
 * Sink-lookup tri-state (see ClaudePidLookup in src/mcp/reconciler.ts):
 *   - `undefined` → session absent → agent-gone (unregister + warn)
 *   - `null`      → session present, sink not yet populated → skip cycle
 *   - `number`    → sink populated → updateAgent + replaceMcpPids
 *
 * Test architecture:
 *   - Mock ../proc-scan.js so isPidAlive + discoverAgentMcpPids return
 *     scripted values per test. discoverClaudeSubprocessPid is NO LONGER
 *     mocked because the reconciler no longer calls it (T-08).
 *   - Fake McpProcessTracker — vi.fn() spies on the EXTENDED API surface
 *     (updateAgent, replaceMcpPids, unregister, getRegisteredAgents).
 *   - getClaudePid fixture — per-test vi.fn returning the tri-state value
 *     for a given agent name.
 *   - Real pino logger pointed at a captured-Writable so log-shape assertions
 *     are byte-precise on the JSON envelope.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Writable } from "node:stream";
import pino from "pino";

// Hoisted mocks for proc-scan helpers. discoverClaudeSubprocessPid is NOT
// mocked here because the reconciler no longer imports it after T-08.
const {
  isPidAliveMock,
  discoverAgentMcpPidsMock,
} = vi.hoisted(() => ({
  isPidAliveMock: vi.fn(),
  discoverAgentMcpPidsMock: vi.fn(),
}));

vi.mock("../proc-scan.js", async () => {
  const actual = await vi.importActual<typeof import("../proc-scan.js")>(
    "../proc-scan.js",
  );
  return {
    ...actual,
    isPidAlive: isPidAliveMock,
    discoverAgentMcpPids: discoverAgentMcpPidsMock,
  };
});

import { reconcileAllAgents } from "../reconciler.js";

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

type AgentEntry = {
  readonly claudePid: number;
  readonly mcpPids: readonly number[];
  readonly registeredAt: number;
};

// vitest 4 narrows `ReturnType<typeof vi.fn>` to a generic
// `Mock<Procedure | Constructable>` that is not directly callable. Pin each
// fake method to its concrete signature so the test body can call them.
interface FakeTracker {
  patterns: RegExp;
  getRegisteredAgents: ReturnType<typeof vi.fn<() => Map<string, AgentEntry>>>;
  updateAgent: ReturnType<typeof vi.fn<(name: string, claudePid: number) => void>>;
  replaceMcpPids: ReturnType<typeof vi.fn<(name: string, pids: readonly number[]) => void>>;
  unregister: ReturnType<typeof vi.fn<(name: string) => readonly number[]>>;
}

function makeTracker(entries: ReadonlyArray<readonly [string, AgentEntry]>): FakeTracker {
  const map = new Map<string, AgentEntry>(entries);
  const tracker: FakeTracker = {
    patterns: /mcp-server/,
    getRegisteredAgents: vi.fn(() => map),
    updateAgent: vi.fn((name: string, claudePid: number) => {
      const prev = map.get(name);
      if (prev) {
        map.set(name, { ...prev, claudePid });
      }
    }),
    replaceMcpPids: vi.fn((name: string, pids: readonly number[]) => {
      const prev = map.get(name);
      if (prev) {
        map.set(name, { ...prev, mcpPids: [...pids] });
      }
    }),
    unregister: vi.fn((name: string) => {
      const prev = map.get(name);
      map.delete(name);
      return prev ? [...prev.mcpPids] : [];
    }),
  };
  return tracker;
}

/**
 * Build a sink-lookup fixture from a `{name → ClaudePidLookup}` map. Default
 * for unknown agents is `undefined` (session-absent) — opt out by adding the
 * agent to the map explicitly.
 */
function makeGetClaudePid(
  table: Record<string, number | null | undefined>,
): (name: string) => number | null | undefined {
  return (name) => (name in table ? table[name] : undefined);
}

function captureLogger(): {
  log: pino.Logger;
  lines: () => Array<Record<string, unknown>>;
} {
  const chunks: string[] = [];
  const sink = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(String(chunk));
      cb();
    },
  });
  const log = pino({ level: "debug" }, sink);
  const lines = () =>
    chunks
      .join("")
      .split("\n")
      .filter((s) => s.length > 0)
      .map((s) => JSON.parse(s) as Record<string, unknown>);
  return { log, lines };
}

const DAEMON_PID = 99_000;

/* ------------------------------------------------------------------ */
/*  Tests                                                              */
/* ------------------------------------------------------------------ */

describe("reconcileAllAgents (FIND-123-A.next T-08 — sink-based)", () => {
  beforeEach(() => {
    isPidAliveMock.mockReset();
    discoverAgentMcpPidsMock.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("Test 1: stale-claude (sink populated) → updateAgent + replaceMcpPids and one warn log", async () => {
    const tracker = makeTracker([
      ["A", { claudePid: 100, mcpPids: [], registeredAt: 1_700_000_000_000 }],
    ]);
    isPidAliveMock.mockReturnValue(false); // claudePid 100 dead
    discoverAgentMcpPidsMock.mockResolvedValue([201, 202]);
    const getClaudePid = vi.fn(makeGetClaudePid({ A: 200 }));

    const { log, lines } = captureLogger();
    await reconcileAllAgents({
      tracker: tracker as unknown as never,
      daemonPid: DAEMON_PID,
      log,
      getClaudePid,
    });

    expect(tracker.updateAgent).toHaveBeenCalledWith("A", 200);
    expect(tracker.replaceMcpPids).toHaveBeenCalledWith("A", [201, 202]);

    // Sink resolver called for the stale agent.
    expect(getClaudePid).toHaveBeenCalledWith("A");

    const warns = lines().filter((l) => l.level === 40);
    expect(warns.length).toBe(1);
    expect(warns[0]!.reason).toBe("stale-claude");
    expect(warns[0]!.agent).toBe("A");
  });

  it("Test 2: missing-mcps → calls replaceMcpPids only (claude alive, mcpPids empty)", async () => {
    const tracker = makeTracker([
      ["A", { claudePid: 100, mcpPids: [], registeredAt: 1_700_000_000_000 }],
    ]);
    isPidAliveMock.mockReturnValue(true); // claudePid still alive
    discoverAgentMcpPidsMock.mockResolvedValue([301, 302, 303]);

    const { log, lines } = captureLogger();
    await reconcileAllAgents({
      tracker: tracker as unknown as never,
      daemonPid: DAEMON_PID,
      log,
      getClaudePid: makeGetClaudePid({ A: 100 }),
    });

    expect(tracker.updateAgent).not.toHaveBeenCalled();
    expect(tracker.replaceMcpPids).toHaveBeenCalledWith("A", [301, 302, 303]);

    const warns = lines().filter((l) => l.level === 40);
    expect(warns.length).toBe(1);
    expect(warns[0]!.reason).toBe("missing-mcps");
  });

  it("Test 3: agent-gone (session absent) → unregister + log, no updateAgent/replaceMcpPids", async () => {
    // Behavior change vs pre-T-08: the agent-gone trigger is now "session
    // absent" (`getClaudePid(name) === undefined`) rather than "/proc walk
    // returned null". This preserves cleanup for stopped agents whose
    // tracker entry survived killAgentGroup (empty-mcpPids short-circuit).
    const tracker = makeTracker([
      ["A", { claudePid: 100, mcpPids: [], registeredAt: 1_700_000_000_000 }],
    ]);
    isPidAliveMock.mockReturnValue(false);

    const { log, lines } = captureLogger();
    await reconcileAllAgents({
      tracker: tracker as unknown as never,
      daemonPid: DAEMON_PID,
      log,
      getClaudePid: makeGetClaudePid({}), // empty table → undefined for "A"
    });

    expect(tracker.unregister).toHaveBeenCalledWith("A");
    expect(tracker.updateAgent).not.toHaveBeenCalled();
    expect(tracker.replaceMcpPids).not.toHaveBeenCalled();

    const warns = lines().filter((l) => l.level === 40);
    expect(warns.length).toBe(1);
    expect(warns[0]!.reason).toBe("agent-gone");
    expect(warns[0]!.msg).toBe("tracker entry dropped — claude proc gone");
  });

  it("Test 3b: sink-pending (session present, getClaudePid → null) → skip cycle", async () => {
    // New test pinning edge case (b) from the T-08 design: sink null means
    // the SDK spawn callback has not yet populated the PID. Reconciler
    // SKIPS — no unregister, no updateAgent, no log. The next reaper tick
    // re-checks once the sink is populated.
    const tracker = makeTracker([
      ["A", { claudePid: 100, mcpPids: [], registeredAt: 1_700_000_000_000 }],
    ]);
    isPidAliveMock.mockReturnValue(false); // old PID dead

    const { log, lines } = captureLogger();
    await reconcileAllAgents({
      tracker: tracker as unknown as never,
      daemonPid: DAEMON_PID,
      log,
      getClaudePid: makeGetClaudePid({ A: null }), // present-but-empty sink
    });

    expect(tracker.unregister).not.toHaveBeenCalled();
    expect(tracker.updateAgent).not.toHaveBeenCalled();
    expect(tracker.replaceMcpPids).not.toHaveBeenCalled();

    const warns = lines().filter((l) => l.level === 40);
    expect(warns.length).toBe(0);
  });

  it("Test 4: idempotent — second cycle with no /proc change emits zero logs and zero mutations", async () => {
    const tracker = makeTracker([
      ["A", { claudePid: 100, mcpPids: [201, 202], registeredAt: 1_700_000_000_000 }],
    ]);
    isPidAliveMock.mockReturnValue(true);
    discoverAgentMcpPidsMock.mockResolvedValue([201, 202]);
    const getClaudePid = makeGetClaudePid({ A: 100 });

    const { log, lines } = captureLogger();
    await reconcileAllAgents({
      tracker: tracker as unknown as never,
      daemonPid: DAEMON_PID,
      log,
      getClaudePid,
    });
    await reconcileAllAgents({
      tracker: tracker as unknown as never,
      daemonPid: DAEMON_PID,
      log,
      getClaudePid,
    });

    expect(tracker.updateAgent).not.toHaveBeenCalled();
    expect(tracker.replaceMcpPids).not.toHaveBeenCalled();
    expect(tracker.unregister).not.toHaveBeenCalled();
    const warns = lines().filter((l) => l.level === 40);
    expect(warns.length).toBe(0);
  });

  it("Test 5: error swallow — failure for one agent doesn't propagate, doesn't block siblings", async () => {
    // Sink lookup is synchronous and doesn't throw, so the failure surface
    // moves to discoverAgentMcpPids (the only remaining async /proc call).
    // Inject a throw there for agent A and verify agent B still reconciles.
    const tracker = makeTracker([
      ["A", { claudePid: 100, mcpPids: [], registeredAt: 1_700_000_000_000 }],
      ["B", { claudePid: 110, mcpPids: [], registeredAt: 1_700_000_000_000 }],
    ]);
    isPidAliveMock.mockReturnValue(true); // both alive — exercises missing-mcps path
    discoverAgentMcpPidsMock.mockImplementation(async (pid: number) => {
      if (pid === 100) {
        throw new Error("simulated /proc failure for A");
      }
      return [311, 312];
    });

    const { log, lines } = captureLogger();
    await expect(
      reconcileAllAgents({
        tracker: tracker as unknown as never,
        daemonPid: DAEMON_PID,
        log,
        getClaudePid: makeGetClaudePid({ A: 100, B: 110 }),
      }),
    ).resolves.toBeUndefined();

    // Agent B should still be reconciled (missing-mcps path).
    expect(tracker.replaceMcpPids).toHaveBeenCalledWith("B", [311, 312]);

    const allLogs = lines();
    const errLikely = allLogs.find(
      (l) =>
        (l.level === 40 || l.level === 50) &&
        typeof l.err === "string" &&
        (l.agent === "A" || String(l.msg).includes("A")),
    );
    expect(errLikely).toBeDefined();
  });

  it("Test 6: one log per agent per cycle — 3 agents reconciled → 3 distinct warn logs", async () => {
    const tracker = makeTracker([
      ["A", { claudePid: 100, mcpPids: [], registeredAt: 1_700_000_000_000 }],
      ["B", { claudePid: 110, mcpPids: [], registeredAt: 1_700_000_000_000 }],
      ["C", { claudePid: 120, mcpPids: [], registeredAt: 1_700_000_000_000 }],
    ]);
    // All three claudePids dead — all three need stale-claude reconcile via
    // sink lookup. Each agent's sink returns a fresh PID.
    isPidAliveMock.mockReturnValue(false);
    discoverAgentMcpPidsMock.mockImplementation(async (pid: number) => [pid + 1]);

    const { log, lines } = captureLogger();
    await reconcileAllAgents({
      tracker: tracker as unknown as never,
      daemonPid: DAEMON_PID,
      log,
      getClaudePid: makeGetClaudePid({ A: 201, B: 202, C: 203 }),
    });

    const warns = lines().filter((l) => l.level === 40 && l.action === "reconcile");
    expect(warns.length).toBe(3);
    const agents = new Set(warns.map((w) => w.agent));
    expect(agents).toEqual(new Set(["A", "B", "C"]));
  });

  it("Test 7: log envelope — exact canonical keys + message string for state-change logs", async () => {
    const tracker = makeTracker([
      ["A", { claudePid: 100, mcpPids: [], registeredAt: 1_700_000_000_000 }],
    ]);
    isPidAliveMock.mockReturnValue(false);
    discoverAgentMcpPidsMock.mockResolvedValue([201, 202]);

    const { log, lines } = captureLogger();
    await reconcileAllAgents({
      tracker: tracker as unknown as never,
      daemonPid: DAEMON_PID,
      log,
      getClaudePid: makeGetClaudePid({ A: 200 }),
    });

    const warns = lines().filter((l) => l.level === 40);
    expect(warns.length).toBe(1);
    const w = warns[0]!;
    expect(w.component).toBe("mcp-tracker");
    expect(w.action).toBe("reconcile");
    expect(w.agent).toBe("A");
    expect(w.oldClaudePid).toBe(100);
    expect(w.newClaudePid).toBe(200);
    expect(w.oldMcpCount).toBe(0);
    expect(w.newMcpCount).toBe(2);
    expect(w.reason).toBe("stale-claude");
    expect(w.msg).toBe("tracker state reconciled");
  });

  it("Test 8: no-op cycle emits zero logs (diff comparison empty)", async () => {
    const tracker = makeTracker([
      ["A", { claudePid: 100, mcpPids: [201, 202], registeredAt: 1_700_000_000_000 }],
    ]);
    isPidAliveMock.mockReturnValue(true);
    // Same set, possibly in a different order — sort-equality applies.
    discoverAgentMcpPidsMock.mockResolvedValue([202, 201]);

    const { log, lines } = captureLogger();
    await reconcileAllAgents({
      tracker: tracker as unknown as never,
      daemonPid: DAEMON_PID,
      log,
      getClaudePid: makeGetClaudePid({ A: 100 }),
    });

    const warns = lines().filter((l) => l.level === 40);
    expect(warns.length).toBe(0);
  });

  // Phase 108 (Pitfall 6) — broker-owned synthetic owners must be skipped.
  it("Test 10 (Phase 108): skips entries whose owner name starts with `__broker:`", async () => {
    const tracker = makeTracker([
      ["fin-client", { claudePid: 100, mcpPids: [201], registeredAt: 1_700_000_000_000 }],
      ["__broker:1password:abc12345", { claudePid: 99_000, mcpPids: [501], registeredAt: 1_700_000_000_000 }],
    ]);
    isPidAliveMock.mockReturnValue(true);
    const getClaudePid = vi.fn(makeGetClaudePid({ "fin-client": 100 }));

    const { log, lines } = captureLogger();
    await reconcileAllAgents({
      tracker: tracker as unknown as never,
      daemonPid: DAEMON_PID,
      log,
      getClaudePid,
    });

    // Synthetic owner remains in the map; no mutation called against it.
    const stillRegistered = tracker.getRegisteredAgents();
    expect(stillRegistered.has("__broker:1password:abc12345")).toBe(true);
    for (const call of tracker.updateAgent.mock.calls) {
      expect((call[0] as string).startsWith("__broker:")).toBe(false);
    }
    for (const call of tracker.replaceMcpPids.mock.calls) {
      expect((call[0] as string).startsWith("__broker:")).toBe(false);
    }
    for (const call of tracker.unregister.mock.calls) {
      expect((call[0] as string).startsWith("__broker:")).toBe(false);
    }
    // No log line should reference the synthetic owner.
    const allLines = lines();
    for (const ln of allLines) {
      if (typeof ln.agent === "string") {
        expect((ln.agent as string).startsWith("__broker:")).toBe(false);
      }
    }
    // Sink resolver MUST NOT be probed for broker entries (early-return
    // before getClaudePid lookup).
    for (const call of getClaudePid.mock.calls) {
      expect((call[0] as string).startsWith("__broker:")).toBe(false);
    }
  });

  it("Test 9: agent-restart — both claudePid and mcpPids change in one cycle", async () => {
    const tracker = makeTracker([
      ["A", { claudePid: 100, mcpPids: [201, 202], registeredAt: 1_700_000_000_000 }],
    ]);
    isPidAliveMock.mockReturnValue(false); // old claudePid dead
    discoverAgentMcpPidsMock.mockResolvedValue([301, 302]); // brand-new mcpPids

    const { log, lines } = captureLogger();
    await reconcileAllAgents({
      tracker: tracker as unknown as never,
      daemonPid: DAEMON_PID,
      log,
      getClaudePid: makeGetClaudePid({ A: 300 }), // new claude from sink
    });

    expect(tracker.updateAgent).toHaveBeenCalledWith("A", 300);
    expect(tracker.replaceMcpPids).toHaveBeenCalledWith("A", [301, 302]);

    const warns = lines().filter((l) => l.level === 40);
    expect(warns.length).toBe(1);
    expect(warns[0]!.reason).toBe("agent-restart");
  });
});
