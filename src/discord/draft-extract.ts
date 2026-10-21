/**
 * Draft extraction — a client-facing draft (email, text, message, script)
 * arrives as its OWN Discord message so it can be long-pressed and copied
 * verbatim. Operator (2026-08-28): "the message drafts should always arrive as
 * a separate discord message so that it's ready to be copy/pasted."
 *
 * Contract with the model (SOUL): put the draft, and nothing else, inside a
 * fenced block whose info string is `draft`:
 *
 *     ```draft
 *     Happy Friday Steven! Quick FYI, ...
 *     ```
 *
 * The daemon removes every such block from the reply and posts each one as a
 * separate plain message — no fence, no header, no annotations — AFTER the
 * analysis. Anything the model wrote around the fence ("Draft below.") stays
 * in the analysis. Pure.
 */

export const DRAFT_FENCE_RE = /^[ \t]*```[ \t]*(draft|email|text|sms|message)[^\n]*\n([\s\S]*?)^[ \t]*```[ \t]*$/gim;

export interface DraftExtraction {
  /** The reply with every draft block removed (surrounding blank lines collapsed). */
  readonly text: string;
  /** Draft bodies in document order, trimmed, fence and info string removed. */
  readonly drafts: readonly string[];
}

export const DRAFT_MAX_CHARS = 2000;

/**
 * A line that only introduces the draft ("Birthday draft, in their voice:",
 * "Draft below:") is a label for content that has left the message; keep it
 * and it dangles. Only a line IMMEDIATELY above a draft fence qualifies.
 */
const LEAD_IN_RE = /(^|\n)[ \t]*(?:\*\*)?[^\n]{0,80}?\b(?:draft|below|voice|message|email|text|note)\b[^\n]{0,40}:[ \t]*(?:\*\*)?[ \t]*\n+(?=[ \t]*```[ \t]*(?:draft|email|text|sms|message))/gi;
// 2026-08-28 — a SHORT introducer ending with a period ("Draft below.",
// "Here's the text.") is a lead-in too; a real sentence that merely mentions
// a message is not, so the period form is capped at ~40 chars.
const LEAD_IN_SHORT_RE = /(^|\n)[ \t]*(?:\*\*)?[^\n]{0,24}?\b(?:draft|below|voice|message|email|text|note)\b[^\n]{0,12}\.[ \t]*(?:\*\*)?[ \t]*\n+(?=[ \t]*```[ \t]*(?:draft|email|text|sms|message))/gi;

/** What the channel delivers as the body when a reply was ONLY a draft. */
export const DRAFT_ONLY_BODY = "Draft below.";

export function extractDrafts(text: string): DraftExtraction {
  if (!text || !text.includes("```")) return { text, drafts: [] };
  const drafts: string[] = [];
  const withoutLeadIns = text.replace(LEAD_IN_RE, "$1").replace(LEAD_IN_SHORT_RE, "$1");
  const stripped = withoutLeadIns.replace(DRAFT_FENCE_RE, (_m, _lang: string, body: string) => {
    // 999.178 R1 — the whole draft body is kept verbatim (no 2000-char cut).
    // A draft too long for one Discord message is split at delivery by
    // `splitDraftForDelivery` into clean copy-paste pieces; truncating here
    // silently dropped the tail of a birthday card / client email. Callers
    // that DIFF drafts (correction-edit) still see one entry per fence.
    const d = body.replace(/^\n+|\s+$/g, "");
    if (d.length > 0) drafts.push(d);
    return "";
  });
  if (drafts.length === 0) return { text, drafts: [] };
  const cleaned = stripped.replace(/\n{3,}/g, "\n\n").replace(/\s+$/, "").replace(/^\n+/, "");
  return { text: cleaned, drafts };
}

/**
 * 999.178 R1 — split ONE draft into consecutive delivery pieces, each within
 * the Discord per-message limit, WITHOUT truncating. A draft is client-facing
 * copy (an email / text / message body the user long-presses and pastes), so the
 * split prefers boundaries a reader copies across cleanly:
 *   1. paragraph breaks (blank lines) — fenced code blocks stay intact;
 *   2. sentence ends, when a single paragraph is itself over the limit;
 *   3. a hard character cut, only when a single sentence is over the limit.
 *
 * The pieces carry NO labels, icons or continuation markers — they stay
 * pristine for copy-paste (the module contract). A continuation hint, if ever
 * wanted, belongs on the analysis lead-in or a separate `-#` subtext line, not
 * inside the draft; for a long email the cleanest paste is just its paragraphs
 * in order, so nothing is injected between pieces.
 *
 * Pure and dependency-free (no formatter import): pieces are ≤ maxChars on the
 * RAW text. Delivery sites still pass each piece through the outbound
 * table-aware splitter as a safety net, so a piece that GROWS during
 * `formatOutboundText` (a raw table gaining a ```text``` fence) is re-split
 * rather than rejected by Discord.
 */
export function splitDraftForDelivery(
  body: string,
  maxChars: number = DRAFT_MAX_CHARS,
): readonly string[] {
  const trimmed = body.replace(/\s+$/, "");
  if (trimmed.length <= maxChars) return trimmed.length > 0 ? [trimmed] : [];
  const pieces: string[] = [];
  let current = "";
  const flush = (): void => {
    if (current.length > 0) pieces.push(current);
    current = "";
  };
  for (const block of splitIntoBlocks(trimmed)) {
    if (block.length > maxChars) {
      // A single paragraph / fenced block bigger than one message: close the
      // accumulator, then break it at sentence (and last-resort char) bounds.
      flush();
      for (const sub of splitOverlongBlock(block, maxChars)) pieces.push(sub);
      continue;
    }
    const joined = current.length === 0 ? block : `${current}\n\n${block}`;
    if (joined.length <= maxChars) current = joined;
    else {
      flush();
      current = block;
    }
  }
  flush();
  return pieces;
}

/**
 * Split text into paragraph-ish blocks on blank lines, keeping a fenced code
 * block (```…```) whole even when it spans blank lines. Blocks are rejoined by
 * the caller with a single blank line (canonical paragraph separator).
 */
function splitIntoBlocks(text: string): string[] {
  const blocks: string[] = [];
  let buf: string[] = [];
  let inFence = false;
  const flush = (): void => {
    const joined = buf.join("\n").replace(/^\n+|\n+$/g, "");
    if (joined.trim().length > 0) blocks.push(joined);
    buf = [];
  };
  for (const line of text.split("\n")) {
    if (/^[ \t]*```/.test(line)) inFence = !inFence;
    if (!inFence && line.trim() === "") {
      flush();
      continue;
    }
    buf.push(line);
  }
  flush();
  return blocks;
}

/** A block over the limit: pack whole sentences, hard-split a giant sentence. */
function splitOverlongBlock(block: string, maxChars: number): string[] {
  const out: string[] = [];
  let buf = "";
  const push = (): void => {
    if (buf.length > 0) out.push(buf);
    buf = "";
  };
  for (const sentence of splitIntoSentences(block)) {
    if (sentence.length > maxChars) {
      push();
      for (const chunk of hardSplit(sentence, maxChars)) out.push(chunk);
      continue;
    }
    // Sentences already carry their trailing whitespace, so concatenation
    // reproduces the block; no separator is inserted.
    if (buf.length + sentence.length <= maxChars) buf += sentence;
    else {
      push();
      buf = sentence;
    }
  }
  push();
  return out.map((s) => s.replace(/\s+$/, "")).filter((s) => s.length > 0);
}

/**
 * Segment text at sentence ends (`.`/`!`/`?` before whitespace) and hard
 * newlines, INCLUDING the trailing whitespace in each segment so concatenating
 * the segments reproduces the input.
 */
function splitIntoSentences(text: string): string[] {
  const segments = text.match(/[\s\S]*?(?:[.!?]+(?=\s)\s*|\n+|$)/g);
  return (segments ?? [text]).filter((s) => s.length > 0);
}

/** Last resort: cut a single over-long segment into fixed-size pieces. */
function hardSplit(segment: string, maxChars: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < segment.length; i += maxChars) {
    out.push(segment.slice(i, i + maxChars));
  }
  return out;
}
