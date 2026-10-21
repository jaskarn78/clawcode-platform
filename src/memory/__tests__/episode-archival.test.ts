import { describe, it, expect, afterEach, vi } from "vitest";
import { MemoryStore } from "../store.js";
import { EpisodeStore } from "../episode-store.js";
import { archiveOldEpisodes } from "../episode-archival.js";
import type { EpisodeArchivalResult } from "../episode-archival.js";

/** Mock EmbeddingService that returns deterministic 384-dim vectors. */
function createMockEmbedder() {
  let callCount = 0;
  return {
    async embed(text: string): Promise<Float32Array> {
      callCount++;
      const arr = new Float32Array(384);
      for (let i = 0; i < 384; i++) {
        arr[i] = Math.sin(i * 0.1 + text.length + callCount * 0.01);
      }
      let norm = 0;
      for (let i = 0; i < 384; i++) norm += arr[i] * arr[i];
      norm = Math.sqrt(norm);
      for (let i = 0; i < 384; i++) arr[i] /= norm;
      return arr;
    },
    async warmup(): Promise<void> {},
    isReady(): boolean {
      return true;
    },
  };
}

/**
 * Helper to insert an episode with a specific created_at date.
 * Inserts directly via store + manual date override in DB.
 */
async function insertEpisodeWithDate(
  store: MemoryStore,
  episodeStore: EpisodeStore,
  title: string,
  dateISO: string,
): Promise<string> {
  const entry = await episodeStore.recordEpisode({
    title,
    summary: `Summary for ${title}`,
  });
  // Override created_at to simulate an old episode
  store.getDatabase().prepare(
    "UPDATE memories SET created_at = ? WHERE id = ?",
  ).run(dateISO, entry.id);
  return entry.id;
}

describe("Episode Archival Pipeline", () => {
  let store: MemoryStore;
  let episodeStore: EpisodeStore;

  afterEach(() => {
    store?.close();
  });

  it("returns { archived: 0, errors: [] } when no episodes exist", async () => {
    store = new MemoryStore(":memory:", { enabled: false, similarityThreshold: 0.85 });
    const result = await archiveOldEpisodes(store, 90);
    expect(result.archived).toBe(0);
    expect(result.errors).toEqual([]);
  });

  it("returns { archived: 0, errors: [] } when all episodes are younger than threshold", async () => {
    store = new MemoryStore(":memory:", { enabled: false, similarityThreshold: 0.85 });
    const embedder = createMockEmbedder();
    episodeStore = new EpisodeStore(store, embedder);

    // Record a recent episode (created_at will be "now")
    await episodeStore.recordEpisode({
      title: "Recent Event",
      summary: "Just happened.",
    });

    const result = await archiveOldEpisodes(store, 90);
    expect(result.archived).toBe(0);
    expect(result.errors).toEqual([]);
  });

  it("archives episodes older than archivalAgeDays (set tier to cold, remove from vec_memories)", async () => {
    store = new MemoryStore(":memory:", { enabled: false, similarityThreshold: 0.85 });
    const embedder = createMockEmbedder();
    episodeStore = new EpisodeStore(store, embedder);

    const oldDate = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000).toISOString();
    const id = await insertEpisodeWithDate(store, episodeStore, "Old Event", oldDate);

    const result = await archiveOldEpisodes(store, 90);
    expect(result.archived).toBe(1);
    expect(result.errors).toEqual([]);

    // Verify tier is cold
    const entry = store.getById(id);
    expect(entry).not.toBeNull();
    expect(entry!.tier).toBe("cold");

    // Verify vec_memories entry is gone
    const vecRow = store.getDatabase().prepare(
      "SELECT COUNT(*) as count FROM vec_memories WHERE memory_id = ?",
    ).get(id) as { count: number };
    expect(vecRow.count).toBe(0);
  });

  it("does not archive episodes that are already cold", async () => {
    store = new MemoryStore(":memory:", { enabled: false, similarityThreshold: 0.85 });
    const embedder = createMockEmbedder();
    episodeStore = new EpisodeStore(store, embedder);

    const oldDate = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000).toISOString();
    const id = await insertEpisodeWithDate(store, episodeStore, "Already Cold", oldDate);

    // Manually set tier to cold
    store.updateTier(id, "cold");

    const result = await archiveOldEpisodes(store, 90);
    expect(result.archived).toBe(0);
    expect(result.errors).toEqual([]);
  });

  it("archived episodes no longer appear in vec_memories KNN search", async () => {
    store = new MemoryStore(":memory:", { enabled: false, similarityThreshold: 0.85 });
    const embedder = createMockEmbedder();
    episodeStore = new EpisodeStore(store, embedder);

    const oldDate = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000).toISOString();
    const id = await insertEpisodeWithDate(store, episodeStore, "Searchable Event", oldDate);

    // Confirm it's in vec_memories before archival
    const beforeCount = (store.getDatabase().prepare(
      "SELECT COUNT(*) as count FROM vec_memories WHERE memory_id = ?",
    ).get(id) as { count: number }).count;
    expect(beforeCount).toBe(1);

    await archiveOldEpisodes(store, 90);

    // After archival, no longer in vec_memories
    const afterCount = (store.getDatabase().prepare(
      "SELECT COUNT(*) as count FROM vec_memories WHERE memory_id = ?",
    ).get(id) as { count: number }).count;
    expect(afterCount).toBe(0);
  });

  it("partial archival: if one episode fails, others still archive", async () => {
    store = new MemoryStore(":memory:", { enabled: false, similarityThreshold: 0.85 });
    const embedder = createMockEmbedder();
    episodeStore = new EpisodeStore(store, embedder);

    const oldDate = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000).toISOString();
    const id1 = await insertEpisodeWithDate(store, episodeStore, "Event A", oldDate);
    const id2 = await insertEpisodeWithDate(store, episodeStore, "Event B", oldDate);

    // Make updateTier fail for id1 by mocking it
    const originalUpdateTier = store.updateTier.bind(store);
    let callIndex = 0;
    vi.spyOn(store, "updateTier").mockImplementation((id, tier) => {
      callIndex++;
      if (callIndex === 1) {
        throw new Error("Simulated failure for first episode");
      }
      return originalUpdateTier(id, tier);
    });

    const result = await archiveOldEpisodes(store, 90);

    // One succeeded, one failed
    expect(result.archived).toBe(1);
    expect(result.errors.length).toBe(1);
    expect(result.errors[0]).toContain("Simulated failure");
  });

  it("archivalAgeDays=0 archives all episodes", async () => {
    store = new MemoryStore(":memory:", { enabled: false, similarityThreshold: 0.85 });
    const embedder = createMockEmbedder();
    episodeStore = new EpisodeStore(store, embedder);

    // Record episodes and backdate them slightly so they are strictly before "now"
    const pastDate = new Date(Date.now() - 1000).toISOString();
    await insertEpisodeWithDate(store, episodeStore, "Event 1", pastDate);
    await insertEpisodeWithDate(store, episodeStore, "Event 2", pastDate);

    const result = await archiveOldEpisodes(store, 0);
    expect(result.archived).toBe(2);
    expect(result.errors).toEqual([]);
  });
});
