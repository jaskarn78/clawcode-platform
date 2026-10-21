/**
 * Phase 999.14 Plan 00 — process-tracker.ts unit tests.
 *
 * Covers MCP-01, MCP-02, MCP-04 substrate:
 *   - killGroup uses NEGATIVE pid (POSIX process-group form)
 *   - ESRCH idempotency (already-dead PID = success, no throw)
 *   - EPERM logged + returns false
 *   - pid <= 1 refused (never call process.kill)
 *   - McpProcessTracker register/unregister/list immutability
 *   - killAgentGroup SIGTERM-then-SIGKILL with grace via fake timers
 *   - killAll iterates all agents
 *   - canonical pino warn log shape pinned
 *   - idempotent killAgentGroup (second call no-op)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Writable } from "node:stream";
import pino from "pino";

// Mock proc-scan so killAgentGroup polling can be controlled.
const { readProcInfoMock } = vi.hoisted(() => ({
  readProcInfoMock: vi.fn(),
}));

vi.mock("../proc-scan.js", async () => {
  const actual = await vi.importActual<typeof import("../proc-scan.js")>(
    "../proc-scan.js",
  );
  return {
    ...actual,
    readProcInfo: readProcInfoMock,
  };
});

import { McpProcessTracker, killGroup } from "../process-tracker.js";

function captureLogger(): { log: pino.Logger; lines: () => Array<Record<string, unknown>> } {
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

function silentLogger(): pino.Logger {
  const sink = new Writable({
    write(_chunk, _enc, cb) {
      cb();
    },
  });
  return pino({ level: "silent" }, sink);
}

describe("killGroup", () => {
  let killSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("Test 1: refuses pid <= 1, returns false, never calls process.kill", () => {
    const { log, lines } = captureLogger();
    expect(killGroup(1, "SIGTERM", log)).toBe(false);
    expect(killGroup(0, "SIGTERM", log)).toBe(false);
    expect(killGroup(-5, "SIGTERM", log)).toBe(false);
    expect(killSpy).not.toHaveBeenCalled();
    const errs = lines().filter((l) => l.level === 50);
    expect(errs.length).toBeGreaterThanOrEqual(3);
  });

  it("Test 2: ESRCH returns true (idempotent success), no rethrow", () => {
    killSpy.mockImplementation(() => {
      const e = new Error("no such process") as NodeJS.ErrnoException;
      e.code = "ESRCH";
      throw e;
    });
    const result = killGroup(12345, "SIGTERM", silentLogger());
    expect(result).toBe(true);
  });

  it("Test 3: EPERM returns false + warn log emitted", () => {
    killSpy.mockImplementation(() => {
      const e = new Error("permission denied") as NodeJS.ErrnoException;
      e.code = "EPERM";
      throw e;
    });
    const { log, lines } = captureLogger();
    expect(killGroup(12345, "SIGTERM", log)).toBe(false);
    const warns = lines().filter((l) => l.level === 40);
    expect(warns.length).toBeGreaterThanOrEqual(1);
  });

  it("Test 4: happy path calls process.kill with NEGATIVE pid", () => {
    killGroup(12345, "SIGTERM", silentLogger());
    expect(killSpy).toHaveBeenCalledWith(-12345, "SIGTERM");
  });
});

describe("McpProcessTracker", () => {
  beforeEach(() => {
    readProcInfoMock.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function makeTracker(log = silentLogger()): McpProcessTracker {
    return new McpProcessTracker({
      uid: 1000,
      log,
      clockTicksPerSec: 100,
      bootTimeUnix: 1_700_000_000,
    });
  }

  it("Test 5: register/unregister/list/listForAgent — returns are immutable", async () => {
    // readProcInfo returns a stable cmdline for register-time capture
    readProcInfoMock.mockResolvedValue({
      pid: 100,
      ppid: 999,
      uid: 1000,
      cmdline: ["sh", "-c", "mcp-server-mysql"],
      startTimeJiffies: 50000,
    });

    const t = makeTracker();
    // Phase 999.15 — 3-arg register(name, claudePid, mcpPids)
    await t.register("agent-a", 999, [100, 101]);
    await t.register("agent-b", 999, [200]);

    expect([...t.list()].sort()).toEqual([100, 101, 200]);
    expect([...t.listForAgent("agent-a")].sort()).toEqual([100, 101]);
    expect(t.listForAgent("unknown")).toEqual([]);

    // Mutating returned array does not affect tracker (it's a fresh copy)
    const listed = [...t.listForAgent("agent-a")];
    listed.push(9999);
    expect([...t.listForAgent("agent-a")].sort()).toEqual([100, 101]);

    const evicted = t.unregister("agent-a");
    expect([...evicted].sort()).toEqual([100, 101]);
    expect(t.list()).toEqual([200]);
  });

  it("Test 6: killAgentGroup SIGTERM-then-SIGKILL with grace", async () => {
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

    // Register-time readProcInfo returns valid info for cmdline capture.
    // Then during polling, return non-null (still alive) until forced.
    readProcInfoMock.mockResolvedValue({
      pid: 500,
      ppid: 999,
      uid: 1000,
      cmdline: ["sh", "-c", "mcp-server-mysql"],
      startTimeJiffies: 50000,
    });

    const t = makeTracker();
    await t.register("agent-x", 999, [500]);

    // Drive killAgentGroup with a short grace; readProcInfo always returns
    // alive, so SIGKILL must fire after the grace period.
    await t.killAgentGroup("agent-x", 100);

    // SIGTERM via NEGATIVE pid (process group)
    expect(killSpy).toHaveBeenCalledWith(-500, "SIGTERM");
    // SIGKILL via POSITIVE pid (individual proc — group leader may be dead)
    expect(killSpy).toHaveBeenCalledWith(500, "SIGKILL");
  });

  it("Test 7: killAll iterates all agents — one SIGTERM per unique pid", async () => {
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

    readProcInfoMock.mockResolvedValue({
      pid: 0,
      ppid: 999,
      uid: 1000,
      cmdline: ["sh", "-c", "mcp"],
      startTimeJiffies: 50000,
    });

    const t = makeTracker();
    await t.register("agent-a", 999, [100, 200]);
    await t.register("agent-b", 999, [200, 300]); // 200 overlaps

    // After register, immediately make readProcInfo return null so SIGKILL is skipped
    readProcInfoMock.mockResolvedValue(null);

    await t.killAll(50);

    const sigtermCalls = killSpy.mock.calls.filter((c) => c[1] === "SIGTERM");
    const sigtermPids = sigtermCalls.map((c) => Math.abs(Number(c[0]))).sort();
    // Each unique pid SIGTERM'd exactly once
    expect(sigtermPids).toEqual([100, 200, 300]);
    // All sent via NEGATIVE pid (process-group form)
    for (const c of sigtermCalls) {
      expect(Number(c[0])).toBeLessThan(0);
    }
  });

  it("Test 8: canonical log shape — component=mcp-tracker, action=sigterm, reason=agent-disconnect", async () => {
    vi.spyOn(process, "kill").mockImplementation(() => true);

    readProcInfoMock.mockResolvedValueOnce({
      pid: 700,
      ppid: 999,
      uid: 1000,
      cmdline: ["sh", "-c", "mcp-server-mysql"],
      startTimeJiffies: 50000,
    });

    const { log, lines } = captureLogger();
    const t = new McpProcessTracker({
      uid: 1000,
      log,
      clockTicksPerSec: 100,
      bootTimeUnix: 1_700_000_000,
    });
    await t.register("agent-y", 999, [700]);

    // Subsequent readProcInfo returns null (proc dies cleanly after SIGTERM)
    readProcInfoMock.mockResolvedValue(null);

    await t.killAgentGroup("agent-y", 50);

    const allLogs = lines();
    const sigterm = allLogs.find(
      (l) =>
        l.component === "mcp-tracker" &&
        l.action === "sigterm" &&
        l.pid === 700,
    );
    expect(sigterm).toBeDefined();
    expect(sigterm!.reason).toBe("agent-disconnect");
    expect(typeof sigterm!.cmdline).toBe("string");
    expect(sigterm!.cmdline).toContain("mcp-server-mysql");
  });

  it("Test 9: idempotent killAgentGroup — second call is a no-op", async () => {
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    readProcInfoMock.mockResolvedValue({
      pid: 800,
      ppid: 999,
      uid: 1000,
      cmdline: ["foo"],
      startTimeJiffies: 50000,
    });

    const t = makeTracker();
    await t.register("agent-z", 999, [800]);

    // Make readProcInfo null after first SIGTERM so SIGKILL is skipped
    readProcInfoMock.mockResolvedValue(null);

    await t.killAgentGroup("agent-z", 50);
    const callsAfterFirst = killSpy.mock.calls.length;

    // Second call — agent already evicted, must not throw or kill anything
    await expect(t.killAgentGroup("agent-z", 50)).resolves.not.toThrow();
    expect(killSpy.mock.calls.length).toBe(callsAfterFirst);
  });
});

/* =========================================================================
 *  Phase 999.15 extensions — RED tests for TRACK-03 + TRACK-06.
 *
 *  All cases below FAIL at Wave 0 because the extended McpProcessTracker API
 *  ships in Plan 01 (updateAgent, replaceMcpPids, getRegisteredAgents,
 *  pruneDeadPids, 3-arg register) and the reconcile-before-kill safety net
 *  in killAgentGroup ships in Plan 02 (TRACK-06).
 *
 *  No 999.14 cases above are modified — strict append.
 * =======================================================================*/

describe("Phase 999.15 extensions", () => {
  beforeEach(() => {
    readProcInfoMock.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function makeTrackerExt(log = silentLogger()): McpProcessTracker {
    return new McpProcessTracker({
      uid: 1000,
      log,
      clockTicksPerSec: 100,
      bootTimeUnix: 1_700_000_000,
    });
  }

  it("PT-1: register(name, claudePid, mcpPids) stores all three; getRegisteredAgents().get(name) reflects them", async () => {
    readProcInfoMock.mockResolvedValue({
      pid: 0,
      ppid: 999,
      uid: 1000,
      cmdline: ["mcp"],
      startTimeJiffies: 50000,
    });

    const t = makeTrackerExt();
    // 3-arg register (Plan 01 signature change). At Wave 0 the runtime
    // ignores the extra positional arg or fails on the missing
    // getRegisteredAgents export — either way the test is RED.
    await t.register("agent-a", 4_000, [101, 102, 103]);

    const map = t.getRegisteredAgents() as ReadonlyMap<string, {
      claudePid: number;
      mcpPids: readonly number[];
      registeredAt: number;
    }>;
    const entry = map.get("agent-a");
    expect(entry).toBeDefined();
    expect(entry!.claudePid).toBe(4_000);
    expect([...entry!.mcpPids].sort()).toEqual([101, 102, 103]);
    expect(typeof entry!.registeredAt).toBe("number");
    expect(Number.isFinite(entry!.registeredAt)).toBe(true);
  });

  it("PT-2: register pins claudePid for the agent (runtime regression for the new signature)", async () => {
    readProcInfoMock.mockResolvedValue({
      pid: 0,
      ppid: 999,
      uid: 1000,
      cmdline: ["mcp"],
      startTimeJiffies: 50000,
    });

    const t = makeTrackerExt();
    await t.register("agent-b", 5_500, [201]);

    const map = t.getRegisteredAgents() as ReadonlyMap<string, {
      claudePid: number;
      mcpPids: readonly number[];
      registeredAt: number;
    }>;
    expect(map.get("agent-b")?.claudePid).toBe(5_500);
  });

  it("PT-3: updateAgent replaces tracked claudePid via NEW object reference (immutable mutations)", async () => {
    readProcInfoMock.mockResolvedValue({
      pid: 0,
      ppid: 999,
      uid: 1000,
      cmdline: ["mcp"],
      startTimeJiffies: 50000,
    });

    const t = makeTrackerExt();
    await t.register("A", 100, []);

    const r1 = (t.getRegisteredAgents() as ReadonlyMap<string, {
      claudePid: number; mcpPids: readonly number[]; registeredAt: number;
    }>).get("A")!;

    t.updateAgent("A", 200);

    const r2 = (t.getRegisteredAgents() as ReadonlyMap<string, {
      claudePid: number; mcpPids: readonly number[]; registeredAt: number;
    }>).get("A")!;

    expect(r1).not.toBe(r2); // new object reference
    expect(r2.claudePid).toBe(200);
    expect(r1.claudePid).toBe(100); // old reference unchanged (immutable mutations)
  });

  it("PT-4: replaceMcpPids replaces full mcp set immutably; old reference unchanged", async () => {
    readProcInfoMock.mockResolvedValue({
      pid: 0,
      ppid: 999,
      uid: 1000,
      cmdline: ["mcp"],
      startTimeJiffies: 50000,
    });

    const t = makeTrackerExt();
    await t.register("A", 100, [201, 202]);

    const r1 = (t.getRegisteredAgents() as ReadonlyMap<string, {
      claudePid: number; mcpPids: readonly number[]; registeredAt: number;
    }>).get("A")!;
    const r1MpidsSnapshot = [...r1.mcpPids].sort();

    t.replaceMcpPids("A", [301, 302, 303]);

    const r2 = (t.getRegisteredAgents() as ReadonlyMap<string, {
      claudePid: number; mcpPids: readonly number[]; registeredAt: number;
    }>).get("A")!;

    expect(r1).not.toBe(r2);
    expect([...r2.mcpPids].sort()).toEqual([301, 302, 303]);
    // r1 reference remains the original — its mcpPids must not have shifted.
    expect([...r1.mcpPids].sort()).toEqual(r1MpidsSnapshot);
  });

  it("PT-5: getRegisteredAgents returns a Map-shaped ReadonlyMap (size/get/has/entries available)", async () => {
    readProcInfoMock.mockResolvedValue({
      pid: 0,
      ppid: 999,
      uid: 1000,
      cmdline: ["mcp"],
      startTimeJiffies: 50000,
    });

    const t = makeTrackerExt();
    await t.register("A", 100, [201]);
    await t.register("B", 110, [211]);

    const map = t.getRegisteredAgents() as ReadonlyMap<string, unknown>;

    expect(typeof map.get).toBe("function");
    expect(typeof map.has).toBe("function");
    expect(typeof map.entries).toBe("function");
    expect(map.size).toBe(2);
    expect(map.has("A")).toBe(true);
    expect(map.has("B")).toBe(true);
    expect(map.has("ghost")).toBe(false);
  });

  it("PT-6: pruneDeadPids removes dead PIDs and returns alive set", async () => {
    // register-time enrichment reads cmdline for each pid
    readProcInfoMock.mockResolvedValue({
      pid: 0,
      ppid: 999,
      uid: 1000,
      cmdline: ["mcp"],
      startTimeJiffies: 50000,
    });

    const t = makeTrackerExt();
    await t.register("A", 100, [101, 102, 103]);

    // Drive isPidAlive's behavior at the syscall layer — process.kill(pid, 0):
    //   - throws ESRCH  → isPidAlive returns false (pid 102 = dead)
    //   - returns true  → isPidAlive returns true  (pids 101, 103 = alive)
    // This is more reliable than spying on the proc-scan module export
    // because ES module live-bindings + vi.mock interactions are brittle.
    vi.spyOn(process, "kill").mockImplementation((pid: number) => {
      if (pid === 102) {
        const e = new Error("no such process") as NodeJS.ErrnoException;
        e.code = "ESRCH";
        throw e;
      }
      return true;
    });

    const result = await t.pruneDeadPids("A");
    expect([...result.pruned].sort()).toEqual([102]);
    expect([...result.alive].sort()).toEqual([101, 103]);

    // Tracker state should reflect the pruning.
    const entry = (t.getRegisteredAgents() as ReadonlyMap<string, {
      mcpPids: readonly number[];
    }>).get("A")!;
    expect([...entry.mcpPids].sort()).toEqual([101, 103]);
  });

  it("PT-7: killAgentGroup reconciles BEFORE kill (TRACK-06) — kills the reconciled set, not the stale one", async () => {
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

    // Register-time read so cmdlines are captured.
    readProcInfoMock.mockResolvedValue({
      pid: 0,
      ppid: 999,
      uid: 1000,
      cmdline: ["mcp"],
      startTimeJiffies: 50000,
    });

    const reconcileFn = vi.fn(async (name: string) => {
      // Simulate reconcile updating the tracker to fresh PIDs.
      t.replaceMcpPids(name, [200, 201]);
    });

    const t = new McpProcessTracker({
      uid: 1000,
      log: silentLogger(),
      clockTicksPerSec: 100,
      bootTimeUnix: 1_700_000_000,
      reconcileAgent: reconcileFn,
    });

    await t.register("agent-x", 100, [100, 101]);

    // After register, make readProcInfo null so SIGKILL is skipped.
    readProcInfoMock.mockResolvedValue(null);

    await t.killAgentGroup("agent-x", 50);

    // reconcileFn called BEFORE any kill (call-order assertion)
    expect(reconcileFn).toHaveBeenCalled();
    const reconcileCallOrder = reconcileFn.mock.invocationCallOrder[0]!;
    const firstKillCallOrder = killSpy.mock.invocationCallOrder[0];
    expect(firstKillCallOrder).toBeDefined();
    expect(reconcileCallOrder).toBeLessThan(firstKillCallOrder!);

    // SIGTERMs should target the RECONCILED set [200, 201], NOT [100, 101].
    const sigtermCalls = killSpy.mock.calls.filter((c) => c[1] === "SIGTERM");
    const sigtermPids = sigtermCalls.map((c) => Math.abs(Number(c[0]))).sort();
    expect(sigtermPids).toEqual([200, 201]);
    // None of the stale recorded PIDs should have been signaled.
    for (const pid of [100, 101]) {
      const hit = sigtermCalls.some((c) => Math.abs(Number(c[0])) === pid);
      expect(hit).toBe(false);
    }
  });

  it("PT-8: killAgentGroup falls back to recorded PIDs when reconcileFn throws (safety net)", async () => {
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

    readProcInfoMock.mockResolvedValue({
      pid: 0,
      ppid: 999,
      uid: 1000,
      cmdline: ["mcp"],
      startTimeJiffies: 50000,
    });

    const reconcileFn = vi.fn(async () => {
      throw new Error("simulated /proc walk failure");
    });

    const { log, lines } = captureLogger();
    const t = new McpProcessTracker({
      uid: 1000,
      log,
      clockTicksPerSec: 100,
      bootTimeUnix: 1_700_000_000,
      reconcileAgent: reconcileFn,
    });

    await t.register("agent-x", 100, [100, 101]);

    readProcInfoMock.mockResolvedValue(null);

    // Must NOT reject — fallback path takes over.
    await expect(t.killAgentGroup("agent-x", 50)).resolves.not.toThrow();

    // SIGTERM the recorded PIDs as fallback.
    const sigtermCalls = killSpy.mock.calls.filter((c) => c[1] === "SIGTERM");
    const sigtermPids = sigtermCalls.map((c) => Math.abs(Number(c[0]))).sort();
    expect(sigtermPids).toEqual([100, 101]);

    // A warn log should mention the err string.
    const warns = lines().filter((l) => l.level === 40);
    const reconcileWarn = warns.find((l) => typeof l.err === "string");
    expect(reconcileWarn).toBeDefined();
  });
});
