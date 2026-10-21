/**
 * Heartbeat check for memory consolidation.
 *
 * DEPRECATED (Phase 46): Consolidation has been moved to the TaskScheduler
 * cron system for per-agent configurable scheduling. This check now returns
 * a healthy no-op result so heartbeat auto-discovery still loads without errors.
 */

import type { CheckModule, CheckResult } from "../types.js";

const consolidationCheck: CheckModule = {
  name: "consolidation",
  interval: 86400,
  timeout: 120,

  async execute(_context): Promise<CheckResult> {
    return {
      status: "healthy",
      message: "Consolidation moved to TaskScheduler (Phase 46)",
      metadata: { deprecated: true },
    };
  },
};

/**
 * Reset the concurrency lock. Kept as no-op for backward compatibility.
 * @internal
 */
export function _resetLock(): void {
  // No-op: consolidation no longer runs from heartbeat
}

export default consolidationCheck;
