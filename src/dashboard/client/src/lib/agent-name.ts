/**
 * Phase 116 post-deploy Bug 1 — subagent name bucketing.
 *
 * Mirrors the daemon-side helpers in `src/manager/subagent-name.ts`. The
 * SPA cannot import from outside `src/dashboard/client/` (separate
 * tsconfig + Vite root) so the regex is duplicated here with a hard
 * link back to the canonical source — when the spawner naming convention
 * changes, both files must move together.
 *
 * Canonical source: `src/manager/subagent-name.ts` (D-NAM-01 / D-NAM-02).
 *
 * Two patterns produced by SubagentThreadSpawner.spawnInThread:
 *   - Delegated: `${parent}-via-${delegate}-${nanoid(6)}`
 *     e.g. `fin-client-via-fin-research-57r__G`
 *   - Direct:    `${parent}-sub-${nanoid(6)}`
 *     e.g. `fin-client-sub-4XZKL0`
 *
 * `nanoid(6)` uses the URL-safe alphabet `[A-Za-z0-9_-]` (6 chars).
 */

const SUBAGENT_PARENT_RE = /^(.+?)-(?:via-.+-|sub-)[A-Za-z0-9_-]{6}$/

/**
 * Strip a subagent-thread suffix to recover the parent (root) agent name.
 * Returns the input unchanged if it doesn't match the spawner-generated
 * naming convention — operator-defined agents pass through verbatim.
 *
 * Used by the F17 cost dashboard to bucket subagent series back to their
 * root agent so the chart legend doesn't explode into hundreds of one-shot
 * series (operator screenshot showed `Admin Clawdy-sub-Wo2nHX`,
 * `fin-client-sub-pRVDAx`, `Admin Clawdy-via-research-2K7cf3`, etc.
 * each treated as a distinct series).
 */
export function parentAgentName(name: string): string {
  const match = SUBAGENT_PARENT_RE.exec(name)
  return match ? match[1]! : name
}
