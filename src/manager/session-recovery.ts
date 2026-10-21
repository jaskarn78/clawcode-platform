import type { Logger } from "pino";
import type { ResolvedAgentConfig } from "../shared/types.js";
import type { BackoffConfig } from "./types.js";
import type { SessionHandle } from "./session-adapter.js";
import { readRegistry, updateEntry, mutateRegistry } from "./registry.js";
import { calculateBackoff } from "./backoff.js";

/**
 * Callback type for performing an actual restart.
 * Delegated back to SessionManager since it needs access to startAgent.
 */
export type RestartFn = (
  name: string,
  config: ResolvedAgentConfig,
) => Promise<void>;

/**
 * Quick task 260521-5gh Gap 2 — payload for the `onCrashAlert` DI hook.
 *
 * Fired on every crash (`terminal: false`, from updateRegistryOnCrash) and
 * on the terminal `failed` transition (`terminal: true`, from markFailed).
 * The daemon's hook turns this into a Discord crash alert; the terminal
 * variant gets a louder "manual restart needed" alert.
 */
export type CrashAlertPayload = {
  readonly agent: string;
  readonly errorSummary: string;
  readonly attempt: number;
  readonly terminal: boolean;
};

/**
 * Manages crash recovery, exponential backoff, and restart scheduling.
 *
 * Extracted from SessionManager to isolate recovery concerns.
 * The performRestart implementation lives in SessionManager and is
 * passed as a callback to this class.
 */
export class SessionRecoveryManager {
  /**
   * Internal: promise from the last crash handler, used by tests to await async operations.
   * @internal
   */
  _lastCrashPromise: Promise<void> | null = null;

  /**
   * Internal: promise from the last restart attempt, used by tests to await async operations.
   * @internal
   */
  _lastRestartPromise: Promise<void> | null = null;

  /**
   * Internal: promise from the last stability reset, used by tests to await async operations.
   * @internal
   */
  _lastStabilityPromise: Promise<void> | null = null;

  private readonly stabilityTimers: Map<
    string,
    ReturnType<typeof setTimeout>
  > = new Map();
  private readonly restartTimers: Map<
    string,
    ReturnType<typeof setTimeout>
  > = new Map();

  constructor(
    private readonly registryPath: string,
    private readonly backoffConfig: BackoffConfig,
    private readonly log: Logger,
    private readonly performRestartFn: RestartFn,
    /**
     * Quick task 260521-5gh Gap 2 — optional crash-alert DI hook. Fired on
     * every crash (`terminal: false`) and on the terminal `failed` transition
     * (`terminal: true`). Optional + back-compatible: production wires it via
     * the daemon; tests omit it. A throwing hook is swallowed (fail-open) so
     * an alerting failure can never destabilize recovery.
     */
    private readonly onCrashAlert?: (payload: CrashAlertPayload) => void,
  ) {}

  /**
   * Handle an agent crash: update registry, calculate backoff, schedule restart.
   * Removes the crashed session from the sessions map.
   *
   * Quick task 260521-5gh Gap 3 — the optional `crashMeta` 5th parameter
   * carries crash-context (a short `cause` marker + the session-start epoch
   * for uptime computation). It is optional and back-compatible: the existing
   * `onError` caller in session-manager.ts omits it; only the warm-path-failure
   * site passes it explicitly.
   */
  handleCrash(
    name: string,
    config: ResolvedAgentConfig,
    error: Error,
    sessions: Map<string, SessionHandle>,
    crashMeta?: {
      readonly cause?: string;
      readonly startedAtMs?: number | null;
    },
  ): void {
    // Clear timers
    this.clearStabilityTimer(name);
    sessions.delete(name);

    // Update registry and schedule restart
    const crashPromise = this.updateRegistryOnCrash(name, error, crashMeta).then(
      (failures) => {
        this.scheduleRestart(name, config, failures);
      },
    );

    // Store the promise so tests can await it
    this._lastCrashPromise = crashPromise;
  }

  /**
   * Set a stability timer that resets consecutiveFailures after stableAfterMs.
   */
  setStabilityTimer(name: string): void {
    this.clearStabilityTimer(name);

    const timer = setTimeout(() => {
      const p = this.resetBackoff(name);
      this._lastStabilityPromise = p;
    }, this.backoffConfig.stableAfterMs);

    this.stabilityTimers.set(name, timer);
  }

  /**
   * Clear the stability timer for an agent.
   */
  clearStabilityTimer(name: string): void {
    const timer = this.stabilityTimers.get(name);
    if (timer) {
      clearTimeout(timer);
      this.stabilityTimers.delete(name);
    }
  }

  /**
   * Clear the restart timer for an agent.
   */
  clearRestartTimer(name: string): void {
    const timer = this.restartTimers.get(name);
    if (timer) {
      clearTimeout(timer);
      this.restartTimers.delete(name);
    }
  }

  /**
   * Clear all timers (stability + restart) for all agents.
   */
  clearAllTimers(): void {
    for (const timer of this.stabilityTimers.values()) {
      clearTimeout(timer);
    }
    this.stabilityTimers.clear();

    for (const timer of this.restartTimers.values()) {
      clearTimeout(timer);
    }
    this.restartTimers.clear();
  }

  // ---------------------------------------------------------------------------
  // Private methods
  // ---------------------------------------------------------------------------

  /**
   * Update registry after a crash, returning the new consecutive failure count.
   *
   * Quick task 260521-5gh Gap 3 — the crash log line is enriched with the
   * error `stack` (when present), the session `uptimeMs` (computed from
   * `crashMeta.startedAtMs`), and a `cause` marker. Only non-sensitive fields
   * are logged: `error.message`, `error.stack`, the numeric uptime, the cause
   * string, and `consecutiveFailures` — no response bodies, env, or secrets.
   */
  private async updateRegistryOnCrash(
    name: string,
    error: Error,
    crashMeta?: {
      readonly cause?: string;
      readonly startedAtMs?: number | null;
    },
  ): Promise<number> {
    const entry = (await readRegistry(this.registryPath)).entries.find(
      (e) => e.name === name,
    );
    const failures = (entry?.consecutiveFailures ?? 0) + 1;

    // Atomic partial-merge: the failures count is derived from the pre-read,
    // but the write merges onto a fresh registry so it can't clobber a
    // concurrent cross-name/cross-field writer (the lost-update guard).
    await mutateRegistry(this.registryPath, (current) =>
      updateEntry(current, name, {
        status: "crashed",
        sessionId: null,
        lastError: error.message,
        consecutiveFailures: failures,
      }),
    );

    const uptimeMs = crashMeta?.startedAtMs
      ? Date.now() - crashMeta.startedAtMs
      : null;
    this.log.error(
      {
        agent: name,
        error: error.message,
        consecutiveFailures: failures,
        // Omit the `stack` key entirely when absent — never log `undefined`.
        ...(error.stack ? { stack: error.stack } : {}),
        uptimeMs,
        cause: crashMeta?.cause ?? "session-onError",
      },
      "agent crashed",
    );

    // Quick task 260521-5gh Gap 2 — fire the crash-alert hook AFTER the
    // registry write + log so a slow / throwing alert cannot delay or block
    // the recovery state transition. A throwing hook is swallowed (fail-open).
    this.fireCrashAlert({
      agent: name,
      errorSummary: error.message,
      attempt: failures,
      terminal: false,
    });

    return failures;
  }

  /**
   * Quick task 260521-5gh Gap 2 — invoke the optional `onCrashAlert` hook,
   * fail-open. A missing hook is a silent no-op; a throwing hook is swallowed
   * and warn-logged so an alerting failure can never destabilize recovery.
   */
  private fireCrashAlert(payload: CrashAlertPayload): void {
    if (!this.onCrashAlert) return;
    try {
      this.onCrashAlert(payload);
    } catch (err) {
      this.log.warn(
        { agent: payload.agent, error: (err as Error).message },
        "onCrashAlert hook threw — swallowed (recovery unaffected)",
      );
    }
  }

  /**
   * Schedule a restart with exponential backoff, or mark failed if max retries exceeded.
   * Public to allow SessionManager.reconcileRegistry to schedule restarts for crashed entries.
   */
  scheduleRestart(
    name: string,
    config: ResolvedAgentConfig,
    consecutiveFailures: number,
  ): void {
    const delay = calculateBackoff(consecutiveFailures, this.backoffConfig);

    if (delay === -1) {
      // Max retries exceeded
      const p = this.markFailed(name);
      this._lastRestartPromise = p;
      return;
    }

    this.log.info(
      { agent: name, delayMs: delay, attempt: consecutiveFailures },
      "scheduling restart",
    );

    const timer = setTimeout(() => {
      const p = this.performRestartFn(name, config);
      this._lastRestartPromise = p;
    }, delay);

    this.restartTimers.set(name, timer);
  }

  /**
   * Mark an agent as failed (max retries exceeded).
   */
  private async markFailed(name: string): Promise<void> {
    await mutateRegistry(this.registryPath, (current) =>
      updateEntry(current, name, { status: "failed" }),
    );

    this.log.error({ agent: name }, "agent failed after max retries");

    // Quick task 260521-5gh Gap 2 — fire the louder terminal crash alert
    // AFTER the registry write + log. Fail-open via fireCrashAlert.
    this.fireCrashAlert({
      agent: name,
      errorSummary: "max retries exhausted",
      attempt: this.backoffConfig.maxRetries,
      terminal: true,
    });
  }

  /**
   * Reset the backoff counter for a stable agent.
   */
  private async resetBackoff(name: string): Promise<void> {
    let didReset = false;
    await mutateRegistry(this.registryPath, (current) => {
      const entry = current.entries.find((e) => e.name === name);
      if (entry && entry.status === "running") {
        didReset = true;
        return updateEntry(current, name, {
          consecutiveFailures: 0,
          lastStableAt: Date.now(),
        });
      }
      // No-op: returning the same reference skips the write (preserves the
      // original "only write when running" behavior).
      return current;
    });
    if (didReset) {
      this.log.info({ agent: name }, "backoff reset after stable period");
    }
  }
}
