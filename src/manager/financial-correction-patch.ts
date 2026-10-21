/**
 * 999.63/B (token optimization, 2026-08-26) — pure patch-op parsing and
 * application for the financial-verification corrective hop.
 *
 * The hop's PATCH_OUTPUT_CONTRACT asks for a fenced ```json block of
 * minimal find/replace ops (plus a citation per op) instead of a full
 * regenerated message. This module owns:
 *
 *   - `parsePatchOps`   — tolerant extraction/validation of the ops array
 *                         from the model reply (fenced block preferred,
 *                         bare JSON array accepted; null on anything else).
 *   - `applyPatchOps`   — ALL-OR-NOTHING application: ops run in order
 *                         against the evolving text, each replacing the
 *                         FIRST occurrence of its `find`; any op whose
 *                         `find` is absent fails the whole patch (null).
 *                         Partial application is worse than none — a
 *                         half-corrected message reads as fully corrected.
 *   - `renderCorrectionNote` — compact fallback rendering ("old → new
 *                         (source)" lines) for the post path when the
 *                         patched full text cannot be delivered.
 *
 * PURE: no I/O, no logging, no Date. Side effects stay in the runner /
 * bridge shells (house pure-core + shell shape).
 */

/** One surgical correction operation from the corrective hop. */
export interface CorrectionPatchOp {
  /** Exact text copied from the original draft (string-matched). */
  readonly find: string;
  /** Corrected replacement text (may be empty = deletion). */
  readonly replace: string;
  /** Citation that verifies the correction (URL or document name). */
  readonly source: string;
}

/**
 * 999.63d/4 compact-note caps. The first rendering quoted full find/
 * replace spans (120/160 chars each) — three ops produced a "wall"
 * (2026-08-26 13:05 incident, operator veto). The note is now a GLANCE
 * summary: tight snippets, source reduced to its domain, at most
 * `NOTE_MAX_OPS` lines plus an "…and N more", hard total cap. The full
 * detail lives in the transcript, not the channel.
 */
export const NOTE_FIND_MAX_CHARS = 40;
export const NOTE_REPLACE_MAX_CHARS = 50;
export const NOTE_MAX_OPS = 3;
export const NOTE_TOTAL_MAX_CHARS = 500;

/**
 * Extract the first fenced code block's body (```json ... ``` or a bare
 * ``` ... ``` fence). Returns null when no fence is present.
 */
function extractFencedBlock(reply: string): string | null {
  const match = /```(?:json)?\s*\n?([\s\S]*?)```/.exec(reply);
  return match ? match[1] : null;
}

/**
 * Parse the corrective reply into validated patch ops.
 *
 * Accepts (in order): the first fenced ```json block; a reply that is
 * itself a bare JSON array. Anything else — prose, malformed JSON, wrong
 * shapes, an EMPTY array (an empty patch is not a correction; the
 * sentinel is the no-correction channel) — returns null and the caller
 * falls back to raw-reply handling.
 *
 * `source` is tolerated missing/non-string (normalized to "") — a
 * citation-less op still patches; the citation quality is a telemetry /
 * review concern, not a delivery gate.
 */
export function parsePatchOps(
  reply: string,
): readonly CorrectionPatchOp[] | null {
  const body = extractFencedBlock(reply) ?? reply;
  const trimmed = body.trim();
  if (!trimmed.startsWith("[")) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length === 0) return null;
  const ops: CorrectionPatchOp[] = [];
  for (const entry of parsed) {
    if (typeof entry !== "object" || entry === null) return null;
    const op = entry as Record<string, unknown>;
    if (typeof op.find !== "string" || op.find.length === 0) return null;
    if (typeof op.replace !== "string") return null;
    ops.push({
      find: op.find,
      replace: op.replace,
      source: typeof op.source === "string" ? op.source : "",
    });
  }
  return Object.freeze(ops);
}

/**
 * Apply ops in order against the evolving text (op N+1 matches against
 * the output of op N), replacing the FIRST occurrence of each `find`.
 * ALL-OR-NOTHING: any op with zero matches returns null — the caller
 * must fall back rather than deliver a partially corrected message.
 */
export function applyPatchOps(
  original: string,
  ops: readonly CorrectionPatchOp[],
): string | null {
  let text = original;
  for (const op of ops) {
    const at = text.indexOf(op.find);
    if (at === -1) return null;
    text = text.slice(0, at) + op.replace + text.slice(at + op.find.length);
  }
  return text;
}

const truncate = (s: string, max: number): string =>
  s.length <= max ? s : `${s.slice(0, max - 1)}…`;

const collapseWhitespace = (s: string): string =>
  s.replace(/\s+/g, " ").trim();

/** Max chars for each side of the changed span in a note line. */
export const NOTE_SPAN_MAX_CHARS = 60;
const DIFF_CONTEXT_WORDS = 3;
/** Leading list/subtext decoration that must not count as "changed". */
const DECOR_RE = /^\s*(?:-#\s*|[-*•]\s+|\d+[.)]\s+)?(?:\*\*)?/;

export interface DiffSpan {
  readonly before: string;
  readonly old: string;
  readonly neu: string;
  readonly after: string;
  readonly clippedStart: boolean;
  readonly clippedEnd: boolean;
}

/**
 * Word-level minimal difference between `find` and `replace`: the common
 * prefix and suffix are context (≤ DIFF_CONTEXT_WORDS each side), the middle
 * is the change. Pure.
 */
export function diffSpan(find: string, replace: string): DiffSpan {
  const a = collapseWhitespace(find.replace(DECOR_RE, "")).split(" ").filter(Boolean);
  const b = collapseWhitespace(replace.replace(DECOR_RE, "")).split(" ").filter(Boolean);
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  let s = 0;
  while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
  return {
    before: a.slice(Math.max(0, p - DIFF_CONTEXT_WORDS), p).join(" "),
    old: a.slice(p, a.length - s).join(" "),
    neu: b.slice(p, b.length - s).join(" "),
    after: a.slice(a.length - s, a.length - s + DIFF_CONTEXT_WORDS).join(" "),
    clippedStart: p > DIFF_CONTEXT_WORDS,
    clippedEnd: s > DIFF_CONTEXT_WORDS,
  };
}

/**
 * Reduce a citation to its glanceable label: URL → bare hostname
 * (www-stripped); non-URL (a document name) → tight truncation.
 */
function sourceLabel(source: string): string {
  const s = source.trim();
  if (s.length === 0) return "";
  try {
    return new URL(s).hostname.replace(/^www\./, "");
  } catch {
    return truncate(s, 30);
  }
}

/**
 * Compact human-readable rendering of the ops for the fallback POST path
 * (used when the patched text cannot be edited in place — single-message
 * ref gone AND chunk-edit not provable). GLANCE-sized by design (see the
 * caps doc above): tight snippets, domain-only sources, ≤ NOTE_MAX_OPS
 * lines + an "…and N more" tail, NOTE_TOTAL_MAX_CHARS hard cap. Never a
 * wall.
 */
export function renderCorrectionNote(
  ops: readonly CorrectionPatchOp[],
  prefix: string,
): string {
  // 2026-08-28 — show the CHANGE, not the strings. The old rendering clipped
  // both spans at 40/50 chars, so a one-word count fix inside a long line
  // shipped as "Rocket Lab - the closest thing to a min… → Rocket Lab - the
  // closest thing to a mini SpaceX, …" three times over. Now: the differing
  // words with three words of context each side, and identical changes
  // merged ("(3 places)").
  const merged: Array<{ line: string; count: number; src: string }> = [];
  for (const op of ops) {
    const d = diffSpan(op.find, op.replace);
    const src = sourceLabel(op.source);
    // Same change in the same context merges; the same words changed in a
    // different sentence stay separate lines.
    const key = `${d.old}\u0000${d.neu}\u0000${d.before}\u0000${d.after}`;
    const hit = merged.find((m) => m.line === key);
    if (hit) hit.count++;
    else merged.push({ line: key, count: 1, src });
  }
  const shown = merged.slice(0, NOTE_MAX_OPS);
  const lines = shown.map((m) => {
    const [oldRaw, newRaw, beforeRaw, afterRaw] = m.line.split("\u0000") as [string, string, string, string];
    const d: DiffSpan = ops
      .map((o) => diffSpan(o.find, o.replace))
      .find((x) => x.old === oldRaw && x.neu === newRaw && x.before === beforeRaw && x.after === afterRaw)!;
    const oldT = d.old.length > 0 ? truncate(d.old, NOTE_SPAN_MAX_CHARS) : "(nothing)";
    const newT = d.neu.length > 0 ? truncate(d.neu, NOTE_SPAN_MAX_CHARS) : "(removed)";
    const before = d.before.length > 0 ? `${d.clippedStart ? "…" : ""}${d.before} ` : "";
    const after = d.after.length > 0 ? ` ${d.after}${d.clippedEnd ? "…" : ""}` : "";
    const places = m.count > 1 ? ` (${m.count} places)` : "";
    return `• ${before}${oldT} → ${newT}${after}${places}${m.src.length > 0 ? ` (${m.src})` : ""}`;
  });
  if (merged.length > NOTE_MAX_OPS) {
    lines.push(`…and ${merged.length - NOTE_MAX_OPS} more`);
  }
  const note = `${prefix}${lines.join("\n")}`;
  return note.length <= NOTE_TOTAL_MAX_CHARS
    ? note
    : `${note.slice(0, NOTE_TOTAL_MAX_CHARS - 1)}…`;
}
