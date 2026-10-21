/**
 * Phase 999.119 — guard for memory-maintenance heartbeat checks.
 *
 * Every machine-generated session (fork, warm-pool, subagent thread, via)
 * is started with its parent agent's config, so `initMemory` opens a
 * SECOND `MemoryStore` on the parent's `memories.db`. The maintenance
 * checks are keyed by session name, so a live fork ran tier maintenance,
 * the auto-linker and the summary drain a second time against the same
 * database — two connections, two locks, same rows. Observed 2026-09-05:
 * `projects-fork-6NMty0` and `personal-fork-GccQQp` each reporting their
 * own tier/linker results for their parent's store, and the linker FK
 * failure "propagating" to the fork.
 *
 * The parent's own heartbeat maintains the store; derived sessions skip.
 */

import { spawnKindOf } from "../manager/subagent-name.js";
import type { CheckResult } from "./types.js";

/** True when `agentName` is a derived session that shares its parent's store. */
export function sharesParentMemoryStore(agentName: string): boolean {
  return spawnKindOf(agentName) !== "agent";
}

/** The healthy no-op result a skipped maintenance check reports. */
export function sharedStoreSkipResult(checkName: string): CheckResult {
  return {
    status: "healthy",
    message: `${checkName}: skipped — derived session shares its parent agent's memory store`,
    metadata: { skipped: true, reason: "shared-parent-store" },
  };
}
