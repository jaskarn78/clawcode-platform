/**
 * 999.171 — trail repaint scheduler (the frozen-elapsed fix).
 *
 * The status trail only repainted on tool / claim events, and a paint inside
 * `editIntervalMs` was DROPPED with no catch-up — so during a long silent
 * think the elapsed time in the header froze. The scheduler ticks every 5 s,
 * honours the edit interval, and turns a throttled request into exactly one
 * catch-up paint instead of losing it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { TRAIL_REPAINT_TICK_MS, createTrailRepaintScheduler } from "../trail-repaint.js";

const INTERVAL_MS = 750;

/**
 * Test clock = the faked `Date` (vi.useFakeTimers fakes it), injected as
 * `now`, so the scheduler's clock and its timers advance together. The
 * default paint records itself as the last edit, like the bridge's paintTrail.
 */
function setup(opts: { lastPaintAt?: number; updatesLastPaint?: boolean } = {}) {
  let lastPaintAt = opts.lastPaintAt ?? 0;
  const paint = vi.fn(async () => {
    if (opts.updatesLastPaint !== false) lastPaintAt = Date.now();
  });
  const onError = vi.fn();
  const scheduler = createTrailRepaintScheduler({
    paint,
    intervalMs: INTERVAL_MS,
    lastPaintAt: () => lastPaintAt,
    now: () => Date.now(),
    onError,
  });
  const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms);
  return {
    paint,
    onError,
    scheduler,
    advance,
    setLastPaintAt: (v: number) => {
      lastPaintAt = v;
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(100_000);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("createTrailRepaintScheduler", () => {
  it("ticks every 5 s by default", () => {
    expect(TRAIL_REPAINT_TICK_MS).toBe(5_000);
  });

  it("a request long after the last paint paints immediately, once", async () => {
    const h = setup({ lastPaintAt: 0 });
    h.scheduler.request();
    expect(h.paint).toHaveBeenCalledTimes(1);
    await h.advance(10_000);
    expect(h.paint).toHaveBeenCalledTimes(1);
  });

  it("a request inside the interval is not dropped: exactly one catch-up paint at lastPaintAt + interval", async () => {
    const h = setup();
    h.setLastPaintAt(Date.now() - 200); // painted 200 ms ago
    h.scheduler.request();
    expect(h.paint).not.toHaveBeenCalled();
    await h.advance(549);
    expect(h.paint).not.toHaveBeenCalled();
    await h.advance(1);
    expect(h.paint).toHaveBeenCalledTimes(1);
    await h.advance(5_000);
    expect(h.paint).toHaveBeenCalledTimes(1);
  });

  it("three requests inside the window coalesce into the one catch-up paint", async () => {
    const h = setup();
    h.setLastPaintAt(Date.now() - 100);
    h.scheduler.request();
    await h.advance(100);
    h.scheduler.request();
    await h.advance(100);
    h.scheduler.request();
    expect(h.paint).not.toHaveBeenCalled();
    await h.advance(450);
    expect(h.paint).toHaveBeenCalledTimes(1);
    await h.advance(5_000);
    expect(h.paint).toHaveBeenCalledTimes(1);
  });

  it("a catch-up re-checks the interval if another path painted meanwhile", async () => {
    const h = setup();
    h.setLastPaintAt(Date.now() - 200);
    h.scheduler.request(); // catch-up due in 550 ms
    await h.advance(300);
    h.setLastPaintAt(Date.now()); // a tool event painted directly
    await h.advance(250); // original catch-up fires: too soon, reschedules
    expect(h.paint).not.toHaveBeenCalled();
    await h.advance(500);
    expect(h.paint).toHaveBeenCalledTimes(1);
  });

  it("start() repaints on every tick while the interval allows (elapsed keeps moving)", async () => {
    const h = setup();
    h.scheduler.start();
    await h.advance(TRAIL_REPAINT_TICK_MS * 3);
    expect(h.paint.mock.calls.length).toBeGreaterThanOrEqual(3);
    h.scheduler.stop();
  });

  it("start() twice is a no-op (one ticker)", async () => {
    const h = setup();
    h.scheduler.start();
    h.scheduler.start();
    await h.advance(TRAIL_REPAINT_TICK_MS);
    expect(h.paint).toHaveBeenCalledTimes(1);
    h.scheduler.stop();
  });

  it("stop() is terminal: no ticker paint, no pending catch-up, request() and start() are no-ops", async () => {
    const h = setup();
    h.scheduler.start();
    h.setLastPaintAt(Date.now() - 100);
    h.scheduler.request(); // catch-up pending
    expect(h.scheduler.stopped).toBe(false);
    h.scheduler.stop();
    expect(h.scheduler.stopped).toBe(true);
    await h.advance(TRAIL_REPAINT_TICK_MS * 3);
    h.scheduler.request();
    h.scheduler.start();
    await h.advance(TRAIL_REPAINT_TICK_MS * 3);
    expect(h.paint).not.toHaveBeenCalled();
    h.scheduler.stop(); // idempotent
    expect(h.scheduler.stopped).toBe(true);
  });

  it("requests during an in-flight paint produce exactly one follow-up paint after it settles", async () => {
    const h = setup({ lastPaintAt: 0, updatesLastPaint: false });
    let release!: () => void;
    h.paint.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    h.scheduler.request();
    expect(h.paint).toHaveBeenCalledTimes(1);
    h.scheduler.request();
    h.scheduler.request();
    h.scheduler.request();
    expect(h.paint).toHaveBeenCalledTimes(1);
    release();
    await h.advance(0);
    expect(h.paint).toHaveBeenCalledTimes(2);
    await h.advance(10_000);
    expect(h.paint).toHaveBeenCalledTimes(2);
  });

  it("the follow-up of an in-flight paint still honours the interval", async () => {
    const h = setup({ lastPaintAt: 0 });
    let release!: () => void;
    h.paint.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    h.scheduler.request();
    h.setLastPaintAt(Date.now()); // the in-flight paint's edit landed
    h.scheduler.request();
    release();
    await h.advance(0);
    expect(h.paint).toHaveBeenCalledTimes(1);
    await h.advance(INTERVAL_MS);
    expect(h.paint).toHaveBeenCalledTimes(2);
  });

  it("a rejecting paint is swallowed into onError and later requests still paint", async () => {
    const h = setup({ lastPaintAt: 0, updatesLastPaint: false });
    const boom = new Error("discord 500");
    h.paint.mockRejectedValueOnce(boom);
    h.scheduler.request();
    await h.advance(0);
    expect(h.onError).toHaveBeenCalledWith(boom);
    h.scheduler.request();
    await h.advance(0);
    expect(h.paint).toHaveBeenCalledTimes(2);
  });

  it("a synchronously throwing paint is swallowed too", async () => {
    const h = setup({ lastPaintAt: 0, updatesLastPaint: false });
    h.paint.mockImplementationOnce(() => {
      throw new Error("sync boom");
    });
    expect(() => h.scheduler.request()).not.toThrow();
    await h.advance(0);
    expect(h.onError).toHaveBeenCalledTimes(1);
    h.scheduler.request();
    expect(h.paint).toHaveBeenCalledTimes(2);
  });
});
