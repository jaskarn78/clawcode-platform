/**
 * Regression: the absolute per-turn ceiling (`max-turn-duration`).
 *
 * The two activity-based trips can BOTH be defeated by a turn that slow-drips
 * output (every consumed token resets `lastUsefulTokenAt`, so `no-useful-tokens`
 * never fires; `max-pause-exceeded` only fires while a tool is paused). Such a
 * turn never settles → the serial-queue slot leaks → QUEUE_FULL. The absolute
 * wall-clock ceiling is the activity-independent backstop that guarantees every
 * turn trips (→ interrupt → settle) within a bounded time.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  createStreamStallTracker,
  type StreamStallPayload,
} from "../stream-stall-tracker.js";

describe("stream-stall-tracker — absolute max-turn-duration ceiling", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("trips with reason 'max-turn-duration' under CONTINUOUS activity (the slow-drip hang the activity timers can't catch)", async () => {
    const onStall = vi.fn<(p: StreamStallPayload) => void>();
    const tracker = createStreamStallTracker({
      thresholdMs: 1000, // no-useful-tokens would need 1s of silence
      maxTurnDurationMs: 3000, // absolute ceiling
      checkIntervalMs: 100,
      onStall,
    });

    // Mark a useful token every 500ms (< thresholdMs) so the no-useful-tokens
    // trip NEVER fires — exactly the slow-drip stream that hangs forever today.
    for (let i = 0; i < 5; i++) {
      await vi.advanceTimersByTimeAsync(500); // t = 500..2500
      tracker.markUsefulToken();
    }
    expect(onStall).not.toHaveBeenCalled(); // still under the cap, activity fresh

    // Cross the absolute ceiling — the activity-independent trip fires.
    await vi.advanceTimersByTimeAsync(800); // t ≈ 3300
    tracker.stop();

    expect(onStall).toHaveBeenCalledTimes(1);
    const payload = onStall.mock.calls[0]?.[0];
    expect(payload?.reason).toBe("max-turn-duration");
    expect(payload?.turnDurationMs ?? 0).toBeGreaterThan(3000);
  });

  it("does NOT trip when the turn completes before the ceiling", async () => {
    const onStall = vi.fn();
    const tracker = createStreamStallTracker({
      thresholdMs: 1000,
      maxTurnDurationMs: 3000,
      checkIntervalMs: 100,
      onStall,
    });
    for (let i = 0; i < 5; i++) {
      await vi.advanceTimersByTimeAsync(500); // t = 500..2500 (< 3000)
      tracker.markUsefulToken();
    }
    tracker.stop(); // turn finished before the ceiling
    await vi.advanceTimersByTimeAsync(5000); // a stopped tracker never trips
    expect(onStall).not.toHaveBeenCalled();
  });

  it("rejects a non-positive maxTurnDurationMs", () => {
    expect(() =>
      createStreamStallTracker({
        thresholdMs: 1000,
        maxTurnDurationMs: 0,
        onStall: vi.fn(),
      }),
    ).toThrow(/maxTurnDurationMs/);
  });

  /**
   * Phase 145 WS2 — the per-session override path the worker uses. A
   * workflow-worker session carries a LARGE FINITE `maxTurnDurationMs` (config
   * min == the 20-min default, max 8h) so a long worker turn does NOT trip the
   * 20-min default ceiling. This pins the "lifted ceiling" behavior the handle
   * threads through from `AgentSessionConfig.maxTurnDurationMs`.
   */
  describe("Phase 145 WS2 — lifted ceiling override (worker session)", () => {
    it("a large finite ceiling does NOT trip 'max-turn-duration' for a simulated 40-min turn (a default 20-min tracker WOULD)", async () => {
      const onStall = vi.fn<(p: StreamStallPayload) => void>();
      const tracker = createStreamStallTracker({
        thresholdMs: 120_000, // 2-min silence threshold (> the 60s activity gap)
        maxTurnDurationMs: 2 * 60 * 60_000, // 2h worker ceiling (lifted)
        checkIntervalMs: 1000,
        onStall,
      });
      // Progress every 60s for 40 min: no-useful-tokens never trips (gap <
      // threshold). A DEFAULT (20-min) tracker would have tripped at 20 min;
      // with the lifted ceiling we sail past 40 min with no trip.
      for (let i = 0; i < 40; i++) {
        await vi.advanceTimersByTimeAsync(60_000);
        tracker.markUsefulToken();
      }
      tracker.stop();
      expect(onStall).not.toHaveBeenCalled();
    });

    it("rejects Infinity (the ceiling can be LIFTED, never DISABLED — Number.isFinite guard)", () => {
      expect(() =>
        createStreamStallTracker({
          thresholdMs: 1000,
          maxTurnDurationMs: Number.POSITIVE_INFINITY,
          onStall: vi.fn(),
        }),
      ).toThrow(/maxTurnDurationMs/);
    });

    it("a lifted ceiling does NOT disarm the no-useful-tokens activity trip (genuine hang still caught)", async () => {
      const onStall = vi.fn<(p: StreamStallPayload) => void>();
      const tracker = createStreamStallTracker({
        thresholdMs: 1000, // 1s of silence trips no-useful-tokens
        maxTurnDurationMs: 2 * 60 * 60_000, // 2h — far away, can't be what fires
        checkIntervalMs: 100,
        onStall,
      });
      // A worker that genuinely hangs (no useful token) for > threshold. The
      // lifted absolute ceiling must NOT suppress the activity-based stall
      // detection — a real hang still trips well before the 2h wall clock.
      await vi.advanceTimersByTimeAsync(1500);
      tracker.stop();
      expect(onStall).toHaveBeenCalledTimes(1);
      expect(onStall.mock.calls[0]?.[0]?.reason).toBe("no-useful-tokens");
    });
  });

  it("defaults to a 20-min ceiling when maxTurnDurationMs is omitted (production path)", async () => {
    const onStall = vi.fn();
    const tracker = createStreamStallTracker({
      thresholdMs: 120_000, // 2-min silence threshold (> the 60s activity gap)
      checkIntervalMs: 1000,
      onStall,
    });
    // Keep activity fresh every 60s across 18 min — no-useful-tokens never trips
    // (gap < threshold), and we're under the 20-min turn ceiling. No trip yet.
    for (let i = 0; i < 18; i++) {
      await vi.advanceTimersByTimeAsync(60_000);
      tracker.markUsefulToken();
    }
    expect(onStall).not.toHaveBeenCalled();
    // Cross 20 min → the default ceiling trips.
    await vi.advanceTimersByTimeAsync(3 * 60_000);
    tracker.stop();
    expect(onStall).toHaveBeenCalledTimes(1);
    expect(onStall.mock.calls[0]?.[0]?.reason).toBe("max-turn-duration");
  });

  /**
   * v3 inert-stream fix (2026-06-14). With `tokenActivityTripsEnabled: false`
   * (the v3 / claude-code-interactive wiring), the no-useful-tokens activity
   * trip must NOT fire on a silent stream — that is the false-abort we are
   * removing (60 observed `phase127-stream-stall` aborts on `v3-research`).
   * The absolute `max-turn-duration` wall-clock backstop MUST stay armed so a
   * genuinely hung v3 turn still settles and releases its queue slot.
   */
  describe("tokenActivityTripsEnabled: false (v3 inert-stream wiring)", () => {
    it("does NOT trip on silence past thresholdMs — the no-useful-tokens false-abort is suppressed", async () => {
      const onStall = vi.fn<(p: StreamStallPayload) => void>();
      const tracker = createStreamStallTracker({
        thresholdMs: 1000, // would normally trip after 1s of silence
        maxTurnDurationMs: 60_000, // far away
        checkIntervalMs: 100,
        tokenActivityTripsEnabled: false,
        onStall,
      });
      // Total silence for 10× the threshold — on the SDK path this would have
      // tripped no-useful-tokens many times over. Here it must stay silent.
      await vi.advanceTimersByTimeAsync(10_000);
      tracker.stop();
      expect(onStall).not.toHaveBeenCalled();
    });

    it("STILL trips with reason 'max-turn-duration' when the wall-clock ceiling elapses (queue-slot backstop preserved)", async () => {
      const onStall = vi.fn<(p: StreamStallPayload) => void>();
      const tracker = createStreamStallTracker({
        thresholdMs: 1000,
        maxTurnDurationMs: 3000, // absolute ceiling stays armed even with activity trips off
        checkIntervalMs: 100,
        tokenActivityTripsEnabled: false,
        onStall,
      });
      // Silent the whole time (v3's inert SDK stream). The no-useful-tokens
      // trip is suppressed, but the wall-clock backstop must still fire.
      await vi.advanceTimersByTimeAsync(2500);
      expect(onStall).not.toHaveBeenCalled(); // under the ceiling
      await vi.advanceTimersByTimeAsync(800); // cross 3000ms
      tracker.stop();
      expect(onStall).toHaveBeenCalledTimes(1);
      const payload = onStall.mock.calls[0]?.[0];
      expect(payload?.reason).toBe("max-turn-duration");
      expect(payload?.turnDurationMs ?? 0).toBeGreaterThan(3000);
    });

    it("also suppresses the max-pause-exceeded ceiling (a paused inert stream never trips on pause)", async () => {
      const onStall = vi.fn<(p: StreamStallPayload) => void>();
      const tracker = createStreamStallTracker({
        thresholdMs: 1000,
        maxPauseDurationMs: 2000,
        fastMaxPauseDurationMs: 1000,
        maxTurnDurationMs: 60_000, // far away so only the pause ceiling could fire
        checkIntervalMs: 100,
        tokenActivityTripsEnabled: false,
        onStall,
      });
      tracker.pause(); // slow pause held well past maxPauseDurationMs
      await vi.advanceTimersByTimeAsync(5000);
      tracker.stop();
      expect(onStall).not.toHaveBeenCalled();
    });
  });
});
