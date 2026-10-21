/**
 * Phase 999.122 — memory census as a heartbeat check.
 *
 * Carries the `memory doctor` numbers (integrity, tiers, sessions, v2
 * coverage) in its metadata every 15 minutes, so `/api/health` and
 * `clawcode health` show them and the fleet brief can read them without
 * an admin IPC call. `warning` when the store needs `memory doctor
 * --repair`; never critical (nothing here is an availability problem).
 *
 * Read-only. Fork-guarded like every maintenance check (derived sessions
 * share the parent's store).
 */

import type { CheckModule, CheckResult } from "../types.js";
import { sharesParentMemoryStore, sharedStoreSkipResult } from "../shared-memory-guard.js";
import {
  collectMemoryCensus,
  memoryCensusLine,
  memoryCensusProblems,
  type MemoryCensusSource,
} from "../../manager/memory-census.js";

const memoryCensusCheck: CheckModule = {
  name: "memory-census",
  interval: 900, // 15 minutes
  timeout: 30,

  async execute(context): Promise<CheckResult> {
    const { agentName, sessionManager } = context;
    if (sharesParentMemoryStore(agentName)) {
      return sharedStoreSkipResult("memory-census");
    }
    try {
      const census = collectMemoryCensus(sessionManager as MemoryCensusSource, agentName);
      if (!census) {
        return { status: "healthy", message: "No memory store" };
      }
      const problems = memoryCensusProblems(census);
      if (problems.length > 0) {
        return {
          status: "warning",
          message: `${problems.join("; ")} - run \`clawcode memory doctor -a ${agentName} --repair\``,
          metadata: { ...census, problems },
        };
      }
      return { status: "healthy", message: memoryCensusLine(census), metadata: { ...census } };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      return { status: "warning", message: `memory-census failed: ${message}` };
    }
  },
};

export default memoryCensusCheck;
