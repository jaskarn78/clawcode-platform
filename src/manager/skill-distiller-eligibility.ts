/**
 * Phase 132 Plan 01 T-03 — eligibility filter (FIRST gate).
 *
 * Pure function. Decides whether a `task.completed` event qualifies for
 * out-of-band distillation. Plan 02's distiller chains a SECOND gate
 * (trajectory-fingerprint dedup via `./skill-distiller-fingerprint.ts`)
 * downstream — this module does NOT compute fingerprints.
 *
 * Per CONTEXT.md decisions:
 *   - D-03 thresholds (operator-tunable defaults):
 *       minToolCalls: 6
 *       minDurationMs: 180_000 (3 minutes wall-clock)
 *       outcomeFilter: ["success"]
 *   - D-08: feature DEFAULT OFF fleet-wide; `config.enabled=false`
 *     short-circuits regardless of trajectory shape.
 *
 * The `config` argument is the RESOLVED per-agent config — defaults
 * already merged. The resolver itself lives in Plan 02 (loader edits +
 * SessionManager.getAgentConfig closure-re-read pattern).
 *
 * Per `feedback_silent_path_bifurcation.md`: this is the SINGLE source
 * of truth for eligibility classification. Plan 02's distiller, the
 * `phase132-task-completed` telemetry tag, and any future UAT replay
 * or dashboard preview all import from here. Rejection `reason` is the
 * SAME enum across every consumer — no string drift.
 *
 * Pure: zero I/O, no logger. Safe to call in unit tests.
 */

/**
 * `task.completed` event payload. `trajectory` carries tool-name + ts
 * pairs only (no parameter content — D-07 information-disclosure
 * mitigation). `toolCallCount` equals trajectory.length but is passed
 * explicitly so structured-log auditors don't have to re-derive it.
 */
export type TaskCompletedEvent = {
  readonly agent: string;
  readonly sessionId: string;
  readonly trajectory: ReadonlyArray<{ readonly tool: string; readonly ts: number }>;
  readonly durationMs: number;
  readonly toolCallCount: number;
  readonly outcome: "success" | "partial" | "failed";
};

/** Resolved per-agent skill-distiller config (defaults already merged). */
export type SkillDistillerConfig = {
  readonly enabled: boolean;
  readonly minToolCalls: number;
  readonly minDurationMs: number;
  readonly outcomeFilter: ReadonlyArray<"success" | "partial" | "failed">;
  readonly distillerModel?: "haiku" | "sonnet";
};

/** Stable enum — Plan 02 logs verbatim under `phase132-task-completed`. */
export type EligibilityReason =
  | "disabled"
  | "too-few-tool-calls"
  | "too-short-duration"
  | "outcome-filtered";

/** Discriminated union. Rejection variants carry actual+threshold/allowed. */
export type EligibilityResult =
  | { readonly eligible: true }
  | { readonly eligible: false; readonly reason: "disabled" }
  | {
      readonly eligible: false;
      readonly reason: "too-few-tool-calls";
      readonly actual: number;
      readonly threshold: number;
    }
  | {
      readonly eligible: false;
      readonly reason: "too-short-duration";
      readonly actual: number;
      readonly threshold: number;
    }
  | {
      readonly eligible: false;
      readonly reason: "outcome-filtered";
      readonly actual: "success" | "partial" | "failed";
      readonly allowed: ReadonlyArray<"success" | "partial" | "failed">;
    };

/**
 * D-03 + D-08 gate. First-match-wins order:
 *   1. !config.enabled              → "disabled"
 *   2. toolCallCount < threshold    → "too-few-tool-calls"
 *   3. durationMs   < threshold     → "too-short-duration"
 *   4. !outcomeFilter.includes(...)  → "outcome-filtered"
 *   5. otherwise                     → { eligible: true }
 *
 * Order matters: enabled-gate fires first so disabled-fleet operators
 * see a consistent "disabled" telemetry line regardless of trajectory.
 */
export function isEligibleForDistillation(
  event: TaskCompletedEvent,
  config: SkillDistillerConfig,
): EligibilityResult {
  if (!config.enabled) {
    return { eligible: false, reason: "disabled" };
  }
  if (event.toolCallCount < config.minToolCalls) {
    return {
      eligible: false,
      reason: "too-few-tool-calls",
      actual: event.toolCallCount,
      threshold: config.minToolCalls,
    };
  }
  if (event.durationMs < config.minDurationMs) {
    return {
      eligible: false,
      reason: "too-short-duration",
      actual: event.durationMs,
      threshold: config.minDurationMs,
    };
  }
  if (!config.outcomeFilter.includes(event.outcome)) {
    return {
      eligible: false,
      reason: "outcome-filtered",
      actual: event.outcome,
      allowed: config.outcomeFilter,
    };
  }
  return { eligible: true };
}
