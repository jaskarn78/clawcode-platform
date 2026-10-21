/**
 * Routing table mapping Discord channels to agents.
 * Immutable after construction -- no mutation after startup.
 */
export type RoutingTable = {
  readonly channelToAgent: ReadonlyMap<string, string>;
  readonly agentToChannels: ReadonlyMap<string, readonly string[]>;
};

/**
 * Configuration for a single token bucket.
 */
export type TokenBucketConfig = {
  readonly capacity: number;
  readonly refillRate: number; // tokens per second
};

/**
 * Configuration for the rate limiter (global + per-channel).
 */
export type RateLimiterConfig = {
  readonly global: TokenBucketConfig;
  readonly perChannel: TokenBucketConfig;
  readonly maxQueueDepth: number;
};

/**
 * Result of a rate limit check.
 */
export type RateLimitPermit = {
  readonly allowed: boolean;
  readonly retryAfterMs: number;
};

/**
 * A message queued while rate-limited.
 */
export type QueuedMessage = {
  readonly channelId: string;
  readonly content: string;
  readonly enqueuedAt: number;
};

/**
 * Observable stats from the rate limiter.
 */
export type RateLimiterStats = {
  readonly globalTokens: number;
  readonly channelTokens: ReadonlyMap<string, number>;
  readonly queueDepths: ReadonlyMap<string, number>;
};

/**
 * Rate limiter interface (closure-based, not class).
 */
export type RateLimiter = {
  readonly requestPermit: (channelId: string) => RateLimitPermit;
  readonly enqueue: (channelId: string, content: string) => boolean;
  readonly dequeueNext: (channelId: string) => QueuedMessage | undefined;
  readonly getStats: () => RateLimiterStats;
};

/**
 * Default rate limiter config per Discord API best practices.
 * Global: 50 req/s (D-10), Per-channel: 5 msg/5s (D-13), Queue: 100 per channel (D-12).
 */
export const DEFAULT_RATE_LIMITER_CONFIG: RateLimiterConfig = {
  global: { capacity: 50, refillRate: 50 },
  perChannel: { capacity: 5, refillRate: 1 },
  maxQueueDepth: 100,
} as const;
