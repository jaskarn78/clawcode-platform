/**
 * Phase 999.119 pass 2 — daily conversation-session hygiene.
 *
 * `conversation_sessions` only ever grew: a row is opened at every agent
 * start and closed only by a clean stop or an observed crash, so daemon
 * restarts, kills and short-lived derived sessions (forks, subagent
 * threads, warm-pool) left hundreds of `active` rows per agent, most of
 * them with zero turns. Census 2026-09-05: Admin Clawdy 263 active (177
 * empty) + 362 empty terminated rows older than 30 days out of 843 total.
 *
 * Two passes, both fork-guarded (derived sessions share the parent's DB):
 *   1. close `active` rows whose agent name is not running and that
 *      started more than a day ago → `crashed` (eligible for the summary
 *      drain if they carry turns);
 *   2. delete terminated rows with no turns and no archive entry that
 *      started more than 30 days ago.
 *
 * The row for the agent's CURRENT session is never touched: its name is
 * running. Stale rows for the agent's own name are closed at agent start
 * (`SessionManager` → `closeStaleActiveSessions`), not here.
 */

import type { CheckModule, CheckResult } from "../types.js";
import { sharesParentMemoryStore, sharedStoreSkipResult } from "../shared-memory-guard.js";

/** Active rows for non-running names older than this are closed as crashed. */
export const ORPHAN_ACTIVE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** Empty terminated rows older than this are deleted. */
export const EMPTY_SESSION_RETENTION_DAYS = 30;

const sessionRetentionCheck: CheckModule = {
  name: "session-retention",
  interval: 86400, // daily
  timeout: 30,

  async execute(context): Promise<CheckResult> {
    const { agentName, sessionManager } = context;

    if (sharesParentMemoryStore(agentName)) {
      return sharedStoreSkipResult("session-retention");
    }

    const getConversationStore = (
      sessionManager as { getConversationStore?: (n: string) => unknown }
    ).getConversationStore;
    const store =
      typeof getConversationStore === "function"
        ? getConversationStore.call(sessionManager, agentName)
        : undefined;
    if (
      !store ||
      typeof (store as { pruneEmptyTerminatedSessions?: unknown })
        .pruneEmptyTerminatedSessions !== "function"
    ) {
      return { status: "healthy", message: "No conversation store" };
    }
    const conv = store as {
      closeOrphanedActiveSessions: (running: readonly string[], startedBefore: string) => number;
      pruneEmptyTerminatedSessions: (startedBefore: string) => number;
    };

    try {
      const running = sessionManager.getRunningAgents();
      const orphanCutoff = new Date(Date.now() - ORPHAN_ACTIVE_MAX_AGE_MS).toISOString();
      const pruneCutoff = new Date(
        Date.now() - EMPTY_SESSION_RETENTION_DAYS * 24 * 60 * 60 * 1000,
      ).toISOString();
      const closed = conv.closeOrphanedActiveSessions(running, orphanCutoff);
      const pruned = conv.pruneEmptyTerminatedSessions(pruneCutoff);
      const message =
        closed === 0 && pruned === 0
          ? "No stale sessions"
          : `Closed ${closed} orphaned active session(s), pruned ${pruned} empty terminated session(s)`;
      return {
        status: "healthy",
        message,
        metadata: { closed, pruned, orphanCutoff, pruneCutoff },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      return { status: "warning", message: `session-retention failed: ${message}` };
    }
  },
};

export default sessionRetentionCheck;
