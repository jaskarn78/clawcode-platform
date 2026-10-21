/**
 * Heartbeat check that triggers tier maintenance for agent memory.
 *
 * Auto-discovered by HeartbeatRunner from the checks directory.
 * Runs every 6 hours to re-warm/promote/demote/cool memories between tiers.
 *
 * Uses a simple per-agent lock (Set) to prevent concurrent runs.
 *
 * Phase 999.119 — derived sessions (forks etc.) skip: they share the
 * parent's store and the parent maintains it. A cycle that finished with
 * per-row errors reports `warning` with the first error, while the rest of
 * the cycle's work still lands (the TierManager isolates each row).
 */

import type { CheckModule, CheckResult } from "../types.js";
import { sharesParentMemoryStore, sharedStoreSkipResult } from "../shared-memory-guard.js";

/** Simple per-agent lock to prevent concurrent tier maintenance runs. */
const runningAgents = new Set<string>();

const tierMaintenanceCheck: CheckModule = {
  name: "tier-maintenance",
  interval: 21600, // 6 hours in seconds
  timeout: 30, // 30 seconds — no LLM calls, just DB operations

  async execute(context): Promise<CheckResult> {
    const { agentName, sessionManager } = context;

    if (sharesParentMemoryStore(agentName)) {
      return sharedStoreSkipResult("tier-maintenance");
    }

    // Concurrency lock
    if (runningAgents.has(agentName)) {
      return {
        status: "healthy",
        message: "Tier maintenance already running, skipping",
        metadata: { skipped: true },
      };
    }

    const tierManager = sessionManager.getTierManager(agentName);
    if (!tierManager) {
      return {
        status: "healthy",
        message: "No tier manager configured",
      };
    }

    runningAgents.add(agentName);
    try {
      const result = tierManager.runMaintenance();
      // `?? 0` — tolerate a pre-999.119 result shape (test doubles, older
      // TierManager builds) that has no rewarmed/errors fields.
      const rewarmed = result.rewarmed ?? 0;
      const errors = result.errors ?? 0;
      const summary = `${result.promoted} promoted, ${result.demoted} demoted, ${result.archived} cooled, ${rewarmed} re-warmed`;

      if (errors > 0) {
        return {
          status: "warning",
          message: `Tier maintenance: ${summary}; ${errors} row error(s) — first: ${result.firstError ?? "unknown"}`,
          metadata: { ...result },
        };
      }

      const total = result.demoted + result.archived + result.promoted + rewarmed;
      if (total === 0) {
        return {
          status: "healthy",
          message: "No tier changes needed",
          metadata: { ...result },
        };
      }

      return {
        status: "healthy",
        message: `Tier maintenance: ${summary}`,
        metadata: { ...result },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      return {
        status: "warning",
        message: `Tier maintenance failed: ${message}`,
      };
    } finally {
      runningAgents.delete(agentName);
    }
  },
};

/**
 * Reset the concurrency lock. Exported for test cleanup only.
 * @internal
 */
export function _resetLock(): void {
  runningAgents.clear();
}

export default tierMaintenanceCheck;
