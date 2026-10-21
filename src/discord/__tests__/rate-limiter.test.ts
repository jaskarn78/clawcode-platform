import { describe, it, expect } from "vitest";
import { createRateLimiter } from "../rate-limiter.js";
import { DEFAULT_RATE_LIMITER_CONFIG } from "../types.js";
import type { RateLimiterConfig } from "../types.js";

describe("createRateLimiter", () => {
  it("returns a RateLimiter with full global and per-channel token buckets", () => {
    const limiter = createRateLimiter();
    const stats = limiter.getStats();

    expect(stats.globalTokens).toBe(50);
    expect(stats.channelTokens.size).toBe(0);
    expect(stats.queueDepths.size).toBe(0);
  });

  it("requestPermit on a fresh limiter returns allowed=true", () => {
    const limiter = createRateLimiter();
    const permit = limiter.requestPermit("ch-1");

    expect(permit.allowed).toBe(true);
    expect(permit.retryAfterMs).toBe(0);
  });

  it("requestPermit 51 times: first 50 allowed, 51st denied with retryAfterMs > 0 (D-10)", () => {
    const now = 1000000;
    const clock = () => now;
    const limiter = createRateLimiter(DEFAULT_RATE_LIMITER_CONFIG, clock);

    // Use different channels to avoid per-channel limit
    for (let i = 0; i < 50; i++) {
      const permit = limiter.requestPermit(`ch-${i}`);
      expect(permit.allowed).toBe(true);
    }

    const permit51 = limiter.requestPermit("ch-50");
    expect(permit51.allowed).toBe(false);
    expect(permit51.retryAfterMs).toBeGreaterThan(0);
  });

  it("requestPermit on same channel 6 times: first 5 allowed, 6th denied (D-13)", () => {
    const now = 1000000;
    const clock = () => now;
    const limiter = createRateLimiter(DEFAULT_RATE_LIMITER_CONFIG, clock);

    for (let i = 0; i < 5; i++) {
      const permit = limiter.requestPermit("ch-1");
      expect(permit.allowed).toBe(true);
    }

    const permit6 = limiter.requestPermit("ch-1");
    expect(permit6.allowed).toBe(false);
    expect(permit6.retryAfterMs).toBeGreaterThan(0);
  });

  it("after refill interval, previously exhausted bucket allows requests again", () => {
    let now = 1000000;
    const clock = () => now;
    const limiter = createRateLimiter(DEFAULT_RATE_LIMITER_CONFIG, clock);

    // Exhaust per-channel bucket (5 requests)
    for (let i = 0; i < 5; i++) {
      limiter.requestPermit("ch-1");
    }
    expect(limiter.requestPermit("ch-1").allowed).toBe(false);

    // Advance time by 1 second (refillRate=1 token/s for perChannel)
    now += 1000;
    const permit = limiter.requestPermit("ch-1");
    expect(permit.allowed).toBe(true);
  });
});

describe("queue operations", () => {
  it("enqueue adds message; dequeueNext returns oldest (FIFO)", () => {
    const now = 1000000;
    const clock = () => now;
    const limiter = createRateLimiter(DEFAULT_RATE_LIMITER_CONFIG, clock);

    limiter.enqueue("ch-1", "first");
    limiter.enqueue("ch-1", "second");

    const msg = limiter.dequeueNext("ch-1");
    expect(msg).toBeDefined();
    expect(msg!.content).toBe("first");
    expect(msg!.channelId).toBe("ch-1");
    expect(msg!.enqueuedAt).toBe(now);

    const msg2 = limiter.dequeueNext("ch-1");
    expect(msg2!.content).toBe("second");

    expect(limiter.dequeueNext("ch-1")).toBeUndefined();
  });

  it("queue respects maxQueueDepth; overflow drops oldest (D-12)", () => {
    const now = 1000000;
    const clock = () => now;
    const config: RateLimiterConfig = {
      global: { capacity: 50, refillRate: 50 },
      perChannel: { capacity: 5, refillRate: 1 },
      maxQueueDepth: 3,
    };
    const limiter = createRateLimiter(config, clock);

    limiter.enqueue("ch-1", "msg-1");
    limiter.enqueue("ch-1", "msg-2");
    limiter.enqueue("ch-1", "msg-3");
    // Queue is full, this should drop oldest (msg-1)
    const result = limiter.enqueue("ch-1", "msg-4");
    expect(result).toBe(true);

    const first = limiter.dequeueNext("ch-1");
    expect(first!.content).toBe("msg-2"); // msg-1 was dropped
  });
});

describe("getStats", () => {
  it("returns current token counts and queue depths", () => {
    const now = 1000000;
    const clock = () => now;
    const limiter = createRateLimiter(DEFAULT_RATE_LIMITER_CONFIG, clock);

    limiter.requestPermit("ch-1");
    limiter.requestPermit("ch-1");
    limiter.enqueue("ch-1", "queued");

    const stats = limiter.getStats();
    expect(stats.globalTokens).toBe(48); // 50 - 2
    expect(stats.channelTokens.get("ch-1")).toBe(3); // 5 - 2
    expect(stats.queueDepths.get("ch-1")).toBe(1);
  });
});
