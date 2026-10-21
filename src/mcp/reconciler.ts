/**
 * Phase 999.15 — Tracker reconciliation engine (TRACK-01 + TRACK-04).
 *
 * Per-tick self-healing for the McpProcessTracker. Wakes up via
 * onTickAfter on the existing 60s orphan-reaper interval (wired in
 * src/manager/daemon.ts) and walks every registered agent:
 *
 *   - If recorded claudePid is dead → consult `deps.getClaudePid(name)`:
 *       - Returns `undefined` (session absent / stopped) → unregister(name).
 *         reason="agent-gone". Cleans up tracker entries when stopAgent
 *         left a residual entry behind (e.g. killAgentGroup short-circuited
 *         on an empty mcpPids list).
 *       - Returns `null` (session present, sink not yet populated by the
 *         SDK spawn callback) → SKIP this cycle. Next tick will retry.
 *       - Returns a number (sink populated) → updateAgent(name, newPid).
 *         reason="stale-claude".
 *   - If reason is "stale-claude" OR oldMcpCount === 0 → re-walk MCP
 *     children → replaceMcpPids(name, newMcpPids). reason upgraded to
 *     "agent-restart" if oldMcpCount > 0 AND new mcpPids differ.
 *
 * FIND-123-A.next T-08 — replaced the legacy `/proc`-walk rediscovery
 * (`discoverClaudeSubprocessPid`) with sink-based lookup. The sink is the
 * source of truth: the structural spawn wrapper writes child.pid into the
 * per-handle `ClaudePidSink` on every (re-)spawn, so a fresh sink read
 * always reflects the SDK's current claude PID without /proc scanning.
 * Stale-sink case (sink holds an old PID and claude died but SDK has not
 * yet respawned): reconciler SKIPS for that tick — the next spawn writes
 * the new PID into the sink, OR operator stop drops the session entirely
 * and the next tick takes the agent-gone path.
 *
 * Logging is DIFF-BASED: emits ONE warn log per agent per cycle ONLY when
 * tracker state actually changed (canonical envelope below). No-op cycles
 * are silent (CONTEXT determinism — required for journal cleanliness on
 * busy hosts where 14+ agents tick every 60s).
 *
 * Canonical log envelope (pinned by reconciler.test.ts Test 7):
 *   { component: "mcp-tracker", action: "reconcile", agent,
 *     oldClaudePid, newClaudePid, oldMcpCount, newMcpCount, reason,
 *     msg: "tracker state reconciled" }
 *
 * agent-gone variant:
 *   { component: "mcp-tracker", action: "reconcile", agent,
 *     oldClaudePid, oldMcpCount, reason: "agent-gone",
 *     msg: "tracker entry dropped — claude proc gone" }
 *
 * Iteration safety: snapshots agent NAMES via Array.from(...keys()) before
 * iterating so that mid-iteration mutations (unregister on agent-gone,
 * concurrent register from session-manager.ts polled discovery) don't
 * corrupt the walk (CONTEXT Pitfall 4).
 *
 * Error swallow: each agent's reconcile is in its own try/catch. A failure
 * for one agent NEVER propagates to the caller (onTickAfter must not
 * crash the reaper interval) and never blocks sibling agents.
 */

import type { Logger } from "pino";
import { discoverAgentMcpPids, isPidAlive } from "./proc-scan.js";
import type { McpProcessTracker } from "./process-tracker.js";

export type ReconcileReason =
  | "stale-claude"
  | "missing-mcps"
  | "agent-restart"
  | "agent-gone";

/**
 * Result of looking up an agent's current claude PID via the per-handle sink.
 *
 * `undefined` → session absent (operator stopped, never started, or fork
 * torn down). Reconciler should drop the tracker entry (agent-gone).
 *
 * `null` → session present but sink not yet populated (race window between
 * handle construction and the SDK spawn callback firing). Reconciler should
 * skip the entry for this cycle; the next tick will retry.
 *
 * `number` → sink populated with the live claude PID. Reconciler treats
 * this as the source of truth.
 */
export type ClaudePidLookup = number | null | undefined;

export interface ReconcileDeps {
  readonly tracker: McpProcessTracker;
  readonly daemonPid: number;
  readonly log: Logger;
  /**
   * FIND-123-A.next T-08 — sink-based claudePid resolver. Synchronous read
   * of the per-handle `ClaudePidSink` populated by the structural spawn
   * wrapper (`src/manager/detached-spawn.ts`). See `ClaudePidLookup` for
   * the tri-state contract.
   *
   * Optional ONLY to keep test fixtures that predate the sink contract
   * compiling. Production daemon ALWAYS injects this — when omitted, the
   * reconciler is a no-op for the stale-claude detection branch (treats
   * every entry as if the sink were null → skip).
   */
  readonly getClaudePid?: (agentName: string) => ClaudePidLookup;
}

/**
 * Reconcile every registered agent. Snapshots names BEFORE iterating to
 * survive mid-iteration mutations. Per-agent failures are caught + logged;
 * function never throws.
 */
export async function reconcileAllAgents(deps: ReconcileDeps): Promise<void> {
  const names = Array.from(deps.tracker.getRegisteredAgents().keys());
  for (const name of names) {
    // Phase 108 (Pitfall 6) — broker-owned pool children are registered
    // under synthetic owners with the `__broker:` prefix. The OnePassword
    // broker is the SOLE entity allowed to SIGTERM those PIDs (it knows
    // the per-pool refcount + drain ceiling). Per-tick reconciliation
    // must never treat them as per-agent entries — skipping them here
    // also prevents stale-claude detection from running, which would
    // otherwise see the daemon PID as the "claude" process and never
    // mark these entries as dead. Broker's own onPoolExit callback
    // unregisters the synthetic entry on child exit.
    if (name.startsWith("__broker:")) continue;
    try {
      await reconcileAgent(name, deps);
    } catch (err) {
      deps.log.warn(
        {
          component: "mcp-tracker",
          action: "reconcile",
          agent: name,
          err: String(err),
        },
        "reconcile failed for agent",
      );
    }
  }
}

/**
 * Reconcile a single agent. Used both by reconcileAllAgents (per-tick loop)
 * and by McpProcessTracker.killAgentGroup (TRACK-06 reconcile-before-kill —
 * Plan 02 wires the closure via deps.reconcileAgent in daemon.ts).
 *
 * No-op when the agent is no longer registered (race-safe).
 */
export async function reconcileAgent(
  name: string,
  deps: ReconcileDeps,
): Promise<void> {
  // Phase 108 (Pitfall 6) — defensive skip for broker-owned synthetic
  // owners. reconcileAllAgents already filters them, but reconcileAgent
  // is also wired into tracker.killAgentGroup's reconcile-before-kill
  // closure (TRACK-06). A future caller passing a `__broker:` name here
  // would otherwise probe a non-existent claude proc, mark it dead, and
  // unregister the entry behind the broker's back.
  if (name.startsWith("__broker:")) return;
  const entry = deps.tracker.getRegisteredAgents().get(name);
  if (!entry) return;

  const oldClaudePid = entry.claudePid;
  const oldMcpPids: readonly number[] = [...entry.mcpPids];
  const oldMcpCount = oldMcpPids.length;

  let newClaudePid = oldClaudePid;
  let reason: ReconcileReason | null = null;

  // Stale-claude detection: consult the per-handle sink when recorded PID
  // is dead. Tri-state lookup (undefined / null / number) drives the next
  // action — see ClaudePidLookup docs.
  if (!isPidAlive(oldClaudePid)) {
    const lookup: ClaudePidLookup = deps.getClaudePid
      ? deps.getClaudePid(name)
      : null;
    if (lookup === undefined) {
      // Session absent (operator stopped, fork dispose, etc.) — drop entry
      // and emit agent-gone log. This is the cleanup path for the case
      // killAgentGroup left an empty-mcpPids tracker entry behind.
      deps.tracker.unregister(name);
      deps.log.warn(
        {
          component: "mcp-tracker",
          action: "reconcile",
          agent: name,
          oldClaudePid,
          oldMcpCount,
          reason: "agent-gone" satisfies ReconcileReason,
        },
        "tracker entry dropped — claude proc gone",
      );
      return;
    }
    if (lookup === null) {
      // Session present but sink not yet populated (SDK spawn race) — or
      // claude died and the SDK has not yet respawned. Skip this cycle;
      // the next tick re-checks once the sink is populated.
      return;
    }
    deps.tracker.updateAgent(name, lookup);
    newClaudePid = lookup;
    reason = "stale-claude";
  }

  // Re-walk MCP children when claude changed OR mcpCount was 0 (initial
  // registration race). Otherwise leave existing tracker state untouched.
  if (reason === "stale-claude" || oldMcpCount === 0) {
    const newMcpPids = await discoverAgentMcpPids(
      newClaudePid,
      deps.tracker.patterns,
    );
    deps.tracker.replaceMcpPids(name, newMcpPids);

    // Reason classifier: upgrade to "agent-restart" when BOTH claude and
    // mcpPids changed (RESEARCH Pattern 4). Only "missing-mcps" when
    // claude was alive and we filled in an empty mcp list.
    if (reason === "stale-claude") {
      if (oldMcpCount > 0 && pidSetsDiffer(oldMcpPids, newMcpPids)) {
        reason = "agent-restart";
      }
    } else {
      reason = "missing-mcps";
    }

    // Diff-based logging: only emit when state actually changed.
    if (snapshotsDiffer(
      { claudePid: oldClaudePid, mcpPids: oldMcpPids },
      { claudePid: newClaudePid, mcpPids: newMcpPids },
    )) {
      deps.log.warn(
        {
          component: "mcp-tracker",
          action: "reconcile",
          agent: name,
          oldClaudePid,
          newClaudePid,
          oldMcpCount,
          newMcpCount: newMcpPids.length,
          reason,
        },
        "tracker state reconciled",
      );
    }
  }
}

/**
 * Sorted-set equality for two pid arrays. True when sets differ in size or
 * contents.
 */
function pidSetsDiffer(
  a: readonly number[],
  b: readonly number[],
): boolean {
  if (a.length !== b.length) return true;
  const x = [...a].sort((p, q) => p - q);
  const y = [...b].sort((p, q) => p - q);
  for (let i = 0; i < x.length; i++) {
    if (x[i] !== y[i]) return true;
  }
  return false;
}

/**
 * Deep-equal on { claudePid, mcpPids[].sort() } — TRACK-04 diff predicate.
 * Returns true when the two snapshots represent different tracker state
 * (and therefore the reconciler emits a state-change log line).
 */
function snapshotsDiffer(
  a: { readonly claudePid: number; readonly mcpPids: readonly number[] },
  b: { readonly claudePid: number; readonly mcpPids: readonly number[] },
): boolean {
  if (a.claudePid !== b.claudePid) return true;
  return pidSetsDiffer(a.mcpPids, b.mcpPids);
}
