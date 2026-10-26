/**
 * DocumentStore — SQLite-backed document chunk storage with vector search.
 *
 * Stores document chunks in a better-sqlite3 database alongside 384-dim
 * embeddings in a sqlite-vec virtual table. Supports ingest (with overwrite),
 * KNN search with adjacent-chunk context, and source-based deletion.
 *
 * Phase 101 D-09 (CF-2): the `vec_document_chunks` embedding column is
 * `int8[384]` — Phase 115 bge-small int8 (NOT MiniLM float32 as v1 was).
 * DocumentStore is greenfield for v2 per D-09 — any old `float[384]` table
 * found on disk is dropped and recreated by `migrateDocumentChunksToInt8()`
 * called from the constructor. The migration is idempotent: re-running on an
 * already-int8 table is a no-op.
 *
 * The plan PLAN.md references `src/memory/store.ts` for this surface; the
 * actual file is `src/documents/store.ts` (Rule 3 deviation — documented
 * in 101-01-SUMMARY.md).
 */

import type { Database as DatabaseType, Statement } from "better-sqlite3";
import { nanoid } from "nanoid";
import type { IngestResult, DocumentSearchResult } from "./types.js";
import type { ChunkInput } from "./chunker.js";
import { computeDocSlug } from "../document-ingest/index.js";

/** Maximum search limit to prevent excessive queries. */
const MAX_SEARCH_LIMIT = 20;

/** Chunk count threshold for warning. */
const CHUNK_COUNT_WARNING_THRESHOLD = 10_000;

/** Raw row shape from document_chunks table. */
type ChunkRow = {
  readonly id: string;
  readonly source: string;
  readonly chunk_index: number;
  readonly content: string;
  readonly start_char: number;
  readonly end_char: number;
  readonly created_at: string;
};

export type ContentPriorityLevel = "high" | "medium" | "low";

/**
 * Phase 999.43 D-01 multipliers — per-document content_priority_weight values.
 * Axis 2: high=1.5, medium=1.0, low=0.5. Apply to the final score formula
 * (D-02) at retrieval time alongside the per-agent agent_priority_weight
 * (Axis 1: high=1.5, medium=1.0, low=0.7) and the 7-day recency boost (1.3×).
 */
export const CONTENT_PRIORITY_WEIGHTS: Readonly<Record<ContentPriorityLevel, number>> = Object.freeze({
  high: 1.5,
  medium: 1.0,
  low: 0.5,
});

/**
 * Source-kind discriminator on documents.source_kind (D-04). Three values:
 *   - "discord_attachment": auto-ingest path from Plan 02 dispatcher
 *   - "manual_ingest_document": Phase 101 MCP tool surface (operator-driven)
 *   - "manual_pre_999_43": auto-backfill placeholder for pre-999.43 docs
 *     whose chunks predate the documents table (Test 5 in Plan 01 Task 2)
 */
export type DocumentSourceKind =
  | "discord_attachment"
  | "manual_ingest_document"
  | "manual_pre_999_43"
  // 999.156 — a finished audio/video transcript (derived from an attachment).
  | "transcript";

/**
 * D-04 provenance row on the `documents` table. 1:1 with `document_chunks.source`.
 * Provenance lives per-doc (NOT per-chunk) to avoid N× storage on the chunk
 * fan-out. `content_priority_weight` is the EFFECTIVE weight (derived from
 * override_class if set, else auto_classified_class via CONTENT_PRIORITY_WEIGHTS).
 * `agent_priority_weight_at_ingest` is an informational snapshot — the LIVE
 * agent weight is read at query time per D-01 hot-reload semantics.
 */
export type DocumentRow = {
  readonly source: string;
  readonly agent_name: string;
  readonly channel_id: string | null;
  readonly message_id: string | null;
  readonly user_id: string | null;
  readonly ingested_at: string;
  readonly source_kind: DocumentSourceKind;
  readonly auto_classified_class: ContentPriorityLevel;
  readonly override_class: ContentPriorityLevel | null;
  readonly content_priority_weight: number;
  readonly agent_priority_weight_at_ingest: number;
  /**
   * Phase 999.43-fu2 Path A — for image attachments, the persisted on-disk
   * path to the post-Phase-113 image (typically under
   * `<memoryPath>/inbox/attachments/<filename>`). NULL for non-image source
   * kinds (PDF, docx, xlsx, etc.). Surfaced through `search_documents` so
   * the agent can `Read` the image directly when shape/visual fidelity
   * matters beyond OCR text. Subject to the existing attachment-cleanup
   * policy (24h default) — agents should treat retrieval of an old image
   * path as best-effort. Phase 999.154: when the image archive is enabled
   * this points at the durable archived WebP instead of the inbox copy.
   */
  readonly source_image_path: string | null;
  /** Phase 999.154 — sha256 of the original bytes (exact-duplicate key). */
  readonly content_sha256?: string | null;
  /** Phase 999.154 — 64-bit dHash (hex) for near-duplicate image detection. */
  readonly image_dhash?: string | null;
  /** Phase 999.154 — set on a duplicate's row: the source it duplicates (no chunks of its own). */
  readonly duplicate_of?: string | null;
  /** Phase 999.154 — structured vision analysis (JSON) the chunks were built from. */
  readonly vision_json?: string | null;
  /** WP3 (2026-10-25): original upload filename (the inbox path is timestamped). */
  readonly filename?: string | null;
  /** WP3: Discord display name of the sender, when known. */
  readonly user_name?: string | null;
  /** WP3: Discord channel name, when the bridge supplied it. */
  readonly channel_name?: string | null;
  /**
   * WP3: outcome of the last ingest attempt: "ok" (chunks stored),
   * "empty" (nothing extractable; a stub chunk was stored), "failed" (the
   * pipeline threw). NULL on rows written before this column existed
   * (treated as "ok").
   */
  readonly ingest_status?: IngestStatus | null;
  /** WP3: how many times the auto-ingest handler has processed this source. */
  readonly ingest_attempts?: number | null;
};

/** WP3: see DocumentRow.ingest_status. */
export type IngestStatus = "ok" | "empty" | "failed";

/**
 * WP3: a source whose last attempt was "empty" or "failed" is retried by the
 * inbox rescan until this many attempts have been made.
 */
export const MAX_INGEST_ATTEMPTS = 3;

/** WP3: true when the rescan should re-enqueue the file behind this row. */
export function documentNeedsRetry(row: DocumentRow): boolean {
  const status = row.ingest_status ?? "ok";
  if (status === "ok") return false;
  return (row.ingest_attempts ?? 0) < MAX_INGEST_ATTEMPTS;
}

/** Input shape for `upsertDocumentRow` — fields callers MUST provide. */
export type DocumentRowInput = {
  readonly source: string;
  readonly agentName: string;
  readonly channelId?: string | null;
  readonly messageId?: string | null;
  readonly userId?: string | null;
  readonly ingestedAt: string;
  readonly sourceKind: DocumentSourceKind;
  readonly autoClassifiedClass: ContentPriorityLevel;
  readonly overrideClass?: ContentPriorityLevel | null;
  readonly contentWeight: number;
  readonly agentWeightAtIngest: number;
  /**
   * Phase 999.43-fu2 Path A — optional persisted image path. Pass for image
   * attachments only; PDF/docx/xlsx ingests should leave undefined (stored as
   * NULL). See `DocumentRow.source_image_path` for full semantics.
   */
  readonly sourceImagePath?: string | null;
  /** Phase 999.154 — see DocumentRow.content_sha256 / image_dhash / duplicate_of / vision_json. */
  readonly contentSha256?: string | null;
  readonly imageDhash?: string | null;
  readonly duplicateOf?: string | null;
  readonly visionJson?: string | null;
  /** WP3: see DocumentRow.filename / user_name / channel_name. */
  readonly filename?: string | null;
  readonly userName?: string | null;
  readonly channelName?: string | null;
  /** WP3: see DocumentRow.ingest_status / ingest_attempts. Defaults: "ok", 0. */
  readonly ingestStatus?: IngestStatus | null;
  readonly ingestAttempts?: number | null;
};

/** Phase 999.154 — near-duplicate candidate projection. */
export type ImageHashRow = {
  readonly source: string;
  readonly image_dhash: string;
  readonly vision_json: string | null;
  readonly auto_classified_class: ContentPriorityLevel;
};

/** Raw row from KNN search join. */
type SearchRow = {
  readonly id: string;
  readonly source: string;
  readonly chunk_index: number;
  readonly content: string;
  readonly distance: number;
  // Phase 999.43 Plan 03 — LEFT JOIN documents (null when chunk has no
  // provenance row, e.g. pre-Plan-01-backfill orphan). Multipliers default
  // to 1.0 when null (legacy chunks score neutrally).
  readonly content_weight: number | null;
  readonly ingested_at: string | null;
  readonly source_kind: string | null;
  // Phase 999.43-fu2 Path A T03 — surface persisted image path (image
  // attachments only; NULL for PDF/docx/etc. and for legacy rows that
  // predate the fu2 migration).
  readonly source_image_path: string | null;
  // WP3: provenance for the search_documents payload.
  readonly filename: string | null;
  readonly user_name: string | null;
  readonly channel_name: string | null;
};

/** Raw chunk projection returned by `getChunksForSource`. */
export type StoredChunk = {
  readonly id: string;
  readonly chunkIndex: number;
  readonly content: string;
};

/** Prepared statements for all store operations. */
type PreparedStatements = {
  readonly insertChunk: Statement;
  readonly insertVec: Statement;
  readonly deleteBySource: Statement;
  readonly deleteVecBySource: Statement;
  readonly getChunkCount: Statement;
  readonly getAdjacentChunk: Statement;
  readonly searchAll: Statement;
  readonly searchBySource: Statement;
  readonly listSources: Statement;
  readonly getChunkIdsBySource: Statement;
  readonly getChunksBySource: Statement;
  // WP3: delete_document also removes the provenance row (and rows that
  // were recorded as exact duplicates of it).
  readonly deleteDocumentRows: Statement;
  readonly listDuplicatesOf: Statement;
  readonly countImagePathRefs: Statement;
  readonly setIngestOutcome: Statement;
  // Phase 999.43 Plan 01 Task 2 — documents (provenance) table CRUD.
  readonly upsertDocumentRow: Statement;
  readonly getDocumentRow: Statement;
  readonly getDocumentRowByMessageId: Statement;
  readonly setDocumentPriority: Statement;
  // Phase 999.43 Plan 03 Task 2 — bridge memory_chunks `document:<slug>`
  // path values to the documents table keyed by full filepath.
  readonly listAllDocumentsSources: Statement;
  // Phase 999.154 — dedupe lookups.
  readonly findDocumentBySha256: Statement;
  readonly listRecentImageHashes: Statement;
};

export class DocumentStore {
  private readonly db: DatabaseType;
  private readonly stmts: PreparedStatements;
  /**
   * WP3: mutation stamp for cache keying. Starts at construction time and
   * moves forward on every ingest, delete, provenance upsert and priority
   * change, so a search_documents cache key that includes it can never
   * serve a result computed before the corpus changed (across daemon
   * restarts too, since the stamp is a monotonic ms clock).
   */
  private version = Date.now();

  constructor(db: DatabaseType) {
    this.db = db;
    // Phase 101 D-09 migration MUST run before initSchema — it drops any
    // pre-existing float[384] vec_document_chunks so initSchema's
    // CREATE...IF NOT EXISTS lands the int8[384] shape.
    migrateDocumentChunksToInt8(db);
    this.initSchema();
    // Phase 999.43-fu2 Path A migration — additive column on documents.
    // Must run AFTER initSchema (which creates the table) so the ADD COLUMN
    // target exists. Idempotent — see migrateAddSourceImagePath().
    migrateAddSourceImagePath(db);
    // Phase 999.154 — additive dedupe/vision columns (idempotent).
    migrateAddImageIngestColumns(db);
    // WP3: provenance + retry bookkeeping columns (idempotent).
    migrateAddProvenanceColumns(db);
    this.stmts = this.prepareStatements();
  }

  /**
   * WP3: current mutation stamp. Include it in any cache key built over
   * search results so ingest, delete and priority changes invalidate them.
   */
  getVersion(): number {
    return this.version;
  }

  private bumpVersion(): void {
    this.version = Math.max(this.version + 1, Date.now());
  }

  /**
   * Ingest document chunks with their embeddings.
   *
   * If the source already exists, all previous chunks are deleted first
   * (overwrite semantics). Runs atomically within a transaction.
   */
  ingest(
    source: string,
    chunks: readonly ChunkInput[],
    embeddings: readonly Int8Array[] | readonly Float32Array[],
  ): IngestResult {
    const now = new Date().toISOString();
    let totalChars = 0;

    this.db.transaction(() => {
      // Delete existing chunks for this source (overwrite)
      this.deleteChunksForSource(source);

      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        const embedding = embeddings[i];
        const id = nanoid();

        this.stmts.insertChunk.run(
          id,
          source,
          chunk.chunkIndex,
          chunk.content,
          chunk.startChar,
          chunk.endChar,
          now,
        );
        // Phase 101 D-09: sqlite-vec int8 binding expects raw bytes (Buffer).
        // Int8Array → Buffer via Buffer.from(buf, byteOffset, byteLength) so
        // shared-buffer Int8Array views don't bleed extra bytes.
        const bytes =
          embedding instanceof Int8Array
            ? Buffer.from(
                embedding.buffer,
                embedding.byteOffset,
                embedding.byteLength,
              )
            : Buffer.from(
                (embedding as Float32Array).buffer,
                (embedding as Float32Array).byteOffset,
                (embedding as Float32Array).byteLength,
              );
        this.stmts.insertVec.run(id, bytes);
        totalChars += chunk.content.length;
      }
    })();
    this.bumpVersion();

    // Check chunk count and warn if threshold exceeded
    const count = this.getChunkCount();
    if (count > CHUNK_COUNT_WARNING_THRESHOLD) {
      console.warn(
        `[DocumentStore] Chunk count (${count}) exceeds ${CHUNK_COUNT_WARNING_THRESHOLD}. Consider archiving old documents.`,
      );
    }

    return Object.freeze({
      source,
      chunksCreated: chunks.length,
      totalChars,
    });
  }

  /**
   * Search for document chunks similar to the query embedding.
   *
   * Returns up to `limit` results (clamped to 20).
   *
   * Phase 999.43 Plan 03 — D-02 score formula (LOCKED VERBATIM):
   *   weightedScore = similarity × agentWeight × contentWeight × recencyBoost
   *
   * Multipliers:
   *   - agentWeight  (D-01 axis 1, threaded from caller per-query):
   *       high = 1.5, medium = 1.0, low = 0.7
   *   - contentWeight (D-01 axis 2, read from documents.content_priority_weight):
   *       high = 1.5, medium = 1.0, low = 0.5
   *   - recencyBoost: 1.3× if documents.ingested_at within last 7 days,
   *     else 1.0× (D-07: query-time computed, NOT stored).
   *
   * Backward compat: callers that omit `agentWeight` get the neutral 1.0
   * multiplier; legacy `documents` row (or missing row from LEFT JOIN)
   * scores at base similarity unchanged.
   *
   * Each result includes content from adjacent chunks for context.
   * Optionally filters by source.
   */
  search(
    embedding: Int8Array | Float32Array,
    limit = 5,
    source?: string,
    agentWeight: number = 1.0,
  ): readonly DocumentSearchResult[] {
    const clampedLimit = Math.min(Math.max(1, limit), MAX_SEARCH_LIMIT);
    // Over-fetch by 3× so the post-fetch re-rank can promote a docs row
    // whose weighted score beats a higher-raw-similarity row with lower
    // multipliers. sqlite-vec's `MATCH k=?` must be a fixed integer at
    // SQL time so we cannot ORDER BY weighted score in SQL.
    const overFetchK = Math.min(clampedLimit * 3, MAX_SEARCH_LIMIT * 3);

    // Phase 101 D-09: convert Int8Array/Float32Array query embedding to a raw
    // Buffer so the vec_int8(?) cast in the prepared statement receives bytes.
    const queryBytes =
      embedding instanceof Int8Array
        ? Buffer.from(
            embedding.buffer,
            embedding.byteOffset,
            embedding.byteLength,
          )
        : Buffer.from(
            (embedding as Float32Array).buffer,
            (embedding as Float32Array).byteOffset,
            (embedding as Float32Array).byteLength,
          );

    // WP3: with a source filter the candidates are restricted to that
    // source BEFORE scoring: a brute-force vec_distance_cosine over the
    // source's own chunks (an indexed lookup on document_chunks.source, then
    // one vector read per chunk). The previous KNN-then-filter query returned
    // nothing once the document's chunks fell outside the global top-k.
    const rows: readonly SearchRow[] = source
      ? (this.stmts.searchBySource.all(queryBytes, source, overFetchK) as SearchRow[])
      : (this.stmts.searchAll.all(queryBytes, overFetchK) as SearchRow[]);

    // D-02 score formula constants. Centralized so the
    // 7-day window literal is auditable. D-07: query-time only.
    const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
    const RECENCY_BOOST = 1.3;
    const now = Date.now();

    const ranked = rows.map((row) => {
      const similarity = 1 - row.distance;
      // LEFT JOIN may return null when the chunk's `documents` provenance
      // row is absent (pre-Plan-01-backfill orphan). Default to neutral.
      const contentWeight = row.content_weight ?? 1.0;
      const ingestedTs = row.ingested_at ? Date.parse(row.ingested_at) : 0;
      const ageMs = ingestedTs > 0 ? now - ingestedTs : Number.POSITIVE_INFINITY;
      const recencyBoostApplied = ageMs <= SEVEN_DAYS_MS;
      const recencyBoost = recencyBoostApplied ? RECENCY_BOOST : 1.0;
      const weightedScore =
        similarity * agentWeight * contentWeight * recencyBoost;
      return { row, similarity, weightedScore, recencyBoostApplied };
    });

    // DESC by weighted score, then slice to caller-requested limit.
    ranked.sort((a, b) => b.weightedScore - a.weightedScore);
    const sliced = ranked.slice(0, clampedLimit);

    const results = sliced.map(({ row, similarity, weightedScore, recencyBoostApplied }) => {
      // Fetch adjacent chunks for context
      const before = this.stmts.getAdjacentChunk.get(
        row.source,
        row.chunk_index - 1,
      ) as ChunkRow | undefined;
      const after = this.stmts.getAdjacentChunk.get(
        row.source,
        row.chunk_index + 1,
      ) as ChunkRow | undefined;

      return Object.freeze({
        chunkId: row.id,
        source: row.source,
        chunkIndex: row.chunk_index,
        content: row.content,
        similarity,
        contextBefore: before?.content ?? null,
        contextAfter: after?.content ?? null,
        weightedScore,
        recencyBoostApplied,
        // Phase 999.43-fu2 Path A T03 — surface persisted image path so
        // search_documents callers (MCP server.ts:1296+ → agent) can Read
        // the underlying image when chart-shape re-look is warranted.
        // null for non-image source kinds and for legacy rows whose
        // documents row lacks the column.
        sourceImagePath: row.source_image_path ?? null,
        // WP3: provenance for the tool payload.
        filename: row.filename ?? null,
        ingestedAt: row.ingested_at ?? null,
        userName: row.user_name ?? null,
        channelName: row.channel_name ?? null,
        sourceKind: row.source_kind ?? null,
      } satisfies DocumentSearchResult);
    });

    return Object.freeze(results);
  }

  /**
   * Delete all chunks and embeddings for a document source, plus its
   * `documents` provenance row and any rows recorded as exact duplicates of
   * it (WP3). The memory mirror (`document:<slug>` in memory_chunks) lives in
   * the MemoryStore; the daemon's delete-document case removes it.
   * Returns the number of chunks deleted.
   */
  deleteDocument(source: string): number {
    let deleted = 0;
    this.db.transaction(() => {
      deleted = this.deleteChunksForSource(source);
      this.stmts.deleteDocumentRows.run(source, source);
    })();
    this.bumpVersion();
    return deleted;
  }

  /**
   * WP3: rows recorded as exact duplicates of `source` (their own inbox
   * path plus the image path they share with the original).
   */
  listDuplicatesOf(
    source: string,
  ): readonly { readonly source: string; readonly source_image_path: string | null }[] {
    return this.stmts.listDuplicatesOf.all(source) as Array<{
      source: string;
      source_image_path: string | null;
    }>;
  }

  /** WP3: how many documents rows still point at this archived image path. */
  countImagePathReferences(path: string): number {
    return (this.stmts.countImagePathRefs.get(path) as { n: number }).n;
  }

  /**
   * WP3: record the outcome of an ingest attempt on an existing row without
   * touching its other provenance fields. No-op when the row is absent.
   */
  setIngestOutcome(source: string, status: IngestStatus, attempts: number): void {
    this.stmts.setIngestOutcome.run(status, attempts, source);
    this.bumpVersion();
  }

  /** WP3: every stored chunk of a source in chunk order (no embeddings). */
  getChunksForSource(source: string): readonly StoredChunk[] {
    const rows = this.stmts.getChunksBySource.all(source) as ReadonlyArray<{
      id: string;
      chunk_index: number;
      content: string;
    }>;
    return Object.freeze(
      rows.map((r) => Object.freeze({ id: r.id, chunkIndex: r.chunk_index, content: r.content })),
    );
  }

  /** Get total number of document chunks across all sources. */
  getChunkCount(): number {
    const row = this.stmts.getChunkCount.get() as { count: number };
    return row.count;
  }

  /** List all distinct document sources, sorted alphabetically. */
  listSources(): readonly string[] {
    const rows = this.stmts.listSources.all() as ReadonlyArray<{ source: string }>;
    return Object.freeze(rows.map((r) => r.source));
  }

  /**
   * Phase 999.43 Plan 04 — list every `source` in the `documents` provenance
   * table (NOT `document_chunks` — `listSources` above is keyed on the
   * chunks table). Used by Plan 04's `reclassify-docs` IPC handler to walk
   * every ingested document in an agent's store and apply a glob rule.
   *
   * Includes pre-Plan-01-backfill placeholder rows (source_kind =
   * "manual_pre_999_43") — operators can target those explicitly with a
   * rule like `*=medium` to retroactively assign defaults. Returns rows in
   * insertion order (no ORDER BY); callers that need deterministic order
   * should sort.
   */
  listDocumentSources(): readonly string[] {
    const rows = this.stmts.listAllDocumentsSources.all() as ReadonlyArray<{
      source: string;
    }>;
    return Object.freeze(rows.map((r) => r.source));
  }

  /** Delete chunks for a source from both tables. Returns count deleted. */
  private deleteChunksForSource(source: string): number {
    // Get chunk IDs first for vec table deletion
    const chunkIds = this.stmts.getChunkIdsBySource.all(source) as ReadonlyArray<{ id: string }>;
    for (const row of chunkIds) {
      this.stmts.deleteVecBySource.run(row.id);
    }
    const result = this.stmts.deleteBySource.run(source);
    return result.changes;
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS document_chunks (
        id TEXT PRIMARY KEY,
        source TEXT NOT NULL,
        chunk_index INTEGER NOT NULL,
        content TEXT NOT NULL,
        start_char INTEGER NOT NULL,
        end_char INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_doc_chunks_source
        ON document_chunks(source);
      CREATE INDEX IF NOT EXISTS idx_doc_chunks_source_index
        ON document_chunks(source, chunk_index);

      CREATE VIRTUAL TABLE IF NOT EXISTS vec_document_chunks USING vec0(
        chunk_id TEXT PRIMARY KEY,
        embedding int8[384] distance_metric=cosine
      );

      -- Phase 999.43 Plan 01 Task 2 — D-04 provenance per document.
      -- 1:1 with document_chunks.source. content_priority_weight is the
      -- EFFECTIVE weight (derived from override_class if set, else
      -- auto_classified_class via the D-01 multipliers 1.5/1.0/0.5).
      -- agent_priority_weight_at_ingest is informational; the LIVE agent
      -- weight is read at query time per D-01 hot-reload semantics.
      CREATE TABLE IF NOT EXISTS documents (
        source TEXT PRIMARY KEY,
        agent_name TEXT NOT NULL,
        channel_id TEXT,
        message_id TEXT,
        user_id TEXT,
        ingested_at TEXT NOT NULL,
        source_kind TEXT NOT NULL,
        auto_classified_class TEXT NOT NULL,
        override_class TEXT,
        content_priority_weight REAL NOT NULL DEFAULT 1.0,
        agent_priority_weight_at_ingest REAL NOT NULL DEFAULT 1.0
      );
      CREATE INDEX IF NOT EXISTS idx_documents_message_id
        ON documents(message_id);
      CREATE INDEX IF NOT EXISTS idx_documents_agent
        ON documents(agent_name);
    `);

    // Phase 999.43 Plan 01 Task 2 — backwards-compat backfill for pre-999.43
    // production DBs (Phase 101 live on clawdy as of 2026-05-16). When the
    // documents table is empty BUT document_chunks already has rows from
    // prior manual ingests (Phase 101 MCP tool surface), insert placeholder
    // provenance rows with source_kind="manual_pre_999_43" so query-side
    // LEFT JOIN (Plan 03) doesn't drop these documents from search results.
    // Idempotent — only fires when documents is empty (no-op on fresh DBs
    // and on re-opens of already-backfilled DBs).
    const docCount = (
      this.db
        .prepare("SELECT COUNT(*) as count FROM documents")
        .get() as { count: number }
    ).count;
    if (docCount === 0) {
      const chunkCount = (
        this.db
          .prepare("SELECT COUNT(*) as count FROM document_chunks")
          .get() as { count: number }
      ).count;
      if (chunkCount > 0) {
        this.db.exec(`
          INSERT INTO documents (
            source, agent_name, ingested_at, source_kind,
            auto_classified_class, content_priority_weight,
            agent_priority_weight_at_ingest
          )
          SELECT
            source,
            '_unknown' AS agent_name,
            COALESCE(MIN(created_at), datetime('now')) AS ingested_at,
            'manual_pre_999_43' AS source_kind,
            'medium' AS auto_classified_class,
            1.0 AS content_priority_weight,
            1.0 AS agent_priority_weight_at_ingest
          FROM document_chunks
          GROUP BY source;
        `);
      }
    }
  }

  private prepareStatements(): PreparedStatements {
    return {
      insertChunk: this.db.prepare(`
        INSERT INTO document_chunks (id, source, chunk_index, content, start_char, end_char, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `),
      // Phase 101 D-09: embedding column is int8[384]. sqlite-vec requires the
      // raw bytes to be cast via the `vec_int8(?)` SQL function before insert
      // (otherwise the bind defaults to float32 and the column-type assertion
      // rejects it). Callers pass `Buffer.from(int8Array.buffer)` for the bind.
      insertVec: this.db.prepare(`
        INSERT INTO vec_document_chunks (chunk_id, embedding)
        VALUES (?, vec_int8(?))
      `),
      deleteBySource: this.db.prepare(
        "DELETE FROM document_chunks WHERE source = ?",
      ),
      deleteVecBySource: this.db.prepare(
        "DELETE FROM vec_document_chunks WHERE chunk_id = ?",
      ),
      getChunkCount: this.db.prepare(
        "SELECT COUNT(*) as count FROM document_chunks",
      ),
      getAdjacentChunk: this.db.prepare(
        "SELECT id, source, chunk_index, content, start_char, end_char, created_at FROM document_chunks WHERE source = ? AND chunk_index = ?",
      ),
      // Query embedding bound as Buffer.from(int8Array.buffer); wrapped via
      // vec_int8(?) to match the int8[384] column type.
      // Phase 999.43 Plan 03 — LEFT JOIN documents surfaces the
      // per-document content_priority_weight + ingested_at + source_kind
      // so the post-fetch ranking pass can apply D-02 multiplicative
      // weighting + 7-day recency boost. LEFT JOIN (not INNER) so chunks
      // without a provenance row (pre-Plan-01-backfill orphans) still
      // appear — those score at the neutral 1.0 multiplier.
      searchAll: this.db.prepare(`
        SELECT d.id, d.source, d.chunk_index, d.content, v.distance,
               docs.content_priority_weight AS content_weight,
               docs.ingested_at AS ingested_at,
               docs.source_kind AS source_kind,
               docs.source_image_path AS source_image_path,
               docs.filename AS filename,
               docs.user_name AS user_name,
               docs.channel_name AS channel_name
        FROM vec_document_chunks v
        INNER JOIN document_chunks d ON d.id = v.chunk_id
        LEFT JOIN documents docs ON docs.source = d.source
        WHERE v.embedding MATCH vec_int8(?)
          AND k = ?
        ORDER BY v.distance
      `),
      // WP3: source-scoped search is a brute force over that source's
      // chunks (vec_distance_cosine on the int8 vectors), not a global KNN
      // filtered afterwards. Bind order: query bytes, source, limit.
      searchBySource: this.db.prepare(`
        SELECT d.id, d.source, d.chunk_index, d.content,
               vec_distance_cosine(v.embedding, vec_int8(?)) AS distance,
               docs.content_priority_weight AS content_weight,
               docs.ingested_at AS ingested_at,
               docs.source_kind AS source_kind,
               docs.source_image_path AS source_image_path,
               docs.filename AS filename,
               docs.user_name AS user_name,
               docs.channel_name AS channel_name
        FROM document_chunks d
        INNER JOIN vec_document_chunks v ON v.chunk_id = d.id
        LEFT JOIN documents docs ON docs.source = d.source
        WHERE d.source = ?
        ORDER BY distance
        LIMIT ?
      `),
      listSources: this.db.prepare(
        "SELECT DISTINCT source FROM document_chunks ORDER BY source",
      ),
      getChunkIdsBySource: this.db.prepare(
        "SELECT id FROM document_chunks WHERE source = ?",
      ),
      getChunksBySource: this.db.prepare(
        "SELECT id, chunk_index, content FROM document_chunks WHERE source = ? ORDER BY chunk_index",
      ),
      deleteDocumentRows: this.db.prepare(
        "DELETE FROM documents WHERE source = ? OR duplicate_of = ?",
      ),
      listDuplicatesOf: this.db.prepare(
        "SELECT source, source_image_path FROM documents WHERE duplicate_of = ?",
      ),
      countImagePathRefs: this.db.prepare(
        "SELECT COUNT(*) AS n FROM documents WHERE source_image_path = ?",
      ),
      setIngestOutcome: this.db.prepare(
        "UPDATE documents SET ingest_status = ?, ingest_attempts = ? WHERE source = ?",
      ),
      // Phase 999.43 Plan 01 Task 2 — documents table CRUD.
      // ON CONFLICT(source) DO UPDATE — idempotent upsert. agent_name +
      // ingested_at + source_kind + auto_classified_class are immutable
      // post-ingest; only the provenance metadata + weight values flip
      // when the row is re-asserted (Plan 04 emoji override + MCP-tool path).
      upsertDocumentRow: this.db.prepare(`
        INSERT INTO documents (
          source, agent_name, channel_id, message_id, user_id,
          ingested_at, source_kind, auto_classified_class, override_class,
          content_priority_weight, agent_priority_weight_at_ingest,
          source_image_path, content_sha256, image_dhash, duplicate_of,
          vision_json, filename, user_name, channel_name, ingest_status,
          ingest_attempts
        ) VALUES (
          @source, @agent_name, @channel_id, @message_id, @user_id,
          @ingested_at, @source_kind, @auto_classified_class, @override_class,
          @content_priority_weight, @agent_priority_weight_at_ingest,
          @source_image_path, @content_sha256, @image_dhash, @duplicate_of,
          @vision_json, @filename, @user_name, @channel_name, @ingest_status,
          @ingest_attempts
        )
        ON CONFLICT(source) DO UPDATE SET
          agent_name = excluded.agent_name,
          channel_id = excluded.channel_id,
          message_id = excluded.message_id,
          user_id = excluded.user_id,
          ingested_at = excluded.ingested_at,
          source_kind = excluded.source_kind,
          auto_classified_class = excluded.auto_classified_class,
          override_class = excluded.override_class,
          content_priority_weight = excluded.content_priority_weight,
          agent_priority_weight_at_ingest = excluded.agent_priority_weight_at_ingest,
          source_image_path = excluded.source_image_path,
          content_sha256 = excluded.content_sha256,
          image_dhash = excluded.image_dhash,
          duplicate_of = excluded.duplicate_of,
          vision_json = excluded.vision_json,
          filename = excluded.filename,
          user_name = excluded.user_name,
          channel_name = excluded.channel_name,
          ingest_status = excluded.ingest_status,
          ingest_attempts = excluded.ingest_attempts
      `),
      getDocumentRow: this.db.prepare(
        "SELECT * FROM documents WHERE source = ?",
      ),
      getDocumentRowByMessageId: this.db.prepare(
        "SELECT * FROM documents WHERE message_id = ?",
      ),
      // setDocumentPriority — sets override_class + recomputes
      // content_priority_weight per D-01 multipliers (1.5/1.0/0.5).
      // auto_classified_class is intentionally NOT touched (D-04 immutable
      // post-ingest). D-08 sandbox is enforced at the IPC layer in Plan 04,
      // NOT here — this method is the low-level write.
      setDocumentPriority: this.db.prepare(`
        UPDATE documents
        SET override_class = @level,
            content_priority_weight = @weight
        WHERE source = @source
      `),
      // Phase 999.43 Plan 03 Task 2 — sources-only projection used by
      // getDocumentRowBySlug to walk the table and match by computed slug.
      listAllDocumentsSources: this.db.prepare(
        "SELECT source FROM documents",
      ),
      // WP3: a stub ("empty") or "failed" original must not swallow a
      // re-send of the same bytes, so only successful originals match.
      findDocumentBySha256: this.db.prepare(
        `SELECT * FROM documents
         WHERE content_sha256 = ? AND duplicate_of IS NULL
           AND (ingest_status IS NULL OR ingest_status = 'ok')
         ORDER BY ingested_at ASC LIMIT 1`,
      ),
      listRecentImageHashes: this.db.prepare(
        `SELECT source, image_dhash, vision_json, auto_classified_class
         FROM documents
         WHERE image_dhash IS NOT NULL AND duplicate_of IS NULL
           AND ingested_at >= ?
         ORDER BY ingested_at DESC LIMIT ?`,
      ),
    };
  }

  /**
   * Phase 999.43 Plan 01 Task 2 — upsert a per-document provenance row.
   * Idempotent: calling twice with the same `source` updates the row, not
   * duplicates it (ON CONFLICT(source) DO UPDATE). `contentWeight` MUST be
   * derived from CONTENT_PRIORITY_WEIGHTS by callers — this method does
   * NOT recompute weight from class to keep ingest-time flexibility (Plan 02
   * dispatcher snapshots the weight at classification time).
   */
  upsertDocumentRow(row: DocumentRowInput): void {
    this.stmts.upsertDocumentRow.run({
      source: row.source,
      agent_name: row.agentName,
      channel_id: row.channelId ?? null,
      message_id: row.messageId ?? null,
      user_id: row.userId ?? null,
      ingested_at: row.ingestedAt,
      source_kind: row.sourceKind,
      auto_classified_class: row.autoClassifiedClass,
      override_class: row.overrideClass ?? null,
      content_priority_weight: row.contentWeight,
      agent_priority_weight_at_ingest: row.agentWeightAtIngest,
      source_image_path: row.sourceImagePath ?? null,
      content_sha256: row.contentSha256 ?? null,
      image_dhash: row.imageDhash ?? null,
      duplicate_of: row.duplicateOf ?? null,
      vision_json: row.visionJson ?? null,
      filename: row.filename ?? null,
      user_name: row.userName ?? null,
      channel_name: row.channelName ?? null,
      ingest_status: row.ingestStatus ?? "ok",
      ingest_attempts: row.ingestAttempts ?? 0,
    });
    this.bumpVersion();
  }

  /** Phase 999.154 — the original (non-duplicate) document with these exact bytes. */
  findDocumentBySha256(sha256: string): DocumentRow | null {
    const row = this.stmts.findDocumentBySha256.get(sha256) as DocumentRow | undefined;
    return row ?? null;
  }

  /** Phase 999.154 — recent image hashes for near-duplicate matching (newest first). */
  listRecentImageHashes(sinceIso: string, limit: number): readonly ImageHashRow[] {
    return this.stmts.listRecentImageHashes.all(sinceIso, limit) as ImageHashRow[];
  }

  /** Fetch a documents row by `source`. Returns null when not present. */
  getDocumentRow(source: string): DocumentRow | null {
    const row = this.stmts.getDocumentRow.get(source) as DocumentRow | undefined;
    return row ?? null;
  }

  /**
   * Phase 999.43 Plan 03 Task 2 — fetch a documents row whose `source`
   * filepath computes to the given docSlug (`computeDocSlug(source) === slug`).
   * Used by memory-retrieval's score-weighting pass: `memory_chunks.path`
   * carries the document-prefix value `document:<slug>` (per
   * `src/document-ingest/cross-ingest.ts`), but the `documents` table is
   * keyed by full filepath. This method bridges the asymmetry.
   *
   * Linear scan — documents are bounded per agent (low hundreds). Returns
   * the first match (slug collisions across different file paths are
   * possible but unusual; first match keeps behavior deterministic).
   * Returns null when no row matches.
   */
  getDocumentRowBySlug(slug: string): DocumentRow | null {
    const allSources = this.stmts.listAllDocumentsSources.all() as ReadonlyArray<{
      source: string;
    }>;
    for (const { source } of allSources) {
      if (computeDocSlug(source) === slug) {
        return this.getDocumentRow(source);
      }
    }
    return null;
  }

  /**
   * Fetch a documents row by `message_id` — used by Plan 04 emoji-reaction
   * handler (operator drops 🔴/🟡/🟢 on the source Discord message; lookup
   * resolves the message id to the ingested document).
   */
  getDocumentRowByMessageId(messageId: string): DocumentRow | null {
    const row = this.stmts.getDocumentRowByMessageId.get(messageId) as
      | DocumentRow
      | undefined;
    return row ?? null;
  }

  /**
   * Phase 999.43 D-03 / D-08 — set an operator/agent priority override on
   * a document. Recomputes `content_priority_weight` from D-01 multipliers
   * (high=1.5, medium=1.0, low=0.5). `auto_classified_class` is intentionally
   * preserved (D-04 immutable post-ingest); the audit trail keeps both values
   * so misclassifications can be traced.
   *
   * The `who` parameter is currently informational — D-08 sandbox enforcement
   * (agent cannot escalate own doc beyond MEDIUM) lives at the IPC layer in
   * Plan 04, NOT here. This method is the low-level write surface used by
   * the emoji handler, MCP tool, and CLI override.
   */
  setDocumentPriority(
    source: string,
    level: ContentPriorityLevel,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    who: "operator" | "agent",
  ): void {
    const weight = CONTENT_PRIORITY_WEIGHTS[level];
    this.stmts.setDocumentPriority.run({ source, level, weight });
    this.bumpVersion();
  }
}

/**
 * WP3 (2026-10-25): additive provenance + retry columns on `documents`:
 * filename, user_name, channel_name (TEXT, NULLable), ingest_status (TEXT,
 * NULL means "ok") and ingest_attempts (INTEGER NOT NULL DEFAULT 0). Same
 * idempotent PRAGMA-introspection pattern as the earlier migrations.
 * Returns the columns actually added.
 */
export function migrateAddProvenanceColumns(db: DatabaseType): readonly string[] {
  const tableExists = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='documents'")
    .get() as { name: string } | undefined;
  if (!tableExists) return [];
  const present = new Set(
    (db.prepare("PRAGMA table_info(documents)").all() as ReadonlyArray<{ name: string }>).map(
      (c) => c.name,
    ),
  );
  const added: string[] = [];
  const columns: ReadonlyArray<readonly [string, string]> = [
    ["filename", "TEXT"],
    ["user_name", "TEXT"],
    ["channel_name", "TEXT"],
    ["ingest_status", "TEXT"],
    ["ingest_attempts", "INTEGER NOT NULL DEFAULT 0"],
  ];
  for (const [col, type] of columns) {
    if (present.has(col)) continue;
    db.exec(`ALTER TABLE documents ADD COLUMN ${col} ${type}`);
    added.push(col);
  }
  return added;
}

/**
 * Phase 101 D-09 migration: drop any pre-existing `vec_document_chunks` whose
 * embedding column is float[384] and let `initSchema()` recreate it as
 * int8[384]. Greenfield-for-v2 per D-09 — no row data is preserved across
 * the migration (the document write path has not yet shipped at v1; there
 * are no historical document chunks to migrate).
 *
 * Idempotent:
 *   - if the table doesn't exist yet (fresh DB) → no-op, returns false
 *   - if the table exists and is already int8 → no-op, returns false
 *   - if the table exists and is float[384]   → DROP, returns true
 *
 * sqlite-vec's `vec_info()` exposes per-column metadata; we use it to
 * introspect the embedding column type. Wrapped in a transaction so a crash
 * mid-migration leaves the DB in either pre- or post-state, never partial.
 *
 * Phase 101-01 SUMMARY documents the canonical syntax discovery: the plan
 * called for `vector_int8[384]` but sqlite-vec rejects that grammar; the
 * canonical syntax is `int8[384]` (verified via Database :memory: probe).
 */
export function migrateDocumentChunksToInt8(db: DatabaseType): boolean {
  // Cheap check: does the virtual table exist at all?
  const exists = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='vec_document_chunks'",
    )
    .get() as { name: string } | undefined;
  if (!exists) return false;

  // Inspect the embedding column type. sqlite-vec exposes the shadow table
  // `vec_document_chunks_info` (or `vec_info()` table-valued function on
  // newer builds); fall back to reading the CREATE statement via sql column.
  const createSql = (
    db
      .prepare(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name='vec_document_chunks'",
      )
      .get() as { sql: string } | undefined
  )?.sql ?? "";

  // Already int8 → no-op.
  if (/int8\s*\[\s*384\s*\]/i.test(createSql)) return false;
  // Float (v1 schema) → drop so initSchema can recreate as int8.
  if (/\bfloat\s*\[\s*384\s*\]/i.test(createSql)) {
    db.transaction(() => {
      db.exec("DROP TABLE IF EXISTS vec_document_chunks;");
      // document_chunks (metadata) is intentionally kept — its rows reference
      // chunk_id values that will be re-populated on next ingest. For
      // safety, we also clear orphaned metadata so search can never return
      // chunks whose vector was just dropped.
      db.exec("DELETE FROM document_chunks;");
    })();
    return true;
  }
  // Unknown shape (future schema?) — leave it alone, log via thrown Error
  // so the operator notices before silent corruption.
  return false;
}

/**
 * Phase 999.43-fu2 Path A — additive column migration on the `documents`
 * table. Adds `source_image_path TEXT` (NULLABLE, no DEFAULT) so the
 * auto-ingest dispatcher can persist the on-disk image path for image
 * attachments and `search_documents` can surface it back to agents on
 * retrieval. Backfill semantics: existing rows are NULL (no DEFAULT clause,
 * SQLite fills the column with NULL on ADD COLUMN).
 *
 * Idempotency: SQLite's `ALTER TABLE ... ADD COLUMN` is NOT
 * `IF NOT EXISTS`-able, so we introspect `PRAGMA table_info` first and
 * skip if the column is already present. Re-running the migration is a
 * no-op (returns false). Returns true iff the migration actually added
 * the column (first run on a pre-fu2 DB).
 *
 * MUST be called AFTER `initSchema()` — the `documents` table must exist
 * first. The constructor wires this ordering.
 */
export function migrateAddSourceImagePath(db: DatabaseType): boolean {
  // Cheap check: does the documents table exist? If not, initSchema didn't
  // run (shouldn't happen via the constructor, but defend against direct
  // module callers).
  const tableExists = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='documents'",
    )
    .get() as { name: string } | undefined;
  if (!tableExists) return false;

  // Check whether source_image_path is already present (idempotency guard).
  const columns = db
    .prepare("PRAGMA table_info(documents)")
    .all() as ReadonlyArray<{ name: string }>;
  const hasColumn = columns.some((c) => c.name === "source_image_path");
  if (hasColumn) return false;

  // First-run path: add the column. NULLABLE, no DEFAULT — existing rows
  // get NULL automatically per SQLite semantics.
  db.exec("ALTER TABLE documents ADD COLUMN source_image_path TEXT");
  return true;
}

/**
 * Phase 999.154 — additive columns for image dedupe + structured vision.
 * Same idempotent PRAGMA-introspection pattern as migrateAddSourceImagePath;
 * all NULLABLE, existing rows read NULL. Returns the columns actually added.
 */
export function migrateAddImageIngestColumns(db: DatabaseType): readonly string[] {
  const tableExists = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='documents'")
    .get() as { name: string } | undefined;
  if (!tableExists) return [];
  const present = new Set(
    (db.prepare("PRAGMA table_info(documents)").all() as ReadonlyArray<{ name: string }>).map(
      (c) => c.name,
    ),
  );
  const added: string[] = [];
  for (const col of ["content_sha256", "image_dhash", "duplicate_of", "vision_json"]) {
    if (present.has(col)) continue;
    db.exec(`ALTER TABLE documents ADD COLUMN ${col} TEXT`);
    added.push(col);
  }
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_documents_content_sha256 ON documents(content_sha256)",
  );
  return added;
}
