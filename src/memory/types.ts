/**
 * Memory module types.
 * All types are readonly per project immutability convention.
 */

/** Valid sources for memory entries. */
export type MemorySource = "conversation" | "manual" | "system" | "consolidation" | "episode";

/** Input for recording a discrete episode event as memory. */
export type EpisodeInput = {
  readonly title: string;
  readonly summary: string;
  readonly importance?: number;
  readonly tags?: readonly string[];
  readonly occurredAt?: string; // ISO 8601, defaults to now
};

/** Memory storage tier. */
export type MemoryTier = "hot" | "warm" | "cold";

/** A stored memory entry with full metadata. */
export type MemoryEntry = {
  readonly id: string;
  readonly content: string;
  readonly source: MemorySource;
  readonly importance: number;
  readonly accessCount: number;
  readonly tags: readonly string[];
  readonly embedding: Float32Array | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly accessedAt: string;
  readonly tier: MemoryTier;
  /** Conversation turn IDs this memory was derived from (CONV-03 lineage). Null for non-conversation memories. */
  readonly sourceTurnIds: readonly string[] | null;
};

/** Input for creating a new memory entry. */
export type CreateMemoryInput = {
  readonly content: string;
  readonly source: MemorySource;
  readonly importance?: number;
  readonly tags?: readonly string[];
  readonly skipDedup?: boolean;
  /** Conversation turn IDs this memory was derived from (CONV-03 lineage). Omit for non-conversation memories. */
  readonly sourceTurnIds?: readonly string[];
  /**
   * Phase 80 MEM-02 — stable per-source-path identifier used to de-duplicate
   * imports across re-runs. Format: "openclaw:<agent>:<sha256-of-relpath>"
   * (path-only hash — content changes don't create duplicates). When
   * provided, insert() uses INSERT OR IGNORE semantics and returns the
   * existing row on collision. Dedup (content-similarity merging) is
   * SKIPPED on the origin_id path — idempotency is the contract.
   */
  readonly origin_id?: string;
};

/** A search result extends MemoryEntry with distance score. */
export type SearchResult = MemoryEntry & {
  readonly distance: number;
};

/** A session log entry tracking a daily markdown file. */
export type SessionLogEntry = {
  readonly id: string;
  readonly date: string;
  readonly filePath: string;
  readonly entryCount: number;
  readonly createdAt: string;
};

/** Embedding vector type alias for clarity. */
export type EmbeddingVector = Float32Array;

/** Re-export RankedSearchResult for consumers. */
export type { RankedSearchResult } from "./relevance.js";

// ── Phase 115 Plan 03 sub-scope 11 — formal Tier 1 / Tier 2 split ─────────

/**
 * Phase 115 Plan 03 sub-scope 11 — Tier 1 source descriptor.
 *
 * Tier 1 = file-backed semantic memory. Curated, bounded, ALWAYS injected
 * into the stable prefix at every assembly. Sources are operator-curated
 * markdown files: SOUL.md (persona fingerprint), IDENTITY.md (persona body),
 * MEMORY.md (long-term curated memory autoload), USER.md (operator profile).
 *
 * Storage: filesystem under the agent's workspace (e.g.
 * `~/.clawcode/agents/<name>/MEMORY.md`).
 *
 * Read path: `buildSessionConfig` in `src/manager/session-config.ts` reads
 * each file at session start and threads its content through `ContextSources`
 * (the `identitySoulFingerprint` / `identityFile` / `identityCapabilityManifest`
 * / `identityMemoryAutoload` carved sub-fields, see context-assembler.ts).
 *
 * Write path: operator (manual edit) + Phase 95 dreaming consolidation
 * (D-10 hybrid policy — promotion candidates may write to MEMORY.md after
 * the operator-veto window).
 *
 * Hard caps: `INJECTED_MEMORY_MAX_CHARS = 16_000` for MEMORY.md; smaller
 * caps for the other sources via `extractFingerprint` (≤1200 chars) etc.
 *
 * The `tier` discriminator is a string-literal so this interface can
 * cleanly union with `MemoryTier2Source` for callers that traffic in
 * mixed-source result lists. The discriminator does NOT collide with the
 * pre-existing `MemoryTier = "hot" | "warm" | "cold"` storage tier
 * (which lives on `MemoryEntry`); keep the two concerns separate at
 * call sites.
 */
export interface MemoryTier1Source {
  readonly tier: "tier1";
  /** Which curated file this source represents. */
  readonly source: "soul" | "identity" | "memory" | "user";
  /** Absolute filesystem path the content was read from (for log/diag). */
  readonly path: string;
  /** Hard char cap applied at the read site (e.g. INJECTED_MEMORY_MAX_CHARS). */
  readonly maxChars: number;
  /** File body, post head-tail truncate when over `maxChars`. */
  readonly content: string;
}

/**
 * Phase 115 Plan 03 sub-scope 11 — Tier 2 source descriptor.
 *
 * Tier 2 = chunk-backed episodic memory. Unbounded in size; lazily
 * retrieved per-turn via hybrid (vec + FTS5 + RRF) ranking. Sources are
 * the per-agent SQLite DB tables: `memory_chunks` (file-scanner indexed
 * markdown bodies) and `memories` (the agent's own `memory_save` outputs).
 *
 * Storage: per-agent SQLite at `~/.clawcode/agents/<name>/memory/memories.db`
 * with `sqlite-vec` virtual tables (`vec_memory_chunks`, `vec_memories`)
 * and FTS5 indices (`memory_chunks_fts`).
 *
 * Read path: `retrieveMemoryChunks` (per-turn, bounded by token budget)
 * + the Phase 115 sub-scope 7 lazy-load MCP tools (`clawcode-memory-search`,
 * etc.) that put older context one tool-call away rather than always-injected.
 *
 * Write path: file scanner (markdown indexer) + `memory_save` MCP tool +
 * session summarizer outputs.
 *
 * The `tier` discriminator is a string-literal so this interface unions
 * cleanly with `MemoryTier1Source`. `chunkId` and `memoryId` are mutually
 * exclusive in practice (a single source row carries one or the other),
 * but neither is required because Plan 115-04+ may construct `MemoryTier2Source`
 * shapes from non-DB inputs (e.g. ad-hoc lazy-recall results).
 */
export interface MemoryTier2Source {
  readonly tier: "tier2";
  /** Which Tier 2 substrate produced this row. */
  readonly source: "chunks" | "memories";
  /** Set when `source === "chunks"` — the `memory_chunks.id`. */
  readonly chunkId?: string;
  /** Set when `source === "memories"` — the `memories.id`. */
  readonly memoryId?: string;
  /** Body text rendered into the prompt or returned to the agent. */
  readonly content: string;
  /** Tags carried through from the source row (empty when unknown). */
  readonly tags: readonly string[];
  /** Importance score (0-1 scale per `memories.importance`). 0 when unknown. */
  readonly importance: number;
}

/**
 * Phase 115 Plan 03 sub-scope 11 — discriminated-union alias.
 *
 * Named `TypedMemorySource` (NOT `MemorySource`) to avoid colliding with the
 * pre-existing `MemorySource = "conversation" | "manual" | ...` string union
 * above. Callers that want the union should import this alias; callers that
 * want the file-source string literal should keep importing `MemorySource`.
 */
export type TypedMemorySource = MemoryTier1Source | MemoryTier2Source;
