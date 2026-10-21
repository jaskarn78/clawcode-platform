/**
 * Phase 138 Plan 05 T-05 — failover-controller cron wiring.
 *
 * Registers a 1-minute `croner` tick that drives `FailoverController.
 * tick()`. Mirrors the `scheduleDailySummaryCron` / `scheduleMigrationCron`
 * / dream-cron pattern: an injectable `cronFactory` (production wraps
 * `new Cron(...)`; tests pass a stub that captures the callback for
 * synchronous triggering) and a `.stop()` handle for graceful shutdown.
 *
 * **Why this is daemon-BOOT-wired, not test-only.** A cron module with
 * no production caller is the silent-path-bifurcation anti-pattern
 * (`feedback_silent_path_bifurcation` — it bit dream-cron for 5+ days).
 * `daemon.ts` registers `scheduleFailoverCron` alongside the other crons
 * at boot; the sentinel grep in 138-05's verification block asserts the
 * `scheduleFailoverCron` call exists in `daemon.ts`.
 *
 * **Tick-error isolation.** A throw inside `FailoverController.tick()`
 * is caught + logged (`phase138-failover-cron-error`) — a single bad
 * tick must NOT crash the cron; the next minute's tick fires normally.
 * `FailoverController.tick` already swallows its own per-decision errors;
 * this catch is defence-in-depth for an unexpected throw in the read
 * path.
 *
 * See:
 *   - `src/manager/daily-summary-cron.ts` — the pattern template
 *   - `src/manager/failover-controller.ts` — the tick implementation
 */

import { Cron } from "croner";

/** Minimal logger surface — daemon passes a pino child, tests a stub. */
export interface FailoverCronLogger {
  info(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
}

/** The controller surface the cron drives. */
export interface FailoverCronController {
  tick(): Promise<void>;
}

/**
 * Minimal Cron-like handle — trims croner's surface to the one method
 * the daemon shutdown sequence touches.
 */
export interface FailoverCronHandle {
  readonly stop: () => void;
}

/**
 * Factory for the underlying scheduler. Production passes a wrapper over
 * croner's `new Cron(...)`; tests pass a stub that captures the callback
 * for deterministic synchronous triggering.
 */
export type FailoverCronFactory = (
  pattern: string,
  opts: { readonly name: string },
  callback: () => unknown | Promise<unknown>,
) => FailoverCronHandle;

/** Default production cron factory — thin wrapper over `new Cron(...)`. */
const DEFAULT_CRON_FACTORY: FailoverCronFactory = (
  pattern,
  opts,
  callback,
) => {
  const cron = new Cron(pattern, { name: opts.name }, async () => {
    await callback();
  });
  return { stop: () => cron.stop() };
};

/** Arguments for {@link scheduleFailoverCron}. */
export interface ScheduleFailoverCronArgs {
  /** The failover controller whose `tick()` the cron drives. */
  readonly controller: FailoverCronController;
  /** Logger. */
  readonly logger: FailoverCronLogger;
  /** Override for tests — defaults to real croner. */
  readonly cronFactory?: FailoverCronFactory;
  /** Override for tests — defaults to `*​/1 * * * *` (every minute). */
  readonly pattern?: string;
}

/**
 * Schedule the 1-minute failover cron. Returns a handle whose `.stop()`
 * the daemon's SIGTERM shutdown sequence calls — BEFORE the shared
 * `fleet-alerts.db` handle closes, so an in-flight tick never writes to
 * a closed connection.
 *
 * The tick callback is async; any thrown error is caught + logged so a
 * single bad tick cannot kill the cron.
 */
export function scheduleFailoverCron(
  args: ScheduleFailoverCronArgs,
): FailoverCronHandle {
  const factory = args.cronFactory ?? DEFAULT_CRON_FACTORY;
  const pattern = args.pattern ?? "*/1 * * * *";

  const callback = async (): Promise<void> => {
    try {
      await args.controller.tick();
    } catch (err) {
      args.logger.error(
        {
          tag: "phase138-failover-cron-error",
          error: err instanceof Error ? err.message : String(err),
        },
        "phase138-failover-cron-error",
      );
    }
  };

  return factory(pattern, { name: "phase138-failover" }, callback);
}
