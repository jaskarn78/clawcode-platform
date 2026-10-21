/**
 * Relevance decay scoring for memory entries.
 *
 * Implements exponential half-life decay: memories accessed recently score higher
 * than stale ones, with a configurable half-life period.
 */

/** Parameters controlling the decay curve. */
export type DecayParams = {
  readonly halfLifeDays: number;
};

/**
 * Calculate the relevance score for a memory entry based on importance and recency.
 *
 * Formula: importance * 0.5^(daysSinceAccess / halfLifeDays)
 *
 * - If the memory was accessed in the future relative to `now`, returns importance unchanged.
 * - Result is always clamped to [0, 1].
 *
 * @param importance - Base importance score (0-1)
 * @param accessedAt - ISO 8601 timestamp of last access
 * @param now - Current reference time
 * @param config - Decay configuration with halfLifeDays
 * @returns Relevance score in [0, 1]
 */
export function calculateRelevanceScore(
  importance: number,
  accessedAt: string,
  now: Date,
  config: DecayParams,
): number {
  const accessedTime = new Date(accessedAt).getTime();
  const nowTime = now.getTime();
  const daysSinceAccess = (nowTime - accessedTime) / (1000 * 60 * 60 * 24);

  if (daysSinceAccess <= 0) {
    return Math.max(0, Math.min(1, importance));
  }

  const decayed = importance * Math.pow(0.5, daysSinceAccess / config.halfLifeDays);
  return Math.max(0, Math.min(1, decayed));
}
