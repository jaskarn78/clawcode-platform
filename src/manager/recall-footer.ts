/**
 * Phase 999.124 — memory-recall visibility footer.
 *
 * WHY. The pre-turn retrieval (Phase 90 MEM-03) silently puts a
 * `<memory-context>` block in front of the model every few turns. The
 * operator never sees WHAT was recalled, so a reply shaped by a stale or
 * wrong memory reads like a hallucination, and a reply that ignored a good
 * memory reads like forgetfulness. The advisor footer solved the same
 * problem for consultations; this is the same pattern for recall: one
 * italic line under the reply, an itemised block in verbose channels.
 *
 * Pure. The turn dispatcher records a `RecallRecord` when its retrieval
 * fires; the Discord bridge consumes it single-shot at the footer mutation
 * point and appends the rendered text.
 */

import { retrievalResultDate, type MemoryRetrievalResult } from "../memory/memory-retrieval.js";

export interface RecalledMemory {
  readonly id: string;
  /** ISO timestamp when the memory was saved; absent for legacy rows. */
  readonly createdAt?: string;
  /** First line of the memory, trimmed for the verbose block. */
  readonly snippet: string;
}

export interface RecalledNote {
  /** Basename of the file (MEMORY.md) or the document slug. */
  readonly path: string;
  readonly heading: string | null;
  /** WP2: ISO file mtime (or document ingest time); absent when unknown. */
  readonly date?: string;
}

export interface RecallRecord {
  /** Epoch ms when the retrieval ran; the bridge ignores stale records. */
  readonly at: number;
  readonly memories: readonly RecalledMemory[];
  readonly notes: readonly RecalledNote[];
  readonly documents: readonly RecalledNote[];
}

/** A record older than this is never appended (the turn it belonged to is gone). */
export const RECALL_FOOTER_TTL_MS = 10 * 60 * 1000;
const SNIPPET_MAX = 90;
const VERBOSE_MAX_LINES = 8;

function snippetOf(body: string): string {
  const line =
    body
      .split("\n")
      .map((l) => l.replace(/^#+\s*/, "").replace(/[`*_]/g, "").trim())
      .find((l) => l.length > 0) ?? "";
  return line.length > SNIPPET_MAX ? `${line.slice(0, SNIPPET_MAX - 1).trimEnd()}…` : line;
}

function basename(path: string): string {
  const stripped = path.replace(/^document:/, "");
  const idx = stripped.lastIndexOf("/");
  return idx === -1 ? stripped : stripped.slice(idx + 1);
}

/** Summarise what the retrieval put in front of the model. */
export function summarizeRecall(
  chunks: readonly MemoryRetrievalResult[],
  now: number = Date.now(),
): RecallRecord {
  const memories: RecalledMemory[] = [];
  const notes: RecalledNote[] = [];
  const documents: RecalledNote[] = [];
  for (const c of chunks) {
    if (c.source === "memory") {
      memories.push(
        Object.freeze({
          id: c.chunkId,
          ...(c.createdAt ? { createdAt: c.createdAt } : {}),
          snippet: snippetOf(c.body),
        }),
      );
    } else {
      // WP2: notes and documents carry their file date too.
      const date = retrievalResultDate(c);
      const note = Object.freeze({
        path: basename(c.path),
        heading: c.heading,
        ...(date ? { date } : {}),
      });
      if (c.path.startsWith("document:")) documents.push(note);
      else notes.push(note);
    }
  }
  return Object.freeze({
    at: now,
    memories: Object.freeze(memories),
    notes: Object.freeze(notes),
    documents: Object.freeze(documents),
  });
}

function fmtDate(iso: string, now: number): string | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const sameYear = d.getFullYear() === new Date(now).getFullYear();
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
  });
}

/** " (Jun 12 to Aug 30)", " (Jun 12)", or "" when none of `isos` parses. */
function dateRange(isos: readonly (string | undefined)[], now: number): string {
  const times = isos
    .map((iso) => (iso ? new Date(iso).getTime() : NaN))
    .filter((t) => !Number.isNaN(t));
  if (times.length === 0) return "";
  const lo = fmtDate(new Date(Math.min(...times)).toISOString(), now);
  const hi = fmtDate(new Date(Math.max(...times)).toISOString(), now);
  if (!lo || !hi) return "";
  return lo === hi ? ` (${lo})` : ` (${lo} to ${hi})`;
}

/** "(Jun 12 to Aug 30)", "(Jun 12)", or "" when no memory carries a date. */
export function recallDateRange(record: RecallRecord, now: number = Date.now()): string {
  return dateRange(record.memories.map((m) => m.createdAt), now);
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/**
 * The one-line footer. Empty string when nothing was recalled. Each count
 * is followed by its own date range; WP2 (2026-10-25) added the ranges for
 * notes and documents (file dates), which earlier results never carried.
 */
export function recallFooterLine(record: RecallRecord, now: number = Date.now()): string {
  const parts: string[] = [];
  if (record.memories.length > 0) {
    parts.push(`${plural(record.memories.length, "memory", "memories")}${recallDateRange(record, now)}`);
  }
  if (record.notes.length > 0) {
    parts.push(`${plural(record.notes.length, "note", "notes")}${dateRange(record.notes.map((n) => n.date), now)}`);
  }
  if (record.documents.length > 0) {
    parts.push(
      `${plural(record.documents.length, "document", "documents")}${dateRange(record.documents.map((d) => d.date), now)}`,
    );
  }
  if (parts.length === 0) return "";
  return `*— recalled ${parts.join(", ")}*`;
}

/** The itemised block for verbose channels. */
export function recallVerboseBlock(record: RecallRecord, now: number = Date.now()): string {
  const lines: string[] = [];
  for (const m of record.memories) {
    const date = m.createdAt ? fmtDate(m.createdAt, now) : null;
    lines.push(`• ${date ? `${date}: ` : ""}${m.snippet || m.id}`);
  }
  for (const n of [...record.notes, ...record.documents]) {
    const date = n.date ? fmtDate(n.date, now) : null;
    lines.push(`• ${date ? `${date}: ` : ""}${n.path}${n.heading ? ` › ${n.heading}` : ""}`);
  }
  const shown = lines.slice(0, VERBOSE_MAX_LINES);
  if (lines.length > VERBOSE_MAX_LINES) shown.push(`• … and ${lines.length - VERBOSE_MAX_LINES} more`);
  return "```\n🧠 recalled\n" + shown.join("\n").replace(/```/g, "'''") + "\n```";
}

/**
 * What the bridge appends to the reply: the line (normal), or the line
 * plus the block (verbose). Starts with the same blank-line separator the
 * advisor and steered footers use. Empty when nothing was recalled.
 */
export function renderRecallFooter(
  record: RecallRecord,
  level: "normal" | "verbose",
  now: number = Date.now(),
): string {
  const line = recallFooterLine(record, now);
  if (!line) return "";
  return level === "verbose"
    ? `\n\n${line}\n${recallVerboseBlock(record, now)}`
    : `\n\n${line}`;
}
