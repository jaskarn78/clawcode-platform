import Database from "better-sqlite3";
import type { Database as DatabaseType, Statement } from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { nanoid } from "nanoid";
import { buildFtsMatchQuery } from "./fts-query.js";
import { MemoryError } from "./errors.js";
import { checkForDuplicate, mergeMemory } from "./dedup.js";
import { extractWikilinks } from "./graph.js";
import { calculateImportance } from "./importance.js";
import { autoLinkMemory } from "./similarity.js";
import { int8ToBuffer, dequantizeInt8 } from "./embedder-quantize.js";
import {
  normalizeDistance,
  readVersionForPhase,
  toQueryVector,
  type EmbeddingReadVersion,
  type QueryVector,
} from "./embedding-version.js";
import type { EmbeddingMigrationPhase } from "./migrations/embedding-v2.js";
import type {
  MemoryEntry,
  MemoryTier,
  CreateMemoryInput,
  SessionLogEntry,
} from "./types.js";

/** Prepared statements for all store operations. */
type PreparedStatements = {
  readonly insertMemory: Statement;
  readonly insertVec: Statement;
  readonly getById: Statement;
  readonly getByOriginId: Statement;
  readonly updateAccess: Statement;
  readonly deleteMemory: Statement;
  readonly deleteVec: Statement;
  /**
   * Phase 115 D-08 — cascade-delete from `vec_memories_v2`. Same
   * statement shape as `deleteVec` (DELETE WHERE memory_id = ?), runs
   * inside the same `db.transaction()` per Phase 107 invariant.
   * Idempotent — DELETE-WHERE-no-match is a 0-row no-op so this works
   * for pre-dual-write entries that have no v2 row yet.
   */
  readonly deleteVecV2: Statement;
  /**
   * Phase 115 D-08 — INSERT OR REPLACE into `vec_memories_v2`. Used by
   * the dual-write hook in MemoryStore.insertEmbeddingV2 + the migration
   * runner's batch re-embed loop. `vec_int8(?)` SQL function is required
   * because sqlite-vec rejects raw Int8Array bindings as float32-shaped.
   */
  readonly insertVecV2: Statement;
  readonly listRecent: Statement;
  readonly insertSessionLog: Statement;
  readonly insertLink: Statement;
  readonly deleteLinksFrom: Statement;
  readonly getBacklinks: Statement;
  readonly getForwardLinks: Statement;
  readonly checkMemoryExists: Statement;
  /**
   * Phase 84 SKILL-04 — tag+content exact-match lookup for
   * self-improving-agent `.learnings/*.md` dedup during migration.
   * Uses LIKE '%tag%' to match a JSON-encoded tags column containing
   * the tag as a substring; content is compared literally.
   */
  readonly findByTagAndContent: Statement;
  /**
   * Phase 100-fu — single-row access bump for non-search callers
   * (GraphSearch graph-walked neighbors). Mirrors `updateAccess`
   * verbatim — kept as a separate prepared statement so usage sites
   * are easy to grep and so the SemanticSearch path is unaffected.
   */
  readonly bumpAccess: Statement;
  /**
   * Phase 100-fu — count inbound wikilink edges for a memory id. Used
   * by TierManager.refreshHotTier() to surface graph-centrality as a
   * hot-tier promotion signal independent of direct access count.
   */
  readonly getBacklinkCount: Statement;
  /**
   * Phase 999.119 — detach a memory from every conversation session that
   * names it as its summary. `conversation_sessions.summary_memory_id`
   * REFERENCES memories(id) with NO ON DELETE action, so deleting a
   * session-summary memory (tier maintenance, dedup, operator archive)
   * failed with "FOREIGN KEY constraint failed" and aborted the whole
   * cycle. `session_archive.summary_memory_id` (no FK) keeps the lineage.
   */
  readonly detachSessionSummary: Statement;
  /** Phase 999.119 — auto-linker scan cursor (see `markAutoLinked`). */
  readonly markAutoLinked: Statement;
  /** Phase 999.119 — retrieval-side recency touch (no access_count bump). */
  readonly touchAccessedAt: Statement;
};

/**
 * Phase 999.119 — a warm-tier row plus its inbound-link count. Both the
 * promotion scan and the cold scan need the centrality signal, and fetching
 * it inside the listing query replaces the old one-COUNT-per-row loop
 * (up to 5,000 extra statements per maintenance cycle).
 */
export type TierScanCandidate = MemoryEntry & {
  readonly backlinkCount: number;
};

/**
 * Phase 999.119 — read-only integrity census. Every count is a class of
 * row that references something which no longer exists. All of them are
 * produced by writes that bypassed `MemoryStore.delete()` (manual SQL
 * clean-ups with `foreign_keys` OFF, historical table-rebuild migrations)
 * and every one of them can wedge a maintenance path:
 *   - a dangling `memory_links` row is an FK violation waiting to fire;
 *   - an orphan `vec_memories` row is returned by KNN and makes the
 *     auto-linker INSERT a link to a ghost → FOREIGN KEY constraint failed;
 *   - a dangling `summary_memory_id` blocks nothing by itself but is
 *     the footprint of the same bypass.
 */
export type IntegrityReport = Readonly<{
  danglingLinks: number;
  danglingSessionSummaries: number;
  orphanVecV1: number;
  orphanVecV2: number;
  orphanChunkVecV1: number;
  orphanChunkVecV2: number;
  orphanChunkFts: number;
  /** Rows reported by `PRAGMA foreign_key_check` (all tables). */
  fkViolations: number;
  /**
   * Phase 999.119 pass 2 — memories with no vector at all (invisible to
   * search, linker and tiering). Not a delete-repair; the doctor's
   * `--repair` re-embeds them. Excluded from `total`.
   */
  memoriesWithoutEmbedding: number;
  /** Sum of the repairable classes (everything except `fkViolations`). */
  total: number;
}>;

/** Phase 999.119 — what `repairIntegrity()` removed, per class. */
export type IntegrityRepairResult = Readonly<{
  danglingLinksRemoved: number;
  sessionSummariesDetached: number;
  orphanVecV1Removed: number;
  orphanVecV2Removed: number;
  orphanChunkVecV1Removed: number;
  orphanChunkVecV2Removed: number;
  orphanChunkFtsRemoved: number;
  total: number;
}>;

/**
 * MemoryStore — SQLite-backed memory storage with sqlite-vec for vector search.
 *
 * Opens a better-sqlite3 database, enables WAL mode, loads the sqlite-vec
 * extension, and creates all required tables. Provides CRUD operations
 * for memories and session log entries.
 */
/** Configuration for deduplication on insert. */
type DedupStoreConfig = {
  readonly enabled: boolean;
  readonly similarityThreshold: number;
};

/** Default deduplication configuration. */
const DEFAULT_DEDUP_CONFIG: DedupStoreConfig = {
  enabled: true,
  similarityThreshold: 0.85,
};

export class MemoryStore {
  private readonly db: DatabaseType;
  private readonly stmts: PreparedStatements;
  private readonly dbPath: string;
  private readonly dedupConfig: DedupStoreConfig;
  /**
   * Phase 141 — best-effort embedding-v2 dual-write seam. Fired AFTER a new
   * memory / chunk row is committed (NOT inside the txn, NOT awaited) so the v2
   * (bge-small-int8) embedding can be computed + written by the wiring layer
   * (SessionMemory injects it with the embedder + per-agent migration phase).
   * Closes the v1-grows / v2-lags leak: previously v2 rows for new memories were
   * only ever filled by the re-embed backfill, whose forward cursor never
   * revisits writes landed behind it. A store with NO hook (CLI / bulk-import
   * paths) opts out — the batch handles those.
   */
  private embeddingV2Hook?: (memoryId: string, content: string) => void;
  private chunkEmbeddingV2Hook?: (chunkId: string, body: string) => void;

  /** Phase 141 — wire the per-agent best-effort v2 dual-write (see field doc). */
  setEmbeddingV2Hook(
    hook: (memoryId: string, content: string) => void,
  ): void {
    this.embeddingV2Hook = hook;
  }

  /** Phase 141 — wire the per-agent best-effort v2 chunk dual-write. */
  setChunkEmbeddingV2Hook(
    hook: (chunkId: string, body: string) => void,
  ): void {
    this.chunkEmbeddingV2Hook = hook;
  }

  constructor(dbPath: string, dedupConfig?: DedupStoreConfig) {
    this.dbPath = dbPath;
    this.dedupConfig = dedupConfig ?? DEFAULT_DEDUP_CONFIG;

    try {
      this.db = new Database(dbPath);
      this.db.pragma("journal_mode = WAL");
      this.db.pragma("busy_timeout = 5000");
      this.db.pragma("synchronous = NORMAL");
      this.db.pragma("foreign_keys = ON");

      sqliteVec.load(this.db);

      this.initSchema();
      this.migrateSchema();
      this.migrateTierColumn();
      this.migrateEpisodeSource();
      this.migrateGraphLinks();
      this.migrateConversationTables();
      this.migrateSourceTurnIds();
      this.migrateInstructionFlags();
      this.migrateConversationTurnsFts();
      this.migrateSessionArchiveTables();
      this.migrateApiKeySessionsTable();
      this.migrateOriginIdColumn();
      this.migrateMetadataColumn();
      this.migrateMemoryChunks();
      // Phase 999.187 — keyword index over `memories` (triggers + one-shot backfill).
      this.migrateMemoriesFts();
      // Phase 115 D-08 — additive embedding-v2 tables (vec_memories_v2 +
      // vec_memory_chunks_v2 with int8[384] cosine columns) + per-agent
      // `migrations` state machine table. Idempotent (CREATE TABLE/VIRTUAL
      // TABLE IF NOT EXISTS). NO migrate-down — operator rolls back via
      // the embedding-v2 state machine in src/memory/migrations/embedding-v2.ts
      // (which sets the read flag back to v1 but keeps the v2 column data
      // for re-attempt — see Phase 115 D-08 rollback path).
      this.migrateEmbeddingV2Tables();
      // Phase 999.119 — maintenance columns + indexes (auto-linker scan
      // cursor, tier/accessed_at index for the tier scans, summary_memory_id
      // index for the delete-time detach). Idempotent.
      this.migrateMaintenanceColumns();
      this.stmts = this.prepareStatements();
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unknown error";
      throw new MemoryError(`Failed to initialize store: ${message}`, dbPath);
    }
  }

  /** Exposes the underlying database for advanced queries (e.g., SemanticSearch). */
  getDatabase(): DatabaseType {
    return this.db;
  }

  /**
   * Insert a new memory with its embedding.
   *
   * Phase 1-114 contract: writes `memories` + `vec_memories` rows
   * atomically inside one `db.transaction()`.
   *
   * Phase 115 D-08 dual-write extension: when `opts.embeddingV2` is
   * provided, ALSO writes `vec_memories_v2` inside the SAME transaction.
   * Phase 107 atomic-cascade invariant: either all THREE rows commit
   * (memories + vec_memories + vec_memories_v2) or NONE do — a throw
   * inside the transaction (e.g. v2 INSERT fails) rolls back the v1
   * write too.
   *
   * The opts.embeddingV2 path is consumed by:
   *   - The wave-4 dual-write hook in MemoryStore callers (when
   *     EmbeddingV2Migrator.currentWriteVersions() includes "v2").
   *   - The `insertWithDualWrite` convenience wrapper below (this plan).
   */
  insert(
    input: CreateMemoryInput,
    embedding: Float32Array,
    opts?: { embeddingV2?: Int8Array },
  ): MemoryEntry {
    try {
      if (opts?.embeddingV2 && opts.embeddingV2.length !== 384) {
        throw new MemoryError(
          `Phase 115 v2 embedding must be 384-dim int8; got ${opts.embeddingV2.length}`,
          this.dbPath,
        );
      }
      // Phase 80 MEM-02 — origin_id path skips dedup entirely. Idempotency
      // by hash is the contract; content-similarity merging is a different
      // semantic that does not apply to migrated imports.
      const hasOriginId =
        typeof input.origin_id === "string" && input.origin_id.length > 0;

      // Existing dedup path (preserved verbatim) — only runs when origin_id
      // is absent AND dedupConfig.enabled AND !skipDedup.
      if (!hasOriginId && this.dedupConfig.enabled && !input.skipDedup) {
        const dedupResult = checkForDuplicate(embedding, this.db, {
          similarityThreshold: this.dedupConfig.similarityThreshold,
        });

        if (dedupResult.action === "merge") {
          mergeMemory(this.db, dedupResult.existingId, {
            content: input.content,
            importance: input.importance ?? 0.5,
            tags: input.tags ?? [],
            embedding,
          });

          // Re-extract links after merge.
          //
          // Phase 115 D-08 — when dedup merges into an existing memory
          // and the caller also passed a v2 embedding, write the v2
          // row for the EXISTING memory id atomically inside this same
          // transaction. mergeMemory() updates the v1 vec; we mirror
          // that for v2 (INSERT OR REPLACE so re-merge is idempotent).
          this.db.transaction(() => {
            const mergedTargets = extractWikilinks(input.content);
            this.stmts.deleteLinksFrom.run(dedupResult.existingId);
            const mergeNow = new Date().toISOString();
            for (const targetId of mergedTargets) {
              const exists = this.stmts.checkMemoryExists.get(targetId);
              if (exists) {
                this.stmts.insertLink.run(dedupResult.existingId, targetId, targetId, mergeNow);
              }
            }
            if (opts?.embeddingV2) {
              this.stmts.insertVecV2.run(
                dedupResult.existingId,
                int8ToBuffer(opts.embeddingV2),
              );
            }
          })();

          // Eager auto-link after merge
          try {
            autoLinkMemory(this, dedupResult.existingId);
          } catch {
            // Non-fatal: heartbeat auto-linker will catch missed links
          }

          const merged = this.getById(dedupResult.existingId);
          if (!merged) {
            throw new MemoryError(
              `Merged memory ${dedupResult.existingId} not found after merge`,
              this.dbPath,
            );
          }
          return merged;
        }
      }

      // Normal insert path
      const now = new Date().toISOString();
      const id = nanoid();
      const importance = input.importance != null && input.importance !== 0.5
        ? input.importance
        : calculateImportance(input.content);
      const tags = input.tags ?? [];
      const sourceTurnIdsJson =
        input.sourceTurnIds && input.sourceTurnIds.length > 0
          ? JSON.stringify([...input.sourceTurnIds])
          : null;
      const originIdOrNull = hasOriginId ? (input.origin_id as string) : null;

      let inserted = true;
      this.db.transaction(() => {
        const result = this.stmts.insertMemory.run(
          id,
          input.content,
          input.source,
          importance,
          JSON.stringify(tags),
          now,
          now,
          now,
          sourceTurnIdsJson,
          originIdOrNull,
        );
        if (result.changes === 0) {
          if (!hasOriginId) {
            // INSERT OR IGNORE suppresses CHECK-constraint failures too
            // (e.g., invalid `source` value). Without an origin_id this is
            // NEVER a legitimate idempotent skip — re-raise to preserve the
            // pre-existing validation contract (461 tests depend on invalid
            // source throwing).
            throw new MemoryError(
              `INSERT suppressed with no origin_id — likely constraint violation (source="${input.source}")`,
              this.dbPath,
            );
          }
          // origin_id collision — INSERT OR IGNORE fired. Do NOT write
          // vec_memories and do NOT extract wikilinks for this run (they
          // were already extracted on the original insert).
          inserted = false;
          return;
        }
        this.stmts.insertVec.run(id, embedding);
        // Phase 115 D-08 — atomic dual-write. v2 row written inside the
        // SAME transaction as v1 + memories. A throw here (e.g. vec_int8
        // type rejection, disk-full) rolls back the v1 + memories
        // writes too — Phase 107 atomic-cascade invariant preserved
        // for the insert side, mirroring the delete side.
        if (opts?.embeddingV2) {
          this.stmts.insertVecV2.run(id, int8ToBuffer(opts.embeddingV2));
        }

        // Extract wikilinks and create edges to existing targets
        const targets = extractWikilinks(input.content);
        for (const targetId of targets) {
          const exists = this.stmts.checkMemoryExists.get(targetId);
          if (exists) {
            this.stmts.insertLink.run(id, targetId, targetId, now);
          }
        }
      })();

      // Phase 141 — best-effort v2 dual-write for the just-committed NEW row.
      // Skipped when the caller already supplied a v2 embedding (no double
      // write) or when the row was an idempotent origin_id skip (!inserted).
      // Fired outside the txn (the hook does its own async embed + write) and
      // never awaited, so a v2 failure can't roll back or block the v1 write.
      if (inserted && !opts?.embeddingV2 && this.embeddingV2Hook) {
        this.embeddingV2Hook(id, input.content);
      }

      if (!inserted && hasOriginId) {
        // Idempotent skip — return the existing row. Callers (Plan 02
        // translator) compare returned entry.createdAt against a
        // "this run" marker to classify upserted vs skipped for the CLI.
        const existing = this.stmts.getByOriginId.get(input.origin_id) as
          | MemoryRow
          | undefined;
        if (!existing) {
          throw new MemoryError(
            `origin_id ${input.origin_id} collision but SELECT returned no row`,
            this.dbPath,
          );
        }
        return rowToEntry(existing);
      }

      // Eager auto-link: discover similar memories and create edges
      try {
        autoLinkMemory(this, id);
      } catch {
        // Non-fatal: heartbeat auto-linker will catch missed links
      }

      return Object.freeze({
        id,
        content: input.content,
        source: input.source,
        importance,
        accessCount: 0,
        tags: Object.freeze([...tags]),
        embedding,
        createdAt: now,
        updatedAt: now,
        accessedAt: now,
        tier: "warm" as const,
        sourceTurnIds:
          input.sourceTurnIds && input.sourceTurnIds.length > 0
            ? Object.freeze([...input.sourceTurnIds])
            : null,
      });
    } catch (error) {
      if (error instanceof MemoryError) throw error;
      const message =
        error instanceof Error ? error.message : "Unknown error";
      throw new MemoryError(`Failed to insert memory: ${message}`, this.dbPath);
    }
  }

  /**
   * Retrieve a memory by ID. Increments access_count and updates accessed_at.
   * Returns null if not found.
   */
  getById(id: string): MemoryEntry | null {
    try {
      const row = this.stmts.getById.get(id) as MemoryRow | undefined;
      if (!row) return null;

      const now = new Date().toISOString();
      this.stmts.updateAccess.run(now, id);

      return rowToEntry({
        ...row,
        access_count: row.access_count + 1,
        accessed_at: now,
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unknown error";
      throw new MemoryError(
        `Failed to get memory ${id}: ${message}`,
        this.dbPath,
      );
    }
  }

  /**
   * Delete a memory from both memories and vec_memories tables.
   * Returns true if the memory existed and was deleted.
   *
   * Phase 115 D-08 — cascade EXTENDED to also delete from
   * `vec_memories_v2` inside the same `db.transaction()`. Phase 107
   * VEC-CLEAN-* atomic-cascade invariant preserved across BOTH v1 and v2
   * vec tables — either all three rows go (memories + vec_memories +
   * vec_memories_v2) or none do.
   *
   * The v2 `DELETE FROM vec_memories_v2` runs even when no v2 row exists
   * for `id` (DELETE-WHERE-no-match is a 0-row no-op in SQLite). This is
   * the right semantics: pre-dual-write entries have no v2 row, but the
   * delete must still cascade idempotently.
   */
  delete(id: string): boolean {
    try {
      let deleted = false;
      this.db.transaction(() => {
        // Phase 999.119 — a session-summary memory is referenced by
        // conversation_sessions.summary_memory_id (FK, no ON DELETE
        // action). Detach first or the DELETE below throws "FOREIGN KEY
        // constraint failed" — which is exactly how fin-research's tier
        // maintenance wedged on one row for days (2026-09-04). The
        // session keeps its status and session_archive keeps the id.
        this.stmts.detachSessionSummary.run(id);
        const result = this.stmts.deleteMemory.run(id);
        deleted = result.changes > 0;
        if (deleted) {
          this.stmts.deleteVec.run(id);
          // Phase 115 D-08 — cascade to v2. Idempotent — DELETE-WHERE-no-
          // match is a 0-row no-op. The transaction wrapper guarantees
          // atomicity per Phase 107 VEC-CLEAN-02.
          this.stmts.deleteVecV2.run(id);
        }
      })();
      return deleted;
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unknown error";
      throw new MemoryError(
        `Failed to delete memory ${id}: ${message}`,
        this.dbPath,
      );
    }
  }

  /**
   * List recent memories ordered by created_at descending.
   */
  listRecent(limit: number): readonly MemoryEntry[] {
    try {
      const rows = this.stmts.listRecent.all(limit) as MemoryRow[];
      return Object.freeze(rows.map(rowToEntry));
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unknown error";
      throw new MemoryError(
        `Failed to list recent memories: ${message}`,
        this.dbPath,
      );
    }
  }

  /** Phase 999.130 — how many memories were created inside [since, until] (inclusive ISO bounds). */
  countInRange(since: string, until: string): number {
    try {
      const row = this.db
        .prepare("SELECT COUNT(*) AS n FROM memories WHERE created_at >= ? AND created_at <= ?")
        .get(since, until) as { n: number };
      return row.n;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      throw new MemoryError(`Failed to count memories in range: ${message}`, this.dbPath);
    }
  }

  /**
   * Phase 999.125 — memories whose `created_at` falls inside [since, until]
   * (inclusive ISO bounds), newest first. The time-windowed lookup uses this
   * instead of `listRecent` so a window far in the past is reachable.
   */
  listInRange(since: string, until: string, limit: number): readonly MemoryEntry[] {
    try {
      const rows = this.db
        .prepare(
          `SELECT id, content, source, importance, access_count, tags,
                  created_at, updated_at, accessed_at, tier, source_turn_ids
           FROM memories
           WHERE created_at >= ? AND created_at <= ?
           ORDER BY created_at DESC, rowid DESC LIMIT ?`,
        )
        .all(since, until, limit) as MemoryRow[];
      return Object.freeze(rows.map(rowToEntry));
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      throw new MemoryError(`Failed to list memories in range: ${message}`, this.dbPath);
    }
  }

  /**
   * Record a session log entry in the session_logs table.
   */
  recordSessionLog(
    entry: Omit<SessionLogEntry, "id" | "createdAt">,
  ): SessionLogEntry {
    const now = new Date().toISOString();
    const id = nanoid();

    try {
      this.stmts.insertSessionLog.run(
        id,
        entry.date,
        entry.filePath,
        entry.entryCount,
        now,
      );

      return Object.freeze({
        id,
        date: entry.date,
        filePath: entry.filePath,
        entryCount: entry.entryCount,
        createdAt: now,
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unknown error";
      throw new MemoryError(
        `Failed to record session log: ${message}`,
        this.dbPath,
      );
    }
  }

  /** Close the database connection. */
  close(): void {
    this.db.close();
  }

  /**
   * Whether the underlying better-sqlite3 connection is still open. Used by
   * fire-and-forget / background best-effort writers (the embedding-v2
   * dual-write hook, consolidation, tier maintenance) to skip cleanly when a
   * concurrent agent stop/restart closed the store mid-flight — instead of
   * running a prepared statement on a closed connection ("The database
   * connection is not open"). better-sqlite3 exposes this natively.
   */
  isOpen(): boolean {
    return this.db.open;
  }

  /**
   * Delete a session log entry by date (for archiving after consolidation).
   * Returns true if the entry existed and was deleted.
   */
  deleteSessionLog(date: string): boolean {
    try {
      const stmt = this.db.prepare(
        "DELETE FROM session_logs WHERE date = ?",
      );
      const result = stmt.run(date);
      return result.changes > 0;
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unknown error";
      throw new MemoryError(
        `Failed to delete session log for ${date}: ${message}`,
        this.dbPath,
      );
    }
  }

  /**
   * Get all tracked session log dates in ascending order.
   * Used by the consolidation pipeline to discover available logs.
   */
  getSessionLogDates(): readonly string[] {
    try {
      const stmt = this.db.prepare(
        "SELECT DISTINCT date FROM session_logs ORDER BY date ASC",
      );
      const rows = stmt.all() as ReadonlyArray<{ date: string }>;
      return Object.freeze(rows.map((r) => r.date));
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unknown error";
      throw new MemoryError(
        `Failed to get session log dates: ${message}`,
        this.dbPath,
      );
    }
  }

  /**
   * Retrieve the embedding vector for a memory by ID.
   * Returns null if the memory has no embedding stored.
   */
  getEmbedding(id: string): Float32Array | null {
    try {
      const row = this.db
        .prepare("SELECT embedding FROM vec_memories WHERE memory_id = ?")
        .get(id) as { embedding: Buffer | Float32Array } | undefined;
      if (!row?.embedding) return null;
      // SQLite returns Buffer; convert to Float32Array
      const buf = row.embedding;
      if (buf instanceof Float32Array) return buf;
      return new Float32Array(
        (buf as Buffer).buffer,
        (buf as Buffer).byteOffset,
        (buf as Buffer).byteLength / 4,
      );
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unknown error";
      throw new MemoryError(
        `Failed to get embedding for ${id}: ${message}`,
        this.dbPath,
      );
    }
  }

  /**
   * Phase 115 D-08 — write a v2 (bge-small-int8) embedding for an existing
   * memory id. Idempotent — INSERT OR REPLACE so the dual-write hook can
   * call this on every memory write without checking for an existing v2
   * row first. The migration runner's batch re-embed also uses this path.
   *
   * Atomicity: the caller is responsible for wrapping in a transaction if
   * dual-write is required (memories + vec_memories + vec_memories_v2 all
   * inside one transaction per Phase 107 lock). The standard call site
   * is `insertWithDualWrite` below, which wraps both v1 + v2 writes.
   *
   * Throws MemoryError if the embedding length doesn't match 384 — vec0
   * column type `int8[384]` is enforced at write time.
   */
  insertEmbeddingV2(memoryId: string, embedding: Int8Array): void {
    if (embedding.length !== 384) {
      throw new MemoryError(
        `Phase 115 v2 embedding must be 384-dim int8; got ${embedding.length}`,
        this.dbPath,
      );
    }
    try {
      this.stmts.insertVecV2.run(memoryId, int8ToBuffer(embedding));
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      throw new MemoryError(
        `Failed to write v2 embedding for ${memoryId}: ${message}`,
        this.dbPath,
      );
    }
  }

  /**
   * Phase 115 D-08 — write a v2 chunk embedding. Mirror of
   * `insertEmbeddingV2` for the chunks side. Used by the migration
   * runner's chunk re-embed loop AND by memory-scanner during
   * dual-write phase (deferred to follow-on plan 115-09; this plan
   * ships the storage primitive).
   */
  insertChunkEmbeddingV2(chunkId: string, embedding: Int8Array): void {
    if (embedding.length !== 384) {
      throw new MemoryError(
        `Phase 115 v2 chunk embedding must be 384-dim int8; got ${embedding.length}`,
        this.dbPath,
      );
    }
    try {
      this.db
        .prepare(
          `INSERT OR REPLACE INTO vec_memory_chunks_v2 (chunk_id, embedding) VALUES (?, vec_int8(?))`,
        )
        .run(chunkId, int8ToBuffer(embedding));
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      throw new MemoryError(
        `Failed to write v2 chunk embedding for ${chunkId}: ${message}`,
        this.dbPath,
      );
    }
  }

  /**
   * Phase 115 D-08 — combined dual-write helper. Thin wrapper over
   * `insert(input, embedding, { embeddingV2 })`. All three rows
   * (memories + vec_memories + vec_memories_v2) commit inside ONE
   * `db.transaction()` — either all three land or none do. Phase 107
   * atomic-cascade invariant preserved across the insert side
   * (matching the delete side).
   *
   * If the v2 INSERT throws (e.g. vec_int8 type rejection, disk-full),
   * the v1 + memories writes roll back too. Regression-pinned by
   * `embedding-v2-cascade-delete.test.ts` insert-atomicity test.
   */
  insertWithDualWrite(
    input: CreateMemoryInput,
    embeddingV1: Float32Array,
    embeddingV2: Int8Array,
  ): MemoryEntry {
    return this.insert(input, embeddingV1, { embeddingV2 });
  }

  /**
   * Phase 115 D-08 — return memories that have a v1 vec_memories row but
   * NO v2 vec_memories_v2 row. The migration runner pulls these in
   * batches to embed + write v2 vectors for historical entries.
   *
   * Sorted by id ASC so a `lastCursor`-based resume is deterministic
   * (id > last_cursor; LIMIT N).
   *
   * Returns memory_id + content; the runner only needs content to embed.
   */
  listMemoriesMissingV2Embedding(
    limit: number,
    afterCursor: string | null,
  ): ReadonlyArray<Readonly<{ id: string; content: string }>> {
    const stmt = afterCursor
      ? this.db.prepare(
          `SELECT m.id, m.content FROM memories m
           WHERE m.id IN (SELECT memory_id FROM vec_memories)
             AND m.id NOT IN (SELECT memory_id FROM vec_memories_v2)
             AND m.id > ?
           ORDER BY m.id ASC
           LIMIT ?`,
        )
      : this.db.prepare(
          `SELECT m.id, m.content FROM memories m
           WHERE m.id IN (SELECT memory_id FROM vec_memories)
             AND m.id NOT IN (SELECT memory_id FROM vec_memories_v2)
           ORDER BY m.id ASC
           LIMIT ?`,
        );
    const rows = afterCursor
      ? (stmt.all(afterCursor, limit) as Array<{ id: string; content: string }>)
      : (stmt.all(limit) as Array<{ id: string; content: string }>);
    return Object.freeze(rows.map((r) => Object.freeze({ ...r })));
  }

  /**
   * Phase 115 D-08 — total count of memories MISSING a v2 embedding.
   * Used by the migration runner to compute progressTotal for status
   * reporting. Counted ONCE at migration start; subsequent batches
   * track progressProcessed against this total.
   */
  // ── Phase 999.119 v2 switch — version-aware reads ─────────────────────

  /**
   * The vector space this agent's reads run against right now: "v2" once
   * the embedding-v2 migration has reached `cutover`, else "v1". Read
   * from the `migrations` row on every call (one PK lookup, microseconds)
   * so an operator transition takes effect on the very next query with no
   * cache to invalidate.
   */
  getEmbeddingReadVersion(): EmbeddingReadVersion {
    try {
      const row = this.db
        .prepare("SELECT phase FROM migrations WHERE key = 'embeddingV2'")
        .get() as { phase: string } | undefined;
      return row ? readVersionForPhase(row.phase as EmbeddingMigrationPhase) : "v1";
    } catch {
      return "v1";
    }
  }

  /** Embed a query for whichever space this store currently reads from. */
  embedQuery(
    embedder: { embedForVersion(text: string, version: EmbeddingReadVersion): Promise<QueryVector> },
    text: string,
  ): Promise<QueryVector> {
    return embedder.embedForVersion(text, this.getEmbeddingReadVersion());
  }

  /** The stored v2 (int8) vector for a memory, or null when it has none yet. */
  getEmbeddingV2(id: string): Int8Array | null {
    try {
      const row = this.db
        .prepare("SELECT embedding FROM vec_memories_v2 WHERE memory_id = ?")
        .get(id) as { embedding: Buffer } | undefined;
      if (!row?.embedding) return null;
      return new Int8Array(new Uint8Array(row.embedding).buffer);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      throw new MemoryError(`Failed to get v2 embedding for ${id}: ${message}`, this.dbPath);
    }
  }

  /**
   * A memory's stored vector as float32 in the requested space (v2 rows
   * are dequantized). For in-process cosine against a QueryVector's
   * `float` — the graph walk's neighbour test.
   */
  getStoredVectorFloat(id: string, version: EmbeddingReadVersion): Float32Array | null {
    if (version === "v1") return this.getEmbedding(id);
    const q = this.getEmbeddingV2(id);
    return q ? dequantizeInt8(q) : null;
  }

  /** Chunks that have a v1 vector but no v2 vector yet. */
  countChunksMissingV2Embedding(): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM memory_chunks c
         WHERE c.id IN (SELECT chunk_id FROM vec_memory_chunks)
           AND c.id NOT IN (SELECT chunk_id FROM vec_memory_chunks_v2)`,
      )
      .get() as { n: number };
    return row.n;
  }

  /**
   * Phase 999.119 pass 2 — memories with NO v1 vector at all. Such a row is
   * invisible to vector search, the auto-linker and cold-tiering (all read
   * `vec_memories`). Production had 256 of them on fin-client (March–
   * April 2026 session summaries written before the vec write was atomic).
   */
  countMemoriesMissingEmbedding(): number {
    const row = this.db
      .prepare(
        "SELECT COUNT(*) AS n FROM memories WHERE id NOT IN (SELECT memory_id FROM vec_memories)",
      )
      .get() as { n: number };
    return row.n;
  }

  /** Phase 999.119 pass 2 — the rows `countMemoriesMissingEmbedding` counts, oldest first. */
  listMemoriesMissingEmbedding(
    limit: number,
  ): ReadonlyArray<Readonly<{ id: string; content: string }>> {
    return this.db
      .prepare(
        `SELECT id, content FROM memories
         WHERE id NOT IN (SELECT memory_id FROM vec_memories)
         ORDER BY created_at ASC LIMIT ?`,
      )
      .all(limit) as ReadonlyArray<{ id: string; content: string }>;
  }

  /**
   * Phase 999.119 pass 2 — write (or replace) a memory's v1 vector. Used by
   * the doctor's re-embed pass for rows that never got one.
   */
  insertEmbeddingV1(memoryId: string, embedding: Float32Array): void {
    if (embedding.length !== 384) {
      throw new MemoryError(
        `v1 embedding must be 384-dim float32; got ${embedding.length}`,
        this.dbPath,
      );
    }
    this.db.transaction(() => {
      this.stmts.deleteVec.run(memoryId);
      this.stmts.insertVec.run(memoryId, embedding);
    })();
  }

  countMemoriesMissingV2Embedding(): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM memories m
         WHERE m.id IN (SELECT memory_id FROM vec_memories)
           AND m.id NOT IN (SELECT memory_id FROM vec_memories_v2)`,
      )
      .get() as { n: number };
    return row.n;
  }

  /**
   * Phase 115 D-08 — return v2 chunks missing a v2 embedding (for the
   * future plan-115-09 chunks-side migration). Same cursor-based resume
   * shape as listMemoriesMissingV2Embedding.
   */
  listChunksMissingV2Embedding(
    limit: number,
    afterCursor: string | null,
  ): ReadonlyArray<Readonly<{ id: string; body: string }>> {
    const stmt = afterCursor
      ? this.db.prepare(
          `SELECT c.id, c.body FROM memory_chunks c
           WHERE c.id IN (SELECT chunk_id FROM vec_memory_chunks)
             AND c.id NOT IN (SELECT chunk_id FROM vec_memory_chunks_v2)
             AND c.id > ?
           ORDER BY c.id ASC
           LIMIT ?`,
        )
      : this.db.prepare(
          `SELECT c.id, c.body FROM memory_chunks c
           WHERE c.id IN (SELECT chunk_id FROM vec_memory_chunks)
             AND c.id NOT IN (SELECT chunk_id FROM vec_memory_chunks_v2)
           ORDER BY c.id ASC
           LIMIT ?`,
        );
    const rows = afterCursor
      ? (stmt.all(afterCursor, limit) as Array<{ id: string; body: string }>)
      : (stmt.all(limit) as Array<{ id: string; body: string }>);
    return Object.freeze(rows.map((r) => Object.freeze({ ...r })));
  }

  /**
   * Phase 115 D-08 — count of vec_memories_v2 rows. Used by the
   * dashboard / `clawcode memory migrate-embeddings status` to surface
   * progress in absolute terms. Mirrors the `vec_memories` count path
   * elsewhere in the file.
   */
  countVecMemoriesV2(): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM vec_memories_v2")
      .get() as { n: number };
    return row.n;
  }

  /**
   * Phase 100-fu — bump access_count + accessed_at for a single memory id.
   *
   * Surfaced because GraphSearch's graph-walked neighbors were returned to
   * callers but never bumped — leaving heavily-linked nodes stuck at
   * access_count=0 forever and unable to qualify for hot-tier promotion
   * (production evidence: fin-client agent had 1,161 of 1,182
   * memories at access_count=0 despite 7,338 wikilink edges).
   *
   * Mirrors the UPDATE shape that SemanticSearch.search() uses on its KNN
   * top-K. Non-existent ids are a silent no-op (UPDATE-WHERE-id=missing
   * affects 0 rows). When `accessedAt` is omitted, defaults to `new Date()`.
   *
   * Callers MUST NOT use this to double-bump a row already bumped by
   * SemanticSearch.search() in the same logical lookup — keep the bump
   * exactly one-per-search-call per memory id.
   */
  bumpAccess(memoryId: string, accessedAt?: string): void {
    this.stmts.bumpAccess.run(
      accessedAt ?? new Date().toISOString(),
      memoryId,
    );
  }

  /**
   * Phase 107 VEC-CLEAN-03 — remove orphan vec_memories entries.
   *
   * Detects rows in `vec_memories` whose `memory_id` is NOT in `memories`
   * (orphans accumulated from historical CHECK-constraint table-recreation
   * migrations at store.ts migrateSchema/migrateEpisodeSource, or any future
   * delete path that bypasses `MemoryStore.delete`). Returns
   * `{ removed, totalAfter }` so the operator sees both the patch count
   * and the post-cleanup `vec_memories` total.
   *
   * Atomicity: DELETE + COUNT run inside a single `db.transaction()`. A
   * mid-transaction throw rolls back the DELETE (regression-tested in
   * `src/memory/__tests__/store-orphan-cleanup.test.ts`).
   *
   * Idempotent: running twice removes 0 the second time.
   *
   * **Directional invariant (CRITICAL — RESEARCH.md pitfall 3):** the
   * SQL only deletes from `vec_memories`, NEVER from `memories`. The
   * cold-archive flow (`episode-archival.ts:53-66`) intentionally leaves
   * `memories` rows present after deleting their `vec_memories` row —
   * that's the OPPOSITE of an orphan (memory present + vec absent), and
   * must be preserved. Reversing the SQL direction would erase
   * cold-archived memories.
   */
  cleanupOrphans(): { removed: number; totalAfter: number } {
    return this.db.transaction(() => {
      const result = this.db
        .prepare(
          "DELETE FROM vec_memories WHERE memory_id NOT IN (SELECT id FROM memories)",
        )
        .run();
      // Phase 115 D-08 — extend orphan cleanup to vec_memories_v2.
      // Same directional invariant: only deletes from `vec_memories_v2`,
      // NEVER from `memories` (cold-archive shape preserved per Phase
      // 107). The v2 cleanup runs in the SAME transaction as v1 cleanup
      // so a mid-cleanup throw rolls back BOTH (regression-pinned by
      // store-orphan-cleanup.test.ts atomic test).
      const v2Result = this.db
        .prepare(
          "DELETE FROM vec_memories_v2 WHERE memory_id NOT IN (SELECT id FROM memories)",
        )
        .run();
      const afterRow = this.db
        .prepare("SELECT COUNT(*) AS n FROM vec_memories")
        .get() as { n: number };
      return {
        // Phase 115 — `removed` is the COMBINED count across v1 + v2 so
        // operator-facing CLI output (`clawcode memory cleanup-orphans`)
        // surfaces total cleanup work done. The `totalAfter` continues to
        // report the v1 count to preserve the pre-115 contract — v2 count
        // is exposed separately via the v2-specific stats path
        // (sub-scope 16c dashboard hook in a later wave).
        removed:
          (result.changes as number) + (v2Result.changes as number),
        totalAfter: afterRow.n,
      };
    })();
  }

  /**
   * Phase 115 D-08 — split cleanupOrphans counter for v2 dashboard wiring.
   * Same DB transaction shape but reports per-table changes for operator
   * visibility (sub-scope 16c). Returns `{ v1Removed, v2Removed, v1Total,
   * v2Total }`. Idempotent. Use this in preference to `cleanupOrphans` when
   * the caller needs per-version counts.
   *
   * Atomicity: BOTH v1 + v2 deletes happen in the same `db.transaction()`.
   * A mid-transaction throw rolls back both (verified by the atomicity
   * regression in `embedding-v2-cascade-delete.test.ts`).
   */
  cleanupOrphansSplit(): {
    v1Removed: number;
    v2Removed: number;
    v1Total: number;
    v2Total: number;
  } {
    return this.db.transaction(() => {
      const v1 = this.db
        .prepare(
          "DELETE FROM vec_memories WHERE memory_id NOT IN (SELECT id FROM memories)",
        )
        .run();
      const v2 = this.db
        .prepare(
          "DELETE FROM vec_memories_v2 WHERE memory_id NOT IN (SELECT id FROM memories)",
        )
        .run();
      const v1Total = (
        this.db
          .prepare("SELECT COUNT(*) AS n FROM vec_memories")
          .get() as { n: number }
      ).n;
      const v2Total = (
        this.db
          .prepare("SELECT COUNT(*) AS n FROM vec_memories_v2")
          .get() as { n: number }
      ).n;
      return {
        v1Removed: v1.changes as number,
        v2Removed: v2.changes as number,
        v1Total,
        v2Total,
      };
    })();
  }

  /**
   * Phase 999.119 — read-only integrity census (see `IntegrityReport`).
   * Safe to run on a live store: SELECT/PRAGMA only. Cost is one scan of
   * memory_links + the vec tables (~100 ms on the largest fleet DB).
   */
  checkIntegrity(): IntegrityReport {
    const count = (sql: string): number => {
      try {
        return (this.db.prepare(sql).get() as { n: number }).n;
      } catch {
        return 0; // table absent on an older schema — nothing to report
      }
    };
    const danglingLinks = count(
      `SELECT COUNT(*) AS n FROM memory_links ml
       WHERE NOT EXISTS (SELECT 1 FROM memories m WHERE m.id = ml.source_id)
          OR NOT EXISTS (SELECT 1 FROM memories m WHERE m.id = ml.target_id)`,
    );
    const danglingSessionSummaries = count(
      `SELECT COUNT(*) AS n FROM conversation_sessions s
       WHERE s.summary_memory_id IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM memories m WHERE m.id = s.summary_memory_id)`,
    );
    const orphanVecV1 = count(
      "SELECT COUNT(*) AS n FROM vec_memories WHERE memory_id NOT IN (SELECT id FROM memories)",
    );
    const orphanVecV2 = count(
      "SELECT COUNT(*) AS n FROM vec_memories_v2 WHERE memory_id NOT IN (SELECT id FROM memories)",
    );
    const orphanChunkVecV1 = count(
      "SELECT COUNT(*) AS n FROM vec_memory_chunks WHERE chunk_id NOT IN (SELECT id FROM memory_chunks)",
    );
    const orphanChunkVecV2 = count(
      "SELECT COUNT(*) AS n FROM vec_memory_chunks_v2 WHERE chunk_id NOT IN (SELECT id FROM memory_chunks)",
    );
    const orphanChunkFts = count(
      "SELECT COUNT(*) AS n FROM memory_chunks_fts WHERE chunk_id NOT IN (SELECT id FROM memory_chunks)",
    );
    let fkViolations = 0;
    try {
      fkViolations = (this.db.pragma("foreign_key_check") as unknown[]).length;
    } catch {
      fkViolations = 0;
    }
    const memoriesWithoutEmbedding = count(
      "SELECT COUNT(*) AS n FROM memories WHERE id NOT IN (SELECT memory_id FROM vec_memories)",
    );
    const total =
      danglingLinks +
      danglingSessionSummaries +
      orphanVecV1 +
      orphanVecV2 +
      orphanChunkVecV1 +
      orphanChunkVecV2 +
      orphanChunkFts;
    return Object.freeze({
      danglingLinks,
      danglingSessionSummaries,
      orphanVecV1,
      orphanVecV2,
      orphanChunkVecV1,
      orphanChunkVecV2,
      orphanChunkFts,
      fkViolations,
      memoriesWithoutEmbedding,
      total,
    });
  }

  /**
   * Phase 999.119 — remove every row class counted by `checkIntegrity()`.
   * One transaction; idempotent; only ever deletes rows that reference a
   * memory/chunk which no longer exists (or NULLs a dangling summary id).
   * NEVER touches `memories` or `memory_chunks` themselves — the
   * directional invariant from Phase 107 (a memory row without a vec row
   * is a legitimate cold-episode shape, not an orphan) is preserved.
   *
   * Runs at daemon boot (`AgentMemoryManager.initMemory`) and before each
   * auto-linker pass, so a manual clean-up that bypassed `delete()` can
   * never wedge the linker for months again (projects: 437 consecutive
   * "FOREIGN KEY constraint failed" runs, 2026-06-14 → 2026-09-05).
   */
  repairIntegrity(): IntegrityRepairResult {
    const run = (sql: string): number => {
      try {
        return this.db.prepare(sql).run().changes;
      } catch {
        return 0; // table absent on an older schema
      }
    };
    return this.db.transaction(() => {
      const danglingLinksRemoved = run(
        `DELETE FROM memory_links
         WHERE NOT EXISTS (SELECT 1 FROM memories m WHERE m.id = memory_links.source_id)
            OR NOT EXISTS (SELECT 1 FROM memories m WHERE m.id = memory_links.target_id)`,
      );
      const sessionSummariesDetached = run(
        `UPDATE conversation_sessions SET summary_memory_id = NULL
         WHERE summary_memory_id IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM memories m WHERE m.id = conversation_sessions.summary_memory_id)`,
      );
      const orphanVecV1Removed = run(
        "DELETE FROM vec_memories WHERE memory_id NOT IN (SELECT id FROM memories)",
      );
      const orphanVecV2Removed = run(
        "DELETE FROM vec_memories_v2 WHERE memory_id NOT IN (SELECT id FROM memories)",
      );
      const orphanChunkVecV1Removed = run(
        "DELETE FROM vec_memory_chunks WHERE chunk_id NOT IN (SELECT id FROM memory_chunks)",
      );
      const orphanChunkVecV2Removed = run(
        "DELETE FROM vec_memory_chunks_v2 WHERE chunk_id NOT IN (SELECT id FROM memory_chunks)",
      );
      const orphanChunkFtsRemoved = run(
        "DELETE FROM memory_chunks_fts WHERE chunk_id NOT IN (SELECT id FROM memory_chunks)",
      );
      const total =
        danglingLinksRemoved +
        sessionSummariesDetached +
        orphanVecV1Removed +
        orphanVecV2Removed +
        orphanChunkVecV1Removed +
        orphanChunkVecV2Removed +
        orphanChunkFtsRemoved;
      return Object.freeze({
        danglingLinksRemoved,
        sessionSummariesDetached,
        orphanVecV1Removed,
        orphanVecV2Removed,
        orphanChunkVecV1Removed,
        orphanChunkVecV2Removed,
        orphanChunkFtsRemoved,
        total,
      });
    })();
  }

  /**
   * Phase 999.119 — best-effort housekeeping after a maintenance cycle:
   * refresh the query planner's statistics for the indexes the tier and
   * linker scans lean on, and fold the WAL back into the main file so it
   * does not grow across a quiet night. Never throws.
   */
  optimize(): void {
    try {
      this.db.pragma("optimize");
    } catch {
      /* best-effort */
    }
    try {
      this.db.pragma("wal_checkpoint(PASSIVE)");
    } catch {
      /* best-effort */
    }
  }

  /**
   * Phase 999.119 — recency touch for memories the pre-turn retriever
   * actually put in front of the model. Updates accessed_at ONLY (not
   * access_count): the relevance-decay clock that drives cold-tiering is
   * reset by real use, while hot-tier promotion by access count stays
   * reserved for explicit lookups + graph centrality (so the five
   * memories retrieved every turn do not crowd the 20-slot hot tier).
   * Pre-999.119 nothing on the retrieval path touched either column —
   * 99.4% of fleet memories sat at access_count=0 with accessed_at ==
   * created_at, so age alone decided what went cold.
   */
  touchAccessedAt(memoryIds: readonly string[], accessedAt?: string): void {
    if (memoryIds.length === 0) return;
    const at = accessedAt ?? new Date().toISOString();
    this.db.transaction(() => {
      for (const id of memoryIds) {
        this.stmts.touchAccessedAt.run(at, id);
      }
    })();
  }

  /**
   * Phase 999.119 — auto-linker scan cursor. Candidates are non-cold
   * memories never scanned (`auto_linked_at IS NULL`, newest first) then
   * memories last scanned before `rescanBefore`. The old candidate rule
   * ("has no outbound auto:similar edge") never advanced: a memory with no
   * neighbour above threshold stayed a candidate forever, so the heartbeat
   * re-scanned the same newest 50 rows every 6 h and never reached the
   * backlog behind them.
   */
  listAutoLinkCandidates(
    limit: number,
    rescanBefore: string,
  ): readonly string[] {
    const rows = this.db
      .prepare(
        `SELECT id FROM memories
         WHERE tier != 'cold'
           AND (auto_linked_at IS NULL OR auto_linked_at < ?)
         ORDER BY (auto_linked_at IS NULL) DESC, created_at DESC
         LIMIT ?`,
      )
      .all(rescanBefore, limit) as ReadonlyArray<{ id: string }>;
    return Object.freeze(rows.map((r) => r.id));
  }

  /** Phase 999.119 — stamp a memory as scanned by the auto-linker. */
  markAutoLinked(memoryId: string, at?: string): void {
    this.stmts.markAutoLinked.run(at ?? new Date().toISOString(), memoryId);
  }

  /**
   * Phase 100-fu — return the number of inbound wikilink edges that
   * point at `memoryId`. Used by the tier manager to detect hub nodes
   * (memories with many backlinks) for graph-centrality promotion.
   *
   * Returns 0 for memories with no backlinks AND for memory IDs that
   * do not exist — both cases produce a single COUNT(*) row of `0`
   * because the WHERE clause matches no rows.
   */
  getBacklinkCount(memoryId: string): number {
    const row = this.stmts.getBacklinkCount.get(memoryId) as
      | { n: number }
      | undefined;
    return row?.n ?? 0;
  }

  /**
   * List memories filtered by tier, ordered by accessed_at descending.
   * Returns a frozen array of MemoryEntry objects.
   */
  listByTier(tier: MemoryTier, limit: number): readonly MemoryEntry[] {
    try {
      const rows = this.db
        .prepare(
          `SELECT id, content, source, updated_at, accessed_at, importance,
                  access_count, tags, created_at, tier, source_turn_ids
           FROM memories WHERE tier = ? ORDER BY accessed_at DESC LIMIT ?`,
        )
        .all(tier, limit) as MemoryRow[];
      return Object.freeze(rows.map(rowToEntry));
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unknown error";
      throw new MemoryError(
        `Failed to list memories by tier ${tier}: ${message}`,
        this.dbPath,
      );
    }
  }

  /**
   * Phase 999.8 follow-up (2026-04-30) — promotion-scan-specific list of
   * warm memories. Orders by inbound backlink count DESC (centrality)
   * with accessed_at DESC as the secondary sort. The vanilla `listByTier`
   * orders only by accessed_at, which biases against rarely-accessed-but-
   * heavily-linked hub memories — exactly the shape Phase 100-fu's
   * centrality-based promotion path targets. Without this, the LIMIT
   * window of `refreshHotTier` keeps surfacing recently-touched memories
   * with low backlink counts and the high-link hubs never get scanned.
   *
   * Used by `TierManager.refreshHotTier`. Not used elsewhere; if a future
   * caller needs hot/cold variants, generalize the orderBy at that point.
   */
  listWarmCandidatesForPromotion(limit: number): readonly TierScanCandidate[] {
    try {
      const rows = this.db
        .prepare(
          `SELECT m.id, m.content, m.source, m.updated_at, m.accessed_at,
                  m.importance, m.access_count, m.tags, m.created_at,
                  m.tier, m.source_turn_ids,
                  COALESCE(lc.backlink_count, 0) AS backlink_count
           FROM memories m
           LEFT JOIN (
             SELECT target_id, COUNT(*) AS backlink_count
             FROM memory_links
             GROUP BY target_id
           ) lc ON lc.target_id = m.id
           WHERE m.tier = 'warm'
           ORDER BY COALESCE(lc.backlink_count, 0) DESC, m.accessed_at DESC
           LIMIT ?`,
        )
        .all(limit) as ScanRow[];
      return Object.freeze(rows.map(rowToScanCandidate));
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unknown error";
      throw new MemoryError(
        `Failed to list warm promotion candidates: ${message}`,
        this.dbPath,
      );
    }
  }

  /**
   * Phase 999.119 — cold-scan candidates: warm memories ordered by
   * accessed_at ASCENDING (least-recently used first) with their inbound
   * link count. The previous scan used `listByTier("warm", 1000)` which
   * orders accessed_at DESC — i.e. the 1,000 memories LEAST eligible for
   * cold — so on any agent with more than 1,000 warm rows the cold pass
   * never reached a single candidate. Oldest-first means each cycle works
   * through the genuinely stale end of the tier.
   */
  listColdArchiveCandidates(limit: number): readonly TierScanCandidate[] {
    try {
      const rows = this.db
        .prepare(
          `SELECT m.id, m.content, m.source, m.updated_at, m.accessed_at,
                  m.importance, m.access_count, m.tags, m.created_at,
                  m.tier, m.source_turn_ids,
                  COALESCE(lc.backlink_count, 0) AS backlink_count
           FROM memories m
           LEFT JOIN (
             SELECT target_id, COUNT(*) AS backlink_count
             FROM memory_links
             GROUP BY target_id
           ) lc ON lc.target_id = m.id
           WHERE m.tier = 'warm'
           ORDER BY m.accessed_at ASC
           LIMIT ?`,
        )
        .all(limit) as ScanRow[];
      return Object.freeze(rows.map(rowToScanCandidate));
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unknown error";
      throw new MemoryError(
        `Failed to list cold archive candidates: ${message}`,
        this.dbPath,
      );
    }
  }

  /**
   * Phase 999.119 — bring cold memories that have been touched since
   * `accessedAfter` (ISO) back to warm. Cold rows stay in SQLite and stay
   * searchable (see TierManager.archiveToCold), so a search hit or a
   * retrieval touch updates accessed_at; this is the lazy re-warm that
   * makes such a hit count again for promotion. Returns rows changed.
   */
  rewarmRecentlyAccessedCold(accessedAfter: string): number {
    try {
      const now = new Date().toISOString();
      const result = this.db
        .prepare(
          `UPDATE memories SET tier = 'warm', updated_at = ?
           WHERE tier = 'cold' AND accessed_at > ?`,
        )
        .run(now, accessedAfter);
      return result.changes;
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unknown error";
      throw new MemoryError(
        `Failed to re-warm recently accessed cold memories: ${message}`,
        this.dbPath,
      );
    }
  }

  /**
   * Update the tier of a memory entry.
   * Returns true if the row was updated, false if not found.
   */
  updateTier(id: string, tier: MemoryTier): boolean {
    try {
      const now = new Date().toISOString();
      const result = this.db
        .prepare("UPDATE memories SET tier = ?, updated_at = ? WHERE id = ?")
        .run(tier, now, id);
      return result.changes > 0;
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unknown error";
      throw new MemoryError(
        `Failed to update tier for ${id}: ${message}`,
        this.dbPath,
      );
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // clawdy-v2 #8 — origin_id-keyed accessors for the iOS cross-session memory
  // REST endpoints. Device memories are stored with origin_id `ios:<uuid>`, so
  // these are scoped to that namespace by the caller (the gateway passes the
  // `ios:%` LIKE pattern / the `ios:`-prefixed origin_id). They never touch the
  // hot insert()/dedup path.
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * List rows whose origin_id matches a LIKE pattern (e.g. `ios:%`), newest
   * first. Returns the minimum shape the gateway round-trips: native fields +
   * origin_id + the opaque metadata blob. The LIKE pattern is caller-supplied
   * and trusted (an internal constant), never end-user input.
   */
  listByOriginPrefix(likePattern: string): ReadonlyArray<{
    id: string;
    content: string;
    createdAt: string;
    updatedAt: string;
    originId: string;
    metadata: string | null;
  }> {
    try {
      const rows = this.db
        .prepare(
          `SELECT id, content, created_at, updated_at, origin_id, metadata
             FROM memories WHERE origin_id LIKE ? ORDER BY created_at DESC`,
        )
        .all(likePattern) as ReadonlyArray<{
        id: string;
        content: string;
        created_at: string;
        updated_at: string;
        origin_id: string;
        metadata: string | null;
      }>;
      return rows.map((r) => ({
        id: r.id,
        content: r.content,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
        originId: r.origin_id,
        metadata: r.metadata,
      }));
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unknown error";
      throw new MemoryError(
        `Failed to list memories by origin prefix: ${message}`,
        this.dbPath,
      );
    }
  }

  /**
   * Update a memory's content by origin_id (the iOS PATCH fact-edit seam).
   * Returns true if a row matched.
   *
   * Deliberately does NOT re-embed — recall is out of scope for the iOS memory
   * phase, so the stale vector is acceptable, documented debt. TODO(recall):
   * re-embed the edited content here when cross-session recall ships.
   */
  updateContentByOriginId(originId: string, content: string): boolean {
    try {
      const now = new Date().toISOString();
      const result = this.db
        .prepare(
          "UPDATE memories SET content = ?, updated_at = ? WHERE origin_id = ?",
        )
        .run(content, now, originId);
      return result.changes > 0;
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unknown error";
      throw new MemoryError(
        `Failed to update content for origin ${originId}: ${message}`,
        this.dbPath,
      );
    }
  }

  /**
   * Attach the opaque metadata blob (the iOS savedAt/context/sourceSessionID
   * JSON) to an already-inserted row, keyed by origin_id. Written as a
   * post-insert UPDATE so the hot insert() path stays untouched. Returns true
   * if a row matched.
   */
  setMetadataByOriginId(originId: string, metadata: string | null): boolean {
    try {
      const result = this.db
        .prepare("UPDATE memories SET metadata = ? WHERE origin_id = ?")
        .run(metadata, originId);
      return result.changes > 0;
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unknown error";
      throw new MemoryError(
        `Failed to set metadata for origin ${originId}: ${message}`,
        this.dbPath,
      );
    }
  }

  /**
   * Delete a memory by origin_id (the iOS "forget" seam), cascading to the vec
   * tables via the existing id-keyed delete(). Returns true if a row matched.
   */
  deleteByOriginId(originId: string): boolean {
    try {
      const row = this.db
        .prepare("SELECT id FROM memories WHERE origin_id = ?")
        .get(originId) as { id: string } | undefined;
      if (!row) return false;
      return this.delete(row.id);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unknown error";
      throw new MemoryError(
        `Failed to delete by origin ${originId}: ${message}`,
        this.dbPath,
      );
    }
  }

  /**
   * Find memories that contain a specific tag in their tags JSON array.
   * Returns a frozen array of frozen MemoryEntry objects.
   */
  findByTag(tag: string): readonly MemoryEntry[] {
    try {
      const rows = this.db.prepare(`
        SELECT m.id, m.content, m.source, m.importance, m.access_count,
               m.tags, m.created_at, m.updated_at, m.accessed_at, m.tier,
               m.source_turn_ids
        FROM memories m, json_each(m.tags) AS t
        WHERE t.value = ?
      `).all(tag) as MemoryRow[];

      return Object.freeze(rows.map(rowToEntry));
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unknown error";
      throw new MemoryError(
        `Failed to find memories by tag ${tag}: ${message}`,
        this.dbPath,
      );
    }
  }

  /** Get prepared statements for graph queries (used by graph module). */
  getGraphStatements(): Pick<PreparedStatements, 'getBacklinks' | 'getForwardLinks' | 'insertLink' | 'deleteLinksFrom' | 'checkMemoryExists'> {
    return this.stmts;
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY,
        content TEXT NOT NULL,
        source TEXT NOT NULL CHECK(source IN ('conversation', 'manual', 'system', 'consolidation', 'episode')),
        importance REAL NOT NULL DEFAULT 0.5 CHECK(importance >= 0.0 AND importance <= 1.0),
        access_count INTEGER NOT NULL DEFAULT 0,
        tags TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        accessed_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS session_logs (
        id TEXT PRIMARY KEY,
        date TEXT NOT NULL,
        file_path TEXT NOT NULL,
        entry_count INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS vec_memories USING vec0(
        memory_id TEXT PRIMARY KEY,
        embedding float[384] distance_metric=cosine
      );
    `);
  }

  /**
   * Migrate existing databases to support the 'consolidation' source value.
   * SQLite CHECK constraints cannot be altered in-place, so we use
   * the standard table recreation pattern inside a transaction.
   */
  private migrateSchema(): void {
    // Test if the current schema already accepts 'consolidation'
    try {
      this.db.exec("SAVEPOINT migration_test");
      try {
        this.db.exec(
          "INSERT INTO memories (id, content, source, importance, tags, created_at, updated_at, accessed_at) VALUES ('__migration_test__', 'test', 'consolidation', 0.5, '[]', '', '', '')",
        );
        // Constraint accepts 'consolidation' -- no migration needed
        this.db.exec("ROLLBACK TO migration_test");
        this.db.exec("RELEASE migration_test");
        return;
      } catch {
        // Constraint rejected 'consolidation' -- need migration
        this.db.exec("ROLLBACK TO migration_test");
        this.db.exec("RELEASE migration_test");
      }
    } catch {
      // Table doesn't exist yet (initSchema will create it)
      return;
    }

    // Recreate table with updated CHECK constraint
    this.db.transaction(() => {
      this.db.exec(`
        CREATE TABLE memories_new (
          id TEXT PRIMARY KEY,
          content TEXT NOT NULL,
          source TEXT NOT NULL CHECK(source IN ('conversation', 'manual', 'system', 'consolidation', 'episode')),
          importance REAL NOT NULL DEFAULT 0.5 CHECK(importance >= 0.0 AND importance <= 1.0),
          access_count INTEGER NOT NULL DEFAULT 0,
          tags TEXT NOT NULL DEFAULT '[]',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          accessed_at TEXT NOT NULL
        );
        INSERT INTO memories_new SELECT * FROM memories;
        DROP TABLE memories;
        ALTER TABLE memories_new RENAME TO memories;
      `);
    })();
  }

  /**
   * Migrate existing databases to add the tier column.
   * Uses PRAGMA table_info to detect if column already exists.
   */
  private migrateTierColumn(): void {
    const columns = this.db
      .prepare("PRAGMA table_info(memories)")
      .all() as ReadonlyArray<{ name: string }>;
    const hasTier = columns.some((c) => c.name === "tier");

    if (!hasTier) {
      this.db.exec(
        "ALTER TABLE memories ADD COLUMN tier TEXT NOT NULL DEFAULT 'warm' CHECK(tier IN ('hot', 'warm', 'cold'))",
      );
    }
  }

  /**
   * Migrate existing databases to accept the 'episode' source value.
   * Uses the same savepoint-test pattern as migrateSchema().
   */
  private migrateEpisodeSource(): void {
    try {
      this.db.exec("SAVEPOINT episode_migration_test");
      try {
        this.db.exec(
          "INSERT INTO memories (id, content, source, importance, tags, created_at, updated_at, accessed_at, tier) VALUES ('__episode_migration_test__', 'test', 'episode', 0.5, '[]', '', '', '', 'warm')",
        );
        // Constraint accepts 'episode' -- no migration needed
        this.db.exec("ROLLBACK TO episode_migration_test");
        this.db.exec("RELEASE episode_migration_test");
        return;
      } catch {
        // Constraint rejected 'episode' -- need migration
        this.db.exec("ROLLBACK TO episode_migration_test");
        this.db.exec("RELEASE episode_migration_test");
      }
    } catch {
      return;
    }

    // Recreate table with updated CHECK constraint including 'episode'
    this.db.transaction(() => {
      this.db.exec(`
        CREATE TABLE memories_new (
          id TEXT PRIMARY KEY,
          content TEXT NOT NULL,
          source TEXT NOT NULL CHECK(source IN ('conversation', 'manual', 'system', 'consolidation', 'episode')),
          importance REAL NOT NULL DEFAULT 0.5 CHECK(importance >= 0.0 AND importance <= 1.0),
          access_count INTEGER NOT NULL DEFAULT 0,
          tags TEXT NOT NULL DEFAULT '[]',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          accessed_at TEXT NOT NULL,
          tier TEXT NOT NULL DEFAULT 'warm' CHECK(tier IN ('hot', 'warm', 'cold'))
        );
        INSERT INTO memories_new SELECT * FROM memories;
        DROP TABLE memories;
        ALTER TABLE memories_new RENAME TO memories;
      `);
    })();
  }

  /**
   * Migrate existing databases to add the memory_links graph table.
   * Creates an adjacency list with CASCADE foreign keys for edge cleanup.
   */
  private migrateGraphLinks(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memory_links (
        source_id TEXT NOT NULL,
        target_id TEXT NOT NULL,
        link_text TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (source_id, target_id),
        FOREIGN KEY (source_id) REFERENCES memories(id) ON DELETE CASCADE,
        FOREIGN KEY (target_id) REFERENCES memories(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_memory_links_target
        ON memory_links(target_id);
    `);
  }

  /**
   * Migrate existing databases to add conversation_sessions and conversation_turns tables.
   * Uses idempotent CREATE TABLE IF NOT EXISTS + CREATE INDEX IF NOT EXISTS.
   *
   * conversation_sessions tracks agent interaction lifecycles with status CHECK constraint.
   * conversation_turns stores individual turns with provenance fields (SEC-01).
   */
  private migrateConversationTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS conversation_sessions (
        id TEXT PRIMARY KEY,
        agent_name TEXT NOT NULL,
        started_at TEXT NOT NULL,
        ended_at TEXT,
        turn_count INTEGER NOT NULL DEFAULT 0,
        total_tokens INTEGER NOT NULL DEFAULT 0,
        summary_memory_id TEXT,
        status TEXT NOT NULL DEFAULT 'active'
          CHECK(status IN ('active', 'ended', 'crashed', 'summarized')),
        FOREIGN KEY (summary_memory_id) REFERENCES memories(id)
      );
      CREATE INDEX IF NOT EXISTS idx_sessions_agent
        ON conversation_sessions(agent_name);
      CREATE INDEX IF NOT EXISTS idx_sessions_status
        ON conversation_sessions(status);
      CREATE INDEX IF NOT EXISTS idx_sessions_started
        ON conversation_sessions(started_at);

      CREATE TABLE IF NOT EXISTS conversation_turns (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        turn_index INTEGER NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'system')),
        content TEXT NOT NULL,
        token_count INTEGER,
        channel_id TEXT,
        discord_user_id TEXT,
        discord_message_id TEXT,
        is_trusted_channel INTEGER NOT NULL DEFAULT 0,
        origin TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY (session_id) REFERENCES conversation_sessions(id)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_turns_session_order
        ON conversation_turns(session_id, turn_index, role);
      CREATE INDEX IF NOT EXISTS idx_turns_session
        ON conversation_turns(session_id, turn_index);
      CREATE INDEX IF NOT EXISTS idx_turns_created
        ON conversation_turns(created_at);
      CREATE INDEX IF NOT EXISTS idx_turns_channel
        ON conversation_turns(channel_id);
      CREATE INDEX IF NOT EXISTS idx_turns_user
        ON conversation_turns(discord_user_id);
    `);
  }

  /**
   * Migrate existing databases to add source_turn_ids column to memories table.
   * Uses PRAGMA table_info check pattern (same as migrateTierColumn).
   * Column is nullable TEXT (JSON array of turn IDs) for CONV-03 lineage tracking.
   */
  private migrateSourceTurnIds(): void {
    const columns = this.db
      .prepare("PRAGMA table_info(memories)")
      .all() as ReadonlyArray<{ name: string }>;
    const hasColumn = columns.some((c) => c.name === "source_turn_ids");
    if (!hasColumn) {
      this.db.exec(
        "ALTER TABLE memories ADD COLUMN source_turn_ids TEXT DEFAULT NULL"
      );
    }
  }

  /**
   * Migrate existing databases to add instruction_flags column to conversation_turns.
   * Uses PRAGMA table_info check pattern (same as migrateSourceTurnIds).
   * Column is nullable TEXT (JSON string of InstructionDetectionResult) for SEC-02 flagging.
   */
  private migrateInstructionFlags(): void {
    const columns = this.db
      .prepare("PRAGMA table_info(conversation_turns)")
      .all() as ReadonlyArray<{ name: string }>;
    const hasColumn = columns.some((c) => c.name === "instruction_flags");
    if (!hasColumn) {
      this.db.exec(
        "ALTER TABLE conversation_turns ADD COLUMN instruction_flags TEXT DEFAULT NULL"
      );
    }
  }

  /**
   * Phase 68 — RETR-02. Create FTS5 full-text index over conversation_turns.content
   * in external-content mode, plus AI/AD/AU triggers for automatic synchronization,
   * plus a one-shot backfill gated on sqlite_master lookup for idempotency across
   * daemon restarts (Pitfall 2: unconditional backfill would double-index on every
   * startup). Tokenizer: `unicode61 remove_diacritics 2` (SQLite default — handles
   * English safely without stemming; if agents report recall gaps during dogfooding,
   * swap to `porter unicode61` via a follow-up migration).
   *
   * External-content mode (`content='conversation_turns'`) avoids duplicating the
   * `content` text — FTS5 stores only tokens and looks up the original row by
   * rowid. Triggers run inside SQLite's transaction boundary so zero code changes
   * are required in `ConversationStore.recordTurn` / `DELETE` / `UPDATE` paths.
   */
  private migrateConversationTurnsFts(): void {
    const existing = this.db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='conversation_turns_fts'",
      )
      .get();
    const needsBackfill = !existing;

    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS conversation_turns_fts USING fts5(
        content,
        content='conversation_turns',
        content_rowid='rowid',
        tokenize='unicode61 remove_diacritics 2'
      );

      CREATE TRIGGER IF NOT EXISTS conversation_turns_ai
      AFTER INSERT ON conversation_turns BEGIN
        INSERT INTO conversation_turns_fts(rowid, content)
          VALUES (new.rowid, new.content);
      END;

      CREATE TRIGGER IF NOT EXISTS conversation_turns_ad
      AFTER DELETE ON conversation_turns BEGIN
        INSERT INTO conversation_turns_fts(conversation_turns_fts, rowid, content)
          VALUES ('delete', old.rowid, old.content);
      END;

      CREATE TRIGGER IF NOT EXISTS conversation_turns_au
      AFTER UPDATE ON conversation_turns BEGIN
        INSERT INTO conversation_turns_fts(conversation_turns_fts, rowid, content)
          VALUES ('delete', old.rowid, old.content);
        INSERT INTO conversation_turns_fts(rowid, content)
          VALUES (new.rowid, new.content);
      END;
    `);

    if (needsBackfill) {
      // One-shot backfill so turns recorded BEFORE this migration ran (Phase 64/65
      // era rows under an older schema) become searchable on the first post-upgrade
      // daemon boot. Guarded by the sqlite_master existence check above — running
      // this on every construction would produce O(n²) duplicates.
      this.db.exec(`
        INSERT INTO conversation_turns_fts(rowid, content)
          SELECT rowid, content FROM conversation_turns;
      `);
    }
  }

  /**
   * Phase 999.42 capability A (Hermes-parity durable session archive) —
   * CONTEXT D1 + D3.
   *
   * Creates the `session_archive` base table and its external-content
   * `session_archive_fts` FTS5 index. Unlike `conversation_turns_fts`,
   * `session_archive.full_text` is a denormalized copy of the raw turn
   * content that SURVIVES the consolidation prune: `summarizeSession`
   * calls `deleteTurnsForSession`, whose `conversation_turns_ad` trigger
   * wipes the matching `conversation_turns_fts` rows. A view over the
   * turn-level index therefore cannot give durable cross-session search;
   * a separate base table is the only design that does.
   *
   * No one-shot backfill here — `session_archive` starts empty. Plan 02
   * owns population (the `summarizeSession` call-site write + the
   * pre-existing-session backfill). Plan 03 owns retrieval.
   *
   * `has_untrusted_turn` is the SEC-01 carry-through: an
   * `archived_from='full'` row carries RAW turn text — a stronger
   * prompt-injection vector than the Haiku-paraphrased session summary.
   * The column is 1 iff ANY archived turn came from an untrusted
   * channel; Plan 03's `searchArchive` default-excludes those rows,
   * mirroring the Phase 68 `searchTurns includeUntrustedChannels:false`
   * hardening. The column lands NOW so it never needs a later migration.
   *
   * Idempotent — every statement is `CREATE ... IF NOT EXISTS`, so a
   * daemon re-boot is a no-op (no duplicate tables, no duplicate
   * triggers). Mirrors the `migrateConversationTurnsFts` /
   * `migrateMemoryChunkTables` discipline.
   */
  private migrateSessionArchiveTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS session_archive (
        session_id         TEXT PRIMARY KEY
                             REFERENCES conversation_sessions(id),
        agent_name         TEXT NOT NULL,
        started_at         TEXT,
        ended_at           TEXT,
        turn_count         INTEGER,
        total_tokens       INTEGER,
        summary_memory_id  TEXT,
        archived_at        TEXT NOT NULL,
        archived_from      TEXT NOT NULL
                             CHECK(archived_from IN ('full', 'summary-only')),
        has_untrusted_turn INTEGER NOT NULL DEFAULT 0,
        full_text          TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_session_archive_agent
        ON session_archive(agent_name);
      CREATE INDEX IF NOT EXISTS idx_session_archive_archived
        ON session_archive(archived_at);

      CREATE VIRTUAL TABLE IF NOT EXISTS session_archive_fts USING fts5(
        full_text,
        content='session_archive',
        content_rowid='rowid',
        tokenize='unicode61 remove_diacritics 2'
      );

      CREATE TRIGGER IF NOT EXISTS session_archive_ai
      AFTER INSERT ON session_archive BEGIN
        INSERT INTO session_archive_fts(rowid, full_text)
          VALUES (new.rowid, new.full_text);
      END;

      CREATE TRIGGER IF NOT EXISTS session_archive_ad
      AFTER DELETE ON session_archive BEGIN
        INSERT INTO session_archive_fts(session_archive_fts, rowid, full_text)
          VALUES ('delete', old.rowid, old.full_text);
      END;

      CREATE TRIGGER IF NOT EXISTS session_archive_au
      AFTER UPDATE ON session_archive BEGIN
        INSERT INTO session_archive_fts(session_archive_fts, rowid, full_text)
          VALUES ('delete', old.rowid, old.full_text);
        INSERT INTO session_archive_fts(rowid, full_text)
          VALUES (new.rowid, new.full_text);
      END;
    `);
  }

  /**
   * Phase 69 — OPENAI-05. Per-bearer-key → Claude-session mapping lives in
   * each agent's memories.db so it survives daemon restarts alongside the
   * conversation sessions themselves.
   *
   * Quick task 260419-p51 (P51-SESSION-ISOLATION) — bumps the schema to v2
   * with composite PK `(key_hash, agent_name)`. Multi-agent bearer keys
   * carry independent session rows per agent; legacy pinned keys preserve
   * their single-agent mapping.
   *
   * Migration flow (wrapped in a transaction for atomicity):
   *   1. Create v1 table (idempotent) — kept as a tombstone for one release
   *      cycle so a downgrade doesn't lose data.
   *   2. Create v2 table (idempotent).
   *   3. If v2 is empty AND v1 has rows, copy v1 → v2 exactly once (the
   *      "v2 empty?" check is the idempotency guard — on the second boot
   *      v2 already has rows and the copy is skipped).
   */
  private migrateApiKeySessionsTable(): void {
    this.db.transaction(() => {
      // v1 — legacy tombstone (still created so the `INSERT...SELECT` below
      // always has a source table even on greenfield DBs).
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS api_key_sessions (
          key_hash      TEXT PRIMARY KEY,
          agent_name    TEXT NOT NULL,
          session_id    TEXT NOT NULL,
          created_at    INTEGER NOT NULL,
          last_used_at  INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_api_key_sessions_agent ON api_key_sessions(agent_name);
      `);
      // v2 — composite PK (key_hash, agent_name).
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS api_key_sessions_v2 (
          key_hash      TEXT NOT NULL,
          agent_name    TEXT NOT NULL,
          session_id    TEXT NOT NULL,
          created_at    INTEGER NOT NULL,
          last_used_at  INTEGER NOT NULL,
          PRIMARY KEY(key_hash, agent_name)
        );
        CREATE INDEX IF NOT EXISTS idx_api_key_sessions_v2_agent ON api_key_sessions_v2(agent_name);
      `);
      // One-shot copy from v1 → v2, guarded by "v2 empty?". Once a v2 row
      // lands (either from this copy or from a fresh driver write), this
      // branch never re-runs on subsequent boots.
      const alreadyMigrated = this.db
        .prepare("SELECT 1 FROM api_key_sessions_v2 LIMIT 1")
        .get();
      if (!alreadyMigrated) {
        this.db.exec(`
          INSERT OR IGNORE INTO api_key_sessions_v2
            (key_hash, agent_name, session_id, created_at, last_used_at)
          SELECT key_hash, agent_name, session_id, created_at, last_used_at
          FROM api_key_sessions
        `);
      }
    })();
  }

  /**
   * Phase 80 MEM-02 — add `origin_id TEXT` column + UNIQUE partial index to
   * memories. Idempotent: PRAGMA-check pattern identical to
   * migrateSourceTurnIds. UNIQUE index uses WHERE origin_id IS NOT NULL so
   * pre-existing rows (NULL) coexist — SQLite already treats NULLs as
   * non-equal for plain UNIQUE, but the partial index makes the intent
   * explicit and slightly reduces index size. CREATE UNIQUE INDEX IF NOT
   * EXISTS guards re-opens.
   */
  private migrateOriginIdColumn(): void {
    const columns = this.db
      .prepare("PRAGMA table_info(memories)")
      .all() as ReadonlyArray<{ name: string }>;
    const hasColumn = columns.some((c) => c.name === "origin_id");
    if (!hasColumn) {
      this.db.exec(
        "ALTER TABLE memories ADD COLUMN origin_id TEXT DEFAULT NULL",
      );
    }
    this.db.exec(
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_memories_origin_id ON memories(origin_id) WHERE origin_id IS NOT NULL",
    );
  }

  /**
   * clawdy-v2 #8 — additive nullable `metadata` column (opaque per-entry JSON
   * blob). Mirrors migrateOriginIdColumn's PRAGMA-check + ALTER pattern:
   * idempotent across re-opens, nullable so every existing row coexists, and
   * read/written by NO existing code path (rowToEntry ignores it, no query
   * references it) — minimal blast radius. Used only by the iOS memory REST
   * gateway to round-trip savedAt/context/sourceSessionID without polluting the
   * `tags` column (which findByTag matches with LIKE '%tag%').
   */
  private migrateMetadataColumn(): void {
    const columns = this.db
      .prepare("PRAGMA table_info(memories)")
      .all() as ReadonlyArray<{ name: string }>;
    if (!columns.some((c) => c.name === "metadata")) {
      this.db.exec("ALTER TABLE memories ADD COLUMN metadata TEXT DEFAULT NULL");
    }
  }

  /**
   * Phase 90 MEM-02 — workspace memory file chunks + embeddings + FTS index.
   *
   * Four new tables, all idempotent via CREATE {TABLE,VIRTUAL TABLE,INDEX}
   * IF NOT EXISTS (matches migrateConversationTables discipline). Owned by
   * Plan 90-02 and consumed by memory-scanner.ts (upserts) +
   * memory-retrieval.ts (hybrid RRF lookup).
   *
   *   memory_files       — idempotency ledger keyed by absolute path.
   *                        Tracks mtime + sha256 so the scanner can skip
   *                        re-embedding files whose content hasn't changed.
   *   memory_chunks      — one row per H2 chunk (per chunkMarkdownByH2).
   *                        Stores heading + body + file_mtime_ms for the
   *                        D-24 time-window filter.
   *   vec_memory_chunks  — sqlite-vec virtual table (384-dim float32 cosine)
   *                        mirroring vec_memories' shape. One row per chunk.
   *   memory_chunks_fts  — FTS5 virtual table over heading + body. Keyed by
   *                        chunk_id (UNINDEXED) so the hybrid retrieval path
   *                        can join vec results → FTS results by chunk_id.
   *                        content='' (contentless mode) — we write the
   *                        body text directly, no trigger sync needed.
   */
  private migrateMemoryChunks(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memory_files (
        path          TEXT PRIMARY KEY,
        mtime_ms      INTEGER NOT NULL,
        sha256        TEXT NOT NULL,
        chunk_count   INTEGER NOT NULL,
        indexed_at    TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS memory_chunks (
        id             TEXT PRIMARY KEY,
        path           TEXT NOT NULL,
        chunk_index    INTEGER NOT NULL,
        heading        TEXT,
        body           TEXT NOT NULL,
        token_count    INTEGER NOT NULL,
        score_weight   REAL NOT NULL DEFAULT 0.0,
        file_mtime_ms  INTEGER NOT NULL,
        created_at     TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_memory_chunks_path ON memory_chunks(path);
      CREATE VIRTUAL TABLE IF NOT EXISTS vec_memory_chunks USING vec0(
        chunk_id TEXT PRIMARY KEY,
        embedding float[384] distance_metric=cosine
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS memory_chunks_fts USING fts5(
        chunk_id UNINDEXED,
        heading,
        body,
        tokenize='porter unicode61 remove_diacritics 2'
      );
    `);
    this.ensurePorterChunkFts();
  }

  /**
   * Phase 999.187 — rebuild `memory_chunks_fts` with the `porter` tokenizer
   * when an older DB still carries the Phase 90 `unicode61`-only index.
   * Text-only (no re-embedding): DROP, CREATE, re-insert from memory_chunks.
   * Runs once per DB; every later boot sees `porter` in sqlite_master and
   * returns immediately.
   */
  private ensurePorterChunkFts(): void {
    const row = this.db
      .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='memory_chunks_fts'")
      .get() as { sql: string } | undefined;
    if (!row || /porter/i.test(row.sql)) return;
    this.db.transaction(() => {
      this.db.exec(`
        DROP TABLE memory_chunks_fts;
        CREATE VIRTUAL TABLE memory_chunks_fts USING fts5(
          chunk_id UNINDEXED,
          heading,
          body,
          tokenize='porter unicode61 remove_diacritics 2'
        );
        INSERT INTO memory_chunks_fts (chunk_id, heading, body)
          SELECT id, COALESCE(heading, ''), body FROM memory_chunks;
      `);
    })();
  }

  /**
   * Phase 999.187 — keyword index over the agent's own saved memories
   * (`memories.content`). The memories side of hybrid retrieval was vector-
   * only, so an exact name, ticker or product code in a saved memory could
   * not be found by keyword. Standalone FTS5 keyed by memory_id (not rowid,
   * which the table-rebuild migrations above do not preserve), kept in sync
   * by triggers; backfilled once when first created. Triggers are re-asserted
   * on every boot so a future `memories` rebuild cannot silently drop them.
   */
  private migrateMemoriesFts(): void {
    const existing = this.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='memories_fts'")
      .get();
    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
        memory_id UNINDEXED,
        content,
        tokenize='porter unicode61 remove_diacritics 2'
      );
      CREATE TRIGGER IF NOT EXISTS memories_fts_ai AFTER INSERT ON memories BEGIN
        INSERT INTO memories_fts (memory_id, content) VALUES (new.id, new.content);
      END;
      CREATE TRIGGER IF NOT EXISTS memories_fts_ad AFTER DELETE ON memories BEGIN
        DELETE FROM memories_fts WHERE memory_id = old.id;
      END;
      CREATE TRIGGER IF NOT EXISTS memories_fts_au AFTER UPDATE OF content ON memories BEGIN
        DELETE FROM memories_fts WHERE memory_id = old.id;
        INSERT INTO memories_fts (memory_id, content) VALUES (new.id, new.content);
      END;
    `);
    if (!existing) {
      this.db.exec(`
        INSERT INTO memories_fts (memory_id, content)
          SELECT id, content FROM memories;
      `);
    }
  }

  /**
   * Phase 115 D-06 + D-07 + D-08 — additive embedding-v2 schema.
   *
   * Adds three things, all idempotent (`IF NOT EXISTS`):
   *
   *   1. `vec_memories_v2`        — sqlite-vec virtual table for the
   *                                 bge-small-en-v1.5 + int8 quantized
   *                                 embeddings. Mirrors `vec_memories`
   *                                 shape (one row per memory_id, 384-dim)
   *                                 but with `int8[384]` column type.
   *   2. `vec_memory_chunks_v2`   — same shape for chunks (one row per
   *                                 chunk_id, 384-dim int8). Mirrors
   *                                 `vec_memory_chunks`.
   *   3. `migrations` table       — per-agent state machine state for the
   *                                 embedding-v2 migration. One row per
   *                                 migration `key` (e.g.
   *                                 `embeddingV2.<agentName>` — for
   *                                 per-agent DBs the agent prefix is
   *                                 implicit since the DB IS per-agent).
   *
   * Phase 107 VEC-CLEAN-* invariant preserved — see the updated `delete()`
   * (memory cascade) + `deleteMemoryChunksByPath()` (chunk cascade) + the
   * extended `cleanupOrphans()` (now scans both v1 and v2 vec tables).
   *
   * The `migrations` table lives in each agent's per-agent DB (NOT in a
   * shared manager DB) per Phase 90's per-agent isolation lock. This makes
   * pause / status / rollback all per-agent operations.
   */
  private migrateEmbeddingV2Tables(): void {
    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS vec_memories_v2 USING vec0(
        memory_id TEXT PRIMARY KEY,
        embedding int8[384] distance_metric=cosine
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS vec_memory_chunks_v2 USING vec0(
        chunk_id TEXT PRIMARY KEY,
        embedding int8[384] distance_metric=cosine
      );
      CREATE TABLE IF NOT EXISTS migrations (
        key                  TEXT PRIMARY KEY,
        phase                TEXT NOT NULL,
        progress_processed   INTEGER NOT NULL DEFAULT 0,
        progress_total       INTEGER NOT NULL DEFAULT 0,
        last_cursor          TEXT,
        started_at           TEXT,
        completed_at         TEXT,
        metadata             TEXT
      );
    `);
  }

  /**
   * Phase 999.119 — maintenance columns + indexes. All idempotent.
   *
   *   - `memories.auto_linked_at` — auto-linker scan cursor. Backfilled
   *     once from `created_at` for rows that already carry an outbound
   *     `auto:similar` edge, so the first post-upgrade heartbeat only
   *     scans the genuine backlog instead of re-walking every memory.
   *   - `idx_memories_tier_accessed` — the tier scans filter on tier and
   *     order by accessed_at; without this they sort the whole table.
   *   - `idx_memories_auto_linked` — cursor lookups.
   *   - `idx_sessions_summary_memory` — the delete-time summary detach
   *     is a point lookup instead of a scan of conversation_sessions.
   */
  private migrateMaintenanceColumns(): void {
    const columns = this.db
      .prepare("PRAGMA table_info(memories)")
      .all() as ReadonlyArray<{ name: string }>;
    const hasCursor = columns.some((c) => c.name === "auto_linked_at");
    if (!hasCursor) {
      this.db.transaction(() => {
        this.db.exec(
          "ALTER TABLE memories ADD COLUMN auto_linked_at TEXT DEFAULT NULL",
        );
        this.db.exec(
          `UPDATE memories SET auto_linked_at = created_at
           WHERE EXISTS (
             SELECT 1 FROM memory_links ml
             WHERE ml.source_id = memories.id AND ml.link_text = 'auto:similar'
           )`,
        );
      })();
    }
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_memories_tier_accessed
        ON memories(tier, accessed_at);
      CREATE INDEX IF NOT EXISTS idx_memories_auto_linked
        ON memories(auto_linked_at);
      CREATE INDEX IF NOT EXISTS idx_sessions_summary_memory
        ON conversation_sessions(summary_memory_id);
    `);
  }

  /**
   * Phase 90 MEM-02 — insert one chunk row across all four memory-chunk
   * tables atomically (wrapped in a transaction). Returns the generated
   * chunk id so callers (memory-scanner) can log / cross-reference.
   *
   * memory_files is upserted: the first chunk for a given path initializes
   * chunk_count=1 + sha/mtime; subsequent chunks for the same path bump
   * chunk_count. Callers that are re-indexing MUST call
   * deleteMemoryChunksByPath(path) first to avoid double-counting.
   */
  insertMemoryChunk(input: Readonly<{
    path: string;
    chunkIndex: number;
    heading: string | null;
    body: string;
    tokenCount: number;
    scoreWeight: number;
    fileMtimeMs: number;
    fileSha256: string;
    embedding: Float32Array;
  }>): string {
    const chunkId = nanoid();
    const now = new Date().toISOString();
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO memory_files (path, mtime_ms, sha256, chunk_count, indexed_at)
           VALUES (?, ?, ?, 1, ?)
           ON CONFLICT(path) DO UPDATE SET
             mtime_ms   = excluded.mtime_ms,
             sha256     = excluded.sha256,
             chunk_count = memory_files.chunk_count + 1,
             indexed_at = excluded.indexed_at`,
        )
        .run(input.path, input.fileMtimeMs, input.fileSha256, now);

      this.db
        .prepare(
          `INSERT INTO memory_chunks
             (id, path, chunk_index, heading, body, token_count, score_weight, file_mtime_ms, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          chunkId,
          input.path,
          input.chunkIndex,
          input.heading,
          input.body,
          input.tokenCount,
          input.scoreWeight,
          input.fileMtimeMs,
          now,
        );

      this.db
        .prepare(
          `INSERT INTO vec_memory_chunks (chunk_id, embedding) VALUES (?, ?)`,
        )
        .run(chunkId, input.embedding);

      this.db
        .prepare(
          `INSERT INTO memory_chunks_fts (chunk_id, heading, body) VALUES (?, ?, ?)`,
        )
        .run(chunkId, input.heading ?? "", input.body);
    })();
    // Phase 141 — best-effort v2 dual-write for the just-committed chunk
    // (mirrors the memory insert hook). No-op when unwired (CLI/import paths).
    if (this.chunkEmbeddingV2Hook) {
      this.chunkEmbeddingV2Hook(chunkId, input.body);
    }
    return chunkId;
  }

  /**
   * Phase 90 MEM-02 — remove every chunk row for `path` across the four
   * tables. Returns the number of rows deleted from memory_chunks
   * (source-of-truth count). vec_memory_chunks + memory_chunks_fts are
   * cleaned by joining on the set of chunk_ids found for the path.
   */
  deleteMemoryChunksByPath(path: string): number {
    return this.db.transaction(() => {
      const ids = this.db
        .prepare(`SELECT id FROM memory_chunks WHERE path = ?`)
        .all(path) as Array<{ id: string }>;
      for (const { id } of ids) {
        this.db
          .prepare(`DELETE FROM vec_memory_chunks WHERE chunk_id = ?`)
          .run(id);
        // Phase 115 D-08 — cascade chunk delete to v2 vec table inside
        // the same transaction. Phase 107 atomic-cascade invariant
        // preserved across BOTH v1 and v2 chunk vec tables. Idempotent
        // (DELETE-WHERE-no-match is a 0-row no-op for chunks that don't
        // yet have a v2 vector — pre-dual-write entries).
        this.db
          .prepare(`DELETE FROM vec_memory_chunks_v2 WHERE chunk_id = ?`)
          .run(id);
        this.db
          .prepare(`DELETE FROM memory_chunks_fts WHERE chunk_id = ?`)
          .run(id);
      }
      const info = this.db
        .prepare(`DELETE FROM memory_chunks WHERE path = ?`)
        .run(path);
      this.db.prepare(`DELETE FROM memory_files WHERE path = ?`).run(path);
      return info.changes as number;
    })();
  }

  /**
   * List the most recent memory_chunks rows ordered by file_mtime_ms DESC.
   * Returns the shape consumed by the dream-pass prompt builder
   * (`{id, path, body, lastModified: Date}`); rowid is the secondary sort
   * key so chunks of the same file land in deterministic order.
   */
  listRecentMemoryChunks(limit: number): readonly Readonly<{
    id: string;
    path: string;
    body: string;
    lastModified: Date;
  }>[] {
    try {
      const rows = this.db
        .prepare(
          `SELECT id, path, body, file_mtime_ms
             FROM memory_chunks
             ORDER BY file_mtime_ms DESC, rowid DESC
             LIMIT ?`,
        )
        .all(limit) as ReadonlyArray<{
        id: string;
        path: string;
        body: string;
        file_mtime_ms: number;
      }>;
      return Object.freeze(
        rows.map((r) =>
          Object.freeze({
            id: r.id,
            path: r.path,
            body: r.body,
            lastModified: new Date(r.file_mtime_ms),
          }),
        ),
      );
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unknown error";
      throw new MemoryError(
        `Failed to list recent memory chunks: ${message}`,
        this.dbPath,
      );
    }
  }

  /**
   * Phase 90 MEM-02 — idempotency gate for the scanner. Returns the stored
   * sha256 for `path` so the scanner can skip re-embedding when the file
   * content hasn't changed (big win for backfill runs).
   */
  getMemoryFileSha256(path: string): string | null {
    const row = this.db
      .prepare(`SELECT sha256 FROM memory_files WHERE path = ?`)
      .get(path) as { sha256: string } | undefined;
    return row ? row.sha256 : null;
  }

  /**
   * Phase 90 MEM-03 — cosine-similarity top-K over vec_memory_chunks. Used
   * by memory-retrieval.ts as one of the two RRF ranker inputs. Returns
   * chunk_id + distance (smaller = more similar).
   */
  searchMemoryChunksVec(
    queryEmbedding: Float32Array | QueryVector,
    limit: number,
  ): ReadonlyArray<Readonly<{ chunk_id: string; distance: number }>> {
    type Row = { chunk_id: string; distance: number };
    const q = toQueryVector(queryEmbedding);
    // Phase 999.119 v2 switch — see searchMemoriesVec.
    if (q.version === "v2") {
      const rows = this.db
        .prepare(
          `SELECT chunk_id, distance FROM vec_memory_chunks_v2
           WHERE embedding MATCH vec_int8(?) AND k = ? ORDER BY distance`,
        )
        .all(int8ToBuffer(q.vector), limit) as Row[];
      return rows.map((r) => ({ ...r, distance: normalizeDistance(r.distance, "v2") }));
    }
    return this.db
      .prepare(
        `SELECT chunk_id, distance FROM vec_memory_chunks
         WHERE embedding MATCH ? AND k = ? ORDER BY distance`,
      )
      .all(q.vector, limit) as Row[];
  }

  /**
   * Phase 90 MEM-03 — FTS5 top-K over memory_chunks_fts. MATCH syntax is
   * a plain token search ("zaid investment" finds docs containing both
   * tokens by default with AND semantics). Returns chunk_id + rank (more
   * negative = better match per FTS5 convention).
   */
  searchMemoryChunksFts(
    query: string,
    limit: number,
  ): ReadonlyArray<Readonly<{ chunk_id: string; rank: number }>> {
    // Phase 999.187 — OR-of-quoted-terms with stopwords removed (see
    // fts-query.ts). The raw message under FTS5's implicit AND matched
    // nothing for any multi-word question.
    const match = buildFtsMatchQuery(query);
    if (!match) return [];
    try {
      return this.db
        .prepare(
          `SELECT chunk_id, rank FROM memory_chunks_fts
           WHERE memory_chunks_fts MATCH ? ORDER BY rank LIMIT ?`,
        )
        .all(match, limit) as ReadonlyArray<{ chunk_id: string; rank: number }>;
    } catch {
      return [];
    }
  }

  /**
   * Phase 999.187 — FTS5 top-K over `memories_fts` (the agent's saved
   * memories). Sibling of searchMemoryChunksFts; fused with the vector side
   * in retrieveMemoryChunks. rank: more negative = better (FTS5 bm25).
   */
  searchMemoriesFts(
    query: string,
    limit: number,
  ): ReadonlyArray<Readonly<{ memory_id: string; rank: number }>> {
    const match = buildFtsMatchQuery(query);
    if (!match) return [];
    try {
      return this.db
        .prepare(
          `SELECT memory_id, rank FROM memories_fts
           WHERE memories_fts MATCH ? ORDER BY rank LIMIT ?`,
        )
        .all(match, limit) as ReadonlyArray<{ memory_id: string; rank: number }>;
    } catch {
      return [];
    }
  }

  /**
   * Phase 100-fu — cosine-similarity top-K over `vec_memories` (the agent's
   * own saved memories — written by memory_save / memory.insert). Sibling
   * to searchMemoryChunksVec, used by retrieveMemoryChunks for the
   * memories-table fan-out so conversational memory is auto-injected into
   * the pre-turn <memory-context> block instead of waiting for an explicit
   * memory_lookup tool call.
   *
   * Returns memory_id + distance (smaller = more similar). The vec_memories
   * table is created in initSchema (line ~597) — no new infra needed.
   */
  searchMemoriesVec(
    queryEmbedding: Float32Array | QueryVector,
    limit: number,
  ): ReadonlyArray<
    Readonly<{
      memory_id: string;
      /** Cosine distance on the v1 scale, whichever table served it. */
      distance: number;
      /** Phase 999.119 pass 2 — carried so the retriever can decay-weight. */
      importance: number;
      accessed_at: string;
      tier: string;
    }>
  > {
    type Row = { memory_id: string; distance: number; importance: number; accessed_at: string; tier: string };
    const q = toQueryVector(queryEmbedding);
    try {
      // Phase 999.119 pass 2 — JOIN memories so the retriever gets the
      // recency/importance signals without a second lookup, and so a vec
      // row whose memory is gone can never surface (the ghost shape).
      // Phase 999.119 v2 switch — the table follows the query's space; v2
      // distances are mapped onto the v1 scale (embedding-version.ts).
      if (q.version === "v2") {
        const rows = this.db
          .prepare(
            `SELECT v.memory_id, v.distance, m.importance, m.accessed_at, m.tier
             FROM vec_memories_v2 v
             INNER JOIN memories m ON m.id = v.memory_id
             WHERE v.embedding MATCH vec_int8(?) AND k = ? ORDER BY v.distance`,
          )
          .all(int8ToBuffer(q.vector), limit) as Row[];
        return rows.map((r) => ({ ...r, distance: normalizeDistance(r.distance, "v2") }));
      }
      return this.db
        .prepare(
          `SELECT v.memory_id, v.distance, m.importance, m.accessed_at, m.tier
           FROM vec_memories v
           INNER JOIN memories m ON m.id = v.memory_id
           WHERE v.embedding MATCH ? AND k = ? ORDER BY v.distance`,
        )
        .all(q.vector, limit) as Row[];
    } catch {
      // Empty table or no matches — vec0 occasionally throws on empty MATCH.
      // Treat as zero results so callers (retrieveMemoryChunks) can fall
      // through to the chunks side without crashing.
      return [];
    }
  }

  /**
   * Phase 100-fu — hydrate a memory by id for the retrieval pipeline.
   * Returns the saved content + tags + importance for projection into the
   * MemoryRetrievalResult shape. Null on miss so the fuser can silently
   * skip stale ids (matches getMemoryChunk semantics).
   *
   * Distinct from getById(): this lookup does NOT bump access_count or
   * accessed_at — pre-turn auto-retrieval should not pollute the recency
   * signal that promotion logic depends on.
   */
  getMemoryForRetrieval(
    memoryId: string,
  ): Readonly<{
    memory_id: string;
    content: string;
    tags: readonly string[];
    importance: number;
    /** Phase 999.124 — for the recall footer's date range. */
    created_at: string;
  }> | null {
    const row = this.db
      .prepare(
        `SELECT id AS memory_id, content, tags, importance, created_at
         FROM memories WHERE id = ?`,
      )
      .get(memoryId) as
      | {
          memory_id: string;
          content: string;
          tags: string;
          importance: number;
          created_at: string;
        }
      | undefined;
    if (!row) return null;
    let parsedTags: readonly string[] = [];
    try {
      const t = JSON.parse(row.tags);
      if (Array.isArray(t)) parsedTags = Object.freeze(t.map(String));
    } catch {
      /* malformed tags → empty */
    }
    return Object.freeze({
      memory_id: row.memory_id,
      content: row.content,
      tags: parsedTags,
      importance: row.importance,
      created_at: row.created_at,
    });
  }

  /**
   * Phase 90 MEM-03 — hydrate a chunk by id for the retrieval pipeline.
   * Returns null on miss so the fuser can silently skip stale ids.
   */
  getMemoryChunk(
    chunkId: string,
  ): Readonly<{
    chunk_id: string;
    path: string;
    heading: string | null;
    body: string;
    file_mtime_ms: number;
    score_weight: number;
  }> | null {
    const row = this.db
      .prepare(
        `SELECT id AS chunk_id, path, heading, body, file_mtime_ms, score_weight
         FROM memory_chunks WHERE id = ?`,
      )
      .get(chunkId) as
      | {
          chunk_id: string;
          path: string;
          heading: string | null;
          body: string;
          file_mtime_ms: number;
          score_weight: number;
        }
      | undefined;
    return row ?? null;
  }

  private prepareStatements(): PreparedStatements {
    return {
      // Phase 80 MEM-02 — INSERT OR IGNORE. Safe even when origin_id is NULL
      // because SQLite UNIQUE on a nullable column does not match NULL=NULL
      // (and the partial UNIQUE index excludes NULLs entirely). The IGNORE
      // clause is inert on the no-origin_id path, preserving backward-compat.
      insertMemory: this.db.prepare(`
        INSERT OR IGNORE INTO memories (id, content, source, importance, tags, created_at, updated_at, accessed_at, tier, source_turn_ids, origin_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'warm', ?, ?)
      `),
      insertVec: this.db.prepare(`
        INSERT INTO vec_memories (memory_id, embedding)
        VALUES (?, ?)
      `),
      getById: this.db.prepare(`
        SELECT id, content, source, importance, access_count, tags,
               created_at, updated_at, accessed_at, tier, source_turn_ids
        FROM memories WHERE id = ?
      `),
      // Phase 80 MEM-02 — origin_id lookup for idempotent collision read-back.
      getByOriginId: this.db.prepare(`
        SELECT id, content, source, importance, access_count, tags,
               created_at, updated_at, accessed_at, tier, source_turn_ids
        FROM memories WHERE origin_id = ?
      `),
      updateAccess: this.db.prepare(`
        UPDATE memories SET access_count = access_count + 1, accessed_at = ? WHERE id = ?
      `),
      deleteMemory: this.db.prepare(`DELETE FROM memories WHERE id = ?`),
      deleteVec: this.db.prepare(`DELETE FROM vec_memories WHERE memory_id = ?`),
      // Phase 115 D-08 — cascade-delete prepared statements for v2 vec
      // table. Same shape as v1 — no JOIN/CTE; the DELETE WHERE memory_id = ?
      // form fires the prepared statement once per cascade.
      deleteVecV2: this.db.prepare(
        `DELETE FROM vec_memories_v2 WHERE memory_id = ?`,
      ),
      // Phase 115 D-08 — INSERT OR REPLACE so dual-write is idempotent.
      // The vec_int8(?) SQL function is REQUIRED — sqlite-vec rejects raw
      // Int8Array buffers as float32-shaped binary. The Buffer must be
      // passed via int8ToBuffer() helper so byteLength is correct.
      insertVecV2: this.db.prepare(
        `INSERT OR REPLACE INTO vec_memories_v2 (memory_id, embedding) VALUES (?, vec_int8(?))`,
      ),
      listRecent: this.db.prepare(`
        SELECT id, content, source, importance, access_count, tags,
               created_at, updated_at, accessed_at, tier, source_turn_ids
        FROM memories ORDER BY created_at DESC, rowid DESC LIMIT ?
      `),
      insertSessionLog: this.db.prepare(`
        INSERT INTO session_logs (id, date, file_path, entry_count, created_at)
        VALUES (?, ?, ?, ?, ?)
      `),
      insertLink: this.db.prepare(
        "INSERT OR IGNORE INTO memory_links (source_id, target_id, link_text, created_at) VALUES (?, ?, ?, ?)",
      ),
      deleteLinksFrom: this.db.prepare(
        "DELETE FROM memory_links WHERE source_id = ?",
      ),
      getBacklinks: this.db.prepare(`
        SELECT m.id, m.content, m.source, m.importance, m.access_count, m.tags,
               m.created_at, m.updated_at, m.accessed_at, m.tier, m.source_turn_ids,
               ml.link_text
        FROM memory_links ml
        JOIN memories m ON ml.source_id = m.id
        WHERE ml.target_id = ?
        ORDER BY m.created_at DESC
      `),
      getForwardLinks: this.db.prepare(`
        SELECT m.id, m.content, m.source, m.importance, m.access_count, m.tags,
               m.created_at, m.updated_at, m.accessed_at, m.tier, m.source_turn_ids,
               ml.link_text
        FROM memory_links ml
        JOIN memories m ON ml.target_id = m.id
        WHERE ml.source_id = ?
        ORDER BY m.created_at DESC
      `),
      checkMemoryExists: this.db.prepare(
        "SELECT 1 FROM memories WHERE id = ?",
      ),
      // Phase 84 SKILL-04 — narrow lookup for the migration dedup path.
      // Tags are stored as a JSON array string (e.g. '["learning","seed"]'),
      // so we LIKE '%"tag"%' to match the exact token. Content is compared
      // verbatim via '='.
      findByTagAndContent: this.db.prepare(
        `SELECT id FROM memories WHERE tags LIKE ? AND content = ? LIMIT 1`,
      ),
      // Phase 100-fu — public single-row access bump (see `bumpAccess`
      // method below). Identical UPDATE shape to `updateAccess` — duplicated
      // intentionally so the semantic-search path stays untouched and the
      // call sites are easy to audit.
      bumpAccess: this.db.prepare(`
        UPDATE memories SET access_count = access_count + 1, accessed_at = ? WHERE id = ?
      `),
      // Phase 100-fu — graph-centrality signal for tier promotion. Counts
      // inbound wikilink edges (rows in memory_links targeting this id).
      // Uses the existing idx_memory_links_target index so the lookup is
      // O(log n) per call.
      getBacklinkCount: this.db.prepare(
        "SELECT COUNT(*) AS n FROM memory_links WHERE target_id = ?",
      ),
      // Phase 999.119 — see the PreparedStatements docs for each.
      detachSessionSummary: this.db.prepare(
        "UPDATE conversation_sessions SET summary_memory_id = NULL WHERE summary_memory_id = ?",
      ),
      markAutoLinked: this.db.prepare(
        "UPDATE memories SET auto_linked_at = ? WHERE id = ?",
      ),
      touchAccessedAt: this.db.prepare(
        "UPDATE memories SET accessed_at = ? WHERE id = ?",
      ),
    };
  }

  /**
   * Phase 84 SKILL-04 — migration-only narrow lookup. Returns the id of a
   * memory whose `tags` JSON-array contains the given tag AND whose
   * `content` exactly matches. Returns undefined when no row matches.
   *
   * Scope is intentionally tight: used by src/migration/skills-learnings-dedup.ts
   * to dedupe `.learnings/*.md` imports against pre-existing
   * tag-"learning" rows seeded by v2.1 memory translation.
   */
  findByTagAndContent(
    tag: string,
    content: string,
  ): { id: string } | undefined {
    const likePattern = `%"${tag}"%`;
    return this.stmts.findByTagAndContent.get(likePattern, content) as
      | { id: string }
      | undefined;
  }
}

/** Raw row shape from SQLite queries. */
type MemoryRow = {
  readonly id: string;
  readonly content: string;
  readonly source: string;
  readonly importance: number;
  readonly access_count: number;
  readonly tags: string;
  readonly created_at: string;
  readonly updated_at: string;
  readonly accessed_at: string;
  readonly tier: string;
  readonly source_turn_ids: string | null;
};

/** Convert a raw SQLite row to an immutable MemoryEntry. */
/** Phase 999.119 — MemoryRow plus the joined inbound-link count. */
type ScanRow = MemoryRow & { readonly backlink_count: number };

/** Phase 999.119 — MemoryEntry + backlinkCount for the tier scans. */
function rowToScanCandidate(row: ScanRow): TierScanCandidate {
  return Object.freeze({
    ...rowToEntry(row),
    backlinkCount: row.backlink_count ?? 0,
  });
}

function rowToEntry(row: MemoryRow): MemoryEntry {
  const rawTurnIds = row.source_turn_ids;
  const sourceTurnIds = rawTurnIds
    ? Object.freeze(JSON.parse(rawTurnIds) as string[])
    : null;

  return Object.freeze({
    id: row.id,
    content: row.content,
    source: row.source as MemoryEntry["source"],
    importance: row.importance,
    accessCount: row.access_count,
    tags: Object.freeze(JSON.parse(row.tags) as string[]),
    embedding: null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    accessedAt: row.accessed_at,
    tier: (row.tier ?? "warm") as MemoryTier,
    sourceTurnIds,
  });
}
