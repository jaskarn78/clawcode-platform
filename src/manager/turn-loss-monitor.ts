/**
 * Phase 140 Plan 05 Task 2 — TurnLossMonitor.
 *
 * The REQUIRED v3 turn-loss telemetry (CONTEXT 140 LOCKED). It replaces the
 * now-inert stream-stall tracker / wedge auto-recovery: under the v3
 * native-channels migration a mid-turn abort degrades to a coarse PTY restart
 * (`interrupt` / `forceReleaseTurn` / the Phase 127 stall tracker all go inert
 * once the live chat agent is a `claude --channels` session with no in-process
 * Query). Without an explicit watchdog, a turn that STARTS but never reaches the
 * `end_to_end` TraceStore segment is fully silent — Stage-3's 7-day soak could
 * show clean SLOs while individual users lose responses.
 *
 * Behaviour:
 *   - `onTurnStart(turnId, agent)` arms a single-shot watchdog at
 *     `(end_to_end p99) × 3`. A duplicate `onTurnStart` for the same id REPLACES
 *     the prior arm (so a noisy caller still produces at most one alert).
 *   - `onTurnEnd(turnId)` cancels the watchdog — the turn reached `end_to_end`.
 *     An orphan end (unknown id) is a silent no-op (turns in flight before the
 *     monitor was wired produce these).
 *   - When the watchdog fires (no end before the deadline), the monitor emits
 *     ONE canonical alert-level log line carrying `turnId`, `agent`, `elapsedMs`,
 *     and `deadlineMs`, and increments `lostTurnCount()`.
 *
 * It is OBSERVE + ALERT ONLY — it never blocks, restarts, or interrupts
 * anything (the PTY supervisor + circuit breaker own recovery). It is also
 * backend-agnostic: it benignly covers v2 turns too (a v2 turn always reaches
 * `end_to_end`, so it never alerts in healthy steady state).
 *
 * All side-effecting seams (the p99 source, the clock, the timer, the alert
 * sink) are injected so the unit suite is fully deterministic.
 */

import { DEFAULT_MODEL_SLOS } from "../performance/slos.js";

/**
 * Floor for the watchdog deadline when the `end_to_end` p99 is unavailable
 * (null / no_data / 0 — e.g. boot before any turn has completed, or a window
 * with no traces).
 *
 * Provenance: the data-driven deadline is `p99 × 3`. The slowest fleet model is
 * Opus, whose `end_to_end` p95 SLO is 40s (`DEFAULT_MODEL_SLOS.opus`, locked
 * 2026-05-11). For response-time distributions p99 ≈ 1.5 × p95, so the
 * steady-state Opus deadline is ≈ 40s × 1.5 × 3 = 180s. We use that as the
 * no-data floor so the floor branch never alerts MORE eagerly than the
 * data-driven branch would on a healthy fleet (a tighter floor such as p95×3 =
 * 120s would produce boot-time false alerts).
 */
export const TURN_LOSS_FLOOR_MS =
  DEFAULT_MODEL_SLOS.opus.end_to_end_p95_ms * 3 * 1.5; // = 180_000

/** Stable structured-log tag — operator pivot: `grep phase140-turn-loss`. */
export const TURN_LOSS_LOG_TAG = "phase140-turn-loss";

/** The alert payload handed to the sink when a turn is detected as lost. */
export interface TurnLossAlert {
  readonly turnId: string;
  readonly agent: string;
  /** Wall-clock ms elapsed from `onTurnStart` to the watchdog firing. */
  readonly elapsedMs: number;
  /** The armed deadline (p99×3, or the floor when p99 was unavailable). */
  readonly deadlineMs: number;
}

/** Opaque timer handle — `number` for setTimeout, but injectable for tests. */
type TimerHandle = unknown;

/** Dependency bag for {@link TurnLossMonitor}. */
export interface TurnLossMonitorDeps {
  /**
   * Returns the current `end_to_end` p99 (ms) for the alerting decision, or
   * `null` when there is no data. Production reads the percentile row from the
   * TraceStore; tests inject a constant. A non-positive value is treated as
   * no_data (the floor applies).
   */
  readonly getEndToEndP99Ms: (agent: string) => number | null;
  /** Monotonic-ish clock (ms). Default `Date.now`. */
  readonly clock?: () => number;
  /** Arm a single-shot timer. Default wraps `setTimeout`. */
  readonly setTimer?: (cb: () => void, delayMs: number) => TimerHandle;
  /** Cancel an armed timer. Default wraps `clearTimeout`. */
  readonly clearTimer?: (handle: TimerHandle) => void;
  /**
   * Sink for the alert. Default emits a canonical `phase140-turn-loss`
   * structured `console.warn` line (alert-level — operators grep warn/error
   * separately from info diagnostics). Plan-02-style wiring can route this to
   * Discord / a session-log row.
   */
  readonly alertSink?: (alert: TurnLossAlert) => void;
}

interface ArmedTurn {
  readonly agent: string;
  readonly startedAtMs: number;
  readonly deadlineMs: number;
  readonly handle: TimerHandle;
}

/**
 * Watchdog for started-but-unfinished turns. Construct ONE per daemon (or per
 * agent — it is keyed by turn id, so a single instance across all agents is
 * fine) and call `onTurnStart` / `onTurnEnd` from the turn lifecycle.
 */
export class TurnLossMonitor {
  private readonly getP99: (agent: string) => number | null;
  private readonly clock: () => number;
  private readonly setTimer: (cb: () => void, delayMs: number) => TimerHandle;
  private readonly clearTimer: (handle: TimerHandle) => void;
  private readonly alertSink: (alert: TurnLossAlert) => void;

  private readonly armed = new Map<string, ArmedTurn>();
  private lostTurns = 0;

  constructor(deps: TurnLossMonitorDeps) {
    this.getP99 = deps.getEndToEndP99Ms;
    this.clock = deps.clock ?? (() => Date.now());
    this.setTimer =
      deps.setTimer ??
      ((cb, delayMs) => setTimeout(cb, delayMs) as unknown as TimerHandle);
    this.clearTimer =
      deps.clearTimer ??
      ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
    this.alertSink = deps.alertSink ?? defaultAlertSink;
  }

  /** Number of turns that fired the watchdog (lost turns) since construction. */
  lostTurnCount(): number {
    return this.lostTurns;
  }

  /**
   * Arm the watchdog for a starting turn. A duplicate id replaces the prior arm
   * (cancels its timer first) so a noisy caller produces at most one alert.
   */
  onTurnStart(turnId: string, agent: string): void {
    // Replace any existing arm for this id.
    const existing = this.armed.get(turnId);
    if (existing) {
      this.safeClear(existing.handle);
      this.armed.delete(turnId);
    }

    const deadlineMs = this.resolveDeadlineMs(agent);
    const startedAtMs = this.clock();
    const handle = this.setTimer(() => {
      this.fire(turnId);
    }, deadlineMs);
    this.armed.set(turnId, { agent, startedAtMs, deadlineMs, handle });
  }

  /**
   * Cancel the watchdog for a turn that reached `end_to_end`. Unknown id → no-op
   * (orphan end from a turn that started before the monitor was wired).
   */
  onTurnEnd(turnId: string): void {
    const entry = this.armed.get(turnId);
    if (!entry) return;
    this.safeClear(entry.handle);
    this.armed.delete(turnId);
  }

  /** Resolve the watchdog deadline: p99×3, or the floor when p99 is unavailable. */
  private resolveDeadlineMs(agent: string): number {
    let p99: number | null;
    try {
      p99 = this.getP99(agent);
    } catch {
      // A failing p99 provider must never break the turn lifecycle — fall back
      // to the floor (observe-only telemetry, never fatal).
      p99 = null;
    }
    if (p99 === null || !Number.isFinite(p99) || p99 <= 0) {
      return TURN_LOSS_FLOOR_MS;
    }
    return p99 * 3;
  }

  /** Watchdog fired — the turn never reached end_to_end. Alert once. */
  private fire(turnId: string): void {
    const entry = this.armed.get(turnId);
    if (!entry) return; // already ended / cancelled — single-shot guard
    this.armed.delete(turnId);
    this.lostTurns += 1;
    const alert: TurnLossAlert = {
      turnId,
      agent: entry.agent,
      elapsedMs: this.clock() - entry.startedAtMs,
      deadlineMs: entry.deadlineMs,
    };
    try {
      this.alertSink(alert);
    } catch {
      // Alert delivery failure must not throw out of a timer callback.
    }
  }

  private safeClear(handle: TimerHandle): void {
    try {
      this.clearTimer(handle);
    } catch {
      // Defensive — clearTimer is idempotent; never let it break a replace/end.
    }
  }
}

/**
 * Default alert sink — a single canonical structured `console.warn` line so the
 * lost turn is operator-visible without any Discord wiring (mirrors the Phase
 * 127 `phase127-stream-stall` precedent). Grep target:
 * `journalctl -u clawcode | grep phase140-turn-loss`.
 */
function defaultAlertSink(alert: TurnLossAlert): void {
  try {
    console.warn(
      TURN_LOSS_LOG_TAG,
      JSON.stringify({
        level: "warn",
        tag: TURN_LOSS_LOG_TAG,
        turnId: alert.turnId,
        agent: alert.agent,
        elapsedMs: alert.elapsedMs,
        deadlineMs: alert.deadlineMs,
        reason:
          "turn started but did not reach end_to_end within p99×3 — likely a v3 mid-turn abort (PTY restart); response may be silently lost",
      }),
    );
  } catch {
    // Observational path — never break.
  }
}
