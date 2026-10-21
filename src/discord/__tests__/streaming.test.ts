import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  ProgressiveMessageEditor,
  isDiscordRateLimitError,
} from "../streaming.js";

/**
 * Phase 54 Plan 03 — ProgressiveMessageEditor cadence + first_visible_token
 * span + rate-limit backoff tests.
 *
 * Covers:
 *   - Default editIntervalMs lowered from 1500ms to 750ms
 *   - Per-agent editIntervalMs override honored for 2nd+ chunks
 *   - First editFn call still fires immediately (preserves pre-plan UX)
 *   - first_visible_token span emitted once per editor instance on the
 *     first editFn invocation (only when a Turn is passed)
 *   - Rate-limit error detection centralized in isDiscordRateLimitError
 *     (DiscordAPIError code 20028, HTTP 429, RateLimitError name)
 *   - On rate-limit error, editIntervalMs DOUBLES for rest of turn
 *   - Non-rate-limit rejections do NOT double the interval
 *   - Multiple rate-limit hits double cumulatively (750 -> 1500 -> 3000)
 *   - Single WARN per editor instance on rate-limit detection
 *   - flush() regression check (pre-plan behavior preserved)
 */

function makeSpanMock() {
  return { end: vi.fn() };
}

function makeTurnMock() {
  const span = makeSpanMock();
  const turn = {
    startSpan: vi.fn().mockReturnValue(span),
    end: vi.fn(),
  };
  return { turn, span };
}

function makeLogMock() {
  return {
    warn: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
  };
}

describe("isDiscordRateLimitError", () => {
  it("returns true for DiscordAPIError with code 20028", () => {
    const err = { code: 20028, message: "Rate limited" };
    expect(isDiscordRateLimitError(err)).toBe(true);
  });

  it("returns true for HTTP 429 error (status === 429)", () => {
    const err = { status: 429, message: "Too Many Requests" };
    expect(isDiscordRateLimitError(err)).toBe(true);
  });

  it("returns true for discord.js RateLimitError instances (name match)", () => {
    class RateLimitError extends Error {
      constructor() {
        super("rl");
        this.name = "RateLimitError";
      }
    }
    expect(isDiscordRateLimitError(new RateLimitError())).toBe(true);
  });

  it("returns false for generic permission errors", () => {
    const err = { code: 50001, message: "Missing Access" };
    expect(isDiscordRateLimitError(err)).toBe(false);
  });

  it("returns false for non-object / null / undefined", () => {
    expect(isDiscordRateLimitError(null)).toBe(false);
    expect(isDiscordRateLimitError(undefined)).toBe(false);
    expect(isDiscordRateLimitError("string")).toBe(false);
    expect(isDiscordRateLimitError(42)).toBe(false);
  });
});

describe("ProgressiveMessageEditor (Phase 54)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("Test 1: default editIntervalMs is 750ms (dropped from 1500)", async () => {
    const editFn = vi.fn().mockResolvedValue(undefined);
    const editor = new ProgressiveMessageEditor({ editFn });

    editor.update("first"); // Fires immediately
    await vi.advanceTimersByTimeAsync(0);
    expect(editFn).toHaveBeenCalledTimes(1);

    editor.update("first + second");
    // At 749ms no second edit should have fired
    await vi.advanceTimersByTimeAsync(749);
    expect(editFn).toHaveBeenCalledTimes(1);

    // At 750ms, the second edit fires
    await vi.advanceTimersByTimeAsync(1);
    expect(editFn).toHaveBeenCalledTimes(2);
  });

  it("Test 2: editIntervalMs override is respected for 2nd+ chunks", async () => {
    const editFn = vi.fn().mockResolvedValue(undefined);
    const editor = new ProgressiveMessageEditor({
      editFn,
      editIntervalMs: 500,
    });

    editor.update("first");
    await vi.advanceTimersByTimeAsync(0);
    expect(editFn).toHaveBeenCalledTimes(1);

    editor.update("first + second");
    await vi.advanceTimersByTimeAsync(499);
    expect(editFn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(editFn).toHaveBeenCalledTimes(2);
  });

  it("Test 3: first update() ALWAYS fires editFn immediately regardless of editIntervalMs", async () => {
    const editFn = vi.fn().mockResolvedValue(undefined);
    const editor = new ProgressiveMessageEditor({
      editFn,
      editIntervalMs: 10000, // Very high
    });

    editor.update("first chunk");
    // Yield microtasks only, no timer advance
    await Promise.resolve();
    expect(editFn).toHaveBeenCalledTimes(1);
    expect(editFn).toHaveBeenCalledWith("first chunk");
  });

  it("Test 4: with Turn, first editFn invocation starts + ends a first_visible_token span exactly once", async () => {
    const editFn = vi.fn().mockResolvedValue(undefined);
    const { turn, span } = makeTurnMock();
    const editor = new ProgressiveMessageEditor({ editFn, turn: turn as any });

    editor.update("first");
    await vi.advanceTimersByTimeAsync(0);

    // startSpan was called once with "first_visible_token" and empty metadata
    expect(turn.startSpan).toHaveBeenCalledTimes(1);
    expect(turn.startSpan).toHaveBeenCalledWith("first_visible_token", {});
    // Span was ended synchronously
    expect(span.end).toHaveBeenCalledTimes(1);
  });

  it("Test 5: subsequent update() calls do NOT re-emit first_visible_token (once per editor instance)", async () => {
    const editFn = vi.fn().mockResolvedValue(undefined);
    const { turn } = makeTurnMock();
    const editor = new ProgressiveMessageEditor({ editFn, turn: turn as any });

    editor.update("first");
    await vi.advanceTimersByTimeAsync(0);
    editor.update("first + second");
    await vi.advanceTimersByTimeAsync(750);
    editor.update("first + second + third");
    await vi.advanceTimersByTimeAsync(750);

    // Only the FIRST update emits the first_visible_token span
    const fvtCalls = turn.startSpan.mock.calls.filter(
      (c) => c[0] === "first_visible_token",
    );
    expect(fvtCalls.length).toBe(1);
  });

  it("Test 6: without a Turn (undefined), no span emitted and no crash", async () => {
    const editFn = vi.fn().mockResolvedValue(undefined);
    const editor = new ProgressiveMessageEditor({ editFn });

    expect(() => editor.update("hello")).not.toThrow();
    await vi.advanceTimersByTimeAsync(0);
    expect(editFn).toHaveBeenCalledTimes(1);
  });

  it("Test 7: DiscordAPIError code 20028 rejection doubles editIntervalMs for subsequent chunks", async () => {
    const editFn = vi
      .fn()
      // First call rejects with rate-limit
      .mockRejectedValueOnce({ code: 20028, message: "Rate limited" })
      .mockResolvedValue(undefined);
    const log = makeLogMock();
    const editor = new ProgressiveMessageEditor({
      editFn,
      editIntervalMs: 500,
      log: log as any,
      agent: "test-agent",
      turnId: "turn-1",
    });

    editor.update("first"); // Rejects with 20028
    await vi.advanceTimersByTimeAsync(0);
    // Yield microtasks so the rejected-promise catch handler runs
    await Promise.resolve();
    await Promise.resolve();
    expect(editFn).toHaveBeenCalledTimes(1);

    editor.update("first + second");
    // Original interval (500) should no longer apply — now doubled to 1000
    await vi.advanceTimersByTimeAsync(500);
    expect(editFn).toHaveBeenCalledTimes(1); // still 1 at 500ms after doubling
    await vi.advanceTimersByTimeAsync(500);
    expect(editFn).toHaveBeenCalledTimes(2); // now 2 at 1000ms post-update
  });

  it("Test 8: HTTP 429 (err.status === 429) rejection also doubles editIntervalMs", async () => {
    const editFn = vi
      .fn()
      .mockRejectedValueOnce({ status: 429, message: "429" })
      .mockResolvedValue(undefined);
    const editor = new ProgressiveMessageEditor({
      editFn,
      editIntervalMs: 300,
    });

    editor.update("first");
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();
    await Promise.resolve();

    editor.update("second");
    await vi.advanceTimersByTimeAsync(300);
    expect(editFn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(300);
    expect(editFn).toHaveBeenCalledTimes(2);
  });

  it("Test 9: non-rate-limit rejection does NOT double the interval", async () => {
    const editFn = vi
      .fn()
      .mockRejectedValueOnce({ code: 50001, message: "Missing Access" })
      .mockResolvedValue(undefined);
    const editor = new ProgressiveMessageEditor({
      editFn,
      editIntervalMs: 500,
    });

    editor.update("first");
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();
    await Promise.resolve();

    editor.update("second");
    await vi.advanceTimersByTimeAsync(500);
    expect(editFn).toHaveBeenCalledTimes(2);
  });

  it("Test 10: multiple rate-limit errors double cumulatively (750 -> 1500 -> 3000)", async () => {
    const editFn = vi
      .fn()
      .mockRejectedValueOnce({ code: 20028 })
      .mockRejectedValueOnce({ code: 20028 })
      .mockResolvedValue(undefined);
    const editor = new ProgressiveMessageEditor({ editFn }); // default 750

    editor.update("first");
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();
    await Promise.resolve();
    // Interval now 1500 after first 20028

    editor.update("second");
    await vi.advanceTimersByTimeAsync(1500);
    await Promise.resolve();
    await Promise.resolve();
    expect(editFn).toHaveBeenCalledTimes(2);
    // Interval now 3000 after second 20028

    editor.update("third");
    await vi.advanceTimersByTimeAsync(2999);
    expect(editFn).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(editFn).toHaveBeenCalledTimes(3);
  });

  it("Test 11: single WARN per editor instance regardless of rate-limit count", async () => {
    const editFn = vi
      .fn()
      .mockRejectedValueOnce({ code: 20028 })
      .mockRejectedValueOnce({ code: 20028 })
      .mockResolvedValue(undefined);
    const log = makeLogMock();
    const editor = new ProgressiveMessageEditor({
      editFn,
      editIntervalMs: 300,
      log: log as any,
      agent: "agent-a",
      turnId: "turn-123",
    });

    editor.update("first");
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();
    await Promise.resolve();

    editor.update("second");
    await vi.advanceTimersByTimeAsync(600); // doubled interval 600
    await Promise.resolve();
    await Promise.resolve();

    // Only ONE warn emitted per editor instance (the first hit)
    expect(log.warn).toHaveBeenCalledTimes(1);
    const warnArgs = log.warn.mock.calls[0]!;
    const payload = warnArgs[0] as Record<string, unknown>;
    expect(payload.agent).toBe("agent-a");
    expect(payload.turnId).toBe("turn-123");
    expect(payload.original_ms).toBe(300);
    expect(payload.backoff_ms).toBe(600);
  });

  /**
   * Phase 100-fu — concurrent-flush lock (PME-LOCK-*).
   *
   * Bug: editFn was invoked fire-and-forget. When the first send was still
   * in-flight (~500ms Discord network round-trip) and the throttle timer
   * (default 750ms) fired the next chunk, both calls reached bridge.ts's
   * editFn implementation. Both saw messageRef.current === null, both called
   * channel.send(content), and Discord showed TWO near-identical messages
   * instead of ONE progressively-edited message.
   *
   * Fix: serialize editFn invocations through an in-flight promise so call N+1
   * always awaits call N before starting.
   */
  it("PME-LOCK-1: second editFn call waits for first to resolve (serialized)", async () => {
    // Track editFn lifecycle ordering: when each call starts and ends.
    const events: string[] = [];
    let resolveFirst: (() => void) | null = null;
    let resolveSecond: (() => void) | null = null;

    const editFn = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            events.push("start-1");
            resolveFirst = () => {
              events.push("end-1");
              resolve();
            };
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            events.push("start-2");
            resolveSecond = () => {
              events.push("end-2");
              resolve();
            };
          }),
      );

    const editor = new ProgressiveMessageEditor({
      editFn,
      editIntervalMs: 100,
    });

    editor.update("first"); // immediate
    await Promise.resolve();
    expect(events).toEqual(["start-1"]); // first started, NOT yet ended

    // Schedule second update via timer
    editor.update("second");
    await vi.advanceTimersByTimeAsync(100);
    await Promise.resolve();
    await Promise.resolve();

    // CRITICAL: editFn was called by the editor (call count == 2),
    // BUT the second editFn body must NOT have started executing because
    // the first promise hasn't resolved yet.
    expect(events).toEqual(["start-1"]); // start-2 must NOT appear yet

    // Now resolve the first; the second should now begin.
    resolveFirst!();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(events).toEqual(["start-1", "end-1", "start-2"]);

    // Cleanup so vitest doesn't hang on un-awaited promises
    resolveSecond!();
    await Promise.resolve();
  });

  it("PME-LOCK-2: serialized calls let the second editFn observe state set by the first", async () => {
    // Discord-style mock: first call sets sendCount=1 (simulating channel.send).
    // The second call observes sendCount===1 and takes the edit branch (simulating
    // messageRef.current !== null). Without serialization, both calls would race
    // and BOTH would observe sendCount===0 → both call send → duplicate message.
    let sendCount = 0;
    const seenStateAt = { first: -1, second: -1 };
    let callIndex = 0;

    const editFn = vi.fn().mockImplementation(async () => {
      const idx = callIndex++;
      // Simulate Discord network round-trip: read state, await, then write.
      const observed = sendCount;
      if (idx === 0) seenStateAt.first = observed;
      else seenStateAt.second = observed;
      // Simulate the await on channel.send (next microtask)
      await Promise.resolve();
      await Promise.resolve();
      if (observed === 0) sendCount++;
    });

    const editor = new ProgressiveMessageEditor({
      editFn,
      editIntervalMs: 50,
    });

    editor.update("first");
    await Promise.resolve();
    editor.update("second");
    await vi.advanceTimersByTimeAsync(50);
    // Drain microtasks so both serialized awaits resolve
    for (let i = 0; i < 10; i++) await Promise.resolve();

    expect(seenStateAt.first).toBe(0);
    // Critical: the second call must observe sendCount === 1 (set by first call).
    expect(seenStateAt.second).toBe(1);
    // Net result: only ONE "send" happened (no duplicate Discord message).
    expect(sendCount).toBe(1);
  });

  it("PME-LOCK-3: editFn rejection on call N does not block call N+1", async () => {
    const editFn = vi
      .fn()
      .mockRejectedValueOnce({ code: 50001, message: "Missing Access" })
      .mockResolvedValueOnce(undefined);

    const editor = new ProgressiveMessageEditor({
      editFn,
      editIntervalMs: 100,
    });

    editor.update("first"); // rejects
    await vi.advanceTimersByTimeAsync(0);
    // Drain rejection
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(editFn).toHaveBeenCalledTimes(1);

    editor.update("second"); // must still fire even though prior rejected
    await vi.advanceTimersByTimeAsync(100);
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(editFn).toHaveBeenCalledTimes(2);
  });

  it("Test 12: flush() still sends pending text and calls editFn once at the end (regression)", async () => {
    const editFn = vi.fn().mockResolvedValue(undefined);
    const editor = new ProgressiveMessageEditor({
      editFn,
      editIntervalMs: 5000, // High so timer never fires naturally
    });

    editor.update("first"); // immediate
    await vi.advanceTimersByTimeAsync(0);
    expect(editFn).toHaveBeenCalledTimes(1);

    editor.update("first + second pending");
    // Don't advance timer — just flush
    await editor.flush();
    expect(editFn).toHaveBeenCalledTimes(2);
    expect(editFn).toHaveBeenLastCalledWith("first + second pending");
  });

  // firstEditMinDelayMs — placeholder min-visibility hold
  //
  // Covers the opt-in hold added so the subagent thread's "🔄 Working..."
  // placeholder stays visible for a perceptible window before the first
  // streamed token edits it away (Phase 999.78 boot suppression dropped
  // time-to-first-token to ~500-1000ms, eliding the placeholder visually).

  it("Test 13: firstEditMinDelayMs defers the first edit until the hold window elapses", async () => {
    const editFn = vi.fn().mockResolvedValue(undefined);
    const editor = new ProgressiveMessageEditor({
      editFn,
      editIntervalMs: 750,
      firstEditMinDelayMs: 1500,
    });

    editor.update("first chunk");
    await vi.advanceTimersByTimeAsync(0);
    // Nothing fires synchronously — held
    expect(editFn).toHaveBeenCalledTimes(0);

    // At 1499ms still held
    await vi.advanceTimersByTimeAsync(1499);
    expect(editFn).toHaveBeenCalledTimes(0);

    // At exactly 1500ms the hold timer fires
    await vi.advanceTimersByTimeAsync(1);
    expect(editFn).toHaveBeenCalledTimes(1);
    expect(editFn).toHaveBeenCalledWith("first chunk");
  });

  it("Test 14: subsequent chunks during the hold are absorbed — only the LATEST text is sent when the timer fires", async () => {
    const editFn = vi.fn().mockResolvedValue(undefined);
    const editor = new ProgressiveMessageEditor({
      editFn,
      editIntervalMs: 750,
      firstEditMinDelayMs: 1500,
    });

    editor.update("first");
    await vi.advanceTimersByTimeAsync(200);
    editor.update("first + second");
    await vi.advanceTimersByTimeAsync(400);
    editor.update("first + second + third");
    expect(editFn).toHaveBeenCalledTimes(0);

    // Run out the rest of the 1500ms hold (200+400 = 600 elapsed, need 900 more)
    await vi.advanceTimersByTimeAsync(900);
    expect(editFn).toHaveBeenCalledTimes(1);
    // The LATEST pending text is what gets sent, not the original "first"
    expect(editFn).toHaveBeenCalledWith("first + second + third");
  });

  it("Test 15: flush() during the hold cancels the timer and sends the pending text immediately", async () => {
    const editFn = vi.fn().mockResolvedValue(undefined);
    const editor = new ProgressiveMessageEditor({
      editFn,
      editIntervalMs: 750,
      firstEditMinDelayMs: 1500,
    });

    editor.update("first");
    await vi.advanceTimersByTimeAsync(300);
    editor.update("first + flushed");
    expect(editFn).toHaveBeenCalledTimes(0);

    await editor.flush();
    expect(editFn).toHaveBeenCalledTimes(1);
    expect(editFn).toHaveBeenCalledWith("first + flushed");

    // Advance past the original hold deadline — the timer was cleared by flush,
    // so no extra edits should fire.
    await vi.advanceTimersByTimeAsync(5000);
    expect(editFn).toHaveBeenCalledTimes(1);
  });

  it("Test 16: firstEditMinDelayMs default 0 preserves the immediate-first-edit behavior", async () => {
    const editFn = vi.fn().mockResolvedValue(undefined);
    const editor = new ProgressiveMessageEditor({ editFn });

    editor.update("first");
    await vi.advanceTimersByTimeAsync(0);
    expect(editFn).toHaveBeenCalledTimes(1);
    expect(editFn).toHaveBeenCalledWith("first");
  });
});
