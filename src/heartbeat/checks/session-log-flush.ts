/**
 * Heartbeat check: flush new conversation turns into the daily session log.
 *
 * Daily session logs (`<memoryDir>/YYYY-MM-DD.md`) are the INPUT to memory
 * consolidation, but were only ever written as a side effect of daemon
 * compaction — which auto-fires from the `context-fill` check at
 * `fill >= autoCompactAt` (~0.7). SDK-session agents report ~0% daemon-side
 * fill, so compaction never fires and daily logs stopped being written
 * (last ones Feb/March), starving consolidation.
 *
 * This check decouples daily-log writing from compaction: every tick it
 * appends NEW turns (cursor-gated, exactly-once) from the ConversationStore —
 * the authoritative turn record — into the daily log. See
 * `src/manager/session-log-flusher.ts`.
 *
 * Always returns `healthy` — a flush failure is logged in metadata but must
 * never poison the heartbeat status surface (fail-soft, like the other
 * side-effecting checks).
 */
import { join } from "node:path";

import type { CheckModule, CheckResult } from "../types.js";
import { flushNewTurnsToSessionLog } from "../../manager/session-log-flusher.js";

const sessionLogFlushCheck: CheckModule = {
  name: "session-log-flush",

  async execute(context): Promise<CheckResult> {
    const { agentName, sessionManager } = context;

    const sid = sessionManager.getActiveConversationSessionId?.(agentName);
    const convStore = sessionManager.getConversationStore?.(agentName);
    const sessionLogger = sessionManager.getSessionLogger?.(agentName);
    const agentConfig = sessionManager.getAgentConfig?.(agentName);
    const memoryPath = agentConfig?.memoryPath;

    if (!sid || !convStore || !sessionLogger || !memoryPath) {
      return { status: "healthy", message: "no active session to flush" };
    }

    const memoryDir = join(memoryPath, "memory");

    try {
      const res = await flushNewTurnsToSessionLog({
        activeSessionId: sid,
        getTurns: (s) => convStore.getTurnsForSession(s),
        appendEntry: (ts, role, content) =>
          sessionLogger.appendEntry(ts, role, content),
        memoryDir,
      });
      return {
        status: "healthy",
        message:
          res.flushed > 0
            ? `flushed ${res.flushed} turn(s) to daily session log`
            : "daily session log up to date",
        metadata: { flushed: res.flushed, dates: res.dates },
      };
    } catch (err) {
      return {
        status: "healthy",
        message: "session-log flush skipped (non-fatal)",
        metadata: { error: err instanceof Error ? err.message : String(err) },
      };
    }
  },
};

export default sessionLogFlushCheck;
