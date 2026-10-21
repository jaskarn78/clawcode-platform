/**
 * EpisodeStore — Records and retrieves discrete episode events as memory entries.
 *
 * Episodes are stored as standard MemoryEntry objects with source="episode" and
 * a structured content format: "[Episode: {title}]\n\n{summary}". This allows
 * episodes to participate in semantic search alongside regular memories.
 */

import type { MemoryStore } from "./store.js";
import type { MemoryEntry, EpisodeInput } from "./types.js";
import type { MemoryTier } from "./types.js";
import { episodeInputSchema } from "./schema.js";

/** Embedder interface matching the subset of EmbeddingService we need. */
type Embedder = {
  embed(text: string): Promise<Float32Array>;
};

/** Raw row shape from SQLite queries (matches store.ts MemoryRow). */
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

export class EpisodeStore {
  private readonly store: MemoryStore;
  private readonly embedder: Embedder;

  constructor(store: MemoryStore, embedder: Embedder) {
    this.store = store;
    this.embedder = embedder;
  }

  /**
   * Record a discrete episode event as a memory entry.
   *
   * Content is formatted as "[Episode: {title}]\n\n{summary}" for search relevance.
   * Tags always include "episode" plus any user-provided tags (deduplicated).
   * Importance defaults to 0.6 if not specified.
   */
  async recordEpisode(input: EpisodeInput): Promise<MemoryEntry> {
    const validated = episodeInputSchema.parse(input);

    const content = `[Episode: ${validated.title}]\n\n${validated.summary}`;
    const importance = validated.importance;

    // Deduplicate tags: always include "episode" first
    const userTags = validated.tags;
    const allTags = ["episode", ...userTags.filter((t) => t !== "episode")];

    const embedding = await this.embedder.embed(content);

    return this.store.insert(
      {
        content,
        source: "episode",
        importance,
        tags: allTags,
        skipDedup: true,
      },
      embedding,
    );
  }

  /**
   * List episodes ordered by creation time (most recent first).
   * Returns only source="episode" entries.
   */
  listEpisodes(limit: number): readonly MemoryEntry[] {
    const db = this.store.getDatabase();
    const rows = db
      .prepare(
        `SELECT id, content, source, importance, access_count, tags,
                created_at, updated_at, accessed_at, tier, source_turn_ids
         FROM memories WHERE source = 'episode'
         ORDER BY created_at DESC, rowid DESC LIMIT ?`,
      )
      .all(limit) as MemoryRow[];

    return Object.freeze(rows.map(rowToEntry));
  }

  /**
   * Get the total count of episode entries.
   */
  getEpisodeCount(): number {
    const db = this.store.getDatabase();
    const row = db
      .prepare("SELECT COUNT(*) as count FROM memories WHERE source = 'episode'")
      .get() as { count: number };
    return row.count;
  }
}

export type { EpisodeInput } from "./types.js";
