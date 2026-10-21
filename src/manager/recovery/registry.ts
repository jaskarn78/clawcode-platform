/**
 * Phase 94 Plan 03 — recovery registry orchestrator.
 *
 * Module-load wiring: 3 default handlers in priority order (lowest priority
 * number runs first):
 *   - playwright-chromium  (priority 10, specific)
 *   - op-refresh           (priority 20, specific)
 *   - subprocess-restart   (priority 100, last-resort, threshold-gated)
 *
 * Bounded budget enforcement (D-05): max 3 attempts per server per hour.
 * Beyond budget, runRecoveryForServer returns 'give-up' WITHOUT invoking
 * any handler. Old attempts (older than ATTEMPT_WINDOW_MS = 1hr) are pruned
 * at the start of each invocation so the budget rolls forward.
 *
 * Admin-clawdy alert (Phase 90.1 bot-direct fallback): when 3 consecutive
 * failure outcomes accrue within 1hr for the same server, deps.adminAlert
 * fires once with a human-readable text message containing server name +
 * verbatim recent error. Failure to send the alert is observational —
 * never breaks the recovery flow.
 *
 * Invariants pinned by tests + static-grep:
 *   - RECOVERY_REGISTRY is Object.freeze'd
 *   - 3 handlers in order: playwright-chromium, op-refresh, subprocess-restart
 *   - Budget exhaustion → 'give-up' with reason containing 'budget'
 *   - 3rd-failure alert via deps.adminAlert
 *   - Pure-DI: no node:child_process import here; handlers receive execFile
 *     etc via deps; production wires real implementations at the daemon edge
 */

import type { McpServerState } from "../../mcp/readiness.js";
import {
  type RecoveryHandler,
  type RecoveryOutcome,
  type RecoveryDeps,
  type AttemptRecord,
  MAX_ATTEMPTS_PER_HOUR,
  ATTEMPT_WINDOW_MS,
} from "./types.js";
import { playwrightChromiumHandler } from "./playwright-chromium.js";
import { opRefreshHandler } from "./op-refresh.js";
import { subprocessRestartHandler } from "./subprocess-restart.js";

/**
 * Module-load 3-handler wiring. Sorted by priority ASC so registry.find()
 * naturally picks the most-specific match first.
 *
 * Object.freeze prevents runtime extension — adding a handler requires a
 * code change + Plan revision.
 */
export const RECOVERY_REGISTRY: readonly RecoveryHandler[] = Object.freeze(
  [playwrightChromiumHandler, opRefreshHandler, subprocessRestartHandler].sort(
    (a, b) => a.priority - b.priority,
  ),
);

/**
 * Drop attempt records older than ATTEMPT_WINDOW_MS. Returns a NEW array
 * so the prev reference stays untouched (immutability). Caller writes the
 * pruned-then-extended array back into the history Map.
 */
function pruneRecent(
  history: readonly AttemptRecord[],
  now: Date,
): readonly AttemptRecord[] {
  const cutoff = now.getTime() - ATTEMPT_WINDOW_MS;
  return history.filter((r) => Date.parse(r.attemptedAt) >= cutoff);
}

/**
 * Run recovery for ONE server, enforcing budget + admin-clawdy alert.
 *
 * @param serverName MCP server name with degraded probe
 * @param state      Current McpServerState (capabilityProbe.error read for matching)
 * @param history    Mutable Map<server, AttemptRecord[]> — registry mutates
 *                   in place (replacing entries, never mutating inner arrays)
 * @param deps       DI surface (execFile, killSubprocess, adminAlert, etc)
 */
export async function runRecoveryForServer(
  serverName: string,
  state: McpServerState,
  history: Map<string, AttemptRecord[]>,
  deps: RecoveryDeps,
): Promise<RecoveryOutcome> {
  const now = (deps.now ?? (() => new Date()))();
  const error = state.capabilityProbe?.error ?? "";

  // Prune the per-server attempt list to the rolling 1hr window. Replace
  // the Map entry with the pruned (mutable) array so subsequent appends
  // don't have to re-prune.
  const recent = [...pruneRecent(history.get(serverName) ?? [], now)];
  history.set(serverName, recent);

  // Budget gate — strictly BEFORE invoking any handler. Pinned by REC-BUDGET.
  if (recent.length >= MAX_ATTEMPTS_PER_HOUR) {
    const giveUp: RecoveryOutcome = {
      kind: "give-up",
      serverName,
      handlerName: "registry",
      reason: `budget exhausted: ${recent.length}/${MAX_ATTEMPTS_PER_HOUR} attempts in last ${ATTEMPT_WINDOW_MS / 60_000}min`,
    };
    // Log the budget-exhaustion attempt itself so operators see why no
    // handler ran. The append uses [...prev, new] so prev's identity is
    // preserved at the entry level (immutability invariant).
    history.set(serverName, [
      ...recent,
      {
        serverName,
        attemptedAt: now.toISOString(),
        handlerName: "registry",
        outcomeKind: giveUp.kind,
      },
    ]);
    return giveUp;
  }

  // Find first matching handler in priority-ascending order.
  const handler = RECOVERY_REGISTRY.find((h) => h.matches(error, state));
  if (!handler) {
    // No specific match AND last-resort handler said no (typically because
    // the 5min degraded-duration threshold isn't met yet). Caller can
    // re-evaluate next tick; we don't burn a budget slot.
    return { kind: "not-applicable", serverName };
  }

  // Invoke the handler. Implementations are required to NOT throw — they
  // catch internal errors and lift them into give-up / retry-later
  // outcomes. We still wrap defensively so a programmer error inside a
  // handler doesn't break the heartbeat tick.
  let outcome: RecoveryOutcome;
  try {
    outcome = await handler.recover(serverName, deps);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    deps.log.error(
      { serverName, handler: handler.name, error: reason },
      "recovery handler threw — coercing to give-up",
    );
    outcome = {
      kind: "give-up",
      serverName,
      handlerName: handler.name,
      reason,
    };
  }

  // Append the attempt record. Immutability invariant — new array, prev
  // entries' references preserved.
  const updated: AttemptRecord[] = [
    ...recent,
    {
      serverName,
      attemptedAt: now.toISOString(),
      handlerName: handler.name,
      outcomeKind: outcome.kind,
    },
  ];
  history.set(serverName, updated);

  // 3rd-failure admin-clawdy alert (D-05 + Phase 90.1).
  // Counts give-up + retry-later as failures. Recovered + not-applicable
  // are not failures.
  const failureCount = updated.filter(
    (r) => r.outcomeKind === "give-up" || r.outcomeKind === "retry-later",
  ).length;
  if (failureCount >= MAX_ATTEMPTS_PER_HOUR) {
    const alertText = `[ClawCode recovery] server ${serverName} has failed recovery ${failureCount} times in last hour. Last error: ${error.slice(0, 500)}`;
    try {
      await deps.adminAlert(alertText);
    } catch (alertErr) {
      deps.log.warn(
        { err: alertErr, serverName },
        "adminAlert failed — observational, not fatal",
      );
    }
  }

  return outcome;
}
