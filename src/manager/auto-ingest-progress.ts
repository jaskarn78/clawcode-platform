/**
 * P2-PROGRESS — edit-in-place ingest-progress tracker.
 *
 * When an agent receives a burst of >=2 attachments, the bridge seeds ONE
 * Discord message ("📥 Ingesting 0/N files…") and this tracker edits it in
 * place as each file finishes ("k/N" → "✅ Ingested N/N files"). Pure logic +
 * a DI'd editor — no Discord import, so it is fully unit-testable.
 *
 * Decisions (locked with the operator):
 *  - EDIT-ONLY: never posts a second message; the final state is an EDIT to ✅
 *    (Discord edits don't push-notify; accepted to keep the channel un-flooded).
 *  - Threshold >=2 attachments (the bridge gates; we double-guard).
 *
 * Correctness:
 *  - The batch is created SYNCHRONOUSLY at seed so an early onItemDone (the
 *    queue can drain item 1 before the seed's channel.send resolves) is counted.
 *  - Items with empty channelId/messageId (rescan-recovered) and items for an
 *    unknown/finalized batch are ignored.
 *  - An inactivity timer finalizes a partial batch (overflow-deferred items
 *    ingest later via rescan and never reach this batch, so `done` can stall
 *    below `total`) and doubles as TTL eviction so the map can't grow unbounded.
 *  - All editor calls are best-effort; failures are swallowed + logged.
 */

import type { Logger } from "pino";

/**
 * Minimal editor surface — `ProgressiveMessageEditor` satisfies this
 * structurally. NOTE: `flush()` takes NO argument — it cancels the pending
 * throttle timer and sends the LATEST `update()` text. So to render a final
 * line you must `update(finalText)` THEN `flush()` (see finalize()).
 */
export interface ProgressEditor {
  /** Set the message to `text` (throttled / coalesced by the editor). */
  update(text: string): void;
  /** Cancel the pending throttle timer and send the latest `update()` text. */
  flush(): Promise<void>;
}

export type AutoIngestProgressDeps = {
  readonly logger: Logger;
  /** Inactivity finalize / TTL window. Default 45s. */
  readonly idleTimeoutMs?: number;
};

/** Per-Discord-message ingest batch. */
type Batch = {
  readonly total: number;
  done: number;
  /** Phase 999.154 — optional first line (turn-vision receipt). */
  headline: string | null;
  /** Phase 999.154 — items the queue deferred (full) — retried by the rescan. */
  deferred: number;
  readonly editor: ProgressEditor;
  finalized: boolean;
  timer: ReturnType<typeof setTimeout> | null;
};

const DEFAULT_IDLE_TIMEOUT_MS = 45_000;
const TAG = "p2-auto-ingest-progress";

function seedText(done: number, total: number): string {
  return `📥 Ingesting ${done}/${total} files…`;
}
function render(batch: {
  readonly done: number;
  readonly total: number;
  readonly headline: string | null;
  readonly deferred: number;
}): string {
  const lines: string[] = [];
  if (batch.headline) lines.push(batch.headline);
  lines.push(seedText(batch.done, batch.total));
  if (batch.deferred > 0) {
    lines.push(`⏳ ${batch.deferred} waiting — ingest queue full; picked up automatically within 10 min`);
  }
  return lines.join("\n");
}
function doneText(done: number, total: number): string {
  return done >= total
    ? `✅ Ingested ${total}/${total} files`
    : `✅ Ingested ${done}/${total} files (rest queued — finishing in the background)`;
}

export class AutoIngestProgress {
  private readonly log: Logger;
  private readonly idleTimeoutMs: number;
  private readonly batches = new Map<string, Batch>();

  constructor(deps: AutoIngestProgressDeps) {
    this.log = deps.logger;
    this.idleTimeoutMs = deps.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  }

  private key(channelId: string, messageId: string): string {
    return `${channelId}:${messageId}`;
  }

  /**
   * Begin tracking a burst. Called by the bridge at dispatch time when
   * `total >= 2` AND the agent has auto-ingest enabled. `editor` is bound to the
   * channel + a freshly-posted progress message.
   */
  seedBatch(
    channelId: string,
    messageId: string,
    total: number,
    editor: ProgressEditor,
  ): void {
    if (total < 2 || !channelId || !messageId) return;
    const key = this.key(channelId, messageId);
    if (this.batches.has(key)) return; // dup seed — ignore
    const batch: Batch = {
      total,
      done: 0,
      headline: null,
      deferred: 0,
      editor,
      finalized: false,
      timer: null,
    };
    this.batches.set(key, batch);
    this.safeUpdate(batch, render(batch));
    this.armTimer(key, batch);
  }

  /** Phase 999.154 — set the receipt headline on a live batch (no-op otherwise). */
  setHeadline(channelId: string, messageId: string, headline: string): void {
    const batch = this.batches.get(this.key(channelId, messageId));
    if (!batch || batch.finalized) return;
    batch.headline = headline;
    this.safeUpdate(batch, render(batch));
  }

  /**
   * Phase 999.154 — the queue was full and deferred an item to disk. Surface it
   * instead of leaving a silent gap until the 10-minute rescan.
   */
  noteDeferred(channelId: string, messageId: string): void {
    const batch = this.batches.get(this.key(channelId, messageId));
    if (!batch || batch.finalized) return;
    batch.deferred += 1;
    this.safeUpdate(batch, render(batch));
  }

  /** One drained item. Ignores empty ids and unknown/finalized batches. */
  onItemDone(event: {
    readonly channelId: string;
    readonly messageId: string;
    readonly ok: boolean;
  }): void {
    if (!event.channelId || !event.messageId) return;
    const key = this.key(event.channelId, event.messageId);
    const batch = this.batches.get(key);
    if (!batch || batch.finalized) return;
    // Count processed regardless of ok (never-drop retries failures via rescan).
    batch.done += 1;
    if (batch.done >= batch.total) {
      this.finalize(key, batch);
      return;
    }
    this.safeUpdate(batch, render(batch));
    this.armTimer(key, batch);
  }

  private armTimer(key: string, batch: Batch): void {
    if (batch.timer) clearTimeout(batch.timer);
    batch.timer = setTimeout(() => {
      // Inactivity backstop: deferred items never arrive on the live queue.
      this.finalize(key, batch);
    }, this.idleTimeoutMs);
    // Don't keep the process alive just for a progress timer.
    batch.timer.unref?.();
  }

  private finalize(key: string, batch: Batch): void {
    if (batch.finalized) return;
    batch.finalized = true;
    if (batch.timer) {
      clearTimeout(batch.timer);
      batch.timer = null;
    }
    this.batches.delete(key);
    // Set the ✅ line as the pending text, THEN flush — flush() cancels the
    // pending throttle timer and sends the latest update() (it takes no arg),
    // so the message deterministically ends at ✅ and a coalesced "k/N" can't
    // land after it.
    this.safeUpdate(
      batch,
      batch.headline
        ? `${batch.headline}\n${doneText(batch.done, batch.total)}`
        : doneText(batch.done, batch.total),
    );
    void batch.editor.flush().catch((err) => {
      this.log.warn(
        { tag: TAG, key, err: err instanceof Error ? err.message : String(err) },
        "auto-ingest progress final edit failed (ignored)",
      );
    });
  }

  private safeUpdate(batch: Batch, text: string): void {
    try {
      batch.editor.update(text);
    } catch (err) {
      this.log.warn(
        { tag: TAG, err: err instanceof Error ? err.message : String(err) },
        "auto-ingest progress edit failed (ignored)",
      );
    }
  }

  /** Diagnostics only. */
  get activeBatches(): number {
    return this.batches.size;
  }

  /** Clear all timers + state (shutdown / tests). */
  dispose(): void {
    for (const batch of this.batches.values()) {
      if (batch.timer) clearTimeout(batch.timer);
    }
    this.batches.clear();
  }
}
