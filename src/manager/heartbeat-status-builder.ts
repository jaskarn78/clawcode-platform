/**
 * Phase 124 Plan 04 T-01 — pure builder for the `heartbeat-status` IPC
 * payload. Extracted from `daemon.ts` so the telemetry surface (Phase 124
 * additions: `session_tokens`, `last_compaction_at`) is unit-testable
 * without booting the full daemon.
 *
 * Wire shape preserved verbatim from the inline `case "heartbeat-status"`
 * body (zone + fillPercentage + checks + overall) — additive only.
 */
import type { CheckResult, CheckStatus } from "../heartbeat/types.js";
import type { ContextZone } from "../heartbeat/context-zones.js";
import type { CreditTelemetryPayload } from "../ipc/protocol.js";
import {
  DEFAULT_INCIDENT_WINDOW_MS,
  type HeartbeatIncidentSummary,
} from "../heartbeat/transition-journal.js";

/**
 * Phase 138 Plan 02 — minimal structural surface the builder needs from
 * the credit-telemetry aggregator. Declared structurally (not an import
 * of `ProviderTelemetryAggregator`) so the builder stays decoupled from
 * the aggregator's SQLite internals and the unit test can pass a stub.
 */
export type CreditTelemetrySource = {
  snapshot(): CreditTelemetryPayload;
};

/** Char→token proxy. Same constant used in daemon-compact-session-ipc.ts. */
const CHARS_PER_TOKEN = 4;
/** Same default max-context character budget as compaction.ts:195. */
const DEFAULT_MAX_CONTEXT_CHARS = 200_000;

export type HeartbeatStatusDeps = Readonly<{
  /** Per-agent latest check results keyed by check name. */
  results: ReadonlyMap<string, ReadonlyMap<string, { result: CheckResult; lastChecked: string }>>;
  /** Per-agent zone snapshot (zone + fill ratio). */
  zoneStatuses: ReadonlyMap<string, { zone: ContextZone; fillPercentage: number }>;
  /** Lookup the last-compaction ISO timestamp (or null). */
  getLastCompactionAt: (agent: string) => string | null;
  /**
   * Per-agent context-fill provider. Returns ratio (0..1) of context used.
   * Undefined → `session_tokens: null` for that agent.
   */
  getContextFillProvider: (
    agent: string,
  ) => { getContextFillPercentage: () => number } | undefined;
  /**
   * Phase 138 Plan 02 — optional fleet credit-telemetry aggregator. When
   * present, `buildHeartbeatStatusPayload` calls `.snapshot()` and attaches
   * the result as the top-level `creditTelemetry` field. Absent → the field
   * is omitted entirely (backwards-compat for pre-138 consumers).
   */
  providerTelemetryAggregator?: CreditTelemetrySource;
  /**
   * Phase 999.122 — optional status-transition journal. When present the
   * payload carries `incidents` (transitions inside `incidentWindowMs`,
   * default 24 h, plus per-agent counts and still-open checks).
   */
  transitionJournal?: { summary(windowMs: number): HeartbeatIncidentSummary };
  incidentWindowMs?: number;
}>;

export type HeartbeatStatusAgentBlock = Readonly<{
  checks: Readonly<Record<string, unknown>>;
  overall: CheckStatus;
  zone?: ContextZone;
  fillPercentage?: number;
  session_tokens: number | null;
  last_compaction_at: string | null;
}>;

export type HeartbeatStatusPayload = Readonly<{
  agents: Readonly<Record<string, HeartbeatStatusAgentBlock>>;
  /**
   * Phase 138 Plan 02 — fleet-aggregate per-provider credit telemetry.
   * Top-level (NOT per-agent). Optional + additive — present only when a
   * `providerTelemetryAggregator` is wired into the builder deps; pre-138
   * consumers ignore the unknown key.
   */
  creditTelemetry?: CreditTelemetryPayload;
  /** Phase 999.122 — status transitions in the window; absent when no journal is wired. */
  incidents?: HeartbeatIncidentSummary;
}>;

/**
 * Estimate absolute tokens for an agent from its fill provider's ratio.
 * Returns null when no provider is wired (e.g., before memory init).
 *
 * Mirrors the estimation used by `daemon-compact-session-ipc.ts:162` so
 * the telemetry surface stays consistent with the compaction return
 * payload's `tokens_before`/`tokens_after` numbers — operators see the
 * same scale across both surfaces.
 */
export function estimateSessionTokens(
  provider: { getContextFillPercentage: () => number } | undefined,
): number | null {
  if (!provider) return null;
  const ratio = provider.getContextFillPercentage();
  return Math.round((ratio * DEFAULT_MAX_CONTEXT_CHARS) / CHARS_PER_TOKEN);
}

/**
 * Build the wire payload for the `heartbeat-status` IPC case. Pure
 * function — no side effects. Consumed by `daemon.ts` (production) and
 * by `heartbeat-status-telemetry.test.ts` (unit test).
 */
export function buildHeartbeatStatusPayload(
  deps: HeartbeatStatusDeps,
): HeartbeatStatusPayload {
  const agents: Record<string, HeartbeatStatusAgentBlock> = {};

  for (const [agentName, checks] of deps.results) {
    const checksObj: Record<string, unknown> = {};
    let worstStatus: CheckStatus = "healthy";

    for (const [checkName, { result, lastChecked }] of checks) {
      checksObj[checkName] = {
        status: result.status,
        message: result.message,
        lastChecked,
        ...(result.metadata ? { metadata: result.metadata } : {}),
      };
      if (
        result.status === "critical" ||
        (result.status === "warning" && worstStatus !== "critical")
      ) {
        worstStatus = result.status;
      }
    }

    const zoneData = deps.zoneStatuses.get(agentName);
    const provider = deps.getContextFillProvider(agentName);
    const session_tokens = estimateSessionTokens(provider);
    const last_compaction_at = deps.getLastCompactionAt(agentName);

    agents[agentName] = {
      checks: checksObj,
      overall: worstStatus,
      ...(zoneData ? { zone: zoneData.zone, fillPercentage: zoneData.fillPercentage } : {}),
      session_tokens,
      last_compaction_at,
    };
  }

  // Phase 138 Plan 02 — attach the fleet credit-telemetry snapshot when
  // an aggregator is wired. Conditional spread (matches the zone /
  // fillPercentage pattern above) so the key is absent entirely when no
  // aggregator is present — pre-138 consumers see the exact same shape.
  return {
    agents,
    ...(deps.providerTelemetryAggregator
      ? { creditTelemetry: deps.providerTelemetryAggregator.snapshot() }
      : {}),
    ...(deps.transitionJournal
      ? {
          incidents: deps.transitionJournal.summary(
            deps.incidentWindowMs ?? DEFAULT_INCIDENT_WINDOW_MS,
          ),
        }
      : {}),
  };
}
