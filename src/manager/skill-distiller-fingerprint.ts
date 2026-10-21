/**
 * Phase 132 Plan 01 T-02 — trajectory fingerprint helper.
 *
 * Backs D-07 sticky-rejection dedup. Per CONTEXT.md §specifics:
 *   "SHA256 of sorted-unique tool-call names + count buckets.
 *    Drops parameter content."
 *
 * Algorithm:
 *   1. Extract `tool` from each call; lowercase for stability.
 *   2. Group by tool name → count per tool.
 *   3. Sort entries by tool name ascending (canonical order).
 *   4. Format as `"<tool>:<count>;<tool>:<count>;..."`.
 *   5. SHA256(utf8) → 64-char lowercase hex.
 *
 * The fingerprint is INTENTIONALLY LOSSY: same trajectory shape across
 * different sessions (different parameter values, different timestamps,
 * different ordering of identical tool sets) collapses to the same hash.
 * That is the whole point of sticky rejection — operator reject decisions
 * stick across re-runs of "same shape" trajectories.
 *
 * Zero new npm deps — uses Node.js `node:crypto`.
 *
 * Per `feedback_silent_path_bifurcation.md`: this is the SINGLE source of
 * truth for trajectory fingerprinting. Plan 02's distiller and any future
 * call site (UAT replay, dashboard preview) import from here.
 */

import { createHash } from "node:crypto";

/**
 * A single normalized entry in the canonical sorted-unique trajectory.
 *
 * Exported so callers can introspect what was hashed (used by telemetry —
 * the `phase132-task-completed` log line includes the normalized shape
 * alongside the fingerprint so operators can grep `journalctl` for
 * "I rejected this shape last week").
 */
export type NormalizedTrajectory = ReadonlyArray<{
  readonly tool: string;
  readonly count: number;
}>;

/**
 * Group tool calls by lowercase tool name, return as sorted-ascending
 * {tool, count} array. Pure function — no side effects.
 *
 * Empty input returns an empty array (canonical form for "no trajectory").
 */
export function normalizeTrajectory(
  // Accepts any object with a `tool` field; extra fields (e.g. `ts`) are
  // ignored — parameter content is INTENTIONALLY dropped per CONTEXT D-07.
  toolCalls: ReadonlyArray<{ readonly tool: string } & Record<string, unknown>>,
): NormalizedTrajectory {
  const counts = new Map<string, number>();
  for (const call of toolCalls) {
    const key = call.tool.toLowerCase();
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return Array.from(counts.entries())
    .map(([tool, count]) => ({ tool, count }))
    .sort((a, b) => (a.tool < b.tool ? -1 : a.tool > b.tool ? 1 : 0));
}

/**
 * Compute the SHA256 trajectory fingerprint per D-07.
 *
 * Empty trajectory → SHA256("") =
 *   "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855".
 * This is documented and stable; do NOT special-case empty inputs.
 */
export function trajectoryFingerprint(
  // Accepts any object with a `tool` field; extra fields (e.g. `ts`) are
  // ignored — parameter content is INTENTIONALLY dropped per CONTEXT D-07.
  toolCalls: ReadonlyArray<{ readonly tool: string } & Record<string, unknown>>,
): string {
  const normalized = normalizeTrajectory(toolCalls);
  const canonical = normalized
    .map((entry) => `${entry.tool}:${entry.count}`)
    .join(";");
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}
