/**
 * Phase 999.154 WS-5 — remove the fake vision "analysis" stored 2026-05-19 ..
 * 2026-09-22 (the bridge dropped every image; Haiku's "I don't see an image"
 * reply was stored as if it were analysis).
 *
 * Surgical: only two shapes are edited, and only when their body matches the
 * refusal sentinel —
 *   <screenshot-analysis> …refusal… </screenshot-analysis>   (turn text → memories, conversation_turns)
 *   ## Chart shape analysis …refusal…                          (document_chunks, memory_chunks)
 * Everything else in a row is kept byte-for-byte. Edited rows are re-embedded
 * (every vector table the row already had a vector in) so search stops
 * matching the refusal wording. Image documents classified in the window get
 * their class recomputed without the refusal text that steered it.
 *
 * DRY-RUN BY DEFAULT. `apply` first writes a full `db.backup()` and aborts if
 * the backup fails. Rows that still read as refusals but match neither shape
 * are REPORTED, never auto-edited.
 */

import { basename } from "node:path";
import type { Database as DatabaseType } from "better-sqlite3";
import { isTruncatedRefusal, isVisionRefusal } from "./refusal-sentinel.js";
import { classifyAttachment, type ContentClass } from "../documents/auto-ingest-classifier.js";
import { inferMimeType } from "../manager/auto-ingest-queue.js";

/** First fake analysis observed in prod (2026-09-22 read-only scan). */
export const CONTAMINATION_WINDOW_START = "2026-05-19T00:00:00.000Z";

const CONTENT_WEIGHT: Readonly<Record<ContentClass, number>> = { high: 1.5, medium: 1.0, low: 0.5 };
const EMBED_BATCH = 32;
const SAMPLE_CHARS = 160;

export type CleanupEmbedder = (
  texts: readonly string[],
  includeV1: boolean,
) => Promise<{ readonly v1: Float32Array[] | null; readonly v2: Int8Array[] }>;

export type TableReport = {
  readonly table: string;
  readonly scanned: number;
  readonly changed: number;
  readonly emptied: number;
  /** Still refusal-shaped after stripping — left for manual review. */
  readonly residual: number;
};

export type CleanupReport = {
  readonly dbPath: string;
  readonly applied: boolean;
  readonly backupPath: string | null;
  readonly tables: readonly TableReport[];
  readonly reclassified: number;
  readonly samples: ReadonlyArray<{ readonly table: string; readonly id: string; readonly removed: string }>;
};

const SCREENSHOT_BLOCK = /\n?<screenshot-analysis>\s*([\s\S]*?)\s*<\/screenshot-analysis>/g;
// Header followed by its body up to the next markdown header or end. The chunker
// may have flattened newlines to spaces, so whitespace is matched loosely.
const CHART_BLOCK = /\s*##\s*Chart shape analysis\s*([\s\S]*?)(?=\s##\s|$)/g;

/** Strip refusal-bodied vision blocks. Returns the cleaned text and what was removed. */
export function stripFakeVision(text: string): { readonly cleaned: string; readonly removed: string[] } {
  const removed: string[] = [];
  const replaceIfRefusal = (block: string, body: string): string => {
    if (!isVisionRefusal(body) && !isTruncatedRefusal(body)) return block;
    removed.push(block.trim());
    return "";
  };
  const cleaned = text
    .replace(SCREENSHOT_BLOCK, (block, body: string) => replaceIfRefusal(block, body))
    .replace(CHART_BLOCK, (block, body: string) => replaceIfRefusal(block, body));
  return { cleaned: removed.length > 0 ? cleaned.trimEnd() : text, removed };
}

type Edit = { readonly id: string; readonly before: string; readonly after: string; readonly removed: string[] };

function tableExists(db: DatabaseType, name: string): boolean {
  return (
    db.prepare("SELECT 1 FROM sqlite_master WHERE name = ? AND type IN ('table','view')").get(name) !==
    undefined
  );
}

function scan(
  db: DatabaseType,
  table: string,
  idCol: string,
  textCol: string,
): { readonly edits: Edit[]; readonly report: TableReport } {
  if (!tableExists(db, table)) {
    return { edits: [], report: { table, scanned: 0, changed: 0, emptied: 0, residual: 0 } };
  }
  const rows = db
    .prepare(
      `SELECT ${idCol} AS id, ${textCol} AS text FROM ${table}
       WHERE ${textCol} LIKE '%screenshot-analysis%' OR ${textCol} LIKE '%Chart shape analysis%'
          OR ${textCol} LIKE '%see an image%' OR ${textCol} LIKE '%provide the image%'`,
    )
    .all() as Array<{ id: string | number; text: string }>;
  const edits: Edit[] = [];
  let residual = 0;
  for (const r of rows) {
    const { cleaned, removed } = stripFakeVision(r.text);
    if (removed.length > 0) edits.push({ id: String(r.id), before: r.text, after: cleaned, removed });
    if (isVisionRefusal(cleaned) && /screenshot-analysis|Chart shape analysis/.test(cleaned)) residual++;
  }
  return {
    edits,
    report: {
      table,
      scanned: rows.length,
      changed: edits.length,
      emptied: edits.filter((e) => e.after.trim().length === 0).length,
      residual,
    },
  };
}

function int8Bytes(v: Int8Array): Buffer {
  return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
}

async function embedAll(
  embed: CleanupEmbedder,
  texts: readonly string[],
  includeV1: boolean,
): Promise<{ v1: Float32Array[] | null; v2: Int8Array[] }> {
  const v1: Float32Array[] = [];
  const v2: Int8Array[] = [];
  for (let i = 0; i < texts.length; i += EMBED_BATCH) {
    const r = await embed(texts.slice(i, i + EMBED_BATCH), includeV1);
    if (includeV1 && r.v1) v1.push(...r.v1);
    v2.push(...r.v2);
  }
  return { v1: includeV1 ? v1 : null, v2 };
}

function hasRow(db: DatabaseType, table: string, keyCol: string, id: string): boolean {
  return tableExists(db, table) && db.prepare(`SELECT 1 FROM ${table} WHERE ${keyCol} = ?`).get(id) !== undefined;
}

/** Image documents classified inside the window without structured vision. */
function planReclassify(db: DatabaseType): Array<{ source: string; cls: ContentClass }> {
  if (!tableExists(db, "documents")) return [];
  const cols = new Set(
    (db.prepare("PRAGMA table_info(documents)").all() as Array<{ name: string }>).map((c) => c.name),
  );
  if (!cols.has("source_image_path")) return [];
  const visionFilter = cols.has("vision_json") ? "AND vision_json IS NULL" : "";
  const rows = db
    .prepare(
      `SELECT source, auto_classified_class AS cls FROM documents
       WHERE source_image_path IS NOT NULL AND override_class IS NULL
         AND ingested_at >= ? ${visionFilter}`,
    )
    .all(CONTAMINATION_WINDOW_START) as Array<{ source: string; cls: ContentClass }>;
  const out: Array<{ source: string; cls: ContentClass }> = [];
  for (const r of rows) {
    const filename = basename(r.source).replace(/^\d+-/, "");
    const cls = classifyAttachment({
      filename,
      mimeType: inferMimeType(filename) ?? "image/png",
      size: 0,
    }).contentClass;
    if (cls !== r.cls) out.push({ source: r.source, cls });
  }
  return out;
}

export async function cleanupVisionContamination(
  db: DatabaseType,
  opts: {
    readonly apply: boolean;
    readonly embed: CleanupEmbedder;
    readonly backupPath: string;
    readonly nowIso?: () => string;
  },
): Promise<CleanupReport> {
  const nowIso = opts.nowIso ?? (() => new Date().toISOString());
  const memories = scan(db, "memories", "id", "content");
  const turns = scan(db, "conversation_turns", "id", "content");
  const docChunks = scan(db, "document_chunks", "id", "content");
  const memChunks = scan(db, "memory_chunks", "id", "body");
  const reclassify = planReclassify(db);

  const samples = [memories, turns, docChunks, memChunks].flatMap((t) =>
    t.edits.slice(0, 2).map((e) => ({
      table: t.report.table,
      id: e.id,
      removed: e.removed.join(" ⏎ ").slice(0, SAMPLE_CHARS),
    })),
  );
  const base = {
    dbPath: db.name,
    tables: [memories.report, turns.report, docChunks.report, memChunks.report],
    reclassified: reclassify.length,
    samples,
  };
  const total =
    memories.edits.length + turns.edits.length + docChunks.edits.length + memChunks.edits.length + reclassify.length;
  if (!opts.apply || total === 0) return { ...base, applied: false, backupPath: null };

  // Backup FIRST — no write happens unless the copy is complete.
  await db.backup(opts.backupPath);

  // Embeddings are computed before the write transaction (async), then
  // written atomically with the text they belong to.
  const memNeedsV1 = memories.edits.some((e) => hasRow(db, "vec_memories", "memory_id", e.id));
  const memVecs = await embedAll(opts.embed, memories.edits.map((e) => e.after), memNeedsV1);
  const liveDocChunks = docChunks.edits.filter((e) => e.after.trim().length > 0);
  const docVecs = await embedAll(opts.embed, liveDocChunks.map((e) => e.after), false);
  const liveMemChunks = memChunks.edits.filter((e) => e.after.trim().length > 0);
  const memChunkVecs = await embedAll(opts.embed, liveMemChunks.map((e) => e.after), true);

  const now = nowIso();
  db.transaction(() => {
    memories.edits.forEach((e, i) => {
      db.prepare("UPDATE memories SET content = ?, updated_at = ? WHERE id = ?").run(e.after, now, e.id);
      if (memVecs.v1 && hasRow(db, "vec_memories", "memory_id", e.id)) {
        db.prepare("DELETE FROM vec_memories WHERE memory_id = ?").run(e.id);
        db.prepare("INSERT INTO vec_memories (memory_id, embedding) VALUES (?, ?)").run(e.id, memVecs.v1[i]!);
      }
      if (hasRow(db, "vec_memories_v2", "memory_id", e.id)) {
        db.prepare("DELETE FROM vec_memories_v2 WHERE memory_id = ?").run(e.id);
        db.prepare("INSERT INTO vec_memories_v2 (memory_id, embedding) VALUES (?, vec_int8(?))").run(
          e.id,
          int8Bytes(memVecs.v2[i]!),
        );
      }
    });

    // conversation_turns_fts follows via the AFTER UPDATE trigger.
    for (const e of turns.edits) {
      db.prepare("UPDATE conversation_turns SET content = ? WHERE id = ?").run(e.after, e.id);
    }

    for (const e of docChunks.edits) {
      db.prepare("DELETE FROM vec_document_chunks WHERE chunk_id = ?").run(e.id);
      if (e.after.trim().length === 0) {
        db.prepare("DELETE FROM document_chunks WHERE id = ?").run(e.id);
      }
    }
    liveDocChunks.forEach((e, i) => {
      db.prepare("UPDATE document_chunks SET content = ? WHERE id = ?").run(e.after, e.id);
      db.prepare("INSERT INTO vec_document_chunks (chunk_id, embedding) VALUES (?, vec_int8(?))").run(
        e.id,
        int8Bytes(docVecs.v2[i]!),
      );
    });

    for (const e of memChunks.edits) {
      const hadV1 = hasRow(db, "vec_memory_chunks", "chunk_id", e.id);
      const hadV2 = hasRow(db, "vec_memory_chunks_v2", "chunk_id", e.id);
      db.prepare("DELETE FROM vec_memory_chunks WHERE chunk_id = ?").run(e.id);
      if (tableExists(db, "vec_memory_chunks_v2")) {
        db.prepare("DELETE FROM vec_memory_chunks_v2 WHERE chunk_id = ?").run(e.id);
      }
      const heading = (
        db.prepare("SELECT heading FROM memory_chunks WHERE id = ?").get(e.id) as { heading: string | null } | undefined
      )?.heading ?? null;
      db.prepare("DELETE FROM memory_chunks_fts WHERE chunk_id = ?").run(e.id);
      if (e.after.trim().length === 0) {
        db.prepare("DELETE FROM memory_chunks WHERE id = ?").run(e.id);
        continue;
      }
      const i = liveMemChunks.indexOf(e);
      db.prepare("UPDATE memory_chunks SET body = ? WHERE id = ?").run(e.after, e.id);
      db.prepare("INSERT INTO memory_chunks_fts (chunk_id, heading, body) VALUES (?, ?, ?)").run(e.id, heading, e.after);
      if (hadV1 && memChunkVecs.v1) {
        db.prepare("INSERT INTO vec_memory_chunks (chunk_id, embedding) VALUES (?, ?)").run(e.id, memChunkVecs.v1[i]!);
      }
      if (hadV2) {
        db.prepare("INSERT INTO vec_memory_chunks_v2 (chunk_id, embedding) VALUES (?, vec_int8(?))").run(
          e.id,
          int8Bytes(memChunkVecs.v2[i]!),
        );
      }
    }

    for (const r of reclassify) {
      db.prepare(
        "UPDATE documents SET auto_classified_class = ?, content_priority_weight = ? WHERE source = ?",
      ).run(r.cls, CONTENT_WEIGHT[r.cls], r.source);
    }
  })();

  return { ...base, applied: true, backupPath: opts.backupPath };
}
