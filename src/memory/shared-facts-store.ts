/**
 * Phase 999.131 — owner-scoped shared facts.
 *
 * WHY. Operator tells the shopping agent "I prefer brief answers" and the
 * projects agent never hears it; every agent learns the owner from
 * scratch. Per-agent memory isolation is deliberate (the v3 cross-agent
 * memory vulnerability is why), so the fix is not cross-agent reads: it
 * is a SEPARATE fleet store keyed by OWNER, where an agent may write with
 * `memory_save({ scope: "owner" })` and every agent with the same owner
 * reads at retrieval time. An agent's owner comes from ITS config, never
 * from tool parameters, so an agent can never reach another owner's facts.
 *
 * One SQLite file under the manager dir (`shared-facts.db`), v1 (MiniLM)
 * vectors via sqlite-vec, insert-time dedup at 0.9 so restating a fact
 * refreshes it instead of duplicating it.
 */

import Database from "better-sqlite3";
import type { Database as DatabaseType } from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { nanoid } from "nanoid";
import type { MemoryRetrievalResult } from "./memory-retrieval.js";

export const SHARED_FACTS_DB_FILE = "shared-facts.db";
export const SHARED_FACT_DEDUP_THRESHOLD = 0.9;
export const SHARED_FACTS_RETRIEVAL_K = 3;
/**
 * Phase 999.187 — cosine floor for an owner fact to ride into a turn. The
 * 999.131 floor of 0.3 sat below the random-pair median that 999.119
 * measured for MiniLM (0.30–0.67), so the top-3 facts passed on nearly every
 * turn whether or not they were relevant. 0.5 keeps clearly related facts
 * and drops the noise; explicit `memory_save({scope:"owner"})` facts are
 * short, so their similarity to a related query is high.
 */
export const SHARED_FACT_MIN_SIMILARITY = 0.5;
/** Path stem the retriever labels owner facts with (the recall footer counts them as notes). */
export const SHARED_FACT_PATH = "owner-facts";
const EMBEDDING_DIM = 384;

export interface SharedFact {
  readonly id: string;
  readonly owner: string;
  readonly content: string;
  readonly tags: readonly string[];
  readonly importance: number;
  readonly sourceAgent: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface SaveSharedFactInput {
  readonly owner: string;
  readonly content: string;
  readonly tags?: readonly string[];
  readonly importance?: number;
  readonly sourceAgent: string;
}

export type SaveSharedFactResult =
  | { readonly action: "inserted"; readonly fact: SharedFact }
  | { readonly action: "refreshed"; readonly fact: SharedFact; readonly similarity: number };

type Row = {
  id: string;
  owner: string;
  content: string;
  tags: string;
  importance: number;
  source_agent: string;
  created_at: string;
  updated_at: string;
};

function rowToFact(r: Row): SharedFact {
  let tags: string[] = [];
  try {
    const parsed: unknown = JSON.parse(r.tags);
    if (Array.isArray(parsed)) tags = parsed.map(String);
  } catch {
    /* malformed tags → none */
  }
  return Object.freeze({
    id: r.id,
    owner: r.owner,
    content: r.content,
    tags: Object.freeze(tags),
    importance: r.importance,
    sourceAgent: r.source_agent,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  });
}

export class SharedFactsStore {
  private readonly db: DatabaseType;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 5000");
    this.db.pragma("synchronous = NORMAL");
    sqliteVec.load(this.db);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS shared_facts (
        id TEXT PRIMARY KEY,
        owner TEXT NOT NULL,
        content TEXT NOT NULL,
        tags TEXT NOT NULL DEFAULT '[]',
        importance REAL NOT NULL DEFAULT 0.7,
        source_agent TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_shared_facts_owner ON shared_facts(owner, updated_at DESC);
      CREATE VIRTUAL TABLE IF NOT EXISTS vec_shared_facts USING vec0(
        fact_id TEXT PRIMARY KEY,
        embedding float[${EMBEDDING_DIM}] distance_metric=cosine
      );
    `);
  }

  getDatabase(): DatabaseType {
    return this.db;
  }

  close(): void {
    this.db.close();
  }

  /** Save (or refresh a near-duplicate of) an owner fact. */
  save(input: SaveSharedFactInput, embedding: Float32Array): SaveSharedFactResult {
    const content = input.content.trim();
    if (content.length === 0) throw new Error("shared fact content is empty");
    const now = new Date().toISOString();
    const tags = [...new Set(input.tags ?? [])];
    const importance = Math.min(1, Math.max(0, input.importance ?? 0.7));

    // Dedup within the owner only.
    const nearest = this.nearest(input.owner, embedding, 1)[0];
    if (nearest && nearest.similarity >= SHARED_FACT_DEDUP_THRESHOLD) {
      const existing = this.get(nearest.id)!;
      const mergedTags = [...new Set([...existing.tags, ...tags])];
      this.db.transaction(() => {
        this.db
          .prepare(
            "UPDATE shared_facts SET content = ?, tags = ?, importance = MAX(importance, ?), source_agent = ?, updated_at = ? WHERE id = ?",
          )
          .run(content, JSON.stringify(mergedTags), importance, input.sourceAgent, now, existing.id);
        this.db.prepare("DELETE FROM vec_shared_facts WHERE fact_id = ?").run(existing.id);
        this.db.prepare("INSERT INTO vec_shared_facts (fact_id, embedding) VALUES (?, ?)").run(existing.id, embedding);
      })();
      return { action: "refreshed", fact: this.get(existing.id)!, similarity: nearest.similarity };
    }

    const id = nanoid();
    this.db.transaction(() => {
      this.db
        .prepare(
          "INSERT INTO shared_facts (id, owner, content, tags, importance, source_agent, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(id, input.owner, content, JSON.stringify(tags), importance, input.sourceAgent, now, now);
      this.db.prepare("INSERT INTO vec_shared_facts (fact_id, embedding) VALUES (?, ?)").run(id, embedding);
    })();
    return { action: "inserted", fact: this.get(id)! };
  }

  get(id: string): SharedFact | null {
    const row = this.db.prepare("SELECT * FROM shared_facts WHERE id = ?").get(id) as Row | undefined;
    return row ? rowToFact(row) : null;
  }

  /** Nearest facts of ONE owner (cosine similarity on the v1 space). */
  nearest(
    owner: string,
    embedding: Float32Array,
    k: number,
  ): ReadonlyArray<{ id: string; similarity: number }> {
    // Over-fetch across owners, then filter: vec0 KNN cannot join on owner.
    const rows = this.db
      .prepare(
        `SELECT v.fact_id AS id, v.distance AS distance, f.owner AS owner
         FROM vec_shared_facts v
         JOIN shared_facts f ON f.id = v.fact_id
         WHERE v.embedding MATCH ? AND k = ?
         ORDER BY v.distance`,
      )
      .all(embedding, Math.max(k * 8, 32)) as Array<{ id: string; distance: number; owner: string }>;
    return rows
      .filter((r) => r.owner === owner)
      .slice(0, k)
      .map((r) => Object.freeze({ id: r.id, similarity: 1 - r.distance }));
  }

  /** Facts for the owner that match the query, most similar first. */
  search(owner: string, embedding: Float32Array, k: number = SHARED_FACTS_RETRIEVAL_K): ReadonlyArray<SharedFact & { similarity: number }> {
    return this.nearest(owner, embedding, k)
      .map((n) => {
        const fact = this.get(n.id);
        return fact ? Object.freeze({ ...fact, similarity: n.similarity }) : null;
      })
      .filter((f): f is SharedFact & { similarity: number } => f !== null);
  }

  list(owner: string, limit = 50): readonly SharedFact[] {
    const rows = this.db
      .prepare("SELECT * FROM shared_facts WHERE owner = ? ORDER BY updated_at DESC LIMIT ?")
      .all(owner, limit) as Row[];
    return Object.freeze(rows.map(rowToFact));
  }

  count(owner: string): number {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM shared_facts WHERE owner = ?").get(owner) as { n: number };
    return row.n;
  }

  /** Delete one fact; the owner must match (an agent can only forget its own owner's facts). */
  delete(id: string, owner: string): boolean {
    let deleted = false;
    this.db.transaction(() => {
      const r = this.db.prepare("DELETE FROM shared_facts WHERE id = ? AND owner = ?").run(id, owner);
      deleted = r.changes > 0;
      if (deleted) this.db.prepare("DELETE FROM vec_shared_facts WHERE fact_id = ?").run(id);
    })();
    return deleted;
  }
}

/**
 * Owner facts as retrieval chunks, appended to the per-agent memory context.
 * Labelled so the model sees where they came from and the recall footer
 * counts them as notes. Empty when the owner has no matching facts.
 */
export function ownerFactsAsChunks(
  store: SharedFactsStore,
  owner: string,
  queryEmbedding: Float32Array,
  k: number = SHARED_FACTS_RETRIEVAL_K,
  minSimilarity = SHARED_FACT_MIN_SIMILARITY,
): readonly MemoryRetrievalResult[] {
  return store
    .search(owner, queryEmbedding, k)
    .filter((f) => f.similarity >= minSimilarity)
    .map((f) =>
      Object.freeze({
        chunkId: `shared:${f.id}`,
        path: SHARED_FACT_PATH,
        heading: `Owner fact (shared by ${f.sourceAgent})`,
        body: f.content,
        fusedScore: f.similarity,
        scoreWeight: 0,
        source: "chunk" as const,
        createdAt: f.createdAt,
      }),
    );
}
