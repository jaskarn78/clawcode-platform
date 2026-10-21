/**
 * Phase 95 Plan 02 Task 2 — D-06 per-agent dream cron timer.
 *
 * Pure-DI module mirroring the src/manager/daily-summary-cron.ts pattern:
 *   - cronFactory is dependency-injected (production wraps `new Cron()`;
 *     tests pass a stub that captures the callback for synchronous trigger)
 *   - isAgentIdle is dependency-injected (the idle-window detector primitive
 *     from Plan 95-01)
 *   - runDreamPass + applyDreamResult are dependency-injected (production
 *     wiring at the daemon edge bridges to the dream-pass + dream-auto-apply
 *     primitives plus the daemon's TurnDispatcher / auto-linker / writeDreamLog)
 *
 * Per-agent schedule label = "dream" — visible in /clawcode-status schedule
 * list per D-06.
 *
 * Note on placement: Plan 95-02 originally referred to a non-existent
 * `src/manager/agent-bootstrap.ts` file. The repo's per-agent cron pattern
 * lives in standalone modules (e.g. daily-summary-cron.ts) wired by the
 * daemon at startup, so this module follows that pattern. Production
 * wiring will be done at the daemon-edge in Plan 95-03 (or in a follow-up
 * to the daemon's startAgent() flow).
 */

import { Cron } from "croner";
import type { DreamPassOutcome } from "./dream-pass.js";
import type { DreamApplyOutcome } from "./dream-auto-apply.js";
import type {
  IsAgentIdleDeps,
  IsAgentIdleResult,
} from "./idle-window-detector.js";

/**
 * Phase 115 Plan 05 T03 — D-05 priority dream-pass trigger constants.
 *
 * When tier-1 truncation fires `PRIORITY_THRESHOLD` times within
 * `PRIORITY_WINDOW_MS` for the same agent, the cron tick switches the
 * idle-window threshold from the agent's normal `dream.idleMinutes` to
 * `PRIORITY_IDLE_MINUTES` (5 minutes per CONTEXT.md D-05).
 */
export const PRIORITY_THRESHOLD = 2;
export const PRIORITY_WINDOW_MS = 24 * 60 * 60 * 1000;
export const PRIORITY_IDLE_MINUTES = 5;

/**
 * Phase 115 Plan 05 T03 — interface for the truncation-event consumer.
 *
 * Production wiring (daemon edge) passes a thin wrapper over the agent's
 * TraceCollector.countTruncationEventsSince. Tests inject a stub. The
 * shape is narrow on purpose so the cron module doesn't pull TraceCollector
 * into its dependency graph (preserves the pure-DI invariant).
 */
export interface TruncationEventCounter {
  countTruncationEventsSince(agent: string, sinceMs: number): number;
}

/**
 * Phase 115 Plan 05 T03 — D-05 priority trigger gate.
 *
 * Returns true when `PRIORITY_THRESHOLD` or more tier-1 truncation events
 * fired for this agent in the last `PRIORITY_WINDOW_MS`. Logs a single
 * warn line per priority firing for operator visibility.
 *
 * Pure function — no side effects beyond logging. Caller is responsible
 * for shortening the idle-minutes threshold accordingly.
 */
export function shouldFirePriorityPass(
  agent: string,
  counter: TruncationEventCounter,
  log: { readonly warn: (msg: string) => void },
  now: () => Date,
): boolean {
  const sinceMs = now().getTime() - PRIORITY_WINDOW_MS;
  let events = 0;
  try {
    events = counter.countTruncationEventsSince(agent, sinceMs);
  } catch {
    // Counter failure is non-fatal — treat as "no priority" so cron keeps
    // firing on the normal cadence. The TraceCollector wrapper already
    // logs its own warn on failure.
    return false;
  }
  if (events >= PRIORITY_THRESHOLD) {
    log.warn(
      `[diag] priority-dream-pass-trigger agent=${agent} events=${events} threshold=${PRIORITY_THRESHOLD}`,
    );
    return true;
  }
  return false;
}

/**
 * Cron handle returned by the factory — trims the surface to just `.stop()`.
 */
export interface DreamCronHandle {
  readonly stop: () => void;
}

/**
 * Cron factory signature. Production passes a wrapper over `new Cron(...)`;
 * tests pass a stub that captures the callback for deterministic triggering.
 */
export type DreamCronFactory = (
  pattern: string,
  opts: { readonly name: string },
  callback: () => void | Promise<void>,
) => DreamCronHandle;

/** Default production factory — thin wrapper over `new Cron(...)`. */
const DEFAULT_DREAM_CRON_FACTORY: DreamCronFactory = (
  pattern,
  opts,
  callback,
) => {
  const cron = new Cron(pattern, { name: opts.name }, async () => {
    await callback();
  });
  return {
    stop: () => cron.stop(),
  };
};

/**
 * Dream-cron registration deps.
 */
export interface DreamCronDeps {
  readonly agentName: string;
  readonly dreamConfig: {
    readonly enabled: boolean;
    readonly idleMinutes: number;
    readonly model: string;
  };
  readonly getLastTurnAt: () => Date | null;
  readonly runDreamPass: (agent: string) => Promise<DreamPassOutcome>;
  readonly applyDreamResult: (
    agent: string,
    outcome: DreamPassOutcome,
  ) => Promise<DreamApplyOutcome>;
  readonly isAgentIdle: (deps: IsAgentIdleDeps) => IsAgentIdleResult;
  readonly now: () => Date;
  readonly log: {
    readonly info: (msg: string) => void;
    readonly warn: (msg: string) => void;
    readonly error: (msg: string) => void;
  };
  /** Override for tests — defaults to real croner. */
  readonly cronFactory?: DreamCronFactory;
  /**
   * Phase 115 Plan 05 T03 — D-05 priority dream-pass trigger.
   *
   * Optional truncation-event counter. When supplied, each cron tick
   * consults `shouldFirePriorityPass`; when 2+ events fired in 24h for
   * the agent, the idle-window threshold is shortened from the configured
   * `dream.idleMinutes` to `PRIORITY_IDLE_MINUTES` (5 minutes), and the
   * priority signal is propagated to applyDreamResult via D-10 Row 5.
   *
   * Omitting this dep keeps Phase 95 D-04 behavior verbatim — useful for
   * legacy tests / agents that don't have a TraceCollector wired.
   */
  readonly truncationEventCounter?: TruncationEventCounter;
  /**
   * Phase 115 Plan 05 T03 — when truncationEventCounter triggers a priority
   * pass, the registration calls applyDreamResult through this priority-
   * aware override. Production wiring threads applyDreamResultD10 here.
   *
   * If absent, priority signal is logged but the legacy applyDreamResult
   * is invoked unchanged (graceful degradation).
   */
  readonly applyDreamResultPriority?: (
    agent: string,
    outcome: DreamPassOutcome,
    isPriorityPass: boolean,
  ) => Promise<DreamApplyOutcome>;
}

export interface DreamCronRegistration {
  readonly registered: boolean;
  readonly reason?: string;
  readonly unregister?: () => void;
  readonly label: "dream";
}

/**
 * Register a per-agent dream cron timer.
 *
 * Behavior:
 *   - dream.enabled === false → no Cron created; returns
 *     {registered:false, reason:'disabled', label:'dream'}
 *   - dream.enabled === true → schedules `*\/${idleMinutes} * * * *` cron;
 *     each tick consults isAgentIdle, fires runDreamPass + applyDreamResult
 *     when idle, logs a skip when active
 *
 * Errors thrown by runDreamPass or applyDreamResult are caught and logged
 * — a single mis-fire does not crash the cron (subsequent ticks keep firing).
 */
export function registerDreamCron(deps: DreamCronDeps): DreamCronRegistration {
  if (!deps.dreamConfig.enabled) {
    return { registered: false, reason: "disabled", label: "dream" };
  }

  const factory = deps.cronFactory ?? DEFAULT_DREAM_CRON_FACTORY;

  // The cron minute-field step must be 1..59 — croner rejects `*/N` for N>60
  // ("steps cannot be greater than maximum value of part (60)") and throws
  // SYNCHRONOUSLY at construction. `idleMinutes` is the IDLE THRESHOLD (schema
  // 5..360), not the check cadence: the cron only needs to fire often enough
  // to catch the window — the real threshold is still enforced by isAgentIdle
  // on every tick below. So clamp the *check cadence* to a valid step; any
  // configured idleMinutes (incl. >59) then works without an invalid pattern.
  // INC-2026-06-04: dream.idleMinutes:90 → `*/90 * * * *` threw and the
  // unguarded throw crash-looped the entire fleet.
  const stepMinutes = Math.min(
    Math.max(Math.floor(deps.dreamConfig.idleMinutes), 1),
    59,
  );
  const pattern = `*/${stepMinutes} * * * *`;

  // Per-agent cron name. croner keys its static `scheduledJobs` registry
  // by name — a hardcoded "dream" collides across agents (noisy duplicate-
  // name warning at boot + only one agent visible in any name-keyed
  // schedule introspection). Suffixing the agent name keeps each
  // registration uniquely addressable. The `label` field below stays
  // "dream" for the D-06 /clawcode-status schedule grouping.
  const cronName = `dream-${deps.agentName}`;

  const onTick = async (): Promise<void> => {
    // Phase 115 Plan 05 T03 — D-05 priority dream-pass gate.
    // Consult the truncation-event counter (if wired) to decide whether to
    // shorten the idle threshold AND propagate the priority signal to the
    // applier (D-10 Row 5).
    let isPriority = false;
    if (deps.truncationEventCounter) {
      isPriority = shouldFirePriorityPass(
        deps.agentName,
        deps.truncationEventCounter,
        deps.log,
        deps.now,
      );
    }
    const effectiveIdleMinutes = isPriority
      ? PRIORITY_IDLE_MINUTES
      : deps.dreamConfig.idleMinutes;

    const idle = deps.isAgentIdle({
      lastTurnAt: deps.getLastTurnAt(),
      idleMinutes: effectiveIdleMinutes,
      now: deps.now,
    });
    if (!idle.idle) {
      deps.log.info(
        `[dream] skip — agent ${deps.agentName} active (${idle.reason})`,
      );
      return;
    }
    try {
      const outcome = await deps.runDreamPass(deps.agentName);
      // Priority signal propagated to applier when wired; falls through
      // to legacy single-arg applier otherwise (Phase 95 D-04 unchanged).
      const applied = deps.applyDreamResultPriority
        ? await deps.applyDreamResultPriority(
            deps.agentName,
            outcome,
            isPriority,
          )
        : await deps.applyDreamResult(deps.agentName, outcome);
      deps.log.info(
        `[dream] ${deps.agentName} ${applied.kind} ` +
          `(isPriorityPass=${isPriority}): ${JSON.stringify(applied)}`,
      );
    } catch (err) {
      deps.log.error(
        `[dream] ${deps.agentName} crashed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  };

  // Defense-in-depth: even with the clamped pattern above, any croner
  // construction failure must degrade THIS agent's dreaming, never crash the
  // daemon. Returns {registered:false, reason:'pattern-error'} so the boot
  // loop logs + continues (INC-2026-06-04 fail-open).
  let handle: DreamCronHandle;
  try {
    handle = factory(pattern, { name: cronName }, onTick);
  } catch (err) {
    deps.log.error(
      `[dream] ${deps.agentName} cron registration failed ` +
        `(pattern=${pattern}, idleMinutes=${deps.dreamConfig.idleMinutes}): ${
          err instanceof Error ? err.message : String(err)
        }`,
    );
    return { registered: false, reason: "pattern-error", label: "dream" };
  }

  return {
    registered: true,
    label: "dream",
    unregister: () => handle.stop(),
  };
}
