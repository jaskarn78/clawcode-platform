/**
 * M4 — trace-store-absent helpers.
 *
 * Per-agent telemetry IPC reads (`latency`, `cache`, `get-turn-trace`) look up
 * the agent's TraceStore, which is torn down when the agent stops/idles. A
 * status poller that requests telemetry for a NON-running agent (observed in
 * prod for `fin-tax`, `acme-content-creator`, `general` every ~20s) made
 * the handler THROW `ManagerError`, which the IPC server re-logs at
 * `level:50` ("handler error") — ~10K pure-noise error lines/day that bury
 * real failures.
 *
 * Fix: when the agent is known NOT running, the trace-store-absent condition
 * is EXPECTED, not a fault. Return an empty (but schema-valid) telemetry
 * payload and log at `debug` instead of throwing. When the agent IS running
 * but its store is missing, that is a genuine fault → keep throwing.
 *
 * The dashboard already treats trace-store-absent as an empty state
 * (`dashboard/server.ts:isAgentAbsentError`), so an empty sentinel renders as
 * "no data" — no consumer regression.
 */

import type { Logger } from "pino";
import type {
  CacheHitRateStatus,
  CacheTelemetryReport,
  LatencyReport,
} from "../performance/types.js";

/**
 * Minimal running-state surface needed to decide absent-vs-fault. Mirrors the
 * `SessionManager.isRunning` accessor so this module is unit-testable without
 * a daemon.
 */
export interface RunningStateProbe {
  isRunning(agentName: string): boolean;
}

/**
 * Decide how to handle a missing TraceStore for a single-agent telemetry read.
 *
 * - Agent NOT running → `{ kind: "absent" }` (caller returns an empty sentinel,
 *   logs at debug). Benign, expected — the store was torn down on idle/stop.
 * - Agent running but storeless → `{ kind: "fault" }` (caller throws the
 *   ManagerError as before). A genuine unexpected condition.
 */
export function classifyMissingTraceStore(
  probe: RunningStateProbe,
  agentName: string,
): { kind: "absent" } | { kind: "fault" } {
  return probe.isRunning(agentName) ? { kind: "fault" } : { kind: "absent" };
}

/**
 * Log the benign "telemetry for a non-running agent" condition at debug.
 * Single mutation point so the message + fields stay consistent across the
 * three call sites.
 */
export function logTraceStoreAbsent(
  log: Logger,
  agentName: string,
  method: string,
): void {
  log.debug(
    {
      component: "telemetry",
      action: "trace-store-absent",
      agent: agentName,
      method,
    },
    "telemetry read for non-running agent — returning empty (agent not running)",
  );
}

/**
 * Empty, schema-valid LatencyReport for a non-running agent. `segments` empty
 * → the dashboard/CLI render "no data". `first_token_headline` is optional and
 * omitted (no samples).
 */
export function emptyLatencyReport(
  agentName: string,
  sinceIso: string,
): LatencyReport {
  return Object.freeze({
    agent: agentName,
    since: sinceIso,
    segments: [],
  });
}

/**
 * Empty CacheTelemetryReport (+ the augmented fields the `cache` handler adds)
 * for a non-running agent. All counters zero; `status` neutral; tool-cache
 * fields null. Matches the shape `buildReport` returns on the happy path so
 * the response is structurally identical to a real (but empty) report.
 */
export function emptyCacheReport(
  agentName: string,
  sinceIso: string,
): CacheTelemetryReport & {
  readonly status: CacheHitRateStatus;
  readonly cache_effect_ms: number | null;
  readonly tool_cache_hit_rate: number | null;
  readonly tool_cache_size_mb: number | null;
  readonly tool_cache_turns: number;
} {
  return Object.freeze({
    agent: agentName,
    since: sinceIso,
    totalTurns: 0,
    avgHitRate: 0,
    p50HitRate: 0,
    p95HitRate: 0,
    totalCacheReads: 0,
    totalCacheWrites: 0,
    totalInputTokens: 0,
    trendByDay: [],
    status: "no_data",
    cache_effect_ms: null,
    tool_cache_hit_rate: null,
    tool_cache_size_mb: null,
    tool_cache_turns: 0,
  });
}
