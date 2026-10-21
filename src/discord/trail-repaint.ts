/**
 * 999.171 — repaint scheduler for the live status trail (the freeze fix).
 *
 * The trail used to repaint only on tool / claim events, through a
 * HoldStatusThrottle-style gate that DROPS a paint landing inside
 * `editIntervalMs` with no catch-up. Elapsed time only moves on a paint, so
 * during a long silent think the header froze at its last value. This
 * scheduler:
 *   - ticks every TRAIL_REPAINT_TICK_MS while started, so elapsed keeps moving;
 *   - honours the edit interval: a request inside it becomes ONE catch-up
 *     paint at `lastPaintAt + intervalMs` (coalesced), never a lost one;
 *   - never overlaps paints: a request while one is in flight marks the trail
 *     dirty and yields exactly one follow-up after it settles;
 *   - swallows paint errors into `onError` (the status card is cosmetic);
 *   - unrefs every timer, so a cosmetic repaint never holds the process open;
 *   - stops for good on stop().
 *
 * `paint` must not call request() itself, and `lastPaintAt` should be the
 * caller's real last-edit time (the catch-up re-checks it when it fires).
 */

/** How often an open, active trail repaints (elapsed moves at least this often). */
export const TRAIL_REPAINT_TICK_MS = 5_000;

export interface TrailRepaintOptions {
  readonly paint: () => Promise<void>;
  /** Minimum gap between paints (perf.streaming.editIntervalMs). */
  readonly intervalMs: number;
  /** When the last edit actually landed (any path, not only this scheduler). */
  readonly lastPaintAt: () => number;
  readonly tickMs?: number;
  readonly now?: () => number;
  readonly onError?: (err: unknown) => void;
}

export interface TrailRepaintScheduler {
  /** Paint as soon as the interval allows; coalesces with any pending paint. */
  request(): void;
  /** Begin the periodic tick. Idempotent; a no-op after stop(). */
  start(): void;
  /** Terminal: clears the ticker and any pending catch-up. Idempotent. */
  stop(): void;
  readonly stopped: boolean;
}

type Timer = ReturnType<typeof setTimeout>;

function unref(timer: Timer): void {
  (timer as { unref?: () => void }).unref?.();
}

export function createTrailRepaintScheduler(
  opts: TrailRepaintOptions,
): TrailRepaintScheduler {
  const tickMs = opts.tickMs ?? TRAIL_REPAINT_TICK_MS;
  const now = opts.now ?? Date.now;
  let stopped = false;
  let inFlight = false;
  let dirty = false;
  let ticker: ReturnType<typeof setInterval> | null = null;
  let catchUp: Timer | null = null;

  const reportError = (err: unknown): void => {
    try {
      opts.onError?.(err);
    } catch {
      // an error reporter must never break the scheduler
    }
  };

  const clearCatchUp = (): void => {
    if (catchUp !== null) {
      clearTimeout(catchUp);
      catchUp = null;
    }
  };

  const run = async (): Promise<void> => {
    inFlight = true;
    try {
      await opts.paint();
    } catch (err) {
      reportError(err);
    } finally {
      inFlight = false;
    }
    if (dirty && !stopped) {
      dirty = false;
      request();
    }
  };

  const request = (): void => {
    if (stopped) return;
    if (inFlight) {
      dirty = true;
      return;
    }
    const since = now() - opts.lastPaintAt();
    if (since >= opts.intervalMs) {
      clearCatchUp();
      void run();
      return;
    }
    if (catchUp !== null) return;
    catchUp = setTimeout(() => {
      catchUp = null;
      request();
    }, opts.intervalMs - since);
    unref(catchUp);
  };

  return {
    request,
    start(): void {
      if (stopped || ticker !== null) return;
      ticker = setInterval(request, tickMs);
      unref(ticker);
    },
    stop(): void {
      stopped = true;
      dirty = false;
      if (ticker !== null) {
        clearInterval(ticker);
        ticker = null;
      }
      clearCatchUp();
    },
    get stopped(): boolean {
      return stopped;
    },
  };
}
