import type { Logger } from "pino";

/**
 * Shutdown watchdog + bounded-step helpers (C1 — stuck-shutdown wedge).
 *
 * The daemon shutdown closure awaits several external-resource teardowns
 * (`openAiEndpoint.close()`, `dashboard.close()`, `browserManager.close()`,
 * `discordBridge.stop()`, `slashHandler.stop()`, `manager.stopAll()`). Any one
 * of these can hang indefinitely, wedging the whole shutdown for 5–6 minutes
 * until systemd's `TimeoutStopSec` SIGKILLs the process. That made every deploy
 * a multi-minute outage (the meta-blocker identified in the 2026-06-16 audit).
 *
 * Two independent guards, both pure + injectable for unit tests:
 *   - `withShutdownStep` bounds a single teardown await: race it against a
 *     timeout, log + continue on timeout, NEVER reject (one slow resource must
 *     not abort the rest of shutdown).
 *   - `armShutdownWatchdog` is the top-level net: a single `setTimeout` that
 *     force-exits the process if the entire shutdown closure has not completed
 *     within the budget. `.unref()`'d so a clean shutdown is never kept alive
 *     by the pending timer.
 */

/** Default per-step bound. Generous enough for a healthy teardown, short
 * enough that six serial timeouts still land well under the watchdog budget. */
export const DEFAULT_SHUTDOWN_STEP_TIMEOUT_MS = 10_000;

/** Default top-level watchdog budget covering the entire shutdown closure. */
export const DEFAULT_SHUTDOWN_WATCHDOG_MS = 20_000;

export interface ShutdownStepResult {
  /** True when the step did not settle before `timeoutMs` elapsed. */
  readonly timedOut: boolean;
}

/**
 * Run a shutdown teardown step with a bounded timeout. Resolves when the step
 * settles OR when `timeoutMs` elapses, whichever comes first. Never rejects —
 * an error or hang in one teardown must not block the remaining shutdown.
 *
 * On timeout, logs at `warn` and returns `{ timedOut: true }`; the underlying
 * promise is left to settle (or hang) in the background — by the time it would,
 * the process is exiting.
 */
export async function withShutdownStep(
  label: string,
  step: () => Promise<unknown>,
  timeoutMs: number,
  log: Pick<Logger, "warn">,
): Promise<ShutdownStepResult> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), timeoutMs);
    // Do not let the bound timer keep the loop alive on a fast clean step.
    timer.unref?.();
  });

  // Wrap the step so a rejection is swallowed (logged) rather than propagated —
  // a teardown that throws is non-fatal to shutdown by contract.
  const guarded = (async (): Promise<"settled"> => {
    try {
      await step();
    } catch (err) {
      log.warn(
        { step: label, err: err instanceof Error ? err.message : String(err) },
        "shutdown step threw (non-fatal — continuing)",
      );
    }
    return "settled";
  })();

  const outcome = await Promise.race([guarded, timeout]);
  if (timer !== undefined) clearTimeout(timer);

  if (outcome === "timeout") {
    log.warn(
      { step: label, timeoutMs },
      "shutdown step timed out — continuing without it (resource left to be reaped by exit)",
    );
    return { timedOut: true };
  }
  return { timedOut: false };
}

export interface ShutdownWatchdogHandle {
  /** Cancel the watchdog timer (called on a clean, in-budget shutdown). */
  readonly disarm: () => void;
}

/**
 * Arm a top-level force-exit net for the whole shutdown closure. If `disarm()`
 * is not called within `timeoutMs`, `exit(exitCode)` fires.
 *
 * `exitCode` MUST match the signal's intended disposition:
 *   - SIGTERM / SIGINT → 0 (clean stop).
 *   - SIGHUP → 129 (128 + signal 1). The systemd unit declares
 *     `RestartForceExitStatus=129` so a SIGHUP-induced exit is treated as a
 *     failure trigger and the daemon is restarted. A blanket exit 0 on the
 *     SIGHUP path would be read as a clean exit → NO restart → reintroduces the
 *     2026-05-01 silent-death outage that the SIGHUP handler exists to prevent.
 *
 * The timer is `.unref()`'d so a shutdown that completes in budget exits
 * naturally without the watchdog holding the event loop open.
 */
export function armShutdownWatchdog(
  exitCode: number,
  timeoutMs: number,
  exit: (code: number) => void,
  log: Pick<Logger, "error">,
): ShutdownWatchdogHandle {
  const timer = setTimeout(() => {
    log.error(
      { timeoutMs, exitCode },
      "shutdown watchdog fired — shutdown did not complete in budget, forcing exit",
    );
    exit(exitCode);
  }, timeoutMs);
  timer.unref?.();

  let disarmed = false;
  return {
    disarm: () => {
      if (disarmed) return;
      disarmed = true;
      clearTimeout(timer);
    },
  };
}
