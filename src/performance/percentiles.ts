/**
 * Percentile helpers and SQL for the trace subsystem.
 *
 * `parseSinceDuration` / `sinceToIso` are shared between:
 *   - `clawcode latency --since <duration>` CLI
 *   - `GET /api/agents/:name/latency?since=<duration>` dashboard endpoint
 *   - trace-retention heartbeat check
 *
 * `PERCENTILE_SQL` is the canonical ROW_NUMBER()-based percentile query
 * used by TraceStore.getPercentiles. SQLite lacks PERCENTILE_CONT, so we
 * rank rows and index into the nearest-rank position.
 */

/** Suffix -> milliseconds multiplier. */
const DURATION_MULTIPLIERS: Readonly<Record<string, number>> = Object.freeze({
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
});

const DURATION_PATTERN = /^(\d+)(h|d|m|s)$/;

/**
 * Parse a human duration string into milliseconds.
 *
 * Accepts `<n>s`, `<n>m`, `<n>h`, `<n>d` where n is a positive integer.
 * Examples: `30s`, `90s`, `30m`, `1h`, `6h`, `24h`, `7d`.
 *
 * @param input - Duration string
 * @returns Milliseconds
 * @throws RangeError if the input does not match the expected format
 */
export function parseSinceDuration(input: string): number {
  const match = DURATION_PATTERN.exec(input);
  if (!match) {
    throw new RangeError(`invalid since duration: ${input}`);
  }
  const [, numStr, suffix] = match;
  const multiplier = DURATION_MULTIPLIERS[suffix!];
  if (multiplier === undefined) {
    throw new RangeError(`invalid since duration: ${input}`);
  }
  return Number(numStr) * multiplier;
}

/**
 * Convert a human duration string into an ISO 8601 cutoff timestamp
 * relative to the provided `now` (defaults to `new Date()`).
 *
 * @param input - Duration string (e.g. `24h`, `7d`)
 * @param now - Reference timestamp; defaults to the current time
 * @returns ISO 8601 string representing `now - parseSinceDuration(input)`
 */
export function sinceToIso(input: string, now: Date = new Date()): string {
  const deltaMs = parseSinceDuration(input);
  return new Date(now.getTime() - deltaMs).toISOString();
}

/**
 * Canonical percentile SQL.
 *
 * Bind parameters:
 *   - @agent      — agent name filter
 *   - @since      — ISO 8601 cutoff; only turns with started_at >= @since match
 *   - @span_name  — canonical segment. When equal to `tool_call`, aggregates
 *                   across all spans whose name matches `tool_call.%`. Otherwise
 *                   matches `s.name = @span_name` exactly.
 *
 * Rank math: nearest-rank percentile. For a total of N rows ordered
 * ascending by duration_ms, the p-th percentile is the duration at rank
 * floor(N * p) + 1 (1-indexed), clamped via ROW_NUMBER() >= target.
 * Using CAST(total * p AS INTEGER) + 1 yields stable rankings for the
 * test assertions in percentiles.test.ts (p50 in [49..51] for N=100).
 */
export const PERCENTILE_SQL = `
WITH ranked AS (
  SELECT s.duration_ms,
    ROW_NUMBER() OVER (ORDER BY s.duration_ms) AS rn,
    COUNT(*) OVER () AS total
  FROM trace_spans s
  JOIN traces t ON t.id = s.turn_id
  WHERE t.agent = @agent
    AND t.started_at >= @since
    AND (
      (@span_name = 'tool_call' AND s.name LIKE 'tool_call.%')
      OR (@span_name != 'tool_call' AND s.name = @span_name)
    )
)
SELECT
  CAST(MIN(CASE WHEN rn >= CAST(total * 0.50 AS INTEGER) + 1 THEN duration_ms END) AS INTEGER) AS p50,
  CAST(MIN(CASE WHEN rn >= CAST(total * 0.95 AS INTEGER) + 1 THEN duration_ms END) AS INTEGER) AS p95,
  CAST(MIN(CASE WHEN rn >= CAST(total * 0.99 AS INTEGER) + 1 THEN duration_ms END) AS INTEGER) AS p99,
  total AS count
FROM ranked
`;
