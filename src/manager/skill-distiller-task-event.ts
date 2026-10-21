/**
 * Phase 132 Plan 02 T-01 — emitTaskCompletedEvent (single-pathway emitter).
 *
 * SINGLE source-of-truth for `task.completed` events. Per
 * feedback_silent_path_bifurcation.md the daemon must NOT duplicate this
 * logic at each call site — every emit goes through here.
 *
 * Per D-01 (out-of-band invariant): the dispatch to the distiller is
 * fire-and-forget (`void` prefix). The emitter returns SYNCHRONOUSLY and
 * callers MUST NOT await it. This guarantees the parent daemon path
 * (subagent-complete relay, delegate-task resolution) is never blocked
 * by Haiku latency or distiller errors.
 *
 * Per D-09: every exit branch emits a single pino log with `msg` field
 * equal to the literal string "phase132-task-completed" — verbatim
 * grep-checkable. Payload carries agent, sessionId, toolCallCount,
 * durationMs, outcome, eligible, and (when ineligible) the
 * EligibilityReason string.
 *
 * Eligibility classification is delegated to Plan 01's pure
 * isEligibleForDistillation. This module's only added behavior is
 * (1) resolve per-agent SkillDistillerConfig from the merged-defaults
 * agent config via deps.getAgentConfig, (2) emit telemetry, (3)
 * fire-and-forget dispatch on eligible.
 */
import type { Logger } from "pino";
import {
  isEligibleForDistillation,
  type SkillDistillerConfig,
  type TaskCompletedEvent,
} from "./skill-distiller-eligibility.js";

export type { TaskCompletedEvent } from "./skill-distiller-eligibility.js";

/**
 * Minimal shape the emitter reads off the resolved agent config. The
 * production type is ResolvedAgentConfig (src/config/types.ts) which
 * carries far more fields; we type only what we need so unit tests can
 * craft minimal fixtures.
 */
export type EmitterAgentConfigView = {
  readonly name: string;
  readonly autonomousSkillDrafting?: boolean;
  readonly skillDistiller?: {
    readonly minToolCalls: number;
    readonly minDurationMs: number;
    readonly outcomeFilter: ReadonlyArray<"success" | "partial" | "failed">;
    readonly distillerModel?: "haiku" | "sonnet";
  };
};

export type TaskCompletedEventDeps = {
  readonly log: Logger;
  readonly getAgentConfig: (
    agentName: string,
  ) => EmitterAgentConfigView | undefined;
  /**
   * Fire-and-forget dispatcher. The emitter does NOT await this. If it
   * returns a rejected promise, the emitter attaches a .catch that logs
   * at error level under the same `phase132-task-completed` msg tag
   * (out-of-band invariant — D-01).
   */
  readonly dispatchDistiller: (
    event: TaskCompletedEvent,
  ) => Promise<void> | void;
  readonly now: () => number;
};

/**
 * Resolve per-agent SkillDistillerConfig. The schema's defaults already
 * cascaded at load time; here we only need to flatten autonomousSkillDrafting
 * (the top-level enable toggle) + the skillDistiller block into the
 * single-shape SkillDistillerConfig that Plan 01's eligibility filter
 * consumes.
 */
function resolveConfig(
  view: EmitterAgentConfigView,
): SkillDistillerConfig | null {
  const sd = view.skillDistiller;
  if (!sd) return null;
  return {
    enabled: view.autonomousSkillDrafting === true,
    minToolCalls: sd.minToolCalls,
    minDurationMs: sd.minDurationMs,
    outcomeFilter: sd.outcomeFilter,
    distillerModel: sd.distillerModel,
  };
}

/**
 * Single-pathway emit. Returns synchronously. Caller MUST NOT await.
 *
 * Telemetry: emits EXACTLY ONE pino log entry per call under the
 * `phase132-task-completed` msg tag. Eligible events additionally
 * fire-and-forget dispatchDistiller.
 */
export function emitTaskCompletedEvent(
  deps: TaskCompletedEventDeps,
  event: TaskCompletedEvent,
): void {
  const agentConfig = deps.getAgentConfig(event.agent);
  if (!agentConfig) {
    deps.log.warn(
      {
        agent: event.agent,
        sessionId: event.sessionId,
        toolCallCount: event.toolCallCount,
        durationMs: event.durationMs,
        outcome: event.outcome,
        eligible: false,
        reason: "agent-config-missing",
        ts: deps.now(),
      },
      "phase132-task-completed",
    );
    return;
  }

  const config = resolveConfig(agentConfig);
  if (!config) {
    // No skillDistiller block on resolved config — treat as disabled.
    deps.log.info(
      {
        agent: event.agent,
        sessionId: event.sessionId,
        toolCallCount: event.toolCallCount,
        durationMs: event.durationMs,
        outcome: event.outcome,
        eligible: false,
        reason: "disabled",
        ts: deps.now(),
      },
      "phase132-task-completed",
    );
    return;
  }

  const result = isEligibleForDistillation(event, config);
  const basePayload = {
    agent: event.agent,
    sessionId: event.sessionId,
    toolCallCount: event.toolCallCount,
    durationMs: event.durationMs,
    outcome: event.outcome,
    eligible: result.eligible,
    ts: deps.now(),
  };

  if (!result.eligible) {
    deps.log.info(
      { ...basePayload, reason: result.reason },
      "phase132-task-completed",
    );
    return;
  }

  deps.log.info(basePayload, "phase132-task-completed");

  // D-01 out-of-band fire-and-forget. NO await. If dispatcher returns
  // a rejected promise (or throws synchronously), we log at error level
  // and swallow — the parent daemon path MUST NOT be blocked.
  try {
    const maybe = deps.dispatchDistiller(event);
    if (maybe && typeof (maybe as Promise<void>).then === "function") {
      (maybe as Promise<void>).catch((err: unknown) => {
        deps.log.error(
          {
            agent: event.agent,
            sessionId: event.sessionId,
            dispatchError: err instanceof Error ? err.message : String(err),
            ts: deps.now(),
          },
          "phase132-task-completed",
        );
      });
    }
  } catch (err) {
    deps.log.error(
      {
        agent: event.agent,
        sessionId: event.sessionId,
        dispatchError: err instanceof Error ? err.message : String(err),
        ts: deps.now(),
      },
      "phase132-task-completed",
    );
  }
}
