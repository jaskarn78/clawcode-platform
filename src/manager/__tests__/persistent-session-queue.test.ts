import { describe, it, expect } from "vitest";

/**
 * Phase 73 Plan 01 Task 1 — RED tests for SerialTurnQueue + AsyncPushQueue.
 *
 * Covers the primitives consumed by persistent-session-handle.ts:
 *   - AsyncPushQueue: pushable AsyncIterable<T> with FIFO semantics + end() sentinel.
 *   - SerialTurnQueue: depth-1 mutex with QUEUE_FULL rejection; release-on-throw.
 */

import {
  AsyncPushQueue,
  SerialTurnQueue,
  QUEUE_FULL_ERROR_MESSAGE,
} from "../persistent-session-queue.js";

// ---------------------------------------------------------------------------
// AsyncPushQueue
// ---------------------------------------------------------------------------

describe("AsyncPushQueue", () => {
  it("yields items pushed BEFORE iteration starts in FIFO order", async () => {
    const q = new AsyncPushQueue<number>();
    q.push(1);
    q.push(2);
    q.push(3);
    const iter = q[Symbol.asyncIterator]();
    const a = await iter.next();
    const b = await iter.next();
    const c = await iter.next();
    expect(a).toEqual({ value: 1, done: false });
    expect(b).toEqual({ value: 2, done: false });
    expect(c).toEqual({ value: 3, done: false });
  });

  it("resolves a waiter immediately when an item is pushed after next() is pending", async () => {
    const q = new AsyncPushQueue<string>();
    const iter = q[Symbol.asyncIterator]();
    // Pending next() before any push.
    const pending = iter.next();
    // Give the microtask a chance to register the waiter.
    await Promise.resolve();
    q.push("late");
    const result = await pending;
    expect(result).toEqual({ value: "late", done: false });
  });

  it("end() after items: iterator drains queued items, then returns done", async () => {
    const q = new AsyncPushQueue<number>();
    q.push(10);
    q.push(20);
    q.end();
    const iter = q[Symbol.asyncIterator]();
    const r1 = await iter.next();
    const r2 = await iter.next();
    const r3 = await iter.next();
    expect(r1.value).toBe(10);
    expect(r2.value).toBe(20);
    expect(r3.done).toBe(true);
  });

  it("end() with a pending waiter resolves it with done:true", async () => {
    const q = new AsyncPushQueue<number>();
    const iter = q[Symbol.asyncIterator]();
    const pending = iter.next();
    await Promise.resolve();
    q.end();
    const r = await pending;
    expect(r.done).toBe(true);
  });

  it("push after end() is silently dropped (no yield)", async () => {
    const q = new AsyncPushQueue<number>();
    q.end();
    q.push(99); // dropped
    const iter = q[Symbol.asyncIterator]();
    const r = await iter.next();
    expect(r.done).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// SerialTurnQueue
// ---------------------------------------------------------------------------

/** Helper: build a deferred promise we can settle manually. */
function deferred<T>(): {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (err: unknown) => void;
} {
  let resolve!: (v: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("SerialTurnQueue", () => {
  it("runs a single fn immediately when no turn is in flight", async () => {
    const q = new SerialTurnQueue();
    const result = await q.run(async () => 42);
    expect(result).toBe(42);
  });

  it("second concurrent run() waits for first to complete; ordering preserved", async () => {
    const q = new SerialTurnQueue();
    const order: string[] = [];
    const d1 = deferred<string>();

    const p1 = q.run(async () => {
      order.push("start-1");
      const v = await d1.promise;
      order.push("end-1");
      return v;
    });

    // Without awaiting p1, fire p2. It MUST wait for p1 to complete before its
    // own fn body runs.
    const p2 = q.run(async () => {
      order.push("start-2");
      return "done-2";
    });

    // Let p1 begin.
    await Promise.resolve();
    expect(order).toEqual(["start-1"]);

    // Resolve p1 → then p2 should begin.
    d1.resolve("done-1");

    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toBe("done-1");
    expect(r2).toBe("done-2");
    expect(order).toEqual(["start-1", "end-1", "start-2"]);
  });

  it("third concurrent run() throws QUEUE_FULL (exact message)", async () => {
    const q = new SerialTurnQueue();
    const d1 = deferred<string>();
    const d2 = deferred<string>();

    const p1 = q.run(async () => d1.promise);
    const p2 = q.run(async () => d2.promise);

    // Let p1 start + p2 register as queued.
    await Promise.resolve();
    await Promise.resolve();

    // Third call — both slots filled → throws QUEUE_FULL.
    await expect(q.run(async () => "x")).rejects.toThrow("QUEUE_FULL");

    // Clean up dangling turns.
    d1.resolve("1");
    d2.resolve("2");
    await Promise.all([p1, p2]);
  });

  it("QUEUE_FULL_ERROR_MESSAGE is exactly the string 'QUEUE_FULL'", () => {
    expect(QUEUE_FULL_ERROR_MESSAGE).toBe("QUEUE_FULL");
  });

  it("fn throw releases the slot so subsequent run() proceeds cleanly", async () => {
    const q = new SerialTurnQueue();

    // First run throws — slot MUST release in finally.
    await expect(
      q.run(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    // A subsequent run() should proceed normally (no QUEUE_FULL leak).
    const result = await q.run(async () => "ok");
    expect(result).toBe("ok");
  });

  it("queued turn proceeds even if the inFlight turn rejects (the wait path swallows the inFlight rejection)", async () => {
    const q = new SerialTurnQueue();
    const d1 = deferred<string>();

    const p1 = q.run(async () => d1.promise);

    // Queue a second turn — it should still run after p1 settles (success or failure).
    const p2Start = deferred<void>();
    const p2 = q.run(async () => {
      p2Start.resolve();
      return "second-ok";
    });

    // Reject p1.
    d1.reject(new Error("first-failed"));

    // p1 itself must reject with the original error.
    await expect(p1).rejects.toThrow("first-failed");

    // p2 must still run and succeed (the queue's wait path swallows p1's rejection).
    await expect(p2).resolves.toBe("second-ok");
    // And its start hook fired, proving the body was invoked.
    await expect(p2Start.promise).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// SerialTurnQueue — force-release primitive (quick task 260521-4sa, 999.64)
// ---------------------------------------------------------------------------

describe("SerialTurnQueue.forceClearInFlight + peekInFlight (999.64)", () => {
  it("forceClearInFlight with the matching ref clears the slot", async () => {
    const q = new SerialTurnQueue();
    const d = deferred<string>();
    const p = q.run(async () => d.promise);

    // A turn is in flight — capture the TRACKING ref via peekInFlight().
    const ref = q.peekInFlight();
    expect(ref).not.toBeNull();
    expect(q.hasInFlight()).toBe(true);

    // Identity-matched clear succeeds.
    const cleared = q.forceClearInFlight(ref);
    expect(cleared).toBe(true);
    expect(q.hasInFlight()).toBe(false);

    // Clean up the dangling turn — settling it must not throw.
    d.resolve("late");
    await expect(p).resolves.toBe("late");
  });

  it("forceClearInFlight with a non-matching ref is a no-op (returns false, slot intact)", async () => {
    const q = new SerialTurnQueue();
    const d = deferred<string>();
    const p = q.run(async () => d.promise);

    expect(q.hasInFlight()).toBe(true);

    // A stale/foreign ref must NEVER clear the slot — guards against clearing
    // a turn that took the slot in the same tick (T-99964-01).
    const foreignRef = Promise.resolve("not-the-tracked-promise");
    const cleared = q.forceClearInFlight(foreignRef);
    expect(cleared).toBe(false);
    expect(q.hasInFlight()).toBe(true);

    d.resolve("ok");
    await expect(p).resolves.toBe("ok");
  });

  it("forceClearInFlight with null when no turn is in flight returns false", () => {
    const q = new SerialTurnQueue();
    expect(q.peekInFlight()).toBeNull();
    expect(q.forceClearInFlight(null)).toBe(false);
    expect(q.hasInFlight()).toBe(false);
  });

  it("REGRESSION PIN — a turn whose fn rejects releases the lock via the existing .finally() (criterion 1 error path)", async () => {
    const q = new SerialTurnQueue();

    // Criterion 1, error path: a turn that exits status=error must release the
    // lock WITHOUT the watchdog — the existing .finally() already covers it.
    await expect(
      q.run(async () => {
        throw new Error("status=error");
      }),
    ).rejects.toThrow("status=error");

    // Once the rejection settles, the slot is free — no watchdog needed.
    expect(q.hasInFlight()).toBe(false);
    expect(q.peekInFlight()).toBeNull();

    // And a fresh turn dispatches normally (the wedge does not occur).
    await expect(q.run(async () => "next-turn-ok")).resolves.toBe("next-turn-ok");
  });
});
