import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Writable } from "node:stream";
import pino from "pino";
import {
  scanForSubagentSessions,
  tickSubagentSessionReaper,
  type RunningSessionInfo,
} from "../subagent-session-reaper.js";
import type { ThreadBinding } from "../../discord/thread-types.js";

function captureLogger() {
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

const NOW = 1_700_000_000_000; // arbitrary fixed epoch ms
const HOUR_MS = 60 * 60 * 1000;
const SUB_NAME = "fin-client-via-fin-research-57r__G";
const SUB_NAME_2 = "fin-client-via-fin-research-4XZKL0";
const OPERATOR_NAME = "fin-client";

function session(
  overrides: Partial<RunningSessionInfo> = {},
): RunningSessionInfo {
  return {
    name: SUB_NAME,
    status: "running",
    startedAt: NOW - 14 * HOUR_MS, // 14h old by default — past minAge
    ...overrides,
  };
}

function binding(overrides: Partial<ThreadBinding> = {}): ThreadBinding {
  return {
    threadId: "thread-1",
    parentChannelId: "ch-1",
    agentName: SUB_NAME,
    sessionName: SUB_NAME,
    createdAt: NOW - 14 * HOUR_MS,
    lastActivity: NOW - 13 * HOUR_MS, // 13h ago — beyond default 24h? no, not yet
    ...overrides,
  };
}

const DEFAULT_SCAN = {
  idleTimeoutMinutes: 1440, // 24h
  minAgeSeconds: 300, // 5 min
  now: NOW,
};

describe("scanForSubagentSessions", () => {
  it("returns the orphan-binding case (session running, no binding)", () => {
    const candidates = scanForSubagentSessions({
      sessions: [session()],
      bindings: [],
      ...DEFAULT_SCAN,
    });
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.name).toBe(SUB_NAME);
    expect(candidates[0]!.threadId).toBeNull();
    expect(candidates[0]!.lastActivityAgeSec).toBeNull();
    expect(candidates[0]!.ageSec).toBe(14 * 60 * 60);
  });

  it("returns the idle-binding case (lastActivity > idleTimeout)", () => {
    const candidates = scanForSubagentSessions({
      sessions: [session()],
      bindings: [binding({ lastActivity: NOW - 25 * HOUR_MS })], // 25h ago
      ...DEFAULT_SCAN,
    });
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.threadId).toBe("thread-1");
    expect(candidates[0]!.lastActivityAgeSec).toBe(25 * 60 * 60);
  });

  it("does NOT return when binding lastActivity is fresh", () => {
    const candidates = scanForSubagentSessions({
      sessions: [session()],
      bindings: [binding({ lastActivity: NOW - 5 * 60 * 1000 })], // 5 min ago
      ...DEFAULT_SCAN,
    });
    expect(candidates).toEqual([]);
  });

  it("does NOT return operator-defined session names (no -nanoid6 suffix)", () => {
    const candidates = scanForSubagentSessions({
      sessions: [
        {
          name: OPERATOR_NAME,
          status: "running",
          startedAt: NOW - 30 * HOUR_MS,
        },
      ],
      bindings: [], // missing binding would otherwise trigger orphan-prune
      ...DEFAULT_SCAN,
    });
    expect(candidates).toEqual([]);
  });

  it("skips sessions in `starting` status (race guard)", () => {
    const candidates = scanForSubagentSessions({
      sessions: [session({ status: "starting" })],
      bindings: [],
      ...DEFAULT_SCAN,
    });
    expect(candidates).toEqual([]);
  });

  it("skips sessions younger than minAgeSeconds", () => {
    const candidates = scanForSubagentSessions({
      sessions: [session({ startedAt: NOW - 60 * 1000 })], // 1 min old
      bindings: [],
      ...DEFAULT_SCAN, // minAgeSeconds=300
    });
    expect(candidates).toEqual([]);
  });

  it("skips sessions whose startedAt is null (defensive)", () => {
    const candidates = scanForSubagentSessions({
      sessions: [session({ startedAt: null })],
      bindings: [],
      ...DEFAULT_SCAN,
    });
    expect(candidates).toEqual([]);
  });

  it("returns multiple candidates with stable ordering by input position", () => {
    const candidates = scanForSubagentSessions({
      sessions: [session(), session({ name: SUB_NAME_2 })],
      bindings: [],
      ...DEFAULT_SCAN,
    });
    expect(candidates).toHaveLength(2);
    expect(candidates[0]!.name).toBe(SUB_NAME);
    expect(candidates[1]!.name).toBe(SUB_NAME_2);
  });

  it("handles screenshot-shape: two orphan subagent sessions, both reaped", () => {
    // The literal admin-clawdy 2026-05-04 fleet state:
    //   fin-client-via-fin-research-57r__G — 13h 56m
    //   fin-client-via-fin-research-4XZKL0 —  8h 45m
    const candidates = scanForSubagentSessions({
      sessions: [
        session({ name: SUB_NAME, startedAt: NOW - 13.93 * HOUR_MS }),
        session({ name: SUB_NAME_2, startedAt: NOW - 8.75 * HOUR_MS }),
      ],
      bindings: [], // orphan — the screenshot scenario
      ...DEFAULT_SCAN,
    });
    expect(candidates.map((c) => c.name)).toEqual([SUB_NAME, SUB_NAME_2]);
  });
});

/**
 * Phase 145 WS2 — active-worker survival invariant.
 *
 * A workflow-worker session (Plan 05) runs as a "running" subagent session for
 * 40 min+. The idle reaper MUST NOT reap it WHILE it is making progress. The
 * reaper already keys purely on `binding.lastActivity` (no worker-specific knob
 * needed — verified against the source: scanForSubagentSessions:117-136), so
 * survival is guaranteed by the orchestrator refreshing `binding.lastActivity`
 * on each progress ping. These tests PIN that contract for Plan 05 — they do
 * NOT change reaper source.
 *
 * Two complementary safeties (documented, not re-tested here):
 *   - registry.ts TTL prune touches only `status === "stopped"` sessions, so a
 *     "running" worker is never pruned there regardless of age.
 *   - The reaper's `status === "running"` + `lastActivity` gates are the only
 *     ones that can touch a running worker — hence this lastActivity contract.
 *
 * CONTRACT FOR PLAN 05: the workflow-worker orchestrator MUST refresh
 * `binding.lastActivity` on each progress ping (OR run with a generous
 * worker-sized `idleTimeoutMinutes` > the worker's expected wall-clock). If it
 * does neither, a long-but-progressing worker becomes a reap candidate after
 * `idleTimeoutMinutes` of binding silence and gets stopped mid-work.
 */
describe("Phase 145 WS2 — active-worker survival (reaper lastActivity contract)", () => {
  it("a running worker with lastActivity refreshed within idleTimeout is NOT a candidate (active worker survives)", () => {
    const candidates = scanForSubagentSessions({
      sessions: [session({ startedAt: NOW - 40 * 60 * 1000 })], // 40-min worker
      bindings: [
        // Progress ping 2 min ago — well inside the 24h idle window.
        binding({ lastActivity: NOW - 2 * 60 * 1000 }),
      ],
      ...DEFAULT_SCAN,
    });
    expect(candidates).toEqual([]);
  });

  it("a running worker whose lastActivity is older than idleTimeout IS a candidate (genuinely idle still reaped)", () => {
    const candidates = scanForSubagentSessions({
      sessions: [session({ startedAt: NOW - 40 * 60 * 1000 })],
      bindings: [
        // No progress for 25h — past the 24h idle window → genuinely hung/idle.
        binding({ lastActivity: NOW - 25 * HOUR_MS }),
      ],
      ...DEFAULT_SCAN,
    });
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.name).toBe(SUB_NAME);
    expect(candidates[0]!.lastActivityAgeSec).toBe(25 * 60 * 60);
  });

  it("repeated scans with a per-cycle lastActivity bump never produce a candidate (the progress-ping contract Plan 05 relies on)", () => {
    // Simulate the orchestrator's progress-ping contract: each scan cycle the
    // worker bumps binding.lastActivity to "now", so the binding is never idle
    // for a full idleTimeout window. Across many cycles the worker is never a
    // reap candidate even though its absolute age grows unbounded.
    const cycleMs = 5 * 60 * 1000; // a scan + progress ping every 5 min
    const startedAt = NOW;
    let cursor = NOW;
    for (let cycle = 0; cycle < 12; cycle++) {
      // 12 cycles = 1h of continuous progress, far past the 20-min default wall
      // clock the tracker (Task 1) now lifts for workers.
      cursor += cycleMs;
      const candidates = scanForSubagentSessions({
        sessions: [session({ startedAt })],
        // Progress ping landed this cycle → lastActivity == cursor (now).
        bindings: [binding({ lastActivity: cursor })],
        idleTimeoutMinutes: 1440,
        minAgeSeconds: 300,
        now: cursor,
      });
      expect(candidates).toEqual([]);
    }
  });
});

describe("tickSubagentSessionReaper", () => {
  let cap: ReturnType<typeof captureLogger>;

  beforeEach(() => {
    cap = captureLogger();
    delete process.env.CLAWCODE_SUBAGENT_REAPER_DISABLE;
  });
  afterEach(() => {
    delete process.env.CLAWCODE_SUBAGENT_REAPER_DISABLE;
  });

  it("noops when mode is 'off'", async () => {
    const stopAgent = vi.fn();
    await tickSubagentSessionReaper({
      sessions: [session()],
      bindings: [],
      ...DEFAULT_SCAN,
      mode: "off",
      log: cap.log,
      stopAgent,
    });
    expect(stopAgent).not.toHaveBeenCalled();
    expect(cap.lines()).toEqual([]);
  });

  it("noops when CLAWCODE_SUBAGENT_REAPER_DISABLE=1", async () => {
    process.env.CLAWCODE_SUBAGENT_REAPER_DISABLE = "1";
    const stopAgent = vi.fn();
    await tickSubagentSessionReaper({
      sessions: [session()],
      bindings: [],
      ...DEFAULT_SCAN,
      mode: "reap",
      log: cap.log,
      stopAgent,
    });
    expect(stopAgent).not.toHaveBeenCalled();
  });

  it("alert mode emits warn per candidate but does NOT stop", async () => {
    const stopAgent = vi.fn();
    await tickSubagentSessionReaper({
      sessions: [session(), session({ name: SUB_NAME_2 })],
      bindings: [],
      ...DEFAULT_SCAN,
      mode: "alert",
      log: cap.log,
      stopAgent,
    });
    expect(stopAgent).not.toHaveBeenCalled();
    const alerts = cap.lines().filter(
      (l) =>
        l.component === "subagent-session-reaper" && l.action === "alert",
    );
    expect(alerts).toHaveLength(2);
    expect(alerts[0]!.mode).toBe("alert");
    expect(alerts[0]!.msg).toBe("subagent session candidate detected");
  });

  it("reap mode emits alert+reap and calls stopAgent for each candidate", async () => {
    const stopAgent = vi.fn().mockResolvedValue(undefined);
    await tickSubagentSessionReaper({
      sessions: [session(), session({ name: SUB_NAME_2 })],
      bindings: [],
      ...DEFAULT_SCAN,
      mode: "reap",
      log: cap.log,
      stopAgent,
    });
    expect(stopAgent).toHaveBeenCalledTimes(2);
    expect(stopAgent).toHaveBeenCalledWith(SUB_NAME);
    expect(stopAgent).toHaveBeenCalledWith(SUB_NAME_2);
    const lines = cap.lines();
    expect(
      lines.filter((l) => l.action === "alert").length,
    ).toBeGreaterThanOrEqual(2);
    expect(
      lines.filter((l) => l.action === "reap").length,
    ).toBeGreaterThanOrEqual(2);
  });

  it("tolerates `not running` race silently (info log, no error)", async () => {
    const stopAgent = vi.fn().mockRejectedValueOnce(
      new Error("Agent 'fin-client-via-fin-research-57r__G' is not running"),
    );
    await tickSubagentSessionReaper({
      sessions: [session()],
      bindings: [],
      ...DEFAULT_SCAN,
      mode: "reap",
      log: cap.log,
      stopAgent,
    });
    const lines = cap.lines();
    expect(lines.find((l) => l.level === 50)).toBeUndefined(); // no error level
    expect(
      lines.find(
        (l) =>
          l.level === 30 && // info
          l.action === "reap" &&
          typeof l.msg === "string" &&
          l.msg.includes("already stopped"),
      ),
    ).toBeDefined();
  });

  it("logs error level for unexpected stopAgent failures", async () => {
    const stopAgent = vi.fn().mockRejectedValueOnce(new Error("disk full"));
    await tickSubagentSessionReaper({
      sessions: [session()],
      bindings: [],
      ...DEFAULT_SCAN,
      mode: "reap",
      log: cap.log,
      stopAgent,
    });
    const errors = cap.lines().filter((l) => l.level === 50);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.action).toBe("reap");
    expect(errors[0]!.err).toBe("disk full");
  });

  it("does not throw when stopAgent rejects (callers wire this into setInterval)", async () => {
    const stopAgent = vi.fn().mockRejectedValueOnce(new Error("boom"));
    await expect(
      tickSubagentSessionReaper({
        sessions: [session()],
        bindings: [],
        ...DEFAULT_SCAN,
        mode: "reap",
        log: cap.log,
        stopAgent,
      }),
    ).resolves.toBeUndefined();
  });
});
