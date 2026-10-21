/**
 * UX-A (2026-08-26, Client A trust program) — superseded-document share marking.
 *
 * The Vallejos incident shipped three wrong document versions before the
 * corrected v4/v5 landed, and nothing marked the stale copies: an operator
 * scrolling back could grab a superseded PDF with wrong claims in it. This
 * store remembers the last Discord share message per (agent, document) so
 * that when a NEWER version of the same document is shared, the previous
 * share message can be edited to carry a superseded banner.
 *
 * Pure module (no discord.js, no Date.now) — the daemon's share-file IPC
 * handler owns the single instance and performs the actual message edit.
 * Same house shape as DeliveredMessageRefStore (999.63c).
 */

/** Prepended to a superseded share message's content. */
export const SUPERSEDED_BANNER = "⚠️ *superseded by a newer version below*";

/** Shares older than this are not worth marking (prune-on-write/read). */
export const SHARED_DOC_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** Defensive cap — oldest entries evicted first (Map insertion order). */
export const SHARED_DOC_MAX_ENTRIES = 200;

export interface SharedDocRef {
  readonly messageId: string;
  readonly channelId: string;
  /**
   * The exact content string the share message was posted with (already
   * formatOutboundText-wrapped caption, or "" for caption-less shares).
   * Kept so the superseding edit can recompose the message without a
   * Discord fetch: `SUPERSEDED_BANNER + "\n" + content`.
   */
  readonly content: string;
  /** ms-epoch at share time, for age pruning. */
  readonly at: number;
}

/**
 * Normalized store key: same agent + same document name (case-insensitive,
 * final extension stripped) ⇒ same logical document. `report-v2.pdf` and
 * `report-v2.PDF` collide by design; `report-v2.pdf` and `report-v3.pdf`
 * do NOT — versioned FILENAMES are distinct documents to us, so the
 * common prod pattern (same filename re-shared after revision) is the one
 * this targets.
 */
export function sharedDocKey(agentName: string, filename: string): string {
  const base = filename.toLowerCase().replace(/\.[^./\\]+$/, "");
  return `${agentName}:${base}`;
}

/**
 * Bounded, age-pruned store of the latest share message per document key.
 *
 * `record` returns the DISPLACED previous ref (fresh entries only) so the
 * caller can mark it superseded — write-wins-latest, single previous.
 */
export class SharedDocRefStore {
  private readonly refs = new Map<string, SharedDocRef>();

  record(key: string, ref: SharedDocRef): SharedDocRef | undefined {
    this.prune(ref.at);
    const prev = this.refs.get(key);
    // Re-insert so Map insertion order tracks recency for the size cap.
    this.refs.delete(key);
    this.refs.set(key, ref);
    if (this.refs.size > SHARED_DOC_MAX_ENTRIES) {
      const oldest = this.refs.keys().next().value;
      if (oldest !== undefined) this.refs.delete(oldest);
    }
    if (!prev) return undefined;
    if (ref.at - prev.at > SHARED_DOC_MAX_AGE_MS) return undefined;
    return prev;
  }

  get size(): number {
    return this.refs.size;
  }

  private prune(now: number): void {
    const cutoff = now - SHARED_DOC_MAX_AGE_MS;
    for (const [key, ref] of this.refs) {
      if (ref.at < cutoff) this.refs.delete(key);
    }
  }
}

/** Composed replacement body for a superseded share message. */
export function supersededContent(prev: SharedDocRef): string {
  return prev.content.length > 0
    ? `${SUPERSEDED_BANNER}\n${prev.content}`
    : SUPERSEDED_BANNER;
}
