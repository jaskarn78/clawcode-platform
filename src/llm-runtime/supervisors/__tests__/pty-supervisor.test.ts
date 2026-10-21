import { describe, it, expect, beforeEach, vi } from "vitest";

import {
  PtySupervisor,
  type PtyHandle,
  type PtySpawnFn,
  type PtySupervisorDeps,
} from "../pty-supervisor.js";

/**
 * Phase 140 Plan 02 Task 1 — PtySupervisor unit suite.
 *
 * Proves the supervision state machine (spawn → register → backoff-restart →
 * circuit-break → stop) with a FAKE pty (no real `claude` binary, no real TTY)
 * and a FAKE McpProcessTracker, driven through injected `now()` / `scheduleFn`
 * seams (CodexAgentCli DI discipline — NOT vi.useFakeTimers, per plan
 * <action>).
 *
 * Covers the acceptance criteria:
 *   - fake exit → restart scheduled at 1000ms, then 2000ms, then 4000ms
 *     (backoff doubling), capped at 60000ms
 *   - 11 exits within the mocked hour → 11th does NOT schedule a restart AND
 *     getState() === "circuit-open" AND an alert-level log line was emitted
 *   - register called with (agent, <pid>, []) on spawn
 *   - the argv passed to spawnPty has argv0 matching /(?:^|\/)claude$/
 *     (orphan-claude-reaper coverage)
 *   - resume (Rule 2, 140-01 operator decision): a restart appends
 *     `--resume <id>` when getResumeSessionId() returns one
 */

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

/** A fake pty handle whose exit can be driven manually by the test. */
class FakePty implements PtyHandle {
  readonly pid: number;
  killed: string | null = null;
  private exitCb: ((e: { exitCode: number; signal?: number }) => void) | null =
    null;

  constructor(pid: number) {
    this.pid = pid;
  }

  onExit(listener: (e: { exitCode: number; signal?: number }) => void): {
    dispose(): void;
  } {
    this.exitCb = listener;
    return { dispose: () => { this.exitCb = null; } };
  }

  kill(signal?: string): void {
    this.killed = signal ?? "SIGHUP";
  }

  /** Test driver — simulate the child process exiting. */
  fireExit(exitCode = 1): void {
    this.exitCb?.({ exitCode });
  }
}

interface SpawnRecord {
  readonly file: string;
  readonly args: readonly string[];
  readonly pty: FakePty;
}

/** Build a fake spawnPty that records every invocation + returns a FakePty. */
function makeFakeSpawn(): { fn: PtySpawnFn; spawns: SpawnRecord[] } {
  const spawns: SpawnRecord[] = [];
  let nextPid = 1000;
  const fn: PtySpawnFn = (file, args) => {
    const pty = new FakePty(++nextPid);
    spawns.push({ file, args: [...args], pty });
    return pty;
  };
  return { fn, spawns };
}

/** Minimal McpProcessTracker stub recording register() / killAgentGroup(). */
function makeFakeTracker() {
  const registerCalls: Array<{ agent: string; pid: number; mcpPids: readonly number[] }> = [];
  const killCalls: string[] = [];
  const tracker = {
    register: vi.fn(
      async (agent: string, pid: number, mcpPids: readonly number[]) => {
        registerCalls.push({ agent, pid, mcpPids });
      },
    ),
    killAgentGroup: vi.fn(async (agent: string) => {
      killCalls.push(agent);
    }),
  } as unknown as PtySupervisorDeps["tracker"];
  return { tracker, registerCalls, killCalls };
}

/**
 * Controllable scheduler seam. Records each scheduled delay and lets the test
 * fire the pending timer manually (deterministic — no real timers).
 */
function makeFakeScheduler() {
  const scheduled: Array<{ ms: number; cb: () => void; fired: boolean }> = [];
  const scheduleFn = (cb: () => void, ms: number): { cancel(): void } => {
    const entry = { ms, cb, fired: false };
    scheduled.push(entry);
    return {
      cancel() {
        entry.fired = true; // mark consumed so fireLast() won't run it
      },
    };
  };
  const fireLast = (): void => {
    const entry = scheduled[scheduled.length - 1];
    if (entry && !entry.fired) {
      entry.fired = true;
      entry.cb();
    }
  };
  return { scheduleFn, scheduled, fireLast };
}

function makeFakeLog() {
  const lines: Array<{ level: string; obj: unknown; msg?: string }> = [];
  const log = {
    info: (obj: unknown, msg?: string) => lines.push({ level: "info", obj, msg }),
    warn: (obj: unknown, msg?: string) => lines.push({ level: "warn", obj, msg }),
    error: (obj: unknown, msg?: string) => lines.push({ level: "error", obj, msg }),
  };
  return { log, lines };
}

interface Harness {
  supervisor: PtySupervisor;
  spawns: SpawnRecord[];
  registerCalls: Array<{ agent: string; pid: number; mcpPids: readonly number[] }>;
  killCalls: string[];
  scheduled: Array<{ ms: number; cb: () => void; fired: boolean }>;
  fireLast: () => void;
  lines: Array<{ level: string; obj: unknown; msg?: string }>;
  setNow: (ms: number) => void;
}

function makeHarness(opts?: {
  argv?: readonly string[];
  getResumeSessionId?: () => string | null;
}): Harness {
  const { fn: spawnPty, spawns } = makeFakeSpawn();
  const { tracker, registerCalls, killCalls } = makeFakeTracker();
  const { scheduleFn, scheduled, fireLast } = makeFakeScheduler();
  const { log, lines } = makeFakeLog();
  let nowMs = 0;
  const setNow = (ms: number) => { nowMs = ms; };

  const deps: PtySupervisorDeps = {
    agent: "test-agent",
    argv: opts?.argv ?? [
      "claude",
      "--dangerously-load-development-channels",
      "server:clawcode-channel",
      "plugin:discord@claude-plugins-official",
      "--mcp-config",
      "/tmp/mcp.json",
    ],
    cwd: "/home/agent/ws",
    env: { PATH: "/usr/bin" },
    spawnPty,
    tracker,
    log,
    now: () => nowMs,
    scheduleRestart: scheduleFn,
    getResumeSessionId: opts?.getResumeSessionId,
  };

  return {
    supervisor: new PtySupervisor(deps),
    spawns,
    registerCalls,
    killCalls,
    scheduled,
    fireLast,
    lines,
    setNow,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("PtySupervisor", () => {
  let h: Harness;

  beforeEach(() => {
    h = makeHarness();
  });

  it("spawn() launches claude, registers the PID via tracker.register(agent, pid, []), and reports running", async () => {
    await h.supervisor.spawn();

    expect(h.spawns).toHaveLength(1);
    expect(h.registerCalls).toHaveLength(1);
    expect(h.registerCalls[0]!.agent).toBe("test-agent");
    expect(h.registerCalls[0]!.pid).toBe(h.spawns[0]!.pty.pid);
    expect(h.registerCalls[0]!.mcpPids).toEqual([]);
    expect(h.supervisor.getState()).toBe("running");
  });

  it("the argv passed to spawnPty has argv0 matching /(?:^|\\/)claude$/ (orphan-reaper coverage)", async () => {
    await h.supervisor.spawn();
    const argv0 = h.spawns[0]!.args[0]!;
    expect(argv0).toMatch(/(?:^|\/)claude$/);
  });

  it("a leading absolute claude path also matches the orphan-reaper regex", async () => {
    const hh = makeHarness({ argv: ["/usr/local/bin/claude", "--channels"] });
    await hh.supervisor.spawn();
    expect(hh.spawns[0]!.args[0]!).toMatch(/(?:^|\/)claude$/);
  });

  it("on child exit, restart is scheduled with exponential backoff 1000ms → 2000ms → 4000ms", async () => {
    await h.supervisor.spawn();

    // 1st exit → 1000ms
    h.spawns[0]!.pty.fireExit();
    expect(h.scheduled.at(-1)!.ms).toBe(1000);
    h.fireLast();
    await Promise.resolve();

    // 2nd exit → 2000ms
    h.spawns[1]!.pty.fireExit();
    expect(h.scheduled.at(-1)!.ms).toBe(2000);
    h.fireLast();
    await Promise.resolve();

    // 3rd exit → 4000ms
    h.spawns[2]!.pty.fireExit();
    expect(h.scheduled.at(-1)!.ms).toBe(4000);
  });

  it("backoff is capped at 60000ms", async () => {
    await h.supervisor.spawn();
    // Drive many exits; advance the clock a bit each time to avoid tripping
    // the breaker (stay under 10/hour by spreading exits across > 1hr).
    let t = 0;
    for (let i = 0; i < 9; i++) {
      t += 10 * 60 * 1000; // +10 min per exit → 9 exits span 90 min (>1hr window)
      h.setNow(t);
      h.spawns.at(-1)!.pty.fireExit();
      const last = h.scheduled.at(-1)!;
      expect(last.ms).toBeLessThanOrEqual(60000);
      h.fireLast();
      await Promise.resolve();
    }
    // The latest scheduled backoff must be exactly the 60s cap by now.
    expect(h.scheduled.at(-1)!.ms).toBe(60000);
  });

  it("11 exits within the mocked hour trip the circuit breaker: 11th does NOT reschedule, getState()==='circuit-open', alert logged", async () => {
    await h.supervisor.spawn();

    // 10 exits within the same hour → 10 restarts scheduled + fired.
    for (let i = 0; i < 10; i++) {
      h.setNow(i * 1000); // all within the rolling hour
      h.spawns.at(-1)!.pty.fireExit();
      // a restart was scheduled for each of the first 10
      h.fireLast();
      await Promise.resolve();
    }
    const scheduledAfterTen = h.scheduled.length;

    // 11th exit (still in the hour) → breaker trips.
    h.setNow(10 * 1000);
    h.spawns.at(-1)!.pty.fireExit();
    await Promise.resolve();

    // No NEW restart scheduled for the 11th exit.
    expect(h.scheduled.length).toBe(scheduledAfterTen);
    expect(h.supervisor.getState()).toBe("circuit-open");

    // An alert-level (warn or error) operator log line was emitted.
    const alert = h.lines.find(
      (l) =>
        (l.level === "error" || l.level === "warn") &&
        JSON.stringify(l.obj).includes("circuit"),
    );
    expect(alert).toBeDefined();
  });

  it("restarts that age out of the rolling hour do NOT trip the breaker", async () => {
    await h.supervisor.spawn();
    // 20 exits, each 10 minutes apart → never more than ~6 in any rolling hour.
    let t = 0;
    for (let i = 0; i < 20; i++) {
      t += 10 * 60 * 1000;
      h.setNow(t);
      h.spawns.at(-1)!.pty.fireExit();
      h.fireLast();
      await Promise.resolve();
    }
    expect(h.supervisor.getState()).toBe("running");
  });

  it("stop() group-kills via the tracker (does NOT re-implement kill) and cancels a pending restart timer", async () => {
    await h.supervisor.spawn();
    // Schedule a restart but do not fire it.
    h.spawns[0]!.pty.fireExit();
    const pendingBefore = h.scheduled.at(-1)!;
    expect(pendingBefore.fired).toBe(false);

    await h.supervisor.stop();

    expect(h.killCalls).toEqual(["test-agent"]);
    expect(h.supervisor.getState()).toBe("stopped");
    // The pending restart timer was cancelled (consumed) — firing it is a no-op.
    const spawnsBefore = h.spawns.length;
    h.fireLast();
    await Promise.resolve();
    expect(h.spawns.length).toBe(spawnsBefore);
  });

  it("a stopped supervisor does NOT restart on a late exit event", async () => {
    await h.supervisor.spawn();
    await h.supervisor.stop();
    const spawnsBefore = h.spawns.length;
    const scheduledBefore = h.scheduled.length;
    // Late exit from the killed child.
    h.spawns[0]!.pty.fireExit();
    await Promise.resolve();
    expect(h.spawns.length).toBe(spawnsBefore);
    expect(h.scheduled.length).toBe(scheduledBefore);
  });

  // --- Rule 2 (140-01 operator decision): resume on respawn -----------------

  it("a restart appends `--resume <id>` to argv when getResumeSessionId() returns a session id", async () => {
    const hh = makeHarness({ getResumeSessionId: () => "sess-abc123" });
    await hh.supervisor.spawn();
    // First spawn is a fresh session — no --resume.
    expect(hh.spawns[0]!.args).not.toContain("--resume");

    // Crash → restart should resume the captured session.
    hh.spawns[0]!.pty.fireExit();
    hh.fireLast();
    await Promise.resolve();

    const restartArgs = hh.spawns[1]!.args;
    const idx = restartArgs.indexOf("--resume");
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(restartArgs[idx + 1]).toBe("sess-abc123");
  });

  it("a restart does NOT append `--resume` when getResumeSessionId() returns null (fresh session)", async () => {
    const hh = makeHarness({ getResumeSessionId: () => null });
    await hh.supervisor.spawn();
    hh.spawns[0]!.pty.fireExit();
    hh.fireLast();
    await Promise.resolve();
    expect(hh.spawns[1]!.args).not.toContain("--resume");
  });

  it("re-registers the new PID after each restart so cleanup keeps covering the live child", async () => {
    await h.supervisor.spawn();
    expect(h.registerCalls).toHaveLength(1);
    h.spawns[0]!.pty.fireExit();
    h.fireLast();
    await Promise.resolve();
    expect(h.registerCalls).toHaveLength(2);
    expect(h.registerCalls[1]!.pid).toBe(h.spawns[1]!.pty.pid);
  });
});
