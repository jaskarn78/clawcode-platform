/**
 * Phase 62 Plan 01 — sliding-window token bucket for per-rule throttle.
 *
 * Each rule with a `throttle: { maxPerMinute }` config gets its own
 * TokenBucket instance. The bucket stores timestamps and evicts entries
 * outside the 60-second window on each tryConsume() call.
 *
 * Mutable by design — counter state is intrinsic to throttling.
 * Resets on policy reload (new PolicyEvaluator instance).
 */

export class TokenBucket {
  private readonly maxPerMinute: number;
  private readonly timestamps: number[] = [];

  constructor(maxPerMinute: number) {
    this.maxPerMinute = maxPerMinute;
  }

  /**
   * Attempt to consume a token. Returns true if allowed (under limit),
   * false if the rate limit is exceeded within the 60s window.
   */
  tryConsume(): boolean {
    const now = Date.now();
    const windowStart = now - 60_000;

    // Remove expired entries from the front of the array
    while (this.timestamps.length > 0 && this.timestamps[0]! < windowStart) {
      this.timestamps.shift();
    }

    if (this.timestamps.length >= this.maxPerMinute) {
      return false;
    }

    this.timestamps.push(now);
    return true;
  }
}
