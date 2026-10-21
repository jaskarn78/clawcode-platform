/**
 * Phase 95 Plan 01 Task 2 — D-01 idle-window detector primitive.
 *
 * Pure-DI module:
 *   - No SDK imports
 *   - No fs imports
 *   - No bare zero-arg Date constructor — `now` is dependency-injected so tests
 *     drive deterministic clocks and production wires the daemon's clock
 *     at the daemon edge (95-02 cron, 95-03 IPC handler)
 *
 * Two surfaces:
 *   - `isAgentIdle(deps)` — single-agent silence check (returns reason)
 *   - `findIdleAgents(agents, now)` — fleet sweep filter (cron at 95-02
 *     calls this every dream-cadence tick to decide which agents to wake)
 *
 * Hard floor 5min / hard ceiling 6h are LOCKED from D-01:
 *   - Hard floor: don't dream more often than 5min (burns tokens; even if
 *     an operator sets idleMinutes=1, the floor wins)
 *   - Hard ceiling: if agent has been silent that long, daemon should
 *     STILL fire one consolidation pass regardless of idleMinutes (e.g.
 *     a 6-hour quiet window is its own trigger condition)
 *
 * Idle gating belongs to the cron timer (Plan 95-02), NOT the dream-pass
 * primitive itself. `runDreamPass` (dream-pass.ts) runs unconditionally
 * once invoked — manual triggers (CLI / Discord slash in 95-03) bypass
 * idle gating intentionally.
 */

/** D-01 hard floor: 5 minutes (don't dream more often than this). */
export const IDLE_HARD_FLOOR_MS = 5 * 60 * 1000;

/** D-01 hard ceiling: 6 hours (still fire one final consolidation pass). */
export const IDLE_HARD_CEILING_MS = 6 * 60 * 60 * 1000;

/**
 * Reason codes returned by `isAgentIdle` — drives operator-readable cron
 * + IPC + log output downstream. Discriminate idle vs active vs no-prior-
 * turn so the caller can decide whether to fire / log / skip silently.
 */
export type IsAgentIdleReason =
  | "active"
  | "idle-threshold-met"
  | "idle-ceiling-bypass"
  | "no-prior-turn";

export interface IsAgentIdleDeps {
  readonly lastTurnAt: Date | null;
  readonly idleMinutes: number;
  readonly now: () => Date;
}

export interface IsAgentIdleResult {
  readonly idle: boolean;
  readonly reason: IsAgentIdleReason;
}

/**
 * Return whether the agent has been silent long enough to dream.
 *
 * Order of checks matters:
 *   1. lastTurnAt=null → 'no-prior-turn' (don't dream agents that never spoke)
 *   2. elapsed < hard floor → 'active' (regardless of idleMinutes)
 *   3. elapsed > hard ceiling → 'idle-ceiling-bypass' (D-01 bound fires)
 *   4. elapsed > idleMinutes*60s → 'idle-threshold-met'
 *   5. else → 'active'
 */
export function isAgentIdle(deps: IsAgentIdleDeps): IsAgentIdleResult {
  if (deps.lastTurnAt === null) {
    return { idle: false, reason: "no-prior-turn" };
  }
  const elapsedMs = deps.now().getTime() - deps.lastTurnAt.getTime();
  if (elapsedMs < IDLE_HARD_FLOOR_MS) {
    return { idle: false, reason: "active" };
  }
  if (elapsedMs > IDLE_HARD_CEILING_MS) {
    return { idle: true, reason: "idle-ceiling-bypass" };
  }
  if (elapsedMs > deps.idleMinutes * 60_000) {
    return { idle: true, reason: "idle-threshold-met" };
  }
  return { idle: false, reason: "active" };
}

/**
 * Per-agent input for `findIdleAgents`. Only the fields the cron sweep
 * needs — keep this shape minimal so callers (95-02 cron) can build it
 * from any agent registry without bringing the full SessionHandle type.
 */
export interface FindIdleAgentsInput {
  readonly name: string;
  readonly lastTurnAt: Date | null;
  readonly dreamConfig: { readonly enabled: boolean; readonly idleMinutes: number };
}

/**
 * Filter a fleet to the names of agents that:
 *   1. have `dream.enabled === true`, AND
 *   2. are currently idle per `isAgentIdle`.
 *
 * Order is preserved (input order). Disabled agents are skipped before
 * the idle check fires — saves one Date() call per disabled agent.
 */
export function findIdleAgents(
  agents: readonly FindIdleAgentsInput[],
  now: () => Date,
): readonly string[] {
  const result: string[] = [];
  for (const a of agents) {
    if (!a.dreamConfig.enabled) continue;
    const r = isAgentIdle({
      lastTurnAt: a.lastTurnAt,
      idleMinutes: a.dreamConfig.idleMinutes,
      now,
    });
    if (r.idle) result.push(a.name);
  }
  return Object.freeze(result);
}
