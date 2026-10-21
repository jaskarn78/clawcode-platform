import { describe, it, expect } from "vitest";
import { runWithConcurrencyLimit, ConcurrencyGate } from "../tool-dispatch.js";

/**
 * Phase 55 Plan 02 — runWithConcurrencyLimit unit tests (Tests 8-12).
 *
 * Verifies the semaphore-style concurrency cap + Promise.allSettled error
 * isolation that wraps our MCP handler batch dispatch.
 *
 * Timing tests use real timers with generous tolerance so they don't flake
 * on shared CI runners; medians on ~50ms / ~100ms delays should be stable.
 */

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe("runWithConcurrencyLimit (Phase 55)", () => {
  it("Test 8: 5 handlers at 50ms each with maxConcurrent=5 finish in <150ms (parallel, not serial)", async () => {
    const handlers = Array.from({ length: 5 }, () => async () => {
      await delay(50);
      return "ok";
    });
    const start = Date.now();
    const results = await runWithConcurrencyLimit(handlers, 5);
    const elapsed = Date.now() - start;
    // Serial would be ~250ms; parallel should be ~50ms. Generous 150ms cap.
    expect(elapsed).toBeLessThan(150);
    expect(results).toHaveLength(5);
    expect(results.every((r) => r.status === "fulfilled")).toBe(true);
  });

  it("Test 9: 10 handlers at 100ms each with maxConcurrent=2 finish in ~500ms (5 batches)", async () => {
    const handlers = Array.from({ length: 10 }, () => async () => {
      await delay(100);
      return "ok";
    });
    const start = Date.now();
    const results = await runWithConcurrencyLimit(handlers, 2);
    const elapsed = Date.now() - start;
    // 5 batches of 2 x 100ms = ~500ms. Accept 400-900ms tolerance for CI noise.
    expect(elapsed).toBeGreaterThanOrEqual(400);
    expect(elapsed).toBeLessThan(900);
    expect(results).toHaveLength(10);
  });

  it("Test 10: error isolation — one handler throw does not block siblings", async () => {
    const handlers = [
      async () => {
        await delay(10);
        return "a";
      },
      async () => {
        await delay(10);
        throw new Error("boom");
      },
      async () => {
        await delay(10);
        return "c";
      },
    ];
    const results = await runWithConcurrencyLimit(handlers, 3);
    expect(results).toHaveLength(3);
    expect(results[0]!.status).toBe("fulfilled");
    expect(results[1]!.status).toBe("rejected");
    expect(results[2]!.status).toBe("fulfilled");
    if (results[0]!.status === "fulfilled") expect(results[0]!.value).toBe("a");
    if (results[2]!.status === "fulfilled") expect(results[2]!.value).toBe("c");
    if (results[1]!.status === "rejected") {
      expect((results[1]!.reason as Error).message).toBe("boom");
    }
  });

  it("Test 11: empty handlers array resolves to []", async () => {
    const results = await runWithConcurrencyLimit([], 10);
    expect(results).toEqual([]);
  });

  it("Test 12: maxConcurrent >= handlers.length is equivalent to unconstrained allSettled", async () => {
    const handlers = Array.from({ length: 3 }, (_, i) => async () => {
      await delay(20);
      return i;
    });
    const start = Date.now();
    const results = await runWithConcurrencyLimit(handlers, 100);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(100); // All 3 run in parallel
    expect(results.map((r) => (r.status === "fulfilled" ? r.value : null))).toEqual([0, 1, 2]);
  });

  it("Concurrency cap is honoured — 15 handlers with max 10 never exceed 10 in-flight", async () => {
    let inFlight = 0;
    let peak = 0;
    const handlers = Array.from({ length: 15 }, () => async () => {
      inFlight++;
      if (inFlight > peak) peak = inFlight;
      await delay(30);
      inFlight--;
      return "ok";
    });
    await runWithConcurrencyLimit(handlers, 10);
    expect(peak).toBeLessThanOrEqual(10);
  });

  it("results preserve input order even under varying durations", async () => {
    const handlers = [
      async () => {
        await delay(50);
        return "slow";
      },
      async () => {
        await delay(5);
        return "fast";
      },
      async () => {
        await delay(25);
        return "mid";
      },
    ];
    const results = await runWithConcurrencyLimit(handlers, 3);
    expect(results).toHaveLength(3);
    const values = results.map((r) => (r.status === "fulfilled" ? r.value : null));
    expect(values).toEqual(["slow", "fast", "mid"]);
  });

  it("throws when maxConcurrent <= 0 (avoids deadlock)", async () => {
    const handlers = [async () => "ok"];
    await expect(runWithConcurrencyLimit(handlers, 0)).rejects.toThrow();
    await expect(runWithConcurrencyLimit(handlers, -1)).rejects.toThrow();
  });
});

describe("ConcurrencyGate (v1.7 cleanup)", () => {
  it("rejects invalid limits", () => {
    expect(() => new ConcurrencyGate(0)).toThrow(/>=\s*1|positive/i);
    expect(() => new ConcurrencyGate(-1)).toThrow(/positive/i);
    expect(() => new ConcurrencyGate(Infinity)).toThrow(/finite/i);
  });

  it("acquire resolves immediately when under limit", async () => {
    const gate = new ConcurrencyGate(2);
    expect(gate.inFlight).toBe(0);
    const release1 = await gate.acquire();
    expect(gate.inFlight).toBe(1);
    const release2 = await gate.acquire();
    expect(gate.inFlight).toBe(2);
    release1();
    release2();
    expect(gate.inFlight).toBe(0);
  });

  it("acquire queues when at limit; release wakes next waiter (FIFO)", async () => {
    const gate = new ConcurrencyGate(1);
    const release1 = await gate.acquire();
    expect(gate.inFlight).toBe(1);

    // Second acquire should queue
    let resolved2 = false;
    let resolved3 = false;
    const p2 = gate.acquire().then((r) => {
      resolved2 = true;
      return r;
    });
    const p3 = gate.acquire().then((r) => {
      resolved3 = true;
      return r;
    });

    // Allow microtasks to flush — neither should resolve yet
    await Promise.resolve();
    await Promise.resolve();
    expect(resolved2).toBe(false);
    expect(resolved3).toBe(false);

    // Release first acquirer → p2 resolves (FIFO)
    release1();
    const release2 = await p2;
    expect(resolved2).toBe(true);
    expect(resolved3).toBe(false);
    expect(gate.inFlight).toBe(1);

    // Release second → p3 resolves
    release2();
    const release3 = await p3;
    expect(resolved3).toBe(true);
    expect(gate.inFlight).toBe(1);

    release3();
    expect(gate.inFlight).toBe(0);
  });

  it("release is idempotent (double-release on same call is no-op)", async () => {
    const gate = new ConcurrencyGate(2);
    const release = await gate.acquire();
    expect(gate.inFlight).toBe(1);
    release();
    expect(gate.inFlight).toBe(0);
    release(); // second call
    expect(gate.inFlight).toBe(0); // still 0, not -1
  });

  it("enforces cap with 5 concurrent acquirers and limit 2", async () => {
    const gate = new ConcurrencyGate(2);
    const observed: number[] = [];

    const task = async (id: number): Promise<void> => {
      const release = await gate.acquire();
      observed.push(gate.inFlight);
      await new Promise((r) => setTimeout(r, 10));
      release();
    };

    await Promise.all([task(1), task(2), task(3), task(4), task(5)]);

    // No observation should exceed the cap
    expect(Math.max(...observed)).toBeLessThanOrEqual(2);
    expect(observed).toHaveLength(5);
  });

  it("exposes limit read-only", () => {
    const gate = new ConcurrencyGate(7);
    expect(gate.limit).toBe(7);
  });
});
