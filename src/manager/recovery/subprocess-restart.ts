/**
 * Phase 94 Plan 03 — D-05 pattern 3: last-resort subprocess restart.
 *
 * Catch-all for "stuck" servers — matches when the capabilityProbe has
 * been `degraded` for more than 5 minutes AND no specific handler has
 * fired (priority discriminator: this handler runs LAST in the registry,
 * so the registry's `find(h => h.matches)` only reaches it when the
 * specific handlers all returned false).
 *
 * Action: kill the MCP subprocess via deps.killSubprocess; the SDK
 * respawns the subprocess automatically (transparent reconnect).
 *
 * Why 5 minutes? Below that and we'd be racing transient flaps (network
 * hiccup, slow DNS, host load). 5min is the empirical floor where a
 * still-degraded server is unlikely to recover on its own.
 */

import type { RecoveryHandler, RecoveryOutcome } from "./types.js";
import type { McpServerState } from "../../mcp/readiness.js";

/**
 * Plan 94-03 invariant — pinned by static-grep:
 *   subprocess-restart only matches when the server has been degraded for
 *   strictly MORE than 5 minutes since the last `ready` outcome.
 */
const FIVE_MIN_MS = 5 * 60_000;

export const subprocessRestartHandler: RecoveryHandler = {
  name: "subprocess-restart",
  priority: 100,
  matches(error: string, state: McpServerState): boolean {
    const probe = state.capabilityProbe;
    if (!probe) return false;
    if (probe.status !== "degraded") return false;
    // capabilityProbe.lastSuccessAt is ISO8601 string (vs McpServerState's
    // numeric epoch ms — different field, different type).
    const lastSuccessMs = probe.lastSuccessAt
      ? Date.parse(probe.lastSuccessAt)
      : 0;
    const nowMs = Date.now();
    return nowMs - lastSuccessMs > FIVE_MIN_MS;
  },
  async recover(serverName, deps): Promise<RecoveryOutcome> {
    const startNow = (deps.now ?? (() => new Date()))();
    const startMs = startNow.getTime();
    try {
      await deps.killSubprocess(serverName);
      const endMs = (deps.now ?? (() => new Date()))().getTime();
      return {
        kind: "recovered",
        serverName,
        handlerName: "subprocess-restart",
        durationMs: Math.max(0, endMs - startMs),
        note: "subprocess killed; SDK will respawn",
      };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      return {
        kind: "give-up",
        serverName,
        handlerName: "subprocess-restart",
        reason,
      };
    }
  },
};

export { FIVE_MIN_MS };
