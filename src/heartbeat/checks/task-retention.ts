/**
 * Phase 60 Plan 03 Task 2 — task-retention heartbeat check (LIFE-03).
 *
 * Auto-discovered by HeartbeatRunner from the checks directory.
 * Runs hourly (interval: 3600), not every heartbeat tick.
 *
 * Purges:
 *   1. Terminal task rows (complete/failed/cancelled/timed_out/orphaned)
 *      older than perf.taskRetentionDays (default 7).
 *   2. trigger_events rows older than 2x replayMaxAgeMs (default 48h).
 *
 * tasks.db is daemon-scoped (shared across agents), so this check only
 * runs on the FIRST running agent to avoid redundant purges. The check
 * is idempotent — duplicates are harmless, just wasteful.
 */

import { subDays } from "date-fns";
import type { CheckContext, CheckModule, CheckResult } from "../types.js";

/** Retention window when an agent does not configure `perf.taskRetentionDays`. */
const DEFAULT_RETENTION_DAYS = 7;

/** Default replayMaxAgeMs — matches DEFAULT_REPLAY_MAX_AGE_MS in triggers/types.ts. */
const DEFAULT_REPLAY_MAX_AGE_MS = 86_400_000; // 24h

const taskRetentionCheck: CheckModule = {
  name: "task-retention",
  interval: 3600, // Run every hour, not every heartbeat tick

  async execute(context: CheckContext): Promise<CheckResult> {
    const { taskStore, sessionManager, agentName } = context;

    // Guard: taskStore not injected (pre-Phase 60 daemon or test stub)
    if (!taskStore || typeof taskStore.purgeCompleted !== "function") {
      return { status: "healthy", message: "No task store" };
    }

    // Only run on the FIRST agent tick per heartbeat cycle to avoid
    // redundant purges (tasks.db is daemon-scoped, not per-agent).
    // The check is idempotent so duplicates are harmless, just wasteful.
    const runningAgents = sessionManager.getRunningAgents();
    if (runningAgents.length > 0 && runningAgents[0] !== agentName) {
      return { status: "healthy", message: "Skipped (not first agent)" };
    }

    const agentConfig = sessionManager.getAgentConfig(agentName);
    const retentionDays =
      (agentConfig?.perf as { taskRetentionDays?: number } | undefined)
        ?.taskRetentionDays ?? DEFAULT_RETENTION_DAYS;
    const cutoffDate = subDays(new Date(), retentionDays);
    const cutoffMs = cutoffDate.getTime();

    const deletedTasks = taskStore.purgeCompleted(cutoffMs);

    // Also purge trigger_events older than 2x replayMaxAgeMs (default 48h)
    const replayMaxAgeMs = DEFAULT_REPLAY_MAX_AGE_MS;
    const triggerCutoffMs = Date.now() - 2 * replayMaxAgeMs;
    const deletedTriggerEvents = taskStore.purgeTriggerEvents(triggerCutoffMs);

    const msg =
      deletedTasks > 0 || deletedTriggerEvents > 0
        ? `Purged ${deletedTasks} task(s), ${deletedTriggerEvents} trigger event(s)`
        : "No expired rows";

    return {
      status: "healthy",
      message: msg,
      metadata: { deletedTasks, deletedTriggerEvents, retentionDays, cutoffMs },
    };
  },
};

export default taskRetentionCheck;
