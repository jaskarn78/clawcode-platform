/**
 * Phase 999.X — Subagent thread name detection.
 *
 * Auto-spawned subagent threads have generated names that follow one of two
 * patterns produced by `SubagentThreadSpawner.spawnInThread` (see
 * `src/discord/subagent-thread-spawner.ts:516`):
 *
 *   - Delegated: `${parent}-via-${delegate}-${nanoid(6)}`
 *     e.g. `fin-client-via-fin-research-57r__G`
 *   - Direct:    `${parent}-sub-${nanoid(6)}`
 *     e.g. `fin-client-sub-4XZKL0`
 *
 * `nanoid(6)` uses the URL-safe alphabet `[A-Za-z0-9_-]` (6 chars).
 *
 * Operator-defined agent names (`personal`, `fin-client`, `Admin Clawdy`,
 * etc.) live in `clawcode.yaml` and never carry the trailing 6-char nanoid
 * suffix, so this regex is safe to use as the auto-prune-eligible filter
 * across the codebase. The check is intentionally narrow — both the
 * stale-binding-sweep extension and the subagent-session-reaper key off
 * this single helper so there is one source of truth for "is this name
 * auto-spawned?"
 */

const SUBAGENT_NAME_RE = /^.+-(via-.+-|sub-)[A-Za-z0-9_-]{6}$/;

/**
 * Returns true if `name` matches the SubagentThreadSpawner-generated naming
 * convention. False for operator-defined agent names, even if they happen
 * to contain "via" or "sub" — the trailing 6-char nanoid suffix is the
 * load-bearing part.
 */
export function isSubagentThreadName(name: string): boolean {
  return SUBAGENT_NAME_RE.test(name);
}

/**
 * Loose substring match for the three spawner-generated session-name
 * infixes: `-sub-`, `-via-`, and `-thread-`.
 *
 * Phase 999.19 D3 — this is the LOOSE "exclude from the top-level fleet"
 * predicate. It is the single-source drop-in for the seven ad-hoc
 * `.includes("-sub-") || .includes("-thread-")` filter pairs scattered
 * across `openai/server.ts`, `openai/endpoint-bootstrap.ts`, `daemon.ts`
 * (4 fleet-projection sites), and `cli/commands/threads.ts`. Phase 999.3
 * introduced the `${parent}-via-${delegate}-${id}` pattern but those
 * consumers only matched `-sub-`, leaking `*-via-*` ghost sessions into
 * `/clawcode-fleet` and `topLevelAgents`. This predicate closes that gap.
 *
 * It is INTENTIONALLY unanchored — unlike the strict
 * {@link isSubagentThreadName} (which pins the trailing 6-char nanoid and
 * is used for greeting suppression / `clawcode threads` source
 * classification), this predicate matches the substring exactly as the
 * prior `.includes` checks did, so the rewire is behaviour-preserving for
 * `-sub-` / `-thread-` and additive for `-via-`. The hyphen delimiters
 * (`-sub-` / `-via-`) guard against false hits on ordinary words like
 * "subaru" or "viable".
 */
const SUBAGENT_OR_THREAD_INFIX_RE = /-(sub|via|thread)-/;

/**
 * Returns true when `name` contains a `-sub-`, `-via-`, or `-thread-`
 * infix — i.e. it is a spawner-generated session name that must be
 * excluded from top-level fleet listings. See
 * {@link SUBAGENT_OR_THREAD_INFIX_RE} for the rationale and the contrast
 * with the strict {@link isSubagentThreadName}.
 */
export function isSubagentOrThreadSession(name: string): boolean {
  return SUBAGENT_OR_THREAD_INFIX_RE.test(name);
}

/**
 * Anchored capture used to extract the parent (root) agent name from a
 * subagent thread name. The non-greedy `(.+?)` captures the smallest
 * prefix terminated by the first `-via-…-nanoid6` or `-sub-nanoid6`
 * suffix anchored to end-of-string. We anchor end-of-string explicitly
 * so an operator-defined name that legitimately contains `-sub-` doesn't
 * get spuriously truncated.
 *
 * Examples (each → "fin-client"):
 *   - `fin-client-sub-4XZKL0`
 *   - `fin-client-via-fin-research-57r__G`
 *
 * 116-postdeploy Bug 1: returned from `parentAgentName(name)` so the
 * costs chart can bucket subagent series back to their parent root.
 */
const SUBAGENT_PARENT_RE = /^(.+?)-(?:via-.+-|sub-)[A-Za-z0-9_-]{6}$/;

/**
 * Strip a subagent-thread suffix to recover the parent (root) agent name.
 * Returns the input unchanged if it doesn't match the spawner-generated
 * naming convention — operator-defined agents pass through verbatim.
 *
 * Used by the Phase 116 cost dashboard (and any other surface that needs
 * to roll subagent activity up to the root agent) so the chart legend
 * doesn't explode into hundreds of one-shot series.
 */
export function parentAgentName(name: string): string {
  const match = SUBAGENT_PARENT_RE.exec(name);
  return match ? match[1]! : name;
}

// ---------------------------------------------------------------------------
// 2026-07-31 memory program F1 — spawn-kind classification.
//
// One source of truth for "what kind of session is this name", covering the
// two generator families the predicates above deliberately do NOT match:
// warm-pool workers (`${parent}-pool-${nanoid6}`, warm-worker-pool.ts:480)
// and forks (`${agent}-fork-${nanoid6}`, fork.ts:25 — advisor, optimizer,
// escalation). Additive: `SUBAGENT_NAME_RE` / `isSubagentThreadName` /
// `isSubagentOrThreadSession` keep their exact test-pinned meanings; new
// consumers (census, session-reaper policy table, spawn governor) use
// `spawnKindOf` instead.
// ---------------------------------------------------------------------------

/** Session-name families, by generator. `agent` = operator-defined. */
export type SpawnKind = "agent" | "sub" | "via" | "thread" | "pool" | "fork";

// Anchored per-generator, mirroring SUBAGENT_NAME_RE's trailing-nanoid
// discipline so operator names containing the words can't false-match.
const VIA_RE = /^.+-via-.+-[A-Za-z0-9_-]{6}$/;
const SUB_RE = /^.+-sub-[A-Za-z0-9_-]{6}$/;
const POOL_RE = /^.+-pool-[A-Za-z0-9_-]{6}$/;
// `(-opt)?` — optimizer eval forks append `-opt` to the standard fork name
// (`agent-runner.ts:75`: `${buildForkName(parent)}-opt`).
const FORK_RE = /^.+-fork-[A-Za-z0-9_-]{6}(-opt)?$/;
// `-thread-` names are spawner-generated but historically loose (no pinned
// suffix format) — keep the same loose infix the fleet-exclusion predicate
// uses, checked LAST so the anchored families win.
const THREAD_INFIX_RE = /-thread-/;

/**
 * Classify a session name by its generator family. Order matters: the
 * anchored generator patterns are checked before the loose `-thread-`
 * infix; anything unmatched is an operator-defined `agent`.
 */
export function spawnKindOf(name: string): SpawnKind {
  if (VIA_RE.test(name)) return "via";
  if (SUB_RE.test(name)) return "sub";
  if (POOL_RE.test(name)) return "pool";
  if (FORK_RE.test(name)) return "fork";
  if (THREAD_INFIX_RE.test(name)) return "thread";
  return "agent";
}

/**
 * True for every machine-generated worker session (anything that is not an
 * operator-defined agent). Superset of `isSubagentOrThreadSession` — also
 * covers `-pool-` and `-fork-` names, which the fleet-exclusion predicate
 * deliberately does not.
 */
export function isManagedWorkerName(name: string): boolean {
  return spawnKindOf(name) !== "agent";
}
