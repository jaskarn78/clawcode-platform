/**
 * Unit pins for the workflow worker admission gate (2026-06-27 OOM fix).
 *
 * The gate bounds how many daemon-side workflow workers are admitted at once —
 * by a concurrency cap AND a cgroup memory watermark — so a fan-out can never
 * drive the daemon heap past the cgroup MemoryMax (the incident that took the
 * fleet down). Fully DI'd; these tests use short REAL timers (no cgroup).
 */

import { describe, it, expect } from "vitest";
import type { Logger } from "pino";
import {
  WorkflowAdmissionGate,
  WorkerAdmissionError,
} from "../workflow-admission-gate.js";

const silentLogger: Logger = {
  level: "silent",
  silent: () => undefined,
  trace: () => undefined,
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  fatal: () => undefined,
  child: () => silentLogger,
} as unknown as Logger;

function makeGate() {
  const memRef: { pct: number | null; throw: boolean } = {
    pct: null,
    throw: false,
  };
  const limits = { max: 2, watermark: 85, timeout: 500 };
  const gate = new WorkflowAdmissionGate({
    getMaxConcurrent: () => limits.max,
    getMemoryHighWatermarkPercent: () => limits.watermark,
    getAdmissionTimeoutMs: () => limits.timeout,
    readMemoryPercent: async () => {
      if (memRef.throw) throw new Error("synthetic cgroup read failure");
      return memRef.pct;
    },
    now: () => Date.now(),
    sleep: (ms: number) => new Promise((r) => setTimeout(r, ms)),
    pollMs: 5,
    logger: silentLogger,
  });
  return { gate, limits, memRef };
}

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("WorkflowAdmissionGate — concurrency", () => {
  it("admits up to maxConcurrent immediately", async () => {
    const { gate } = makeGate();
    await gate.acquire();
    await gate.acquire();
    expect(gate.activeCount).toBe(2);
  });

  it("blocks the (cap+1)th acquire until a slot is released", async () => {
    const { gate, limits } = makeGate();
    limits.timeout = 5000;
    const r1 = await gate.acquire();
    await gate.acquire();
    expect(gate.activeCount).toBe(2);

    let resolved = false;
    const p3 = gate.acquire().then((r) => {
      resolved = true;
      return r;
    });
    await tick(40);
    expect(resolved).toBe(false); // blocked on the cap

    r1(); // free a slot
    const r3 = await p3;
    expect(resolved).toBe(true);
    expect(gate.activeCount).toBe(2);
    r3();
  });

  it("throws WorkerAdmissionError(concurrency) when no slot frees in time", async () => {
    const { gate, limits } = makeGate();
    limits.max = 1;
    limits.timeout = 60;
    await gate.acquire(); // hold the only slot
    await expect(gate.acquire()).rejects.toMatchObject({
      name: "WorkerAdmissionError",
      reason: "concurrency",
    });
  });

  it("release is idempotent (decrements active exactly once)", async () => {
    const { gate } = makeGate();
    const r = await gate.acquire();
    expect(gate.activeCount).toBe(1);
    r();
    r();
    r();
    expect(gate.activeCount).toBe(0);
  });

  it("rejects immediately if the abort signal is already aborted", async () => {
    const { gate } = makeGate();
    const ac = new AbortController();
    ac.abort();
    await expect(gate.acquire(ac.signal)).rejects.toBeInstanceOf(
      WorkerAdmissionError,
    );
  });
});

describe("WorkflowAdmissionGate — memory watermark", () => {
  it("blocks while memory is at/above the watermark, admits once it drops", async () => {
    const { gate, limits, memRef } = makeGate();
    limits.timeout = 5000;
    memRef.pct = 90; // above 85
    let resolved = false;
    const p = gate.acquire().then((r) => {
      resolved = true;
      return r;
    });
    await tick(40);
    expect(resolved).toBe(false);

    memRef.pct = 50; // drops below the watermark
    const rel = await p;
    expect(resolved).toBe(true);
    rel();
  });

  it("throws WorkerAdmissionError(memory) when memory stays pressured past the timeout", async () => {
    const { gate, limits, memRef } = makeGate();
    limits.timeout = 60;
    memRef.pct = 99;
    await expect(gate.acquire()).rejects.toMatchObject({
      name: "WorkerAdmissionError",
      reason: "memory",
    });
  });

  it("fails OPEN (admits) when memory is unknown/unbounded (null)", async () => {
    const { gate, memRef } = makeGate();
    memRef.pct = null;
    const r = await gate.acquire();
    expect(gate.activeCount).toBe(1);
    r();
  });

  it("fails OPEN (admits) when the memory read throws", async () => {
    const { gate, memRef } = makeGate();
    memRef.throw = true;
    const r = await gate.acquire();
    expect(gate.activeCount).toBe(1);
    r();
  });
});

describe("WorkflowAdmissionGate — FIFO fairness (INC-2026-07-26)", () => {
  it("grants freed slots in ARRIVAL order — a later acquire cannot jump an earlier waiter", async () => {
    const { gate, limits } = makeGate();
    limits.max = 1;
    limits.timeout = 5000;
    const r1 = await gate.acquire(); // holds the only slot

    const order: string[] = [];
    const pA = gate.acquire().then((r) => {
      order.push("A");
      return r;
    });
    await tick(15); // A is queued first
    const pB = gate.acquire().then((r) => {
      order.push("B");
      return r;
    });
    await tick(15);
    expect(gate.queuedCount).toBe(2);

    r1(); // free the slot — must go to A (queued first), not the poll race
    const rA = await pA;
    expect(order).toEqual(["A"]);
    rA();
    const rB = await pB;
    expect(order).toEqual(["A", "B"]);
    rB();
    expect(gate.queuedCount).toBe(0);
  });

  it("a timed-out waiter leaves the queue so the next waiter becomes head", async () => {
    const { gate, limits } = makeGate();
    limits.max = 1;
    limits.timeout = 60;
    const r1 = await gate.acquire();

    // A times out at 60ms; B (queued behind A) would starve if A's token
    // stayed at the head.
    const pA = gate.acquire();
    await tick(10);
    limits.timeout = 5000; // B gets a long deadline
    const pB = gate.acquire();
    await expect(pA).rejects.toBeInstanceOf(WorkerAdmissionError);
    expect(gate.queuedCount).toBe(1); // A's token removed

    r1(); // B (now head) gets the slot
    const rB = await pB;
    expect(gate.activeCount).toBe(1);
    rB();
  });

  it("an aborted waiter leaves the queue without blocking later waiters", async () => {
    const { gate, limits } = makeGate();
    limits.max = 1;
    limits.timeout = 5000;
    const r1 = await gate.acquire();

    const ac = new AbortController();
    const pA = gate.acquire(ac.signal);
    await tick(10);
    const pB = gate.acquire();
    await tick(10);
    ac.abort();
    await expect(pA).rejects.toBeInstanceOf(WorkerAdmissionError);

    r1();
    const rB = await pB;
    expect(gate.activeCount).toBe(1);
    rB();
  });

  it("FIFO order survives a memory-blocked head — head admits first when memory clears", async () => {
    const { gate, limits, memRef } = makeGate();
    limits.max = 2;
    limits.timeout = 5000;
    memRef.pct = 90; // above the 85 watermark — nobody admits

    const order: string[] = [];
    const pA = gate.acquire().then((r) => {
      order.push("A");
      return r;
    });
    await tick(15);
    const pB = gate.acquire().then((r) => {
      order.push("B");
      return r;
    });
    await tick(30);
    expect(order).toEqual([]); // both blocked on memory
    expect(gate.queuedCount).toBe(2);

    memRef.pct = 50; // clears — grants must still be FIFO (A then B)
    const rA = await pA;
    const rB = await pB;
    expect(order).toEqual(["A", "B"]);
    rA();
    rB();
  });

  it("never over-admits when many waiters race a single freed slot", async () => {
    const { gate, limits } = makeGate();
    limits.max = 2;
    limits.timeout = 5000;
    const r1 = await gate.acquire();
    await gate.acquire();

    const contenders = Array.from({ length: 6 }, () => gate.acquire());
    await tick(20);
    expect(gate.activeCount).toBe(2);

    r1(); // exactly ONE contender may take the freed slot
    await tick(40);
    expect(gate.activeCount).toBe(2);
    expect(gate.queuedCount).toBe(5);

    // Drain: release as they resolve, FIFO — every contender eventually runs.
    for (let i = 0; i < contenders.length; i++) {
      const r = await contenders[i]!;
      r();
    }
    expect(gate.activeCount).toBeLessThanOrEqual(2);
    expect(gate.queuedCount).toBe(0);
  });
});
