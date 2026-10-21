/**
 * 999.171 — per-turn live-thinking controller for the status trail.
 *
 * One controller per rendered turn, started by the bridge's
 * streamAndPostResponse only when live thinking is on for the agent. It:
 *   - subscribes to THIS turn's `system/thinking_tokens` progress through the
 *     thinking-sink registry (keyed by turn id, so frames from any other turn,
 *     a self-fired one included, never reach it: SC-4);
 *   - shows the count as the trail's current `→ thinking · N tokens` line;
 *   - runs the repaint ticker, so elapsed time keeps moving while the model
 *     thinks or a long tool runs, and catches up a throttled tool paint;
 *   - writes one journal summary per turn (frames, peak tokens), never text.
 *
 * Phantom-notification guard (2026-08-27 rule): a turn that has only thought
 * never makes its FIRST status post before the first-paint floor, and never
 * once the answer has started streaming (a status message appearing below a
 * streaming answer would be a misordered phantom post).
 *
 * Everything here is observational: no callback may throw into the stream
 * pump or the bridge. It lives outside bridge.ts so the bridge only wires it.
 */
import {
  type StatusTrail,
  THINKING_FIRST_PAINT_MIN_MS,
  shouldPaintThinkingOnly,
} from "./hold-status.js";
import { TRAIL_REPAINT_TICK_MS, createTrailRepaintScheduler } from "./trail-repaint.js";
import { registerThinkingSink } from "../manager/thinking-sink.js";

export interface LiveThinkingHandle {
  /** Throttled catch-up paint (the tool writer calls this when it is inside the interval). */
  requestPaint(): void;
  /** Terminal and idempotent: stops the ticker, drops the sink, writes the summary. */
  stop(): void;
  /**
   * True once THIS controller's own thinking-only paint, past the first-paint
   * floor, created the status surface. The settle keys on it: a surface that
   * narration, a tool or a claim posted is not a live-thinking post, whatever
   * the trail's thinkingSeen latch says. Still readable after stop().
   */
  readonly postedThinkingOnly: boolean;
}

export interface LiveThinkingSummary {
  readonly frames: number;
  readonly peakTokens: number;
}

export interface LiveThinkingOptions {
  readonly turnId: string;
  readonly trail: StatusTrail;
  /** The bridge's paintTrail. Must never call requestPaint() itself. */
  readonly paintTrail: () => Promise<void>;
  readonly isArmed: () => boolean;
  readonly isDraftStarted: () => boolean;
  /** Tools or claims seen this turn. */
  readonly hasActivityBeyondThinking: () => boolean;
  /** The status (or slot) message exists, or its creation is already in flight. */
  readonly hasPaintedSurface: () => boolean;
  readonly elapsedMs: () => number;
  /** perf.streaming.editIntervalMs (minimum gap between edits). */
  readonly intervalMs: number;
  /** The bridge's real last-edit time, from any paint path. */
  readonly lastPaintAt: () => number;
  readonly tickMs?: number;
  readonly firstPaintMinMs?: number;
  /**
   * Lifetime caps, the typing heartbeat's (bridge TYPING_MAX_MS /
   * TYPING_ABSOLUTE_MAX_MS): a dispatch that never settles never reaches a
   * stop site, so the controller stops itself. Past the soft cap it stops
   * once the session has no turn in flight; past the absolute cap, always.
   */
  readonly softMaxLifetimeMs: number;
  readonly maxLifetimeMs: number;
  /** sessionManager.hasActiveTurn for the session that owns this turn. */
  readonly isTurnActive: () => boolean;
  /**
   * 999.178 R1 — thinking-arm. Called from the guarded paint when the turn is
   * unarmed but has only THOUGHT (no tool, no claim) past the first-paint floor.
   * The bridge sets it only in modes that should arm on thinking (auto), so a
   * tool-less draft shows a first sign of life. Re-checked every repaint tick,
   * so it is robust to thinking starting after this controller is created.
   */
  readonly armOnThinking?: () => void;
  /** Called once when a lifetime cap stops the controller (the bridge logs it). */
  readonly onLifetimeCap?: () => void;
  readonly onSummary?: (summary: LiveThinkingSummary) => void;
}

export function startLiveThinking(opts: LiveThinkingOptions): LiveThinkingHandle {
  const firstPaintMinMs = opts.firstPaintMinMs ?? THINKING_FIRST_PAINT_MIN_MS;
  let frames = 0;
  let peakTokens = 0;
  let stopped = false;
  let postedThinkingOnly = false;

  const pastLifetime = (): boolean => {
    const elapsed = opts.elapsedMs();
    if (elapsed > opts.maxLifetimeMs) return true;
    if (elapsed <= opts.softMaxLifetimeMs) return false;
    try {
      return !opts.isTurnActive();
    } catch {
      return true; // cannot tell: a cosmetic ticker errs toward stopping
    }
  };

  const guardedPaint = async (): Promise<void> => {
    // First, before any paint guard, so an unarmed or idle ticker stops too.
    if (pastLifetime()) {
      stop();
      try {
        opts.onLifetimeCap?.();
      } catch {
        // A journal fault must never break the turn.
      }
      return;
    }
    // Once the answer streams, the trail is frozen (tool writer and sink stand
    // down), so only the header would still move: stop the ticker rather than
    // spend the answer's edit-rate budget on it (LO-03). Not a full stop: the
    // sink keeps counting frames for the journal. This also means a
    // thinking-only turn never makes its FIRST post below a streaming answer.
    if (opts.isDraftStarted()) {
      scheduler.stop();
      return;
    }
    const beyond = opts.hasActivityBeyondThinking();
    if (!opts.isArmed()) {
      // 999.178 R1 — thinking-arm. A tool-less turn that only thinks never trips
      // the bridge's quiet-TOOL arm, so it would never paint. Arm it here once
      // it has thought past the first-paint floor. Gated by the bridge (only
      // passes armOnThinking in the mode that should arm on thinking); a no-op
      // otherwise, so "always" (already armed) and "topic" (topic-only) are
      // unaffected. `beyond` turns mean a tool/claim will arm the normal way.
      if (
        !beyond &&
        opts.trail.thinkingSeen &&
        shouldPaintThinkingOnly(opts.elapsedMs(), firstPaintMinMs)
      ) {
        opts.armOnThinking?.();
      }
      if (!opts.isArmed()) return;
    }
    if (!beyond && !opts.trail.thinkingSeen) return;
    if (
      !beyond &&
      !opts.hasPaintedSurface() &&
      !shouldPaintThinkingOnly(opts.elapsedMs(), firstPaintMinMs)
    ) {
      return;
    }
    // Latch BEFORE the await: nothing between this check and paintTrail's
    // send yields, so this paint is the post's initiator, and a settle that is
    // already awaiting that same in-flight post must see the latch when it
    // resumes. Cleared if the paint made no surface after all.
    if (!beyond && !opts.hasPaintedSurface()) postedThinkingOnly = true;
    await opts.paintTrail();
    if (!opts.hasPaintedSurface()) postedThinkingOnly = false;
  };

  const scheduler = createTrailRepaintScheduler({
    paint: guardedPaint,
    intervalMs: opts.intervalMs,
    lastPaintAt: opts.lastPaintAt,
    tickMs: opts.tickMs ?? TRAIL_REPAINT_TICK_MS,
  });
  scheduler.start();

  const unregister = registerThinkingSink(opts.turnId, (ev) => {
    try {
      frames += 1;
      if (ev.estimatedTokens > peakTokens) peakTokens = ev.estimatedTokens;
      // Mirrors the tool writer's `if (draftStarted) return`.
      if (opts.isDraftStarted()) return;
      if (opts.trail.setThinking(ev.estimatedTokens)) scheduler.request();
    } catch {
      // Observational only: a render fault never reaches the stream pump.
    }
  });

  function stop(): void {
    if (stopped) return;
    stopped = true;
    scheduler.stop();
    unregister();
    if (frames === 0) return;
    try {
      opts.onSummary?.({ frames, peakTokens });
    } catch {
      // A journal fault must never break the turn.
    }
  }

  return {
    requestPaint(): void {
      scheduler.request();
    },
    stop,
    get postedThinkingOnly(): boolean {
      return postedThinkingOnly;
    },
  };
}
