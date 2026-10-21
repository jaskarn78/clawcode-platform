/**
 * Phase 132-fu T02 — `getTrajectoryForTurnId` pure helper.
 *
 * Extracted from `SessionManager` so the accessor can be unit-tested without
 * standing up the full SessionManager constructor (memory stores, embedders,
 * session adapters, warm-path checks, ...). `SessionManager` exposes the
 * same shape via a thin instance method that calls into this helper with
 * the live per-agent TraceStore map.
 *
 * Contract:
 *   - Returns `undefined` when the agent has no per-agent TraceStore — the
 *     "unknown agent" case. Callers (daemon emit sites) should swallow
 *     `undefined` and skip the emit, since there's no signal to feed the
 *     distiller.
 *   - Returns `{trajectory: [], durationMs: 0}` when the agent has a
 *     TraceStore but the requested turn id has no `traces` row yet. The
 *     eligibility filter will reject on `too-few-tool-calls` — correct
 *     behavior for the no-data case.
 *   - Otherwise returns the ordered tool-call trajectory + the
 *     `traces.total_ms` for that turn, ready to splice into a
 *     `TaskCompletedEvent` payload.
 *
 * Replaces the empty-trajectory + `durationMs: 0` stub at the two daemon
 * emit sites (subagent-complete + delegate-task) — see
 * `.planning/phases/132-autonomous-skill-creation/132-04-SUMMARY.md`
 * carry-over #5 + this plan's SUMMARY for the architectural pivot rationale.
 */
import type { TraceStore } from "../performance/trace-store.js";
import type { ToolCallSpanRow } from "../performance/types.js";

/**
 * The shape `emitTaskCompletedEvent` consumes (trajectory + durationMs slice
 * of `TaskCompletedEvent`). Callers spread this into the rest of the event
 * payload at the emit site.
 */
export type TurnTrajectoryView = {
  readonly trajectory: readonly ToolCallSpanRow[];
  readonly durationMs: number;
};

/**
 * Pure helper that reads the per-agent TraceStore (if any) and assembles the
 * `TurnTrajectoryView` for the requested turn id.
 *
 * @param traceStores — typically `manager.memory.traceStores` (Map<agentName,
 *                      TraceStore>). Passed in instead of `SessionManager` so
 *                      this function has no class-shape dependency.
 * @param agentName   — owning agent for the TraceStore lookup.
 * @param turnId      — the `traces.id` value (Discord message id,
 *                      `subagent:<id>`, or `scheduler:<id>` — see
 *                      `src/performance/trace-collector.ts:44`).
 */
export function getTrajectoryForTurnId(
  traceStores: ReadonlyMap<string, TraceStore>,
  agentName: string,
  turnId: string,
): TurnTrajectoryView | undefined {
  const store = traceStores.get(agentName);
  if (!store) return undefined;

  const trajectory = store.getToolCallSpansForTurn(turnId);
  const totalMs = store.getTraceTotalMsForTurn(turnId);
  return Object.freeze({
    trajectory,
    durationMs: typeof totalMs === "number" ? totalMs : 0,
  });
}

/**
 * Phase 132-fu T06 — `getTrajectoryForSubagent` multi-turn aggregator.
 *
 * The CORRECT shape for the subagent-complete emit site. Each subagent
 * thread spans MULTIPLE Discord message-reply turns, each with its own
 * `traces.id = discord:<snowflake>`. Single-turnId lookup
 * (`getTrajectoryForTurnId`) only captures one turn out of many — missing
 * the full work-trajectory.
 *
 * Architecture finding from Phase 132-fu (during T03 wiring): the
 * original spec assumed a single `subagent:<id>` trace.id existed, but
 * TURN_ID_REGEX (src/manager/turn-origin.ts:60) only accepts
 * `discord|scheduler|task|trigger|openai-api` prefixes. The subagent
 * agent process registers under `sessionName` (e.g.
 * `<parent>-sub-<nanoid>`), so its trace rows have
 * `agent = sessionName`. The natural lookup is therefore by
 * `(agent, time-window)` — bounded by the binding's
 * `createdAt`/`completedAt`.
 *
 * Returns `undefined` for unknown agents. Returns `{trajectory:[],
 * durationMs:0}` when the window has no matched tool spans (or no
 * matched traces).
 *
 * `durationMs` is the wall-clock window (`completedAtMs - createdAtMs`)
 * NOT the sum of trace `total_ms` across turns. Wall-clock is more
 * honest for the distiller's "≥3 min total task wall-clock" gate —
 * includes inter-turn idle time which is part of the user-facing
 * task duration.
 */
export function getTrajectoryForSubagent(
  traceStores: ReadonlyMap<string, TraceStore>,
  sessionName: string,
  createdAtMs: number,
  completedAtMs: number,
): TurnTrajectoryView | undefined {
  const store = traceStores.get(sessionName);
  if (!store) return undefined;

  const sinceIso = new Date(createdAtMs).toISOString();
  const untilIso = new Date(completedAtMs).toISOString();
  const trajectory = store.getToolCallSpansForAgentWindow(
    sessionName,
    sinceIso,
    untilIso,
  );
  const durationMs = Math.max(0, completedAtMs - createdAtMs);
  return Object.freeze({ trajectory, durationMs });
}
