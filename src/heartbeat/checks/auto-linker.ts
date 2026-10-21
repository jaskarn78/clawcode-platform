/**
 * Heartbeat check that discovers semantically similar unlinked memories
 * and creates bidirectional edges between them.
 *
 * Auto-discovered by HeartbeatRunner from the checks directory.
 * Runs every 6 hours (21600s) with a 1-minute timeout.
 *
 * Uses a simple per-agent lock (Set) to prevent concurrent runs.
 *
 * Phase 999.119 — runs `MemoryStore.repairIntegrity()` first so orphan
 * vec rows / dangling links left by out-of-band deletes are gone before
 * KNN can hand one to the linker (the FK trap that held the `projects`
 * linker at "FOREIGN KEY constraint failed" from 2026-06-14 to
 * 2026-09-05). Derived sessions (forks etc.) skip — they share the parent
 * agent's store.
 */

import type { CheckModule, CheckResult } from "../types.js";
import { discoverAutoLinks } from "../../memory/similarity.js";
import { sharesParentMemoryStore, sharedStoreSkipResult } from "../shared-memory-guard.js";

/** Simple per-agent lock to prevent concurrent auto-linker runs. */
const runningAgents = new Set<string>();

const autoLinkerCheck: CheckModule = {
  name: "auto-linker",
  interval: 21600, // 6 hours
  timeout: 60, // 1 minute

  async execute(context): Promise<CheckResult> {
    const { agentName, sessionManager } = context;

    if (sharesParentMemoryStore(agentName)) {
      return sharedStoreSkipResult("auto-linker");
    }

    if (runningAgents.has(agentName)) {
      return {
        status: "healthy",
        message: "Auto-linker already running, skipping",
        metadata: { skipped: true },
      };
    }

    const memoryStore = sessionManager.getMemoryStore(agentName);
    if (!memoryStore) {
      return {
        status: "warning",
        message: `Memory store not found for ${agentName}`,
      };
    }

    runningAgents.add(agentName);
    try {
      const repaired = memoryStore.repairIntegrity();
      const result = discoverAutoLinks(memoryStore);
      const repairNote =
        repaired.total > 0 ? `, repaired ${repaired.total} dangling row(s)` : "";
      const orphanNote =
        result.orphansSkipped > 0 ? `, skipped ${result.orphansSkipped} orphan vec row(s)` : "";
      const summary = `created ${result.linksCreated} links, scanned ${result.pairsScanned} candidates, skipped ${result.skippedExisting} existing${orphanNote}${repairNote}`;

      if (result.errors > 0) {
        return {
          status: "warning",
          message: `Auto-linker: ${summary}; ${result.errors} candidate error(s) — first: ${result.firstError ?? "unknown"}`,
          metadata: { ...result, repaired },
        };
      }
      return {
        status: "healthy",
        message: `Auto-linker: ${summary}`,
        metadata: { ...result, repaired },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      return {
        status: "warning",
        message: `Auto-linker failed: ${message}`,
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

export default autoLinkerCheck;
