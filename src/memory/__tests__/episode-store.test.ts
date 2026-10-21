import { describe, it, expect, afterEach } from "vitest";
import { MemoryStore } from "../store.js";
import { EpisodeStore } from "../episode-store.js";
import { SemanticSearch } from "../search.js";
import type { EpisodeInput } from "../types.js";

/** Mock EmbeddingService that returns deterministic 384-dim vectors. */
function createMockEmbedder() {
  let callCount = 0;
  return {
    async embed(text: string): Promise<Float32Array> {
      callCount++;
      const arr = new Float32Array(384);
      // Deterministic but unique per call: use hash of text length + call count
      for (let i = 0; i < 384; i++) {
        arr[i] = Math.sin(i * 0.1 + text.length + callCount * 0.01);
      }
      // Normalize to unit vector for cosine distance
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

function randomEmbedding(): Float32Array {
  const arr = new Float32Array(384);
  for (let i = 0; i < 384; i++) {
    arr[i] = Math.random() * 2 - 1;
  }
  return arr;
}

describe("EpisodeStore", () => {
  let store: MemoryStore;
  let episodeStore: EpisodeStore;

  afterEach(() => {
    store?.close();
  });

  describe("recordEpisode", () => {
    it("stores with correct source, content format, and tags", async () => {
      store = new MemoryStore(":memory:", { enabled: false, similarityThreshold: 0.85 });
      const embedder = createMockEmbedder();
      episodeStore = new EpisodeStore(store, embedder);

      const input: EpisodeInput = {
        title: "Deployment v2.0",
        summary: "Deployed version 2.0 to production successfully.",
        tags: ["deployment", "production"],
      };

      const entry = await episodeStore.recordEpisode(input);

      expect(entry.source).toBe("episode");
      expect(entry.content).toBe("[Episode: Deployment v2.0]\n\nDeployed version 2.0 to production successfully.");
      expect(entry.tags).toContain("episode");
      expect(entry.tags).toContain("deployment");
      expect(entry.tags).toContain("production");
    });

    it("applies default importance of 0.6 when not specified", async () => {
      store = new MemoryStore(":memory:", { enabled: false, similarityThreshold: 0.85 });
      const embedder = createMockEmbedder();
      episodeStore = new EpisodeStore(store, embedder);

      const entry = await episodeStore.recordEpisode({
        title: "Test Event",
        summary: "Something happened.",
      });

      expect(entry.importance).toBe(0.6);
    });

    it("uses provided importance when specified", async () => {
      store = new MemoryStore(":memory:", { enabled: false, similarityThreshold: 0.85 });
      const embedder = createMockEmbedder();
      episodeStore = new EpisodeStore(store, embedder);

      const entry = await episodeStore.recordEpisode({
        title: "Critical Incident",
        summary: "Server went down.",
        importance: 0.95,
      });

      expect(entry.importance).toBe(0.95);
    });

    it("tags always include 'episode' plus user tags with no duplicates", async () => {
      store = new MemoryStore(":memory:", { enabled: false, similarityThreshold: 0.85 });
      const embedder = createMockEmbedder();
      episodeStore = new EpisodeStore(store, embedder);

      const entry = await episodeStore.recordEpisode({
        title: "Dup Tag Test",
        summary: "Testing duplicate tag removal.",
        tags: ["episode", "custom"],
      });

      const episodeTags = entry.tags.filter((t) => t === "episode");
      expect(episodeTags).toHaveLength(1);
      expect(entry.tags).toContain("custom");
    });
  });

  describe("listEpisodes", () => {
    it("returns only episode entries, most recent first", async () => {
      store = new MemoryStore(":memory:", { enabled: false, similarityThreshold: 0.85 });
      const embedder = createMockEmbedder();
      episodeStore = new EpisodeStore(store, embedder);

      // Insert a non-episode memory directly
      store.insert(
        { content: "regular memory", source: "conversation" },
        randomEmbedding(),
      );

      // Insert episodes
      await episodeStore.recordEpisode({
        title: "First Event",
        summary: "First.",
      });
      await episodeStore.recordEpisode({
        title: "Second Event",
        summary: "Second.",
      });

      const episodes = episodeStore.listEpisodes(10);
      expect(episodes).toHaveLength(2);
      expect(episodes[0].content).toContain("Second Event");
      expect(episodes[1].content).toContain("First Event");
      // None should be "conversation" source
      for (const ep of episodes) {
        expect(ep.source).toBe("episode");
      }
    });

    it("returns empty array when no episodes exist", () => {
      store = new MemoryStore(":memory:", { enabled: false, similarityThreshold: 0.85 });
      const embedder = createMockEmbedder();
      episodeStore = new EpisodeStore(store, embedder);

      const episodes = episodeStore.listEpisodes(10);
      expect(episodes).toEqual([]);
    });
  });

  describe("getEpisodeCount", () => {
    it("returns 0 initially and increments after recording", async () => {
      store = new MemoryStore(":memory:", { enabled: false, similarityThreshold: 0.85 });
      const embedder = createMockEmbedder();
      episodeStore = new EpisodeStore(store, embedder);

      expect(episodeStore.getEpisodeCount()).toBe(0);

      await episodeStore.recordEpisode({
        title: "Event 1",
        summary: "First event.",
      });
      expect(episodeStore.getEpisodeCount()).toBe(1);

      await episodeStore.recordEpisode({
        title: "Event 2",
        summary: "Second event.",
      });
      expect(episodeStore.getEpisodeCount()).toBe(2);
    });
  });

  describe("search integration", () => {
    it("episode content is searchable via SemanticSearch", async () => {
      store = new MemoryStore(":memory:", { enabled: false, similarityThreshold: 0.85 });
      const embedder = createMockEmbedder();
      episodeStore = new EpisodeStore(store, embedder);

      // Record an episode
      await episodeStore.recordEpisode({
        title: "Database Migration",
        summary: "Migrated PostgreSQL from v14 to v16 with zero downtime.",
        tags: ["database", "migration"],
      });

      // Search using the same embedder to generate query embedding
      const search = new SemanticSearch(store.getDatabase());
      const queryEmbed = await embedder.embed("database migration");
      const results = search.search(queryEmbed, 5);

      // Should find the episode in results
      expect(results.length).toBeGreaterThan(0);
      const found = results.find((r) => r.content.includes("Database Migration"));
      expect(found).toBeDefined();
      expect(found!.source).toBe("episode");
    });
  });
});
