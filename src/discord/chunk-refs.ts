/**
 * 999.63d/4 — chunk-level message refs for long (chunked) deliveries:
 * the "wall killer".
 *
 * A >2000-char agent response is delivered as N webhook (or bot) chunks
 * whose message ids were historically discarded, so a financial
 * correction could only POST a follow-up note — the 2026-08-26 13:05
 * "wall" incident. This module retains per-chunk refs (EXACT wire text +
 * message id) and, at correction time, plans a minimal set of in-place
 * chunk edits:
 *
 *   1. Re-derive the original chunks from the runner's pre-footer draft
 *      using the SAME transform the webhook leg used
 *      (`formatOutboundText` → `splitMessage`).
 *   2. Locate the latest consecutive run of stored refs matching those
 *      chunks byte-for-byte (the LAST chunk tolerates an appended
 *      suffix — delivery-time footers land there).
 *   3. Re-derive the PATCHED chunks; require the chunk count to be
 *      unchanged; edit ONLY the chunks whose text differs, appending the
 *      correction footer to the last edited chunk.
 *
 * ALL-OR-NOTHING: any mismatch (no matching run, chunk-count change,
 * oversize edit, suffix that does not look like an appended footer)
 * returns null and the caller falls back to the compact note. A wrong
 * in-place edit is strictly worse than a posted note.
 *
 * PURE (store + planner): no discord.js, no I/O, no Date — callers own
 * time and delivery.
 */

import { splitMessage } from "./webhook-manager.js";
import { formatOutboundText } from "./markdown-table-wrap.js";
import { MAX_EDIT_LENGTH } from "./correction-edit.js";

/** One delivered chunk of a multi-chunk response. */
export interface ChunkRef {
  readonly messageId: string;
  readonly channelId: string;
  readonly kind: "webhook" | "bot";
  /** EXACT wire text sent (post-format, post-split). */
  readonly text: string;
  /** ms-epoch at delivery. */
  readonly at: number;
}

/** Refs older than this are prune-on-touch. */
export const CHUNK_REF_MAX_AGE_MS = 2 * 60 * 60 * 1000;

/** Per-agent retention cap (~80 chunks ≈ 40k chars of ring buffer). */
export const CHUNK_REF_MAX_PER_AGENT = 80;

/**
 * Bounded, age-pruned per-agent ring of delivered chunk refs, in
 * delivery order (append-only within a delivery; oldest evicted first).
 */
export class ChunkRefStore {
  private readonly byAgent = new Map<string, ChunkRef[]>();

  record(agentName: string, refs: readonly ChunkRef[]): void {
    if (refs.length === 0) return;
    const now = refs[refs.length - 1]?.at ?? 0;
    const existing = this.byAgent.get(agentName) ?? [];
    const cutoff = now - CHUNK_REF_MAX_AGE_MS;
    const merged = [...existing.filter((r) => r.at >= cutoff), ...refs];
    while (merged.length > CHUNK_REF_MAX_PER_AGENT) merged.shift();
    this.byAgent.set(agentName, merged);
  }

  /** Age-pruned snapshot, delivery order. */
  refsFor(agentName: string, now: number): readonly ChunkRef[] {
    const existing = this.byAgent.get(agentName) ?? [];
    const cutoff = now - CHUNK_REF_MAX_AGE_MS;
    const fresh = existing.filter((r) => r.at >= cutoff);
    if (fresh.length !== existing.length) this.byAgent.set(agentName, fresh);
    return fresh;
  }
}

/** One planned in-place chunk edit. */
export interface ChunkEdit {
  readonly messageId: string;
  readonly channelId: string;
  readonly kind: "webhook" | "bot";
  readonly text: string;
}

export interface ChunkEditPlan {
  readonly edits: readonly ChunkEdit[];
  /** The last edited chunk's message — gets the 🔎 reaction. */
  readonly reactMessageId: string;
  readonly reactChannelId: string;
}

/**
 * Plan the minimal chunk edits for a correction against a chunked
 * delivery. Returns null whenever the edit cannot be PROVEN safe.
 */
export function planChunkEdits(args: {
  readonly refs: readonly ChunkRef[];
  /** The gate's pre-footer draft snapshot (runner args.response). */
  readonly originalResponse: string;
  /** The patched full text (ops already applied to the raw draft). */
  readonly correctedText: string;
  /** Correction footer, appended to the LAST edited chunk. */
  readonly footer: string;
}): ChunkEditPlan | null {
  const { refs, originalResponse, correctedText, footer } = args;
  if (refs.length === 0) return null;

  const origChunks = splitMessage(
    formatOutboundText(originalResponse),
    MAX_EDIT_LENGTH,
  );
  const newChunks = splitMessage(
    formatOutboundText(correctedText),
    MAX_EDIT_LENGTH,
  );
  // The positional diff only works when the chunking shape is unchanged.
  if (newChunks.length !== origChunks.length) return null;
  const n = origChunks.length;
  if (n === 0 || refs.length < n) return null;

  // Locate the LATEST consecutive run of refs matching origChunks.
  // Chunks 0..n-2 must match byte-for-byte; the last chunk tolerates an
  // appended suffix (delivery-time footers), which must be either empty
  // or newline-led (footer-shaped) — anything else is a foreign edit.
  let runStart = -1;
  let lastSuffix = "";
  outer: for (let s = refs.length - n; s >= 0; s--) {
    for (let k = 0; k < n - 1; k++) {
      if (refs[s + k]?.text !== origChunks[k]) continue outer;
    }
    const lastRef = refs[s + n - 1];
    const lastOrig = origChunks[n - 1] ?? "";
    if (!lastRef || !lastRef.text.startsWith(lastOrig)) continue;
    const suffix = lastRef.text.slice(lastOrig.length);
    if (suffix.length > 0 && !suffix.startsWith("\n")) continue;
    // All chunks of one delivery share a channel.
    const channelId = refs[s]?.channelId;
    let sameChannel = true;
    for (let k = 0; k < n; k++) {
      if (refs[s + k]?.channelId !== channelId) sameChannel = false;
    }
    if (!sameChannel) continue;
    runStart = s;
    lastSuffix = suffix;
    break;
  }
  if (runStart === -1) return null;

  // Build the minimal edit set.
  const changed: number[] = [];
  for (let k = 0; k < n; k++) {
    if (newChunks[k] !== origChunks[k]) changed.push(k);
  }
  if (changed.length === 0) return null;
  const lastChanged = changed[changed.length - 1]!;

  const edits: ChunkEdit[] = [];
  for (const k of changed) {
    const ref = refs[runStart + k]!;
    let text = newChunks[k] ?? "";
    if (k === n - 1) text += lastSuffix;
    if (k === lastChanged) text += `\n\n${footer}`;
    if (text.length > MAX_EDIT_LENGTH) return null;
    edits.push({
      messageId: ref.messageId,
      channelId: ref.channelId,
      kind: ref.kind,
      text,
    });
  }
  const reactRef = refs[runStart + lastChanged]!;
  return {
    edits: Object.freeze(edits),
    reactMessageId: reactRef.messageId,
    reactChannelId: reactRef.channelId,
  };
}
