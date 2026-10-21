/**
 * Phase 99-C — heartbeat check that drains the pending-summary backlog.
 *
 * Calls SessionManager.summarizePendingSessions for the agent, capped at
 * PER_TICK_LIMIT sessions per heartbeat. Bounded so a 308-session backlog
 * (the actual production size at land time) drains gradually rather than
 * locking up a single tick on Haiku rate limits.
 *
 * Auto-discovered by HeartbeatRunner — no daemon wiring needed because the
 * file lives under `src/heartbeat/checks/`.
 *
 * Modeled on `auto-linker.ts` (same lock + structure).
 */

import type { CheckModule, CheckResult } from "../types.js";
import { sharesParentMemoryStore, sharedStoreSkipResult } from "../shared-memory-guard.js";

/** Cap per heartbeat tick so a backlog drains across cycles, not in one shot. */
const PER_TICK_LIMIT = 5;

/** Per-agent in-flight lock (one drain at a time per agent). */
const runningAgents = new Set<string>();

const summarizePendingCheck: CheckModule = {
  name: "summarize-pending",
  // 30 min cadence — Haiku-bound, no need to fire more often. Backlog of 5/tick
  // = ~30 hours wall-clock to drain 308 sessions; faster cadence wouldn't help
  // because each summarizeSession call already has its own internal 10s
  // Haiku timeout.
  interval: 1800,
  // 5 sessions × 10s Haiku ceiling + slack for embedder + DB writes.
  timeout: 90,

  async execute(context): Promise<CheckResult> {
    const { agentName, sessionManager } = context;

    // Phase 999.119 — a fork's ConversationStore is the parent's DB; the
    // parent's own heartbeat drains that backlog.
    if (sharesParentMemoryStore(agentName)) {
      return sharedStoreSkipResult("summarize-pending");
    }

    if (runningAgents.has(agentName)) {
      return {
        status: "healthy",
        message: "summarize-pending already running, skipping",
        metadata: { skipped: true },
      };
    }

    runningAgents.add(agentName);
    try {
      const r = await sessionManager.summarizePendingSessions(
        agentName,
        PER_TICK_LIMIT,
      );
      return {
        status: "healthy",
        message: `summarize-pending: attempted ${r.attempted}, summarized ${r.summarized}, skipped ${r.skipped}`,
        metadata: { ...r },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      return {
        status: "warning",
        message: `summarize-pending failed: ${message}`,
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

export default summarizePendingCheck;
