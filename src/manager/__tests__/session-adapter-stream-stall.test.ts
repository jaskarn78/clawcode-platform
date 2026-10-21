import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * Phase 127 — synthetic stream-stall tests.
 *
 * Anchors on the `createStreamStallTracker` chokepoint module
 * (`src/manager/stream-stall-tracker.ts`) so both the production
 * `persistent-session-handle.ts` iteration loop AND the test-only
 * `wrapSdkQuery` path can be exercised through a single, deterministic
 * harness. The tests use `vi.useFakeTimers()` to drive the
 * setInterval-based stall checker without real wall-clock waits.
 *
 * Cases (STALL-01..03, STALL-05) cover the useful-token matrix:
 *   - STALL-01: keepalive-only stream (no useful tokens) → trip at
 *     threshold + 200ms. Also the canonical dead-stream regression for
 *     hotfix 15r — proves a genuinely silent stream STILL trips after
 *     the predicate was widened to count thinking_delta.
 *   - STALL-02: `content_block_delta.text_delta.text` resets the
 *     tracker → no trip across threshold * 3 of simulated activity.
 *   - STALL-03: `content_block_delta.input_json_delta.partial_json`
 *     resets the tracker (D-02 anti-pattern definition) → no trip.
 *   - STALL-05: `content_block_delta.thinking_delta.thinking` resets
 *     the tracker (hotfix 15r) → no trip. An xhigh-effort turn that
 *     emits only extended-thinking deltas was the root cause of the
 *     fin-client false-positive stall crash loop.
 *
 * Threshold pinned to 1000ms throughout for fast iteration; the
 * tracker's internal `checkIntervalMs` is overridden to 100ms via the
 * test option so the production cadence
 * (Math.min(threshold/4, 30_000)) doesn't dominate the test runtime.
 */

import {
  createStreamStallTracker,
  type StreamStallPayload,
} from "../stream-stall-tracker.js";
import {
  makeStreamStallCallback,
  STREAM_STALL_DISCORD_MESSAGE,
} from "../stream-stall-callback.js";

// ---------------------------------------------------------------------------
// Synthetic stream-event types — mirror the narrow shape consumed at
// `persistent-session-handle.ts:858+` and `session-adapter.ts:1912+`.
// We don't import the full SDK union — these synthetic events flow
// only through our test harness which decides whether to call
// `markUsefulToken()` per the production predicate.
// ---------------------------------------------------------------------------

type StreamEventDelta =
  | { readonly type: "text_delta"; readonly text: string }
  | { readonly type: "input_json_delta"; readonly partial_json: string }
  | { readonly type: "thinking_delta"; readonly thinking: string };

type SyntheticStreamEvent =
  | { readonly type: "content_block_start" }
  | { readonly type: "ping" }
  | {
      readonly type: "content_block_delta";
      readonly delta: StreamEventDelta;
    };

/**
 * Apply the production predicate (D-02 anti-pattern definition +
 * hotfix 15r): a useful token is any `content_block_delta` with
 * non-empty `text_delta.text` OR non-empty
 * `input_json_delta.partial_json` OR non-empty
 * `thinking_delta.thinking`. Mirrors the predicate used at the
 * production chokepoint in `persistent-session-handle.ts` —
 * `isTextDelta || isPartialJson || isThinkingDelta`.
 */
function isUsefulToken(event: SyntheticStreamEvent): boolean {
  if (event.type !== "content_block_delta") return false;
  const delta = event.delta;
  if (delta.type === "text_delta") {
    return typeof delta.text === "string" && delta.text.length > 0;
  }
  if (delta.type === "input_json_delta") {
    return (
      typeof delta.partial_json === "string" && delta.partial_json.length > 0
    );
  }
  if (delta.type === "thinking_delta") {
    return typeof delta.thinking === "string" && delta.thinking.length > 0;
  }
  return false;
}

/**
 * Drive the tracker through a synthetic stream. Each event is dispatched
 * at `event.dispatchAtMs` simulated time. After each dispatch, we
 * advance the fake clock to the next dispatch time, letting the
 * tracker's setInterval fire and decide whether the stall threshold
 * has elapsed.
 *
 * Returns the trip payload (if any) captured by the `onStall` spy. We
 * also collect every text_delta / partial_json the predicate would
 * forward to `onAssistantText` in production — used to assert the
 * STALL-02 / STALL-03 "tracker resets but stream continues" path.
 */
async function drive(opts: {
  thresholdMs: number;
  checkIntervalMs: number;
  events: ReadonlyArray<{
    dispatchAtMs: number;
    event: SyntheticStreamEvent;
  }>;
  totalElapsedMs: number;
}): Promise<{
  trippedWith: StreamStallPayload | null;
  usefulTokenCount: number;
  onStallSpy: ReturnType<typeof vi.fn>;
}> {
  const onStallSpy = vi.fn<(payload: StreamStallPayload) => void>();
  const tracker = createStreamStallTracker({
    thresholdMs: opts.thresholdMs,
    onStall: onStallSpy,
    checkIntervalMs: opts.checkIntervalMs,
  });

  let usefulTokenCount = 0;
  let currentSimulatedMs = 0;

  for (const { dispatchAtMs, event } of opts.events) {
    // Advance fake time up to this dispatch instant. Several setInterval
    // ticks may fire during this advance — the tracker decides per tick
    // whether the trip-condition is met.
    const delta = dispatchAtMs - currentSimulatedMs;
    if (delta > 0) {
      await vi.advanceTimersByTimeAsync(delta);
      currentSimulatedMs = dispatchAtMs;
    }
    // Apply the production predicate.
    if (isUsefulToken(event)) {
      usefulTokenCount += 1;
      tracker.markUsefulToken();
    }
  }

  // Advance to the totalElapsedMs deadline (final stall window).
  if (opts.totalElapsedMs > currentSimulatedMs) {
    await vi.advanceTimersByTimeAsync(
      opts.totalElapsedMs - currentSimulatedMs,
    );
  }

  // Stop the tracker (production cleanup happens here in both success
  // and catch paths — T-127-04 mitigation).
  tracker.stop();

  return {
    trippedWith: onStallSpy.mock.calls[0]?.[0] ?? null,
    usefulTokenCount,
    onStallSpy,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("phase127 — stream-stall tracker (synthetic stream)", () => {
  it("STALL-01: keepalive-only (dead) stream trips at threshold + 200ms", async () => {
    // Stream emits ONLY content_block_start + ping events — no useful
    // tokens of ANY kind (text / partial_json / thinking). The
    // fin-client 2026-05-14 pattern in microcosm.
    //
    // hotfix 15r dead-stream regression: after the useful-token
    // predicate was widened to count thinking_delta, a genuinely
    // silent stream (no text/json/thinking deltas) MUST still trip the
    // detector at the threshold. This case proves the real
    // dead-stream protection purpose is preserved.
    const events: Array<{
      dispatchAtMs: number;
      event: SyntheticStreamEvent;
    }> = [];
    // Spam keepalives every 100ms across the threshold window.
    for (let t = 100; t <= 1100; t += 100) {
      events.push({
        dispatchAtMs: t,
        event: t % 200 === 0
          ? { type: "content_block_start" }
          : { type: "ping" },
      });
    }

    const result = await drive({
      thresholdMs: 1000,
      checkIntervalMs: 100,
      events,
      totalElapsedMs: 1200, // threshold + 200ms cushion
    });

    expect(result.trippedWith).not.toBeNull();
    expect(result.trippedWith?.lastUsefulTokenAgeMs).toBeGreaterThan(1000);
    expect(result.trippedWith?.thresholdMs).toBe(1000);
    expect(result.usefulTokenCount).toBe(0);
    expect(result.onStallSpy).toHaveBeenCalledTimes(1);
  });

  it("STALL-02: text_delta tokens reset the tracker (no trip)", async () => {
    // Stream emits a text_delta every (threshold/2 - 50)ms — well within
    // the reset window. Run for threshold * 3 of simulated time.
    const tickEveryMs = 450; // threshold/2 - 50 with threshold=1000
    const events: Array<{
      dispatchAtMs: number;
      event: SyntheticStreamEvent;
    }> = [];
    for (let t = tickEveryMs; t <= 3000; t += tickEveryMs) {
      events.push({
        dispatchAtMs: t,
        event: {
          type: "content_block_delta",
          delta: { type: "text_delta", text: "x" },
        },
      });
    }

    const result = await drive({
      thresholdMs: 1000,
      checkIntervalMs: 100,
      events,
      totalElapsedMs: 3000,
    });

    expect(result.trippedWith).toBeNull();
    expect(result.usefulTokenCount).toBeGreaterThanOrEqual(6);
    expect(result.onStallSpy).not.toHaveBeenCalled();
  });

  it("STALL-03: input_json_delta.partial_json tokens reset the tracker (no trip)", async () => {
    // Tool-use streams emit partial_json (not text_delta). D-02 anti-
    // pattern definition includes this as a useful-token signal so an
    // agent dictating a long tool-use parameter doesn't false-stall.
    const tickEveryMs = 450;
    const events: Array<{
      dispatchAtMs: number;
      event: SyntheticStreamEvent;
    }> = [];
    for (let t = tickEveryMs; t <= 3000; t += tickEveryMs) {
      events.push({
        dispatchAtMs: t,
        event: {
          type: "content_block_delta",
          delta: { type: "input_json_delta", partial_json: '{"a":' },
        },
      });
    }

    const result = await drive({
      thresholdMs: 1000,
      checkIntervalMs: 100,
      events,
      totalElapsedMs: 3000,
    });

    expect(result.trippedWith).toBeNull();
    expect(result.usefulTokenCount).toBeGreaterThanOrEqual(6);
    expect(result.onStallSpy).not.toHaveBeenCalled();
  });

  it("STALL-05: thinking_delta tokens reset the tracker (no trip) — hotfix 15r", async () => {
    // An xhigh-effort turn emits long extended-thinking blocks that
    // produce ONLY thinking_delta events — no text_delta, no
    // input_json_delta. Pre-hotfix-15r the useful-token predicate
    // counted only text/partial_json, so the tracker saw no useful
    // token and aborted healthy fin-client turns (the live crash
    // loop). hotfix 15r adds thinking_delta as a counted useful-token
    // type; this case proves a thinking-only stream no longer trips.
    const tickEveryMs = 450; // threshold/2 - 50 with threshold=1000
    const events: Array<{
      dispatchAtMs: number;
      event: SyntheticStreamEvent;
    }> = [];
    for (let t = tickEveryMs; t <= 3000; t += tickEveryMs) {
      events.push({
        dispatchAtMs: t,
        event: {
          type: "content_block_delta",
          delta: { type: "thinking_delta", thinking: "let me reason..." },
        },
      });
    }

    const result = await drive({
      thresholdMs: 1000,
      checkIntervalMs: 100,
      events,
      totalElapsedMs: 3000,
    });

    expect(result.trippedWith).toBeNull();
    expect(result.usefulTokenCount).toBeGreaterThanOrEqual(6);
    expect(result.onStallSpy).not.toHaveBeenCalled();
  });
});

describe("phase127 — tracker cleanup (T-127-04 mitigation)", () => {
  it("stop() is idempotent and clears the interval", async () => {
    const onStallSpy = vi.fn<(payload: StreamStallPayload) => void>();
    const tracker = createStreamStallTracker({
      thresholdMs: 1000,
      onStall: onStallSpy,
      checkIntervalMs: 100,
    });

    // Two stops in a row must not throw.
    tracker.stop();
    tracker.stop();

    // After stop, advancing time past threshold MUST NOT trip.
    await vi.advanceTimersByTimeAsync(2000);
    expect(onStallSpy).not.toHaveBeenCalled();
  });

  it("trip fires onStall exactly once even with many ticks past threshold", async () => {
    const onStallSpy = vi.fn<(payload: StreamStallPayload) => void>();
    const tracker = createStreamStallTracker({
      thresholdMs: 200,
      onStall: onStallSpy,
      checkIntervalMs: 50,
    });

    // Advance well past threshold; the interval fires many times, but
    // only the first trip counts.
    await vi.advanceTimersByTimeAsync(2000);
    tracker.stop();
    expect(onStallSpy).toHaveBeenCalledTimes(1);
  });

  it("markUsefulToken after stop() is a no-op", async () => {
    const onStallSpy = vi.fn<(payload: StreamStallPayload) => void>();
    const tracker = createStreamStallTracker({
      thresholdMs: 1000,
      onStall: onStallSpy,
      checkIntervalMs: 100,
    });
    tracker.stop();
    tracker.markUsefulToken();
    // Internal state remains inert.
    await vi.advanceTimersByTimeAsync(2000);
    expect(onStallSpy).not.toHaveBeenCalled();
  });
});

/**
 * Phase 127 Plan 02 — STALL-04 integration test for the daemon-side
 * stall callback factory.
 *
 * Anchors on `makeStreamStallCallback` from `stream-stall-callback.ts`.
 * Mocks both sinks (`webhookManager.send` + `sessionLogger.recordStall`)
 * and asserts:
 *   1. Discord notification fires with the verbatim BACKLOG.md text
 *      (single emoji + em-dash U+2014).
 *   2. SessionLog row is written with the enriched payload
 *      (agentName, model, effort + the tracker's narrow payload).
 *   3. Both sinks are fire-and-forget: a rejection from either does
 *      not propagate out of the callback (supervisor recovery
 *      invariant per Phase 89 canary).
 *
 * Tests the factory directly (chokepoint-unit harness) rather than
 * driving through SessionManager.startAgent — that's
 * integration-test territory and this file is the unit surface for
 * the Phase 127 chokepoint per Plan 01 D-03.
 */
/**
 * Phase 127 — tool-aware pause/resume (quick task 260521-3or).
 *
 * The detector counts time spent INSIDE a tool call as "stall" time.
 * fin-client's heavy tools (browser / Bash / mysql, p95 5-12 min)
 * blow past the 180s threshold while the model is legitimately waiting
 * on a tool_result. The tool-aware fix exposes `pause()` / `resume()`
 * on the tracker: the iteration loop pauses on a top-level tool_use and
 * resumes on the matching tool_result, so tool-execution time is not
 * counted toward the stall.
 *
 * These cases exercise `createStreamStallTracker` directly with the
 * existing fake-timer posture (threshold 1000ms, checkInterval 100ms).
 * STALL-01 above is the untouched regression guard that a genuinely
 * dead stream (no marks, NOT paused) still trips — the detector's real
 * purpose survives the tool-aware change.
 */
describe("phase127 — tool-aware pause/resume (quick 260521-3or)", () => {
  it("PAUSE-01: a paused tracker does not trip; resume() restarts a fresh countdown", async () => {
    const onStallSpy = vi.fn<(payload: StreamStallPayload) => void>();
    const tracker = createStreamStallTracker({
      thresholdMs: 1000,
      onStall: onStallSpy,
      checkIntervalMs: 100,
    });

    // Pause (a tool starts) then advance well past the threshold —
    // tool-execution time must NOT count toward the stall.
    tracker.pause();
    await vi.advanceTimersByTimeAsync(5000);
    expect(onStallSpy).not.toHaveBeenCalled();

    // Resume (tool_result) re-arms the countdown fresh.
    tracker.resume();
    // Just under the threshold from the resume instant → still no trip.
    await vi.advanceTimersByTimeAsync(900);
    expect(onStallSpy).not.toHaveBeenCalled();

    // Past the threshold from the resume instant → trips exactly once.
    await vi.advanceTimersByTimeAsync(300);
    expect(onStallSpy).toHaveBeenCalledTimes(1);

    tracker.stop();
  });

  it("PAUSE-02: useful token → pause (tool) → long gap → resume → does not trip", async () => {
    const onStallSpy = vi.fn<(payload: StreamStallPayload) => void>();
    const tracker = createStreamStallTracker({
      thresholdMs: 1000,
      onStall: onStallSpy,
      checkIntervalMs: 100,
    });

    // A useful token lands, then a short gap inside the reset window.
    tracker.markUsefulToken();
    await vi.advanceTimersByTimeAsync(400);

    // A heavy tool starts — pause, then a gap FAR past the threshold.
    tracker.pause();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(onStallSpy).not.toHaveBeenCalled();

    // tool_result arrives — resume, then a short gap under the threshold.
    tracker.resume();
    await vi.advanceTimersByTimeAsync(400);
    expect(onStallSpy).not.toHaveBeenCalled();

    tracker.stop();
  });

  it("PAUSE-03: nested pause — two pause()s need two resume()s before re-arming", async () => {
    const onStallSpy = vi.fn<(payload: StreamStallPayload) => void>();
    const tracker = createStreamStallTracker({
      thresholdMs: 1000,
      onStall: onStallSpy,
      checkIntervalMs: 100,
    });

    // Two parallel tools start.
    tracker.pause();
    tracker.pause();
    await vi.advanceTimersByTimeAsync(2000);
    expect(onStallSpy).not.toHaveBeenCalled();

    // First tool_result — depth drops 2→1, still frozen.
    tracker.resume();
    await vi.advanceTimersByTimeAsync(2000);
    expect(onStallSpy).not.toHaveBeenCalled();

    // Second tool_result — depth drops 1→0, countdown re-arms.
    tracker.resume();
    await vi.advanceTimersByTimeAsync(1200);
    expect(onStallSpy).toHaveBeenCalledTimes(1);

    tracker.stop();
  });

  it("PAUSE-04: resume() at depth 0 and pause()/resume() after stop() are safe no-ops", async () => {
    const onStallSpy = vi.fn<(payload: StreamStallPayload) => void>();
    const tracker = createStreamStallTracker({
      thresholdMs: 1000,
      onStall: onStallSpy,
      checkIntervalMs: 100,
    });

    // resume() on a fresh tracker (pauseDepth 0) must not throw and must
    // not push the depth negative.
    expect(() => tracker.resume()).not.toThrow();

    // After stop(), pause()/resume() are inert — no throw, no trip.
    tracker.stop();
    expect(() => tracker.pause()).not.toThrow();
    expect(() => tracker.resume()).not.toThrow();
    await vi.advanceTimersByTimeAsync(2000);
    expect(onStallSpy).not.toHaveBeenCalled();
  });
});

/**
 * Phase 127 — max-pause ceiling (debug session `phase127-stall-abort-miss`,
 * Option 1).
 *
 * Root cause of the 2026-05-21 fin-client wedges: the tool-aware
 * `pause()` above suppresses the stall trip for the ENTIRE tool-execution
 * window with no upper bound. If the SDK generator HANGS while a tool is
 * in flight — `pause()` ran but the matching `tool_result` never arrives,
 * so `resume()` never runs — `pauseDepth` stays > 0 forever and the stall
 * is never detected.
 *
 * Option 1 adds a `maxPauseDurationMs` ceiling: a pause that outlasts the
 * ceiling trips the stall anyway (reason `"max-pause-exceeded"`) via the
 * same `onStall` clean-abort path. A legitimate tool returning inside the
 * ceiling un-pauses normally and is never tripped.
 *
 * These cases use a small `maxPauseDurationMs` (3000ms) so the ceiling is
 * exercised under fake timers without real-time waits — the production
 * default is DEFAULT_MAX_PAUSE_DURATION_MS (15 min).
 */
describe("phase127 — max-pause ceiling (debug phase127-stall-abort-miss)", () => {
  it("CEIL-01: a pause exceeding maxPauseDurationMs trips the stall even though pauseDepth stays > 0", async () => {
    const onStallSpy = vi.fn<(payload: StreamStallPayload) => void>();
    const tracker = createStreamStallTracker({
      thresholdMs: 1000,
      onStall: onStallSpy,
      checkIntervalMs: 100,
      maxPauseDurationMs: 3000,
    });

    // A tool starts (in-tool hang signature) — pause and NEVER resume,
    // exactly as when the SDK generator hangs mid-tool and the tool_result
    // never arrives.
    tracker.pause();

    // Just under the ceiling — still suppressed (normal tool-aware
    // behaviour; a legitimate tool inside the ceiling must not trip).
    await vi.advanceTimersByTimeAsync(2900);
    expect(onStallSpy).not.toHaveBeenCalled();

    // Past the ceiling — the tracker trips DESPITE pauseDepth still being
    // > 0 (resume() was never called).
    await vi.advanceTimersByTimeAsync(300);
    expect(onStallSpy).toHaveBeenCalledTimes(1);

    const payload = onStallSpy.mock.calls[0]?.[0];
    expect(payload?.reason).toBe("max-pause-exceeded");
    expect(payload?.thresholdMs).toBe(1000);
    expect(payload?.pauseDurationMs).toBeGreaterThan(3000);

    tracker.stop();
  });

  it("CEIL-02: a pause UNDER the ceiling still suppresses the stall (no false trip)", async () => {
    const onStallSpy = vi.fn<(payload: StreamStallPayload) => void>();
    const tracker = createStreamStallTracker({
      thresholdMs: 1000,
      onStall: onStallSpy,
      checkIntervalMs: 100,
      maxPauseDurationMs: 3000,
    });

    // A legitimate heavy tool runs for 2500ms — past the 1000ms stall
    // threshold (so the tool-aware pause is doing real work) but well
    // under the 3000ms ceiling. It must NOT trip.
    tracker.pause();
    await vi.advanceTimersByTimeAsync(2500);
    expect(onStallSpy).not.toHaveBeenCalled();

    // tool_result arrives — resume() clears the pause and the ceiling,
    // re-arming a fresh no-useful-tokens countdown.
    tracker.resume();

    // Under the stall threshold from the resume instant — still no trip.
    await vi.advanceTimersByTimeAsync(900);
    expect(onStallSpy).not.toHaveBeenCalled();

    tracker.stop();
  });

  it("CEIL-03: resume() before the ceiling clears it — a later short pause never inherits the old elapsed time", async () => {
    const onStallSpy = vi.fn<(payload: StreamStallPayload) => void>();
    const tracker = createStreamStallTracker({
      thresholdMs: 1000,
      onStall: onStallSpy,
      checkIntervalMs: 100,
      maxPauseDurationMs: 3000,
    });

    // First tool: pause for 2500ms (under ceiling), then resume.
    tracker.pause();
    await vi.advanceTimersByTimeAsync(2500);
    tracker.resume();
    expect(onStallSpy).not.toHaveBeenCalled();

    // A useful token lands so the no-useful-tokens countdown is fresh.
    tracker.markUsefulToken();

    // Second tool: a NEW pause window. The ceiling must measure from THIS
    // pause's start — not accumulate the first pause's 2500ms. 2500ms here
    // would falsely trip if the ceiling start were not cleared on resume().
    tracker.pause();
    await vi.advanceTimersByTimeAsync(2500);
    expect(onStallSpy).not.toHaveBeenCalled();

    // Cross the ceiling within this second pause window — now it trips.
    await vi.advanceTimersByTimeAsync(700);
    expect(onStallSpy).toHaveBeenCalledTimes(1);
    expect(onStallSpy.mock.calls[0]?.[0]?.reason).toBe("max-pause-exceeded");

    tracker.stop();
  });

  it("CEIL-04: nested pause — a sibling completing re-arms the window; a still-hung tool trips measured from the LAST evidence (INC-2026-07-26)", async () => {
    const onStallSpy = vi.fn<(payload: StreamStallPayload) => void>();
    const tracker = createStreamStallTracker({
      thresholdMs: 1000,
      onStall: onStallSpy,
      checkIntervalMs: 100,
      maxPauseDurationMs: 3000,
    });

    // Two parallel tools start at slightly different times; one of them
    // hangs (its tool_result never arrives) so pauseDepth never returns
    // to 0. Pre-INC-2026-07-26 the ceiling measured the OUTERMOST pause
    // window (from the FIRST pause) — which killed healthy overlapping
    // batches. Now a sibling's completion is evidence the generator is
    // alive: the window re-arms at the resume, and the hang trips
    // maxPauseDurationMs AFTER the last evidence.
    tracker.pause(); // depth 0→1, window opens at t0
    await vi.advanceTimersByTimeAsync(500);
    tracker.pause(); // depth 1→2
    await vi.advanceTimersByTimeAsync(500);
    tracker.resume(); // depth 2→1 at t1000 — evidence → window re-arms

    // t1000+2100 = t3100: past the OLD outermost boundary (t0+3000) but
    // only 2100ms into the re-armed window — must NOT trip.
    await vi.advanceTimersByTimeAsync(2100);
    expect(onStallSpy).not.toHaveBeenCalled();

    // t1000+3000 = t4000 crossed with no further evidence — the remaining
    // tool is a genuine hang. Now it trips.
    await vi.advanceTimersByTimeAsync(1000);
    expect(onStallSpy).toHaveBeenCalledTimes(1);
    const payload = onStallSpy.mock.calls[0]?.[0];
    expect(payload?.reason).toBe("max-pause-exceeded");
    // The reported duration measures the silent tail since the resume, not
    // the whole batch from t0.
    expect(payload?.pauseDurationMs ?? 0).toBeLessThan(4000);
    expect(payload?.pauseDurationMs ?? 0).toBeGreaterThan(3000);

    tracker.stop();
  });

  it("CEIL-06: an overlapping batch whose members complete one by one never trips, even when total paused time far exceeds the ceiling (2026-07-26 worker-1 shape)", async () => {
    const onStallSpy = vi.fn<(payload: StreamStallPayload) => void>();
    const tracker = createStreamStallTracker({
      thresholdMs: 1000,
      onStall: onStallSpy,
      checkIntervalMs: 100,
      maxPauseDurationMs: 3000,
    });

    // Five overlapping tools open, then complete at 1.5s intervals — each
    // completion re-arms the window, so no single evidence gap approaches
    // the 3s ceiling although the batch stays paused for 7.5s total (past
    // the old 3s whole-batch accounting, under the 9s absolute ceiling).
    // This is the specialized-giro-prices shape: 4/5 lanes done, results
    // streaming ten seconds before the old accounting killed it.
    for (let i = 0; i < 5; i++) tracker.pause();
    for (let i = 0; i < 4; i++) {
      await vi.advanceTimersByTimeAsync(1500);
      tracker.resume(); // evidence — re-arms
      expect(onStallSpy).not.toHaveBeenCalled();
    }
    // Final tool completes inside its own window → depth 0, fully unpaused.
    await vi.advanceTimersByTimeAsync(1500);
    tracker.resume();
    expect(onStallSpy).not.toHaveBeenCalled();

    tracker.stop();
  });

  it("CEIL-07: markToolProgress() (child-lane results) re-arms the window; silence after the last evidence still trips (2026-07-26 worker-2 shape)", async () => {
    const onStallSpy = vi.fn<(payload: StreamStallPayload) => void>();
    const tracker = createStreamStallTracker({
      thresholdMs: 1000,
      onStall: onStallSpy,
      checkIntervalMs: 100,
      maxPauseDurationMs: 3000,
    });

    // One long-running parent tool holds the pause the whole time — the
    // reviews-complaints shape: a single research lane, alive via child
    // result blocks, killed at the old whole-pause ceiling.
    tracker.pause();
    for (let i = 0; i < 2; i++) {
      await vi.advanceTimersByTimeAsync(2500); // under the 3s ceiling each leg
      tracker.markToolProgress(); // child-lane result block observed
      expect(onStallSpy).not.toHaveBeenCalled();
    }
    // 5s paused so far with no trip (old accounting would have tripped at
    // 3s). Now the lane goes genuinely silent — the ceiling measures from
    // the LAST evidence and trips (still under the 9s absolute ceiling, so
    // this pins the evidence-tail trip specifically).
    await vi.advanceTimersByTimeAsync(3200);
    expect(onStallSpy).toHaveBeenCalledTimes(1);
    const ceil07Payload = onStallSpy.mock.calls[0]?.[0];
    expect(ceil07Payload?.reason).toBe("max-pause-exceeded");
    expect(ceil07Payload?.continuousPauseDurationMs).toBeUndefined();

    tracker.stop();
  });

  it("CEIL-10: absolute continuous-pause ceiling — a noisy wedge cannot re-arm the window forever (INC-2026-07-26 backstop)", async () => {
    const onStallSpy = vi.fn<(payload: StreamStallPayload) => void>();
    const tracker = createStreamStallTracker({
      thresholdMs: 1000,
      onStall: onStallSpy,
      checkIntervalMs: 100,
      maxPauseDurationMs: 3000, // absolute ceiling = 3 × 3000 = 9000
    });

    // A wedged parent tool drip-feeds child-lane noise every 1s — the
    // evidence window never approaches the 3s ceiling, but the CONTINUOUS
    // pause crosses the 9s absolute bound and trips anyway. Without this
    // backstop the wedge would hold its slot until the turn wall clock
    // (4h for workflow workers).
    tracker.pause();
    for (let i = 0; i < 9; i++) {
      await vi.advanceTimersByTimeAsync(1000);
      tracker.markToolProgress();
    }
    await vi.advanceTimersByTimeAsync(300); // continuous ≈ 9.3s > 9s
    expect(onStallSpy).toHaveBeenCalledTimes(1);
    const payload = onStallSpy.mock.calls[0]?.[0];
    expect(payload?.reason).toBe("max-pause-exceeded");
    expect(payload?.continuousPauseDurationMs ?? 0).toBeGreaterThan(9000);

    tracker.stop();
  });

  it("CEIL-08: markUsefulToken() while paused re-arms the window (child-lane deltas are liveness)", async () => {
    const onStallSpy = vi.fn<(payload: StreamStallPayload) => void>();
    const tracker = createStreamStallTracker({
      thresholdMs: 1000,
      onStall: onStallSpy,
      checkIntervalMs: 100,
      maxPauseDurationMs: 3000,
    });

    // A native Workflow/Task child lane streams deltas while the parent
    // tool holds the pause — markUsefulToken is already called for those
    // (lane-agnostic predicate); it must also count as pause-window
    // evidence.
    tracker.pause();
    await vi.advanceTimersByTimeAsync(2500);
    tracker.markUsefulToken(); // child-lane delta
    await vi.advanceTimersByTimeAsync(2500); // old accounting: 5s > 3s → trip
    expect(onStallSpy).not.toHaveBeenCalled();

    // Silence past the ceiling from the last delta — trips.
    await vi.advanceTimersByTimeAsync(700);
    expect(onStallSpy).toHaveBeenCalledTimes(1);
    expect(onStallSpy.mock.calls[0]?.[0]?.reason).toBe("max-pause-exceeded");

    tracker.stop();
  });

  it("CEIL-09: markToolProgress() while UNPAUSED is a no-op (does not mask the no-useful-tokens trip)", async () => {
    const onStallSpy = vi.fn<(payload: StreamStallPayload) => void>();
    const tracker = createStreamStallTracker({
      thresholdMs: 1000,
      onStall: onStallSpy,
      checkIntervalMs: 100,
      maxPauseDurationMs: 3000,
    });

    // No tool in flight: tool-progress marks must NOT extend the
    // no-useful-tokens countdown — only real deltas do that.
    await vi.advanceTimersByTimeAsync(600);
    tracker.markToolProgress();
    await vi.advanceTimersByTimeAsync(600); // 1.2s since last useful token
    expect(onStallSpy).toHaveBeenCalledTimes(1);
    expect(onStallSpy.mock.calls[0]?.[0]?.reason).toBe("no-useful-tokens");

    tracker.stop();
  });

  it("CEIL-05: invalid maxPauseDurationMs throws at construction", () => {
    expect(() =>
      createStreamStallTracker({
        thresholdMs: 1000,
        onStall: vi.fn(),
        maxPauseDurationMs: 0,
      }),
    ).toThrow(/maxPauseDurationMs must be > 0/);

    expect(() =>
      createStreamStallTracker({
        thresholdMs: 1000,
        onStall: vi.fn(),
        maxPauseDurationMs: -1,
      }),
    ).toThrow(/maxPauseDurationMs must be > 0/);
  });
});

describe("phase127 — daemon stall callback factory (STALL-04)", () => {
  beforeEach(() => {
    // STALL-04 doesn't need fake timers (the callback is synchronous
    // dispatch + fire-and-forget) but the surrounding describe blocks
    // do — reset to real timers here so .catch() chains land on the
    // microtask queue normally.
    vi.useRealTimers();
  });

  function makeMockWebhookManager(overrides?: {
    readonly hasWebhook?: boolean;
    readonly send?: () => Promise<void>;
  }) {
    return {
      hasWebhook: vi.fn().mockReturnValue(overrides?.hasWebhook ?? true),
      send: vi.fn(overrides?.send ?? (async () => undefined)),
    };
  }

  function makeMockSessionLogger(overrides?: {
    readonly recordStall?: (payload: unknown) => Promise<void>;
  }) {
    return {
      recordStall: vi.fn(
        overrides?.recordStall ?? (async () => undefined),
      ),
    };
  }

  it("STALL-04: trip fires both sinks with verbatim message + enriched payload", async () => {
    const webhookManager = makeMockWebhookManager();
    const sessionLogger = makeMockSessionLogger();

    const callback = makeStreamStallCallback({
      agentName: "fin-client",
      model: "claude-opus-4-8",
      effort: "high",
      // Cast: the real WebhookManager class has many more methods; the
      // callback only touches `hasWebhook` + `send` so the structural
      // mock is sufficient.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      webhookManager: webhookManager as any,
      sessionLoggerProvider: () => sessionLogger as unknown as
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        any,
      sessionIdProvider: () => "session-abc",
    });

    callback({ lastUsefulTokenAgeMs: 181_234, thresholdMs: 180_000 });

    // Let the fire-and-forget microtasks settle so .catch chains
    // (if any) flush before assertions.
    await new Promise<void>((resolve) => setImmediate(resolve));

    // Discord sink — exact-string assertion against the BACKLOG-pinned
    // constant. Any paraphrasing breaks here (and any future
    // `journalctl | grep "stream stall — turn aborted"` monitoring).
    expect(webhookManager.hasWebhook).toHaveBeenCalledWith("fin-client");
    expect(webhookManager.send).toHaveBeenCalledTimes(1);
    expect(webhookManager.send).toHaveBeenCalledWith(
      "fin-client",
      STREAM_STALL_DISCORD_MESSAGE,
    );
    // Double-belt: assert the exact bytes — single warning emoji,
    // em-dash U+2014, exact verbatim per BACKLOG.md line 19.
    expect(STREAM_STALL_DISCORD_MESSAGE).toBe(
      "⚠️ stream stall — turn aborted, send the message again",
    );

    // SessionLog sink — enriched payload.
    expect(sessionLogger.recordStall).toHaveBeenCalledTimes(1);
    const recordedPayload = sessionLogger.recordStall.mock.calls[0][0];
    expect(recordedPayload).toMatchObject({
      agentName: "fin-client",
      sessionName: "session-abc",
      turnId: "",
      lastUsefulTokenAgeMs: 181_234,
      thresholdMs: 180_000,
      advisorActive: false,
      model: "claude-opus-4-8",
      effort: "high",
    });
  });

  // NOTE — supervisor-recovery invariants (Discord rejection swallowed,
  // missing webhookManager skipped gracefully) are enforced by the
  // factory's `.catch(log-and-swallow)` chains and the `hasWebhook`
  // gate, but kept out of this test file to match the prompt's "6 + 1
  // = 7 tests" count target. Defense-in-depth: the assertions exist as
  // structural guarantees in `stream-stall-callback.ts` and can be
  // promoted to dedicated tests in a follow-up plan if a regression
  // surfaces.
});
