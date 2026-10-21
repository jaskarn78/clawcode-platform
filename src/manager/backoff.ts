import type { BackoffConfig } from "./types.js";

/**
 * Calculate exponential backoff delay for a given number of consecutive failures.
 *
 * Formula: min(baseMs * 2^failures, maxMs) with +/- 10% jitter.
 * Returns -1 when consecutiveFailures >= maxRetries (stop retrying).
 *
 * @param consecutiveFailures - Number of consecutive failures
 * @param config - Backoff configuration
 * @returns Delay in ms, or -1 if max retries exceeded
 */
export function calculateBackoff(
  consecutiveFailures: number,
  config: BackoffConfig,
): number {
  if (consecutiveFailures >= config.maxRetries) {
    return -1;
  }

  const rawDelay = Math.min(
    config.baseMs * Math.pow(2, consecutiveFailures),
    config.maxMs,
  );

  // Add jitter: +/- 10%
  const jitterFactor = (Math.random() * 2 - 1) * 0.1;
  const delay = rawDelay + rawDelay * jitterFactor;

  return Math.round(delay);
}

/**
 * Determine whether an agent's backoff counter should be reset.
 * Returns true when the agent has been continuously running for at least
 * stableAfterMs milliseconds (per D-14).
 *
 * @param startedAt - Timestamp when the agent was last started (ms)
 * @param now - Current timestamp (ms)
 * @param stableAfterMs - Duration to consider stable (ms)
 */
export function shouldResetBackoff(
  startedAt: number,
  now: number,
  stableAfterMs: number,
): boolean {
  return now - startedAt >= stableAfterMs;
}
