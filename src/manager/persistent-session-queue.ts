/**
 * Phase 73 Plan 01 — depth-1 serial turn queue + pushable async iterable.
 *
 * Two primitives consumed by persistent-session-handle.ts:
 *
 *   SerialTurnQueue: Discord's TurnDispatcher assumes one in-flight turn
 *     per agent; this enforces that invariant at the SessionHandle boundary.
 *     Depth 1 (one in-flight + one queued). A third concurrent send rejects
 *     with QUEUE_FULL — caller (OpenAi server) maps to 429 Retry-After.
 *
 *   AsyncPushQueue<T>: pushable AsyncIterable<T>. The SDK's streaming input
 *     mode wants an AsyncIterable<SDKUserMessage>; we build one here so per-
 *     turn sendAndStream() can push a user message into the shared stream.
 *
 * Both primitives are hand-rolled with no external deps; the shape mirrors
 * the bounded-queue pattern already used in src/openai/driver.ts (pendingResolve
 * waiter + FIFO backlog).
 */

/** Exact message string thrown when SerialTurnQueue is over capacity. */
export const QUEUE_FULL_ERROR_MESSAGE = "QUEUE_FULL";

/**
 * A pushable AsyncIterable<T>. Items pushed before iteration starts are buffered
 * FIFO; items pushed after a waiter is pending resolve that waiter immediately.
 * end() marks the stream complete — pending waiters receive { done: true };
 * subsequent pushes are silently dropped.
 *
 * Intended for feeding SDKUserMessage values into sdk.query({ prompt: ... }).
 */
export class AsyncPushQueue<T> implements AsyncIterable<T> {
  private queue: T[] = [];
  private waiter: ((v: IteratorResult<T>) => void) | null = null;
  private done = false;

  push(item: T): void {
    if (this.done) return; // pushes after end() are dropped
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      w({ value: item, done: false });
      return;
    }
    this.queue.push(item);
  }

  end(): void {
    this.done = true;
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      w({ value: undefined as unknown as T, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> =>
        new Promise<IteratorResult<T>>((resolve) => {
          const item = this.queue.shift();
          if (item !== undefined) {
            resolve({ value: item, done: false });
            return;
          }
          if (this.done) {
            resolve({ value: undefined as unknown as T, done: true });
            return;
          }
          this.waiter = resolve;
        }),
    };
  }
}

/**
 * Depth-1 mutex for agent turns. Semantics:
 *
 *   - No in-flight turn → run fn immediately; it becomes inFlight.
 *   - inFlight but no queued waiter → this run() becomes queued; awaits
 *     inFlight to settle (success OR failure), then its fn runs.
 *   - inFlight AND queued already filled → throws new Error("QUEUE_FULL").
 *
 * The in-flight turn's own rejection is surfaced to ITS caller directly.
 * The queued waiter swallows the inFlight rejection on the WAIT path so
 * a failed turn does not cascade into the next one.
 */
export class SerialTurnQueue {
  private inFlight: Promise<unknown> | null = null;
  private queued: Promise<unknown> | null = null;

  /**
   * Quick task 260419-nic — pure accessor for the in-flight slot.
   *
   * Used by createPersistentSessionHandle's public hasActiveTurn() to expose
   * whether a turn is currently being iterated (true between `run(fn)`
   * invocation and its `.finally` clear). Matches the existing no-setter-
   * leakage pattern — reading the slot NEVER mutates queue state.
   */
  hasInFlight(): boolean {
    return this.inFlight !== null;
  }

  /**
   * Quick task 260521-4sa (999.64) — read the TRACKING in-flight ref.
   *
   * Returns `this.inFlight` directly — the tracking copy (`p.finally(...)`)
   * assigned in `run()` below, NOT the raw `p`. The watchdog's
   * `forceReleaseTurn()` captures this ref BEFORE the threshold elapses so
   * `forceClearInFlight(ref)` can identity-check it. Null between turns.
   *
   * Reading the slot NEVER mutates queue state (mirrors `hasInFlight`).
   */
  peekInFlight(): Promise<unknown> | null {
    return this.inFlight;
  }

  /**
   * Quick task 260521-4sa (999.64) — identity-checked force-release.
   *
   * Clears `inFlight` + `queued` ONLY when `this.inFlight === expectedRef`.
   * Returns true if it cleared, false (no-op) when the slot held a different
   * promise or null.
   *
   * The identity check is load-bearing (threat T-99964-01): a blind
   * `this.inFlight = null` would race a turn that took the slot in the SAME
   * tick — between the watchdog reading a stale activity timestamp and
   * calling this method — and clobber a healthy fresh turn. By requiring the
   * caller to present the exact ref it captured earlier, a slot that has
   * since rolled over to a new turn is left untouched.
   */
  forceClearInFlight(expectedRef: Promise<unknown> | null): boolean {
    if (expectedRef === null || this.inFlight !== expectedRef) {
      return false;
    }
    this.inFlight = null;
    this.queued = null;
    return true;
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.inFlight && this.queued) {
      throw new Error(QUEUE_FULL_ERROR_MESSAGE);
    }
    if (this.inFlight) {
      // Wait for the in-flight turn to settle. Swallow its rejection here —
      // the inFlight caller already sees it on their own promise. The queued
      // turn must proceed regardless of whether inFlight succeeded or failed.
      const waitFor = this.inFlight;
      const waitSwallow = waitFor.then(
        () => undefined,
        () => undefined,
      );
      this.queued = waitSwallow;
      await waitSwallow;
    }
    const p = fn();
    // Track the in-flight slot. `finally` clears both slots so the NEXT run()
    // proceeds cleanly, regardless of success / throw.
    this.inFlight = p.finally(() => {
      this.inFlight = null;
      this.queued = null;
    });
    // Swallow the unhandled-rejection on the tracking copy — the real error
    // is carried by the returned `p`.
    this.inFlight.catch(() => undefined);
    return p;
  }
}
