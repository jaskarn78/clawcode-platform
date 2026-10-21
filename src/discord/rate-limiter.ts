import type {
  RateLimiterConfig,
  RateLimitPermit,
  QueuedMessage,
  RateLimiterStats,
  RateLimiter,
} from "./types.js";
import { DEFAULT_RATE_LIMITER_CONFIG } from "./types.js";

/**
 * Internal mutable token bucket state.
 * Individual bucket operations are pure -- they return new buckets.
 */
type TokenBucket = {
  readonly tokens: number;
  readonly lastRefillAt: number;
};

/**
 * Refill a bucket based on elapsed time. Returns a new bucket (pure).
 */
function refillBucket(
  bucket: TokenBucket,
  config: { readonly capacity: number; readonly refillRate: number },
  now: number,
): TokenBucket {
  const elapsed = (now - bucket.lastRefillAt) / 1000; // seconds
  if (elapsed <= 0) {
    return bucket;
  }

  const refilled = Math.min(
    config.capacity,
    bucket.tokens + elapsed * config.refillRate,
  );

  return {
    tokens: refilled,
    lastRefillAt: now,
  };
}

/**
 * Try to consume one token from a bucket. Returns result and new bucket (pure).
 */
function tryConsume(
  bucket: TokenBucket,
  config: { readonly capacity: number; readonly refillRate: number },
  now: number,
): { readonly allowed: boolean; readonly bucket: TokenBucket; readonly retryAfterMs: number } {
  const refilled = refillBucket(bucket, config, now);

  if (refilled.tokens >= 1) {
    return {
      allowed: true,
      bucket: { tokens: refilled.tokens - 1, lastRefillAt: refilled.lastRefillAt },
      retryAfterMs: 0,
    };
  }

  // Calculate how long until 1 token is available
  const deficit = 1 - refilled.tokens;
  const retryAfterMs = Math.ceil((deficit / config.refillRate) * 1000);

  return {
    allowed: false,
    bucket: refilled,
    retryAfterMs,
  };
}

/**
 * Create a closure-based rate limiter with global and per-channel token buckets.
 *
 * @param config - Rate limiter configuration (defaults to DEFAULT_RATE_LIMITER_CONFIG)
 * @param clock - Injectable clock function for testing (defaults to Date.now)
 */
export function createRateLimiter(
  config: RateLimiterConfig = DEFAULT_RATE_LIMITER_CONFIG,
  clock: () => number = Date.now,
): RateLimiter {
  const now = clock();

  // Mutable internal state
  let globalBucket: TokenBucket = { tokens: config.global.capacity, lastRefillAt: now };
  const channelBuckets = new Map<string, TokenBucket>();
  const channelQueues = new Map<string, QueuedMessage[]>();

  function getOrCreateChannelBucket(channelId: string): TokenBucket {
    const existing = channelBuckets.get(channelId);
    if (existing !== undefined) {
      return existing;
    }
    const bucket: TokenBucket = {
      tokens: config.perChannel.capacity,
      lastRefillAt: clock(),
    };
    channelBuckets.set(channelId, bucket);
    return bucket;
  }

  function requestPermit(channelId: string): RateLimitPermit {
    const currentTime = clock();

    // Check global bucket first
    const globalResult = tryConsume(globalBucket, config.global, currentTime);
    if (!globalResult.allowed) {
      return { allowed: false, retryAfterMs: globalResult.retryAfterMs };
    }

    // Check per-channel bucket
    const channelBucket = getOrCreateChannelBucket(channelId);
    const channelResult = tryConsume(channelBucket, config.perChannel, currentTime);
    if (!channelResult.allowed) {
      // Restore global token since channel denied
      globalBucket = {
        tokens: globalBucket.tokens,
        lastRefillAt: globalResult.bucket.lastRefillAt,
      };
      return { allowed: false, retryAfterMs: channelResult.retryAfterMs };
    }

    // Both allowed -- commit new bucket states
    globalBucket = globalResult.bucket;
    channelBuckets.set(channelId, channelResult.bucket);

    return { allowed: true, retryAfterMs: 0 };
  }

  function enqueue(channelId: string, content: string): boolean {
    const currentTime = clock();
    const queue = channelQueues.get(channelId) ?? [];

    const message: QueuedMessage = {
      channelId,
      content,
      enqueuedAt: currentTime,
    };

    if (queue.length >= config.maxQueueDepth) {
      // Drop oldest message (shift), then push new one
      queue.shift();
    }

    queue.push(message);
    channelQueues.set(channelId, queue);
    return true;
  }

  function dequeueNext(channelId: string): QueuedMessage | undefined {
    const queue = channelQueues.get(channelId);
    if (queue === undefined || queue.length === 0) {
      return undefined;
    }
    return queue.shift();
  }

  function getStats(): RateLimiterStats {
    const currentTime = clock();
    const refilledGlobal = refillBucket(globalBucket, config.global, currentTime);

    const channelTokens = new Map<string, number>();
    for (const [channelId, bucket] of channelBuckets) {
      const refilled = refillBucket(bucket, config.perChannel, currentTime);
      channelTokens.set(channelId, refilled.tokens);
    }

    const queueDepths = new Map<string, number>();
    for (const [channelId, queue] of channelQueues) {
      queueDepths.set(channelId, queue.length);
    }

    return {
      globalTokens: refilledGlobal.tokens,
      channelTokens,
      queueDepths,
    };
  }

  return {
    requestPermit,
    enqueue,
    dequeueNext,
    getStats,
  };
}
