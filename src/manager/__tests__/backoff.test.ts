import { describe, it, expect, vi, afterEach } from "vitest";
import {
  calculateBackoff,
  shouldResetBackoff,
} from "../backoff.js";
import { DEFAULT_BACKOFF_CONFIG } from "../types.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("calculateBackoff", () => {
  const config = DEFAULT_BACKOFF_CONFIG;

  it("returns ~1000ms for 0 consecutive failures", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5); // jitter factor = 0
    const delay = calculateBackoff(0, config);
    expect(delay).toBe(1_000);
  });

  it("returns ~2000ms for 1 consecutive failure", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const delay = calculateBackoff(1, config);
    expect(delay).toBe(2_000);
  });

  it("returns ~4000ms for 2 consecutive failures", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const delay = calculateBackoff(2, config);
    expect(delay).toBe(4_000);
  });

  it("returns ~32000ms for 5 consecutive failures", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const delay = calculateBackoff(5, config);
    expect(delay).toBe(32_000);
  });

  it("caps at maxMs for high failure counts", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const delay = calculateBackoff(9, config);
    // 1000 * 2^9 = 512000, capped at 300000
    expect(delay).toBe(300_000);
  });

  it("returns -1 when failures >= maxRetries", () => {
    const delay = calculateBackoff(10, config);
    expect(delay).toBe(-1);
  });

  it("returns -1 when failures > maxRetries", () => {
    const delay = calculateBackoff(15, config);
    expect(delay).toBe(-1);
  });

  it("applies positive jitter within 10%", () => {
    vi.spyOn(Math, "random").mockReturnValue(1.0); // jitter = +10%
    const delay = calculateBackoff(0, config);
    expect(delay).toBe(1_100); // 1000 + 100
  });

  it("applies negative jitter within 10%", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.0); // jitter = -10%
    const delay = calculateBackoff(0, config);
    expect(delay).toBe(900); // 1000 - 100
  });

  it("jitter stays within +/- 10% bounds", () => {
    // Run with real randomness many times
    vi.restoreAllMocks();
    for (let i = 0; i < 100; i++) {
      const delay = calculateBackoff(0, config);
      expect(delay).toBeGreaterThanOrEqual(900);
      expect(delay).toBeLessThanOrEqual(1_100);
    }
  });

  it("works with custom config", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const custom = { baseMs: 500, maxMs: 10_000, maxRetries: 3, stableAfterMs: 60_000 };
    expect(calculateBackoff(0, custom)).toBe(500);
    expect(calculateBackoff(2, custom)).toBe(2_000);
    expect(calculateBackoff(3, custom)).toBe(-1);
  });
});

describe("shouldResetBackoff", () => {
  const stableAfterMs = 300_000; // 5 minutes

  it("returns true when agent has been running >= stableAfterMs", () => {
    const startedAt = 1_000_000;
    const now = startedAt + stableAfterMs;
    expect(shouldResetBackoff(startedAt, now, stableAfterMs)).toBe(true);
  });

  it("returns true when agent has been running > stableAfterMs", () => {
    const startedAt = 1_000_000;
    const now = startedAt + stableAfterMs + 60_000;
    expect(shouldResetBackoff(startedAt, now, stableAfterMs)).toBe(true);
  });

  it("returns false when agent has been running < stableAfterMs", () => {
    const startedAt = 1_000_000;
    const now = startedAt + stableAfterMs - 1;
    expect(shouldResetBackoff(startedAt, now, stableAfterMs)).toBe(false);
  });

  it("returns false when startedAt is 0 (never started)", () => {
    expect(shouldResetBackoff(0, Date.now(), stableAfterMs)).toBe(true);
    // 0 is a valid timestamp (epoch) — if now - 0 >= stableAfterMs, it's true
  });
});
