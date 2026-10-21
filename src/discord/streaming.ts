/**
 * Progressive message editor utility for Discord streaming responses.
 *
 * Throttles message edits to stay within Discord's rate limits (5 edits per 5 seconds).
 * The first update is sent immediately for fast user feedback, subsequent updates
 * are throttled to editIntervalMs (default 750ms — see Phase 54 CONTEXT D-05 for the
 * tightened cadence; per-agent overrides flow through `perf.streaming.editIntervalMs`
 * with a 300ms floor enforced at Zod).
 *
 * Phase 54 additions:
 *   - first_visible_token span emission on the FIRST editFn invocation (only when
 *     a Turn is passed through the constructor).
 *   - Rate-limit backoff: when editFn rejects with a Discord rate-limit error
 *     (code 20028, HTTP 429, or discord.js RateLimitError), the editor's
 *     editIntervalMs DOUBLES for the remainder of the current turn. A single
 *     pino.WARN fires per editor instance so log volume stays bounded regardless
 *     of how many 429s hit. The editor is reconstructed per Turn so backoff
 *     naturally resets on the next Discord message.
 */

import type { Turn } from "../performance/trace-collector.js";
import type { Logger } from "pino";

export type StreamChunkCallback = (accumulated: string) => void;

export type ProgressiveEditorOptions = {
  readonly editFn: (content: string) => Promise<void>;
  readonly editIntervalMs?: number;  // Default 750ms (Phase 54 — tightened cadence)
  readonly maxLength?: number;       // Default 2000 (Discord limit)
  /**
   * Phase 54: Turn to emit first_visible_token span on the first editFn call.
   * When undefined, no span is emitted (the editor works without trace plumbing).
   */
  readonly turn?: Turn;
  /**
   * Phase 54: logger for the single pino.WARN emitted on the first rate-limit
   * detection per editor instance. When undefined, no warn is emitted.
   */
  readonly log?: Logger;
  /** Agent name included in the rate-limit WARN payload (for operator triage). */
  readonly agent?: string;
  /** Turn id included in the rate-limit WARN payload (for operator triage). */
  readonly turnId?: string;
  /**
   * Minimum visible duration (ms) for an upstream placeholder before the first
   * edit lands. Default `0` (no hold — preserves the pre-existing "first chunk
   * fires immediately" UX).
   *
   * When set to `N > 0`, the FIRST edit is deferred until at least N ms have
   * elapsed since editor construction. Subsequent chunks accumulate into
   * `pendingText` during the hold; when the hold timer fires the LATEST text
   * is sent (not the first chunk). `flush()` honors the hold by clearing the
   * pending timer and sending immediately.
   *
   * Use case: subagent threads post a "🔄 Working..." placeholder before the
   * SDK streams its first delta. With Phase 999.78 boot suppression, the
   * first delta arrives so quickly (~500-1000ms after placeholder send) that
   * Discord's render cycle elides the placeholder — operators perceive the
   * thread "appearing with content directly" instead of going through a
   * visible Working... state. A 1500ms hold restores the visible transition
   * at the cost of up to 1.5s of perceived stream latency.
   */
  readonly firstEditMinDelayMs?: number;
};

/**
 * Phase 54 — detect Discord rate-limit errors from any editFn rejection.
 * Centralizes the 3 shapes documented in discord.js:
 *   - DiscordAPIError code 20028 (interaction rate-limit)
 *   - HTTP status 429 (response rate-limit)
 *   - RateLimitError instances (discord.js class — we check .name since the
 *     constructor is not imported into this module to avoid a hard dep)
 *
 * Returns `false` for non-object / null / undefined inputs so callers can pass
 * any `unknown` error value without pre-filtering.
 */
export function isDiscordRateLimitError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { code?: unknown; status?: unknown; name?: unknown };
  if (typeof e.code === "number" && e.code === 20028) return true;
  if (typeof e.status === "number" && e.status === 429) return true;
  if (typeof e.name === "string" && e.name === "RateLimitError") return true;
  return false;
}

const DEFAULT_EDIT_INTERVAL_MS = 750;
const DEFAULT_MAX_LENGTH = 2000;

/**
 * Throttled progressive message editor.
 *
 * Accepts accumulated text via update(), throttles calls to editFn to avoid
 * Discord rate limits. The first update is forwarded immediately.
 */
export class ProgressiveMessageEditor {
  private readonly editFn: (content: string) => Promise<void>;
  /**
   * Phase 54: mutable — doubles on rate-limit error for the rest of the turn.
   * The editor is reconstructed per Turn so the doubled value naturally resets.
   */
  private editIntervalMs: number;
  private readonly maxLength: number;
  private readonly firstEditMinDelayMs: number;
  private readonly createdAt: number;
  private pendingText: string | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private hasSentFirst = false;
  private disposed = false;
  // Phase 54 state
  private readonly turn: Turn | undefined;
  private readonly log: Logger | undefined;
  private readonly agent: string | undefined;
  private readonly turnId: string | undefined;
  private firstVisibleTokenEmitted = false;
  private rateLimitWarnEmitted = false;
  /**
   * Phase 100-fu — in-flight serialization lock for editFn invocations.
   *
   * Bug fixed: editFn was previously invoked fire-and-forget (
   * `void this.editFn(text).catch(...)`). When the first send was still in-
   * flight (~500ms Discord network round-trip) and the throttle timer fired
   * the next chunk, both calls reached bridge.ts's editFn implementation.
   * Both saw `messageRef.current === null`, both called `channel.send`, and
   * Discord showed TWO near-identical messages instead of ONE
   * progressively-edited message.
   *
   * Fix: serialize through this `inFlight` promise chain. Each call awaits
   * the previous before starting its own editFn body. Rejections are
   * isolated — a failed call N never prevents call N+1 from starting (the
   * await drains the rejection silently, then handleEditError runs).
   *
   * The chain is per-editor-instance, and editors are reconstructed per
   * Turn, so the lock naturally resets at turn boundaries.
   */
  private inFlight: Promise<void> | null = null;

  constructor(options: ProgressiveEditorOptions) {
    this.editFn = options.editFn;
    this.editIntervalMs = options.editIntervalMs ?? DEFAULT_EDIT_INTERVAL_MS;
    this.maxLength = options.maxLength ?? DEFAULT_MAX_LENGTH;
    this.firstEditMinDelayMs = options.firstEditMinDelayMs ?? 0;
    this.createdAt = Date.now();
    this.turn = options.turn;
    this.log = options.log;
    this.agent = options.agent;
    this.turnId = options.turnId;
  }

  /**
   * Called whenever new accumulated text arrives.
   * First call is forwarded immediately; subsequent calls are throttled.
   */
  update(accumulated: string): void {
    if (this.disposed) return;

    this.pendingText = accumulated;

    if (!this.hasSentFirst) {
      // First chunk: mark hasSentFirst so subsequent chunks go through the
      // debounce branch (their pending text still updates `pendingText` and
      // is picked up by whichever timer runs first).
      this.hasSentFirst = true;
      // Phase 54: emit first_visible_token span on the FIRST editFn
      // invocation. Span ends synchronously — its duration captures only the
      // scheduling cost from editor construction to first visible edit. The
      // emit is wrapped in try/catch so trace-setup races never propagate.
      if (!this.firstVisibleTokenEmitted) {
        this.firstVisibleTokenEmitted = true;
        try {
          const span = this.turn?.startSpan("first_visible_token", {});
          try {
            span?.end();
          } catch {
            /* non-fatal */
          }
        } catch {
          /* non-fatal */
        }
      }
      // Opt-in min-visibility hold: if `firstEditMinDelayMs > 0` and the
      // remaining time has not yet elapsed since editor construction, defer
      // the first edit through the same `this.timer` field used by the
      // subsequent-debounce branch. Default 0 → preserves the pre-existing
      // "first chunk fires immediately" path verbatim.
      const elapsed = Date.now() - this.createdAt;
      const remaining = this.firstEditMinDelayMs - elapsed;
      if (remaining > 0) {
        this.timer = setTimeout(() => {
          this.timer = null;
          if (this.pendingText !== null && !this.disposed) {
            const text = this.truncate(this.pendingText);
            this.pendingText = null;
            void this.invokeEditFn(text);
          }
        }, remaining);
        return;
      }
      const text = this.truncate(accumulated);
      this.pendingText = null;
      void this.invokeEditFn(text);
      return;
    }

    // Subsequent chunks: schedule a throttled edit if none pending
    if (this.timer === null) {
      this.timer = setTimeout(() => {
        this.timer = null;
        if (this.pendingText !== null && !this.disposed) {
          const text = this.truncate(this.pendingText);
          this.pendingText = null;
          void this.invokeEditFn(text);
        }
      }, this.editIntervalMs);
    }
  }

  /**
   * Phase 100-fu — serialize editFn invocations through an in-flight promise
   * chain. Returns the promise representing this call so flush() (which
   * awaits the editFn directly today) keeps the same await semantics.
   *
   * Errors from `editFn` are routed to `handleEditError` exactly as before
   * (the prior `.catch` arm). Errors from a *previous* call are awaited but
   * NOT re-thrown — they were already handled by their own catch arm; we
   * only care about ordering, not error propagation between calls.
   */
  private invokeEditFn(text: string): Promise<void> {
    const previous = this.inFlight;
    const next = (async () => {
      if (previous) {
        try {
          await previous;
        } catch {
          /* drained — prior call already handled its own error */
        }
      }
      try {
        await this.editFn(text);
      } catch (err) {
        this.handleEditError(err);
      }
    })();
    this.inFlight = next;
    return next;
  }

  /**
   * Phase 54 — handle editFn rejections. On a Discord rate-limit error,
   * DOUBLE the editIntervalMs for the rest of this editor's lifetime (one
   * turn). Emit a single pino.WARN on the FIRST hit so downstream log volume
   * stays bounded. Non-rate-limit rejections are silently swallowed to
   * preserve the pre-plan non-fatal edit behavior.
   */
  private handleEditError(err: unknown): void {
    if (!isDiscordRateLimitError(err)) {
      // Non-rate-limit: silent swallow (matches pre-plan non-fatal behavior).
      return;
    }
    const prev = this.editIntervalMs;
    this.editIntervalMs = prev * 2;
    if (!this.rateLimitWarnEmitted) {
      this.rateLimitWarnEmitted = true;
      this.log?.warn(
        {
          agent: this.agent,
          turnId: this.turnId,
          original_ms: prev,
          backoff_ms: this.editIntervalMs,
          error:
            err && typeof err === "object" && "message" in err
              ? String((err as { message: unknown }).message)
              : String(err),
        },
        "Discord rate-limit detected — doubling editIntervalMs for rest of turn",
      );
    }
  }

  /**
   * Send the final accumulated text immediately, cancelling any pending timer.
   */
  async flush(): Promise<void> {
    if (this.disposed) return;

    // Cancel pending timer
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    // Phase 141 — ALWAYS drain the in-flight edit, even when pendingText is
    // null. The bridge's final v3 delivery edits the message via a DIRECT
    // v3EditFn(response) call that BYPASSES this serialization chain — without
    // this drain a trailing in-flight progress edit could land AFTER the final
    // answer and clobber it. Draining makes the post-flush sequence
    // deterministic.
    if (this.inFlight) {
      try {
        await this.inFlight;
      } catch {
        /* drained — prior call already handled its own error */
      }
    }

    if (this.pendingText !== null) {
      const text = this.truncate(this.pendingText);
      this.pendingText = null;
      // Phase 100-fu — go through the serialization lock so flush() waits
      // for any in-flight edit before sending the final text. Preserves the
      // original "await editFn" semantics for callers awaiting flush().
      await this.invokeEditFn(text);
    }
  }

  /**
   * Cancel any pending timer without sending. Use in error paths.
   */
  dispose(): void {
    this.disposed = true;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.pendingText = null;
  }

  /**
   * Truncate text to maxLength, appending "..." if over limit.
   */
  private truncate(text: string): string {
    if (text.length <= this.maxLength) {
      return text;
    }
    return text.slice(0, this.maxLength - 3) + "...";
  }
}
