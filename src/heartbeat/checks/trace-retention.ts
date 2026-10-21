/**
 * Heartbeat check that prunes expired traces per agent.
 *
 * Auto-discovered by HeartbeatRunner from the checks directory
 * (src/heartbeat/discovery.ts loads every non-test .ts/.js file that
 * default-exports a CheckModule — no manual registration required).
 *
 * Deletes rows from `traces` older than `perf.traceRetentionDays`
 * (default 7). Child spans in `trace_spans` are removed via the
 * ON DELETE CASCADE foreign key on `trace_spans.turn_id → traces(id)`
 * — there is NO secondary DELETE against `trace_spans` here.
 *
 * The CASCADE-only approach is ratified in the Phase 50 CONTEXT.md
 * retention addendum (2026-04-13) and motivated by RESEARCH Pitfall 4
 * (orphan-span cleanup queries race with in-flight turns under
 * 14-agent concurrency).
 */

import { subDays } from "date-fns";
import type { CheckContext, CheckModule, CheckResult } from "../types.js";

/** Retention window when an agent does not configure `perf.traceRetentionDays`. */
const DEFAULT_RETENTION_DAYS = 7;

const traceRetentionCheck: CheckModule = {
  name: "trace-retention",

  async execute(context: CheckContext): Promise<CheckResult> {
    const { agentName, sessionManager } = context;

    const agentConfig = sessionManager.getAgentConfig(agentName);
    if (!agentConfig) {
      return { status: "healthy", message: "No config available" };
    }

    // getTraceStore is Phase 50 surface; older SessionManager builds may not
    // expose it, so guard defensively. The same guard keeps tests that stub
    // SessionManager minimally (no traceStore field) safe.
    const getTraceStore = (sessionManager as { getTraceStore?: (n: string) => unknown }).getTraceStore;
    const store = typeof getTraceStore === "function" ? getTraceStore.call(sessionManager, agentName) : undefined;
    if (!store || typeof (store as { pruneOlderThan?: unknown }).pruneOlderThan !== "function") {
      return { status: "healthy", message: "No trace store" };
    }

    const retentionDays = agentConfig.perf?.traceRetentionDays ?? DEFAULT_RETENTION_DAYS;
    const cutoffDate = subDays(new Date(), retentionDays);
    const cutoffIso = cutoffDate.toISOString();

    // NOTE: CASCADE handles trace_spans deletion. Do NOT add a secondary DELETE
    // against trace_spans — that creates the race documented in RESEARCH Pitfall 4.
    const deleted = (store as { pruneOlderThan: (iso: string) => number }).pruneOlderThan(cutoffIso);

    return {
      status: "healthy",
      message: deleted > 0 ? `Pruned ${deleted} expired turn(s)` : "No expired traces",
      metadata: { deleted, cutoff: cutoffIso, retentionDays },
    };
  },
};

export default traceRetentionCheck;
