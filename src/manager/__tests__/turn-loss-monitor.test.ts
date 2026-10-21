/**
 * Phase 140 Plan 05 Task 2 — TurnLossMonitor tests.
 *
 * The monitor is the REQUIRED v3 turn-loss telemetry (CONTEXT 140 LOCKED): it
 * replaces the now-inert stream-stall/wedge auto-recovery. Under v3 a mid-turn
 * abort degrades to a coarse PTY restart, so a turn that STARTS but never
 * reaches the `end_to_end` TraceStore segment must surface — otherwise Stage-3's
 * 7-day soak could show clean SLOs while individual users silently lose
 * responses.
 *
 * Contract:
 *   - `onTurnStart(turnId, agent)` arms a watchdog at (end_to_end p99) × 3.
 *   - `onTurnEnd(turnId)` cancels the watchdog (the turn reached end_to_end).
 *   - watchdog fire with no onTurnEnd → exactly ONE canonical alert log line
 *     (turn id + agent + elapsed) + a counter increment.
 *   - p99 null/no_data → arm at a documented FLOOR (not 0, not Infinity).
 *
 * All seams (p99 provider, clock, timer, alert sink) are injected for
 * determinism — no real timers, no real TraceStore.
 */

import { describe, expect, it, vi } from "vitest";

import {
  TurnLossMonitor,
  TURN_LOSS_FLOOR_MS,
  type TurnLossMonitorDeps,
} from "../turn-loss-monitor.js";

/**
 * A controllable fake timer seam. `setTimer` records the callback + delay and
 * returns an incrementing handle; `advance(ms)` fires every armed timer whose
 * accumulated delay has elapsed (single-shot — matches setTimeout semantics).
 */
function makeFakeTimers() {
  let nowMs = 0;
  let nextHandle = 1;
  const armed = new Map<
    number,
    { fireAtMs: number; cb: () => void }
  >();
  return {
    clock: () => nowMs,
    setTimer: (cb: () => void, delayMs: number): unknown => {
      const handle = nextHandle++;
      armed.set(handle, { fireAtMs: nowMs + delayMs, cb });
      return handle;
    },
    clearTimer: (handle: unknown): void => {
      armed.delete(handle as number);
    },
    /** Advance the fake clock, firing any armed timer whose deadline passed. */
    advance: (ms: number): void => {
      nowMs += ms;
      for (const [handle, t] of [...armed.entries()]) {
        if (t.fireAtMs <= nowMs) {
          armed.delete(handle);
          t.cb();
        }
      }
    },
    armedCount: () => armed.size,
  };
}

function makeDeps(
  p99Ms: number | null,
  over: Partial<TurnLossMonitorDeps> = {},
): {
  deps: TurnLossMonitorDeps;
  timers: ReturnType<typeof makeFakeTimers>;
  alerts: Array<{ turnId: string; agent: string; elapsedMs: number; deadlineMs: number }>;
} {
  const timers = makeFakeTimers();
  const alerts: Array<{
    turnId: string;
    agent: string;
    elapsedMs: number;
    deadlineMs: number;
  }> = [];
  const deps: TurnLossMonitorDeps = {
    getEndToEndP99Ms: vi.fn(() => p99Ms),
    clock: timers.clock,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    alertSink: (a) => alerts.push(a),
    ...over,
  };
  return { deps, timers, alerts };
}

describe("TurnLossMonitor", () => {
  it("onTurnStart then deadline passes with NO onTurnEnd → exactly one alert", () => {
    // p99 = 2000ms → deadline = 6000ms.
    const { deps, timers, alerts } = makeDeps(2000);
    const monitor = new TurnLossMonitor(deps);

    monitor.onTurnStart("openai-api:abc123", "clawdy");
    expect(timers.armedCount()).toBe(1);

    timers.advance(6001);

    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.turnId).toBe("openai-api:abc123");
    expect(alerts[0]?.agent).toBe("clawdy");
    expect(alerts[0]?.elapsedMs).toBeGreaterThanOrEqual(6000);
    expect(alerts[0]?.deadlineMs).toBe(6000);
    expect(monitor.lostTurnCount()).toBe(1);
  });

  it("onTurnStart then onTurnEnd before the deadline → NO alert", () => {
    const { deps, timers, alerts } = makeDeps(2000);
    const monitor = new TurnLossMonitor(deps);

    monitor.onTurnStart("turn-1", "clawdy");
    timers.advance(3000); // before the 6000ms deadline
    monitor.onTurnEnd("turn-1");
    expect(timers.armedCount()).toBe(0); // watchdog cancelled

    timers.advance(10_000); // well past the original deadline

    expect(alerts).toHaveLength(0);
    expect(monitor.lostTurnCount()).toBe(0);
  });

  it("p99 null/no_data → arms at the documented FLOOR (not 0, not Infinity)", () => {
    const { deps, timers, alerts } = makeDeps(null);
    const monitor = new TurnLossMonitor(deps);

    monitor.onTurnStart("turn-floor", "assistant");
    expect(timers.armedCount()).toBe(1);

    // Just before the floor → no alert yet.
    timers.advance(TURN_LOSS_FLOOR_MS - 1);
    expect(alerts).toHaveLength(0);

    // Crossing the floor → alert fires with the floor as the deadline.
    timers.advance(2);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.deadlineMs).toBe(TURN_LOSS_FLOOR_MS);
    expect(TURN_LOSS_FLOOR_MS).toBeGreaterThan(0);
    expect(Number.isFinite(TURN_LOSS_FLOOR_MS)).toBe(true);
  });

  it("p99 of 0 is treated as no_data → floor applies (never a 0ms watchdog)", () => {
    const { deps, timers, alerts } = makeDeps(0);
    const monitor = new TurnLossMonitor(deps);
    monitor.onTurnStart("turn-zero", "clawdy");
    // A 0ms deadline would fire immediately on any advance; the floor prevents it.
    timers.advance(1);
    expect(alerts).toHaveLength(0);
    timers.advance(TURN_LOSS_FLOOR_MS);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.deadlineMs).toBe(TURN_LOSS_FLOOR_MS);
  });

  it("onTurnStart twice for the same id → only ONE timer fires (replace semantics)", () => {
    const { deps, timers, alerts } = makeDeps(1000); // deadline 3000ms
    const monitor = new TurnLossMonitor(deps);

    monitor.onTurnStart("dup", "clawdy");
    monitor.onTurnStart("dup", "clawdy"); // replaces the first arm
    expect(timers.armedCount()).toBe(1);

    timers.advance(3001);
    expect(alerts).toHaveLength(1);
    expect(monitor.lostTurnCount()).toBe(1);
  });

  it("onTurnEnd for an unknown id is a silent no-op (orphan end)", () => {
    const { deps, alerts } = makeDeps(1000);
    const monitor = new TurnLossMonitor(deps);
    expect(() => monitor.onTurnEnd("never-started")).not.toThrow();
    expect(alerts).toHaveLength(0);
  });

  it("two concurrent turns are tracked independently", () => {
    const { deps, timers, alerts } = makeDeps(1000); // deadline 3000ms each
    const monitor = new TurnLossMonitor(deps);

    monitor.onTurnStart("A", "clawdy");
    timers.advance(1000);
    monitor.onTurnStart("B", "assistant");

    // End A before its deadline; let B's deadline pass.
    monitor.onTurnEnd("A");
    timers.advance(3001); // A would have fired at 3000 but was cancelled; B fires at 4000

    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.turnId).toBe("B");
    expect(alerts[0]?.agent).toBe("assistant");
  });

  it("emits a canonical alert log line via the default sink (console.warn) carrying turn id + agent + elapsed", () => {
    // Use the REAL default alert sink (no alertSink override) to prove the
    // canonical structured log line is emitted with a stable grep tag.
    const timers = makeFakeTimers();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const monitor = new TurnLossMonitor({
        getEndToEndP99Ms: () => 2000,
        clock: timers.clock,
        setTimer: timers.setTimer,
        clearTimer: timers.clearTimer,
        // no alertSink → default console.warn structured line
      });
      monitor.onTurnStart("openai-api:zzz999", "clawdy");
      timers.advance(6001);

      expect(warnSpy).toHaveBeenCalledTimes(1);
      const [tag, payload] = warnSpy.mock.calls[0]!;
      expect(tag).toBe("phase140-turn-loss");
      const parsed = JSON.parse(payload as string) as Record<string, unknown>;
      expect(parsed.turnId).toBe("openai-api:zzz999");
      expect(parsed.agent).toBe("clawdy");
      expect(typeof parsed.elapsedMs).toBe("number");
      expect(typeof parsed.deadlineMs).toBe("number");
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("a fired watchdog does not double-count if the clock advances again", () => {
    const { deps, timers, alerts } = makeDeps(1000);
    const monitor = new TurnLossMonitor(deps);
    monitor.onTurnStart("once", "clawdy");
    timers.advance(3001);
    timers.advance(5000); // further advances must not re-fire (single-shot)
    expect(alerts).toHaveLength(1);
    expect(monitor.lostTurnCount()).toBe(1);
  });
});
