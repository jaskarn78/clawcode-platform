/**
 * P4 (memory program) — remediation policy resolution + fork/pool session
 * scanning. Pure: no I/O, no Date, no env reads (callers pass env).
 *
 * Two-plane design (locked in the program plan): MemoryGuard OBSERVES
 * classes and alerts on budgets; reapers ACT only on STRUCTURAL orphan
 * signals (not-in-registry, orphaned parent, over-cap). Budget breaches
 * never trigger kills. This module is the shared vocabulary between the
 * planes: which structural reaper may act, at what mode.
 */

import { spawnKindOf } from "./subagent-name.js";

// ---------------------------------------------------------------------------
// Remediation mode lattice
// ---------------------------------------------------------------------------

export type RemediationClass =
  | "mcp-orphan"
  | "chrome"
  | "sub"
  | "survivor-cli"
  | "npm"
  | "fork"
  | "pool";

export type RemediationMode = "off" | "alert" | "reap";

export interface RemediationConfig {
  readonly enabled?: boolean;
  readonly classes?: Readonly<Partial<Record<RemediationClass, RemediationMode>>>;
}

/**
 * Shipped-on reapers (pre-P4 behavior): their `reap` default holds even
 * with the global `enabled: false`, because flipping the global on
 * rollout day must not silently disable three working reapers. Turning
 * THEM off requires an explicit per-class entry.
 */
export const GRANDFATHERED_CLASSES: ReadonlySet<RemediationClass> = new Set([
  "mcp-orphan",
  "chrome",
  "sub",
]);

const MODE_RANK: Record<RemediationMode, number> = { off: 0, alert: 1, reap: 2 };

function tighten(a: RemediationMode, b: RemediationMode): RemediationMode {
  return MODE_RANK[a] <= MODE_RANK[b] ? a : b;
}

/**
 * Resolve the EFFECTIVE mode for a class. Semantics (tighten-only):
 *   1. configured = explicit per-class entry, else `reap` for
 *      grandfathered classes, else `off`.
 *   2. Global `enabled: false` clamps NON-grandfathered classes to
 *      ≤ alert.
 *   3. `CLAWCODE_REMEDIATION_DISABLE=1` clamps EVERYTHING (incl.
 *      grandfathered) to ≤ alert.
 * Alerts themselves never turn off via this config — census/candidate
 * logging is gated by ≥ alert, and only `off` suppresses a scan.
 */
export function resolveRemediationMode(
  cls: RemediationClass,
  cfg: RemediationConfig | undefined,
  env: { readonly CLAWCODE_REMEDIATION_DISABLE?: string },
): RemediationMode {
  const grandfathered = GRANDFATHERED_CLASSES.has(cls);
  let mode: RemediationMode =
    cfg?.classes?.[cls] ?? (grandfathered ? "reap" : "off");
  if ((cfg?.enabled ?? false) === false && !grandfathered) {
    mode = tighten(mode, "alert");
  }
  if (env.CLAWCODE_REMEDIATION_DISABLE === "1") {
    mode = tighten(mode, "alert");
  }
  return mode;
}

// ---------------------------------------------------------------------------
// Fork/pool session scanning (session-registry plane)
// ---------------------------------------------------------------------------

export interface WorkerSessionInfo {
  readonly name: string;
  readonly status: string;
  readonly startedAt: number | null;
}

export interface ForkPoolCandidate {
  readonly name: string;
  readonly kind: "fork" | "pool";
  readonly reason: "orphaned-parent" | "max-age" | "unmanaged-pool" | "over-cap";
  readonly ageSec: number;
}

/** Per-kind policy constants (design-locked). */
export const SESSION_KIND_POLICIES = Object.freeze({
  fork: Object.freeze({ minAgeSeconds: 600, maxAgeMinutes: 120 }),
  // Pool: idleness/age are NEVER triggers — parked-warm is the design
  // intent. Structural triggers only.
  pool: Object.freeze({ minAgeSeconds: 600 }),
});

/**
 * Pure scan for fork/pool leak candidates. ADDITIVE to the shipped
 * `scanForSubagentSessions` (sub/via/thread — untouched, pinned).
 *
 * fork triggers: parent agent not running, OR age ≥ maxAgeMinutes
 *   (forks are minutes-scale by nature — advisor consults, optimizer
 *   evals; a 2h-old fork is a leaked one).
 * pool triggers: parent agent not running, OR the pool disowns the
 *   session (`isPoolManaged` false — leaked across a pool restart), OR
 *   per-parent count exceeds `poolCapForParent` (oldest excess only).
 */
export function scanForForkPoolSessions(args: {
  readonly sessions: readonly WorkerSessionInfo[];
  readonly runningAgentNames: ReadonlySet<string>;
  readonly isPoolManaged: (name: string) => boolean;
  readonly poolCapForParent: (parent: string) => number;
  readonly parentOf: (name: string) => string;
  readonly now?: number;
}): readonly ForkPoolCandidate[] {
  const now = args.now ?? Date.now();
  const out: ForkPoolCandidate[] = [];
  const poolByParent = new Map<string, WorkerSessionInfo[]>();

  for (const s of args.sessions) {
    const kind = spawnKindOf(s.name);
    if (kind !== "fork" && kind !== "pool") continue;
    if (s.status !== "running") continue;
    if (s.startedAt === null) continue;
    const ageSec = Math.round((now - s.startedAt) / 1000);
    if (ageSec < SESSION_KIND_POLICIES[kind].minAgeSeconds) continue;

    const parent = args.parentOf(s.name);
    if (kind === "fork") {
      if (!args.runningAgentNames.has(parent)) {
        out.push({ name: s.name, kind, reason: "orphaned-parent", ageSec });
      } else if (ageSec >= SESSION_KIND_POLICIES.fork.maxAgeMinutes * 60) {
        out.push({ name: s.name, kind, reason: "max-age", ageSec });
      }
      continue;
    }
    // pool
    if (!args.runningAgentNames.has(parent)) {
      out.push({ name: s.name, kind, reason: "orphaned-parent", ageSec });
      continue;
    }
    if (!args.isPoolManaged(s.name)) {
      out.push({ name: s.name, kind, reason: "unmanaged-pool", ageSec });
      continue;
    }
    const list = poolByParent.get(parent) ?? [];
    list.push(s);
    poolByParent.set(parent, list);
  }

  // Over-cap pools: reap OLDEST excess only.
  for (const [parent, list] of poolByParent) {
    const cap = args.poolCapForParent(parent);
    if (list.length <= cap) continue;
    const sorted = [...list].sort(
      (a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0),
    );
    for (const s of sorted.slice(0, list.length - cap)) {
      out.push({
        name: s.name,
        kind: "pool",
        reason: "over-cap",
        ageSec: Math.round((now - (s.startedAt ?? now)) / 1000),
      });
    }
  }
  return out;
}

/**
 * Pool fork/pool sessions never use `-via-`; the standard parent
 * extraction covers `-fork-`/`-pool-` names (strip the generated
 * suffix). Exposed for the daemon's parentOf wiring.
 */
export function forkPoolParentOf(name: string): string {
  const m = /^(.+?)-(?:fork|pool)-[A-Za-z0-9_-]{6}(-opt)?$/.exec(name);
  return m ? m[1]! : name;
}
