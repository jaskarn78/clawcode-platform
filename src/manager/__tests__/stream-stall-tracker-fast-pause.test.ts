/**
 * Regression: the split fast/slow max-pause ceiling (INC-2026-06-05).
 *
 * The single 15-min `max-pause-exceeded` ceiling is sized for the SLOWEST
 * legitimate tool (heavy Bash/browser). When the only outstanding tool is a
 * known-fast one (MCP db/content/quote, local Read/Grep/Glob, ToolSearch — all
 * seconds-scale), a pause that outlasts the SHORTER fast ceiling is an
 * SDK-generator hang, not a slow tool. fin-client's hung
 * `mcp__acme-db__mysql_query` left the turn paused the full 15 min (the
 * `no-useful-tokens` trip is suppressed while paused), and the bridge showed
 * phantom "typing…" until its 600s cap. The fast ceiling settles such a wedge
 * in ~2 min while a single slow tool in flight keeps the full 15 min.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  createStreamStallTracker,
  type StreamStallPayload,
  DEFAULT_FAST_MAX_PAUSE_DURATION_MS,
} from "../stream-stall-tracker.js";

describe("stream-stall-tracker — split fast/slow max-pause ceiling", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const mk = (over: Partial<Parameters<typeof createStreamStallTracker>[0]> = {}) => {
    const onStall = vi.fn<(p: StreamStallPayload) => void>();
    const tracker = createStreamStallTracker({
      thresholdMs: 60_000, // no-useful-tokens (suppressed while paused anyway)
      fastMaxPauseDurationMs: 2_000, // short fast ceiling for the test
      maxPauseDurationMs: 30_000, // slow ceiling well above the fast one
      maxTurnDurationMs: 10 * 60_000, // keep the absolute ceiling out of the way
      checkIntervalMs: 100,
      onStall,
      ...over,
    });
    return { onStall, tracker };
  };

  it("trips at the FAST ceiling when only a fast tool is in flight", async () => {
    const { onStall, tracker } = mk();
    tracker.pause({ fast: true });
    await vi.advanceTimersByTimeAsync(1_500); // < fast ceiling (2s)
    expect(onStall).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(800); // ≈ 2.3s > fast ceiling
    tracker.stop();
    expect(onStall).toHaveBeenCalledTimes(1);
    const p = onStall.mock.calls[0]?.[0];
    expect(p?.reason).toBe("max-pause-exceeded");
    expect(p?.pauseDurationMs ?? 0).toBeGreaterThan(2_000);
    expect(p?.pauseDurationMs ?? 0).toBeLessThan(30_000); // NOT the slow ceiling
  });

  it("a fast tool that resumes inside the fast ceiling does NOT trip", async () => {
    const { onStall, tracker } = mk();
    tracker.pause({ fast: true });
    await vi.advanceTimersByTimeAsync(1_000);
    tracker.resume({ fast: true });
    await vi.advanceTimersByTimeAsync(5_000); // unpaused; no-useful-tokens (60s) not reached
    tracker.stop();
    expect(onStall).not.toHaveBeenCalled();
  });

  it("a SLOW tool keeps the full slow ceiling (does not trip at the fast ceiling)", async () => {
    const { onStall, tracker } = mk();
    tracker.pause({ fast: false });
    await vi.advanceTimersByTimeAsync(5_000); // way past the 2s fast ceiling
    expect(onStall).not.toHaveBeenCalled(); // slow ceiling is 30s
    await vi.advanceTimersByTimeAsync(26_000); // ≈ 31s > slow ceiling
    tracker.stop();
    expect(onStall).toHaveBeenCalledTimes(1);
    expect(onStall.mock.calls[0]?.[0]?.pauseDurationMs ?? 0).toBeGreaterThan(30_000);
  });

  it("a mixed batch (fast + slow outstanding) holds the slow ceiling", async () => {
    const { onStall, tracker } = mk();
    tracker.pause({ fast: true }); // window opens
    tracker.pause({ fast: false }); // a slow tool joins
    await vi.advanceTimersByTimeAsync(5_000); // past fast ceiling, slow still in flight
    expect(onStall).not.toHaveBeenCalled();
    tracker.stop();
  });

  it("re-arms the window on the slow→fast transition so a fresh fast tool isn't instantly cut", async () => {
    const { onStall, tracker } = mk();
    // Slow tool runs a long time (legit), with a fast tool also outstanding.
    tracker.pause({ fast: false }); // window opens at t0, slow ceiling
    tracker.pause({ fast: true });
    await vi.advanceTimersByTimeAsync(20_000); // 20s < 30s slow ceiling — no trip
    expect(onStall).not.toHaveBeenCalled();
    // Slow tool finishes; only the fast tool remains. Window MUST re-arm to now,
    // otherwise the 20s already elapsed would instantly blow the 2s fast ceiling.
    tracker.resume({ fast: false });
    await vi.advanceTimersByTimeAsync(1_500); // 1.5s into the fast-only window (< 2s)
    expect(onStall).not.toHaveBeenCalled();
    // Now exceed the fast ceiling measured FROM the transition.
    await vi.advanceTimersByTimeAsync(800); // ≈ 2.3s fast-only
    tracker.stop();
    expect(onStall).toHaveBeenCalledTimes(1);
    expect(onStall.mock.calls[0]?.[0]?.pauseDurationMs ?? 0).toBeLessThan(20_000);
  });

  it("defaults the fast ceiling to 2 min when omitted (production path)", async () => {
    const onStall = vi.fn();
    expect(DEFAULT_FAST_MAX_PAUSE_DURATION_MS).toBe(2 * 60_000);
    const tracker = createStreamStallTracker({
      thresholdMs: 60_000,
      checkIntervalMs: 1_000,
      onStall,
    });
    tracker.pause({ fast: true });
    await vi.advanceTimersByTimeAsync(90_000); // 1.5 min < 2 min default
    expect(onStall).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(40_000); // ≈ 2.17 min > 2 min default
    tracker.stop();
    expect(onStall).toHaveBeenCalledTimes(1);
    expect(onStall.mock.calls[0]?.[0]?.reason).toBe("max-pause-exceeded");
  });

  it("rejects a non-positive fastMaxPauseDurationMs", () => {
    expect(() =>
      createStreamStallTracker({
        thresholdMs: 1_000,
        fastMaxPauseDurationMs: 0,
        onStall: vi.fn(),
      }),
    ).toThrow(/fastMaxPauseDurationMs/);
  });

  it("un-annotated pause()/resume() default to SLOW (no behaviour change for existing callers)", async () => {
    const { onStall, tracker } = mk();
    tracker.pause(); // no opts → slow
    await vi.advanceTimersByTimeAsync(5_000); // past fast ceiling
    expect(onStall).not.toHaveBeenCalled(); // still slow → 30s ceiling
    tracker.stop();
  });
});
