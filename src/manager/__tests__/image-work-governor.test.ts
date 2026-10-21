/**
 * P1-GATE / P1-SHARP unit tests — counting semaphore + sharp boot config.
 */
import { describe, it, expect } from "vitest";
import sharp from "sharp";
import {
  Semaphore,
  withImageWorkSlot,
  imageWorkGovernor,
  configureSharpAtBoot,
  MAX_IMAGE_WORK_SLOTS,
} from "../image-work-governor.js";

describe("Semaphore (P1-GATE)", () => {
  it("resolves immediately while permits remain, queues past the limit", async () => {
    const s = new Semaphore(2);
    await s.acquire();
    await s.acquire();
    expect(s.availablePermits).toBe(0);

    let thirdResolved = false;
    const third = s.acquire().then(() => {
      thirdResolved = true;
    });
    await Promise.resolve();
    expect(thirdResolved).toBe(false); // queued, not resolved
    expect(s.queueLength).toBe(1);

    s.release(); // hands the permit directly to the waiter
    await third;
    expect(thirdResolved).toBe(true);
    expect(s.queueLength).toBe(0);
  });

  it("release with no waiters restores a permit", async () => {
    const s = new Semaphore(1);
    await s.acquire();
    expect(s.availablePermits).toBe(0);
    s.release();
    expect(s.availablePermits).toBe(1);
  });

  it("FIFO: waiters resolve in order", async () => {
    const s = new Semaphore(1);
    await s.acquire();
    const order: number[] = [];
    const a = s.acquire().then(() => order.push(1));
    const b = s.acquire().then(() => order.push(2));
    s.release();
    await a;
    s.release();
    await b;
    expect(order).toEqual([1, 2]);
  });

  it("rejects a non-positive permit count", () => {
    expect(() => new Semaphore(0)).toThrow();
    expect(() => new Semaphore(-1)).toThrow();
  });

  it("the global governor is sized to MAX_IMAGE_WORK_SLOTS", () => {
    expect(MAX_IMAGE_WORK_SLOTS).toBe(2);
    expect(imageWorkGovernor.availablePermits).toBeLessThanOrEqual(
      MAX_IMAGE_WORK_SLOTS,
    );
  });
});

describe("withImageWorkSlot (landmine #6 — release on EVERY path)", () => {
  it("releases the slot after a successful body", async () => {
    const before = imageWorkGovernor.availablePermits;
    const r = await withImageWorkSlot(async () => 42);
    expect(r).toBe(42);
    expect(imageWorkGovernor.availablePermits).toBe(before);
  });

  it("releases the slot when the body throws", async () => {
    const before = imageWorkGovernor.availablePermits;
    await expect(
      withImageWorkSlot(async () => {
        throw new Error("decode boom");
      }),
    ).rejects.toThrow("decode boom");
    // Slot returned despite the throw — two such leaks would deadlock the gate.
    expect(imageWorkGovernor.availablePermits).toBe(before);
  });
});

describe("configureSharpAtBoot (P1-SHARP)", () => {
  it("sets libvips concurrency to 1", () => {
    configureSharpAtBoot();
    expect(sharp.concurrency()).toBe(1);
  });
});
