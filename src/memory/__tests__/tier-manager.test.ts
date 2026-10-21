import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { mkdirSync, readFileSync, existsSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MemoryStore } from "../store.js";
import {
  TierManager,
  embeddingToBase64,
  base64ToEmbedding,
  generateColdSlug,
} from "../tier-manager.js";
import type { TierConfig } from "../tiers.js";
import { DEFAULT_TIER_CONFIG } from "../tiers.js";
import type { ScoringConfig } from "../relevance.js";
import type { MemoryEntry } from "../types.js";

/** Create a MemoryStore backed by in-memory SQLite (dedup off). */
function createTestStore(): MemoryStore {
  return new MemoryStore(":memory:", { enabled: false, similarityThreshold: 0.85 });
}

/** Create a normalized random embedding. */
function randomEmbedding(dim = 384): Float32Array {
  const arr = new Float32Array(dim);
  let norm = 0;
  for (let i = 0; i < dim; i++) {
    arr[i] = Math.random() * 2 - 1;
    norm += arr[i] * arr[i];
  }
  norm = Math.sqrt(norm);
  for (let i = 0; i < dim; i++) {
    arr[i] /= norm;
  }
  return arr;
}

/** Fake embedder that returns a fixed or random embedding. */
function fakeEmbedder() {
  return {
    embed: vi.fn().mockResolvedValue(randomEmbedding()),
    warmup: vi.fn().mockResolvedValue(undefined),
    isReady: vi.fn().mockReturnValue(true),
  };
}

/** Fake logger. */
function fakeLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
    child: vi.fn().mockReturnThis(),
    level: "info",
  };
}

const DEFAULT_SCORING: ScoringConfig = {
  semanticWeight: 0.7,
  decayWeight: 0.3,
  halfLifeDays: 30,
};

describe("Utility functions", () => {
  describe("embeddingToBase64 / base64ToEmbedding", () => {
    it("round-trips a Float32Array through base64", () => {
      const original = new Float32Array([1.0, -0.5, 0.0, 3.14]);
      const b64 = embeddingToBase64(original);
      const restored = base64ToEmbedding(b64);
      expect(restored.length).toBe(original.length);
      for (let i = 0; i < original.length; i++) {
        expect(restored[i]).toBeCloseTo(original[i], 5);
      }
    });

    it("handles 384-dim embedding", () => {
      const original = randomEmbedding(384);
      const b64 = embeddingToBase64(original);
      const restored = base64ToEmbedding(b64);
      expect(restored.length).toBe(384);
      for (let i = 0; i < 384; i++) {
        expect(restored[i]).toBeCloseTo(original[i], 5);
      }
    });
  });

  describe("generateColdSlug", () => {
    it("lowercases and replaces non-alphanumeric with hyphens", () => {
      expect(generateColdSlug("Hello World! 123")).toBe("hello-world-123");
    });

    it("truncates to 40 chars of source content", () => {
      const longContent = "a".repeat(100);
      const slug = generateColdSlug(longContent);
      // Slug is derived from first 40 chars
      expect(slug.length).toBeLessThanOrEqual(40);
    });

    it("trims leading and trailing hyphens", () => {
      expect(generateColdSlug("---hello---")).toBe("hello");
    });

    it("handles empty string", () => {
      const slug = generateColdSlug("");
      expect(typeof slug).toBe("string");
    });
  });
});

describe("TierManager", () => {
  let store: MemoryStore;
  let memoryDir: string;

  beforeEach(() => {
    store = createTestStore();
    memoryDir = join(tmpdir(), `tier-manager-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(memoryDir, { recursive: true });
  });

  afterEach(() => {
    store?.close();
    try {
      rmSync(memoryDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  function createTierManager(overrides?: {
    tierConfig?: TierConfig;
    scoringConfig?: ScoringConfig;
  }): TierManager {
    return new TierManager({
      store,
      embedder: fakeEmbedder() as any,
      memoryDir,
      tierConfig: overrides?.tierConfig ?? DEFAULT_TIER_CONFIG,
      scoringConfig: overrides?.scoringConfig ?? DEFAULT_SCORING,
      log: fakeLogger() as any,
    });
  }

  describe("archiveToCold (Phase 999.119 — cold is a tier inside SQLite)", () => {
    it("marks the memory cold and KEEPS the row + embedding in SQLite", () => {
      const tm = createTierManager();
      const entry = store.insert(
        { content: "Important fact about cats", source: "conversation", importance: 0.8, tags: ["cats", "facts"] },
        randomEmbedding(),
      );

      expect(tm.archiveToCold(entry)).toBe(true);

      const db = store.getDatabase();
      const row = db.prepare("SELECT tier FROM memories WHERE id = ?").get(entry.id) as { tier: string };
      expect(row.tier).toBe("cold");
      const vecRow = db.prepare("SELECT memory_id FROM vec_memories WHERE memory_id = ?").get(entry.id);
      expect(vecRow).toBeDefined();
      // No file is written any more — nothing ever read them back.
      expect(existsSync(join(memoryDir, "archive", "cold"))).toBe(false);
    });

    it("cold rows stay reachable by vector search (the agent does not forget them)", () => {
      const tm = createTierManager();
      const emb = randomEmbedding();
      const entry = store.insert({ content: "still findable", source: "manual" }, emb);

      tm.archiveToCold(entry);

      const hits = store.searchMemoriesVec(emb, 5);
      expect(hits.map((h) => h.memory_id)).toContain(entry.id);
    });

    it("returns false for an already-cold or missing row", () => {
      const tm = createTierManager();
      const entry = store.insert({ content: "twice", source: "manual" }, randomEmbedding());

      expect(tm.archiveToCold(entry)).toBe(true);
      expect(tm.archiveToCold({ ...entry, tier: "cold" })).toBe(false);
      expect(tm.archiveToCold({ ...entry, id: "nonexistent-id" })).toBe(false);
    });

    it("a session-summary memory can be cooled and later deleted — the FK is detached, not violated", () => {
      const tm = createTierManager();
      const entry = store.insert(
        { content: "2 turn(s). Last user: hi", source: "conversation", importance: 0.78 },
        randomEmbedding(),
      );
      const db = store.getDatabase();
      db.prepare(
        `INSERT INTO conversation_sessions (id, agent_name, started_at, status, summary_memory_id)
         VALUES ('sess-1', 'fin-research', '2026-05-08T02:55:04.767Z', 'summarized', ?)`,
      ).run(entry.id);

      expect(tm.archiveToCold(entry)).toBe(true);
      // Pre-999.119 this threw "FOREIGN KEY constraint failed" and aborted
      // the whole maintenance cycle every 6 h.
      expect(store.delete(entry.id)).toBe(true);

      const session = db
        .prepare("SELECT status, summary_memory_id FROM conversation_sessions WHERE id = 'sess-1'")
        .get() as { status: string; summary_memory_id: string | null };
      expect(session.status).toBe("summarized");
      expect(session.summary_memory_id).toBeNull();
    });
  });

  describe("exportColdArchive + rewarmFromCold (legacy file format)", () => {
    it("writes a markdown file with YAML frontmatter and base64 embedding and keeps the row", () => {
      const tm = createTierManager();
      const entry = store.insert(
        { content: "Important fact about cats", source: "conversation", importance: 0.8, tags: ["cats", "facts"] },
        randomEmbedding(),
      );

      const filePath = tm.exportColdArchive(entry)!;

      expect(existsSync(filePath)).toBe(true);
      const content = readFileSync(filePath, "utf-8");
      expect(content).toContain("---");
      expect(content).toContain("embedding_base64:");
      expect(content).toContain("archived_at:");
      expect(content).toContain("Important fact about cats");
      const row = store.getDatabase().prepare("SELECT tier FROM memories WHERE id = ?").get(entry.id) as { tier: string };
      expect(row.tier).toBe("warm");
    });

    it("creates the cold archive directory if it does not exist", () => {
      const tm = createTierManager();
      const entry = store.insert(
        { content: "test", source: "manual" },
        randomEmbedding(),
      );

      const coldDir = join(memoryDir, "archive", "cold");
      expect(existsSync(coldDir)).toBe(false);

      tm.exportColdArchive(entry);

      expect(existsSync(coldDir)).toBe(true);
    });

    it("returns null if embedding is not found", () => {
      const tm = createTierManager();
      // Create a fake entry that has no embedding in vec_memories
      const fakeEntry: MemoryEntry = Object.freeze({
        id: "nonexistent-id",
        content: "ghost memory",
        source: "manual" as const,
        importance: 0.5,
        accessCount: 0,
        tags: Object.freeze([]),
        embedding: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        accessedAt: new Date().toISOString(),
        tier: "warm" as const,
        sourceTurnIds: null,
      });

      const result = tm.exportColdArchive(fakeEntry);
      expect(result).toBeNull();
    });

    it("filename uses id and slug from content", () => {
      const tm = createTierManager();
      const entry = store.insert(
        { content: "My Special Memory About Testing", source: "manual" },
        randomEmbedding(),
      );

      const filePath = tm.exportColdArchive(entry)!;
      const fileName = filePath.split("/").pop()!;
      expect(fileName).toContain(entry.id);
      expect(fileName).toContain("my-special-memory-about-testing");
      expect(fileName.endsWith(".md")).toBe(true);
    });

    it("rewarmFromCold re-inserts a legacy archive whose row is gone, tier=warm, access_count + 1", async () => {
      const embedder = fakeEmbedder();
      const tm = new TierManager({
        store,
        embedder: embedder as any,
        memoryDir,
        tierConfig: DEFAULT_TIER_CONFIG,
        scoringConfig: DEFAULT_SCORING,
        log: fakeLogger() as any,
      });

      // Simulate the pre-999.119 archiver: file written, row deleted.
      const entry = store.insert(
        { content: "rewarmed content", source: "conversation", importance: 0.7, tags: ["test"] },
        randomEmbedding(),
      );
      const filePath = tm.exportColdArchive(entry)!;
      store.delete(entry.id);

      const rewarmed = await tm.rewarmFromCold(filePath);

      expect(rewarmed.content).toBe("rewarmed content");
      expect(rewarmed.tier).toBe("warm");
      expect(rewarmed.source).toBe("conversation");
      expect(rewarmed.accessCount).toBeGreaterThanOrEqual(1);
      expect(embedder.embed).toHaveBeenCalledWith("rewarmed content");
      expect(existsSync(filePath)).toBe(false);
    });

    it("rewarmFromCold on a file whose row still exists sets it warm and removes the file (no re-embed)", async () => {
      const embedder = fakeEmbedder();
      const tm = new TierManager({
        store,
        embedder: embedder as any,
        memoryDir,
        tierConfig: DEFAULT_TIER_CONFIG,
        scoringConfig: DEFAULT_SCORING,
        log: fakeLogger() as any,
      });
      const entry = store.insert({ content: "ephemeral cold", source: "manual" }, randomEmbedding());
      const filePath = tm.exportColdArchive(entry)!;
      tm.archiveToCold(entry);

      const rewarmed = await tm.rewarmFromCold(filePath);

      expect(rewarmed.id).toBe(entry.id);
      expect(rewarmed.tier).toBe("warm");
      expect(existsSync(filePath)).toBe(false);
      expect(embedder.embed).not.toHaveBeenCalled();
      const row = store.getDatabase().prepare("SELECT tier FROM memories WHERE id = ?").get(entry.id) as { tier: string };
      expect(row.tier).toBe("warm");
    });
  });

  describe("importColdArchives (Phase 999.119 — bring legacy cold files back)", () => {
    it("re-imports a legacy file as a cold-tier row using the stored embedding, without the embedder", () => {
      const embedder = fakeEmbedder();
      const tm = new TierManager({
        store,
        embedder: embedder as any,
        memoryDir,
        tierConfig: DEFAULT_TIER_CONFIG,
        scoringConfig: DEFAULT_SCORING,
        log: fakeLogger() as any,
      });
      const emb = randomEmbedding();
      const entry = store.insert(
        { content: "archived in May", source: "conversation", importance: 0.6, tags: ["x"] },
        emb,
      );
      const filePath = tm.exportColdArchive(entry)!;
      store.delete(entry.id);
      expect(tm.coldArchiveFileCount()).toBe(1);

      const result = tm.importColdArchives();

      expect(result).toEqual({ imported: 1, skipped: 0, failed: 0, firstError: null });
      expect(existsSync(filePath)).toBe(false);
      expect(embedder.embed).not.toHaveBeenCalled();
      const db = store.getDatabase();
      const row = db
        .prepare("SELECT tier, content, importance, access_count FROM memories WHERE id = ?")
        .get(entry.id) as { tier: string; content: string; importance: number; access_count: number };
      expect(row.tier).toBe("cold");
      expect(row.content).toBe("archived in May");
      expect(row.importance).toBeCloseTo(0.6, 5);
      // The stored vector round-trips exactly: a search with the original
      // embedding finds the re-imported row at distance ~0.
      const hits = store.searchMemoriesVec(emb, 1);
      expect(hits[0]?.memory_id).toBe(entry.id);
      expect(hits[0]?.distance).toBeLessThan(1e-5);
    });

    it("removes a file whose row already exists and counts it as skipped", () => {
      const tm = createTierManager();
      const entry = store.insert({ content: "duplicate file", source: "manual" }, randomEmbedding());
      const filePath = tm.exportColdArchive(entry)!;

      const result = tm.importColdArchives();

      expect(result).toEqual({ imported: 0, skipped: 1, failed: 0, firstError: null });
      expect(existsSync(filePath)).toBe(false);
    });

    it("leaves an unparseable file in place and counts it as failed", () => {
      const tm = createTierManager();
      const coldDir = join(memoryDir, "archive", "cold");
      mkdirSync(coldDir, { recursive: true });
      const junk = join(coldDir, "junk.md");
      writeFileSync(junk, "not a cold archive", "utf-8");

      const result = tm.importColdArchives();

      expect(result.imported).toBe(0);
      expect(result.failed).toBe(1);
      expect(result.firstError).toContain("Invalid cold archive format");
      expect(existsSync(junk)).toBe(true);
    });

    it("returns zeros when there is no archive directory", () => {
      const tm = createTierManager();
      expect(tm.coldArchiveFileCount()).toBe(0);
      expect(tm.importColdArchives()).toEqual({ imported: 0, skipped: 0, failed: 0, firstError: null });
    });
  });

  describe("refreshHotTier", () => {
    it("promotes warm memories that meet hot criteria", () => {
      const tm = createTierManager({
        tierConfig: { ...DEFAULT_TIER_CONFIG, hotAccessThreshold: 2, hotBudget: 5 },
      });

      // Insert a warm memory with enough accesses
      const entry = store.insert(
        { content: "frequently accessed", source: "conversation", importance: 0.9 },
        randomEmbedding(),
      );
      // Bump access count to meet threshold
      const db = store.getDatabase();
      const now = new Date().toISOString();
      db.prepare("UPDATE memories SET access_count = ?, accessed_at = ? WHERE id = ?").run(5, now, entry.id);

      tm.refreshHotTier();

      // Check that the memory is now hot
      const row = db.prepare("SELECT tier FROM memories WHERE id = ?").get(entry.id) as { tier: string };
      expect(row.tier).toBe("hot");
    });

    it("demotes hot memories that are stale", () => {
      const tm = createTierManager({
        tierConfig: { ...DEFAULT_TIER_CONFIG, hotDemotionDays: 3 },
      });

      // Insert a memory and make it hot
      const entry = store.insert(
        { content: "stale hot", source: "conversation" },
        randomEmbedding(),
      );
      const db = store.getDatabase();
      db.prepare("UPDATE memories SET tier = 'hot' WHERE id = ?").run(entry.id);

      // Make it stale (accessed 10 days ago)
      const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
      db.prepare("UPDATE memories SET accessed_at = ? WHERE id = ?").run(tenDaysAgo, entry.id);

      tm.refreshHotTier();

      const row = db.prepare("SELECT tier FROM memories WHERE id = ?").get(entry.id) as { tier: string };
      expect(row.tier).toBe("warm");
    });

    it("respects hotBudget limit", () => {
      const tm = createTierManager({
        tierConfig: { ...DEFAULT_TIER_CONFIG, hotAccessThreshold: 1, hotBudget: 2 },
      });

      const db = store.getDatabase();
      const now = new Date().toISOString();

      // Insert 5 warm memories that all qualify
      for (let i = 0; i < 5; i++) {
        const entry = store.insert(
          { content: `memory-${i}`, source: "conversation", importance: 0.5 + i * 0.1 },
          randomEmbedding(),
        );
        db.prepare("UPDATE memories SET access_count = ?, accessed_at = ? WHERE id = ?").run(5, now, entry.id);
      }

      tm.refreshHotTier();

      const hotCount = (db.prepare("SELECT COUNT(*) as cnt FROM memories WHERE tier = 'hot'").get() as { cnt: number }).cnt;
      expect(hotCount).toBe(2);
    });

    // Phase 100-fu — graph-centrality promotion in the TierManager. The
    // refreshHotTier() loop must consult getBacklinkCount(memory.id) and
    // pass that into shouldPromoteToHot so a heavily-linked hub node
    // qualifies even when its direct access_count is below the
    // access-based threshold.

    // TM-1: TierManager passes backlinkCount to shouldPromoteToHot.
    // Verified end-to-end: insert a memory with access_count=0 (so the
    // access-path cannot promote it) and add backlinks at-or-above the
    // centrality threshold. After refreshHotTier(), the row is hot.
    it("TM-1: tier-manager passes backlinkCount to shouldPromoteToHot", () => {
      const tm = createTierManager({
        tierConfig: {
          ...DEFAULT_TIER_CONFIG,
          hotAccessThreshold: 100, // make access-path unreachable
          centralityPromoteThreshold: 5,
          hotBudget: 5,
        },
      });

      const target = store.insert(
        { content: "hub node", source: "manual", importance: 0.7 },
        randomEmbedding(),
      );

      // Wire 5 backlinks onto `target` — meets the centrality threshold.
      const stmts = store.getGraphStatements();
      const linkAt = new Date().toISOString();
      for (let i = 0; i < 5; i++) {
        const src = store.insert(
          { content: `linker ${i}`, source: "manual" },
          randomEmbedding(),
        );
        stmts.insertLink.run(src.id, target.id, target.id, linkAt);
      }

      // Sanity: target has access_count=0 so the access-based path
      // cannot reach the threshold of 100.
      const before = store.getDatabase()
        .prepare("SELECT access_count, tier FROM memories WHERE id = ?")
        .get(target.id) as { access_count: number; tier: string };
      expect(before.access_count).toBe(0);
      expect(before.tier).toBe("warm");

      tm.refreshHotTier();

      const after = store.getDatabase()
        .prepare("SELECT tier FROM memories WHERE id = ?")
        .get(target.id) as { tier: string };
      expect(after.tier).toBe("hot");
    });

    // TM-2: realistic production case. 6 backlinks, access_count=0, an
    // unmodified default config — the memory still ends up hot.
    it("TM-2: a memory with 6 backlinks and access_count=0 gets promoted to hot", () => {
      const tm = createTierManager(); // default config

      const target = store.insert(
        { content: "fin-client style hub", source: "manual", importance: 0.6 },
        randomEmbedding(),
      );

      const stmts = store.getGraphStatements();
      const linkAt = new Date().toISOString();
      for (let i = 0; i < 6; i++) {
        const src = store.insert(
          { content: `turn-summary ${i}`, source: "manual" },
          randomEmbedding(),
        );
        stmts.insertLink.run(src.id, target.id, target.id, linkAt);
      }

      tm.refreshHotTier();

      const row = store.getDatabase()
        .prepare("SELECT tier FROM memories WHERE id = ?")
        .get(target.id) as { tier: string };
      expect(row.tier).toBe("hot");
    });
  });

  describe("getHotMemories", () => {
    it("returns current hot-tier memories sorted by importance desc", () => {
      const tm = createTierManager();
      const db = store.getDatabase();

      const e1 = store.insert(
        { content: "low importance", source: "manual", importance: 0.3 },
        randomEmbedding(),
      );
      const e2 = store.insert(
        { content: "high importance", source: "manual", importance: 0.9 },
        randomEmbedding(),
      );

      db.prepare("UPDATE memories SET tier = 'hot' WHERE id = ?").run(e1.id);
      db.prepare("UPDATE memories SET tier = 'hot' WHERE id = ?").run(e2.id);

      const hotMemories = tm.getHotMemories();
      expect(hotMemories.length).toBe(2);
      expect(hotMemories[0].content).toBe("high importance");
      expect(hotMemories[1].content).toBe("low importance");
    });

    it("returns frozen array", () => {
      const tm = createTierManager();
      const hotMemories = tm.getHotMemories();
      expect(Object.isFrozen(hotMemories)).toBe(true);
    });
  });

  describe("runMaintenance", () => {
    it("performs full cycle: demote stale hot, archive cold-worthy warm, promote qualifying warm", () => {
      const tm = createTierManager({
        tierConfig: {
          ...DEFAULT_TIER_CONFIG,
          hotAccessThreshold: 2,
          hotDemotionDays: 3,
          coldRelevanceThreshold: 0.05,
          hotBudget: 5,
        },
      });

      const db = store.getDatabase();
      const now = new Date();
      const tenDaysAgo = new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000).toISOString();
      const yearAgo = new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000).toISOString();

      // 1. A stale hot memory (should be demoted to warm)
      const staleHot = store.insert(
        { content: "stale hot memory", source: "conversation", importance: 0.5 },
        randomEmbedding(),
      );
      db.prepare("UPDATE memories SET tier = 'hot', accessed_at = ? WHERE id = ?").run(tenDaysAgo, staleHot.id);

      // 2. A low-relevance warm memory (should be archived to cold)
      const lowRelevance = store.insert(
        { content: "ancient memory nobody cares about", source: "manual", importance: 0.01 },
        randomEmbedding(),
      );
      db.prepare("UPDATE memories SET accessed_at = ? WHERE id = ?").run(yearAgo, lowRelevance.id);

      // 3. A frequently accessed warm memory (should be promoted to hot)
      const frequentWarm = store.insert(
        { content: "very popular warm memory", source: "conversation", importance: 0.9 },
        randomEmbedding(),
      );
      db.prepare("UPDATE memories SET access_count = ?, accessed_at = ? WHERE id = ?").run(
        10, now.toISOString(), frequentWarm.id,
      );

      const result = tm.runMaintenance();

      expect(result.demoted).toBeGreaterThanOrEqual(1);
      expect(result.archived).toBeGreaterThanOrEqual(1);
      expect(result.promoted).toBeGreaterThanOrEqual(1);
      expect(result.errors).toBe(0);

      // Verify: stale hot is now warm (importance 0.5, accessed 10 days ago
      // is far above the cold threshold)
      const staleRow = db.prepare("SELECT tier FROM memories WHERE id = ?").get(staleHot.id) as { tier: string };
      expect(staleRow.tier).toBe("warm");

      // Verify: low-relevance warm is cold — and STILL in SQLite
      const lowRow = db.prepare("SELECT tier FROM memories WHERE id = ?").get(lowRelevance.id) as { tier: string };
      expect(lowRow.tier).toBe("cold");

      // Verify: frequent warm is now hot
      const freqRow = db.prepare("SELECT tier FROM memories WHERE id = ?").get(frequentWarm.id) as { tier: string };
      expect(freqRow.tier).toBe("hot");
    });

    it("returns counts of demoted, archived, promoted, rewarmed and errors", () => {
      const tm = createTierManager();
      const result = tm.runMaintenance();
      expect(typeof result.demoted).toBe("number");
      expect(typeof result.archived).toBe("number");
      expect(typeof result.promoted).toBe("number");
      expect(typeof result.rewarmed).toBe("number");
      expect(result.errors).toBe(0);
      expect(result.firstError).toBeNull();
    });

    it("isolates a per-row failure: counts it, keeps the first message, and finishes the cycle", () => {
      const tm = createTierManager();
      const db = store.getDatabase();
      const yearAgo = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString();
      const bad = store.insert({ content: "bad row", source: "manual", importance: 0.01 }, randomEmbedding());
      const good = store.insert({ content: "good row", source: "manual", importance: 0.01 }, randomEmbedding());
      db.prepare("UPDATE memories SET accessed_at = ? WHERE id IN (?, ?)").run(yearAgo, bad.id, good.id);

      const realUpdateTier = store.updateTier.bind(store);
      const spy = vi.spyOn(store, "updateTier").mockImplementation((id, tier) => {
        if (id === bad.id) throw new Error("FOREIGN KEY constraint failed");
        return realUpdateTier(id, tier);
      });

      const result = tm.runMaintenance();
      spy.mockRestore();

      expect(result.errors).toBe(1);
      expect(result.firstError).toContain("FOREIGN KEY constraint failed");
      expect(result.archived).toBe(1);
      const goodRow = db.prepare("SELECT tier FROM memories WHERE id = ?").get(good.id) as { tier: string };
      expect(goodRow.tier).toBe("cold");
    });

    it("never cools a structural hub (backlinks >= centralityPromoteThreshold)", () => {
      const tm = createTierManager({
        tierConfig: { ...DEFAULT_TIER_CONFIG, centralityPromoteThreshold: 3, hotBudget: 0 },
      });
      const db = store.getDatabase();
      const yearAgo = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString();
      const hub = store.insert({ content: "hub", source: "manual", importance: 0.01 }, randomEmbedding());
      const leaf = store.insert({ content: "leaf", source: "manual", importance: 0.01 }, randomEmbedding());
      db.prepare("UPDATE memories SET accessed_at = ? WHERE id IN (?, ?)").run(yearAgo, hub.id, leaf.id);
      for (let i = 0; i < 3; i++) {
        const src = store.insert({ content: `pointer ${i}`, source: "manual" }, randomEmbedding());
        db.prepare("INSERT OR IGNORE INTO memory_links (source_id, target_id, link_text, created_at) VALUES (?, ?, 'auto:similar', ?)")
          .run(src.id, hub.id, new Date().toISOString());
      }

      const result = tm.runMaintenance();

      expect(result.errors).toBe(0);
      const hubRow = db.prepare("SELECT tier FROM memories WHERE id = ?").get(hub.id) as { tier: string };
      const leafRow = db.prepare("SELECT tier FROM memories WHERE id = ?").get(leaf.id) as { tier: string };
      expect(hubRow.tier).toBe("warm");
      expect(leafRow.tier).toBe("cold");
    });

    it("re-warms a cold row that was accessed inside the hot-access window", () => {
      const tm = createTierManager();
      const db = store.getDatabase();
      const entry = store.insert({ content: "used again", source: "manual" }, randomEmbedding());
      db.prepare("UPDATE memories SET tier = 'cold', accessed_at = ? WHERE id = ?")
        .run(new Date().toISOString(), entry.id);

      const result = tm.runMaintenance();

      expect(result.rewarmed).toBe(1);
      const row = db.prepare("SELECT tier FROM memories WHERE id = ?").get(entry.id) as { tier: string };
      expect(row.tier).toBe("warm");
    });

    it("leaves a cold row cold when its last access is outside the window", () => {
      const tm = createTierManager();
      const db = store.getDatabase();
      const entry = store.insert({ content: "long forgotten", source: "manual", importance: 0.01 }, randomEmbedding());
      const yearAgo = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString();
      db.prepare("UPDATE memories SET tier = 'cold', accessed_at = ? WHERE id = ?").run(yearAgo, entry.id);

      const result = tm.runMaintenance();

      expect(result.rewarmed).toBe(0);
      const row = db.prepare("SELECT tier FROM memories WHERE id = ?").get(entry.id) as { tier: string };
      expect(row.tier).toBe("cold");
    });
  });

  // ── Phase 52 Plan 02 — hot-tier stable_token for cache-prefix detection ────

  describe("getHotMemoriesStableToken (Phase 52)", () => {
    it("returns deterministic sha256 over top-3 hot memories' ids + accessedAt", () => {
      const tm = createTierManager();
      // Seed three hot memories.
      const m1 = store.insert(
        { content: "mem one", source: "conversation", importance: 1.0 },
        randomEmbedding(),
      );
      const m2 = store.insert(
        { content: "mem two", source: "conversation", importance: 0.9 },
        randomEmbedding(),
      );
      const m3 = store.insert(
        { content: "mem three", source: "conversation", importance: 0.8 },
        randomEmbedding(),
      );
      // Promote all three to hot tier.
      store.updateTier(m1.id, "hot");
      store.updateTier(m2.id, "hot");
      store.updateTier(m3.id, "hot");

      const token1 = tm.getHotMemoriesStableToken();
      const token2 = tm.getHotMemoriesStableToken();
      expect(token1).toBe(token2);
      expect(token1).toMatch(/^[a-f0-9]{64}$/);
    });

    it("token changes when hot-tier composition changes", () => {
      const tm = createTierManager();
      const m1 = store.insert(
        { content: "mem one", source: "conversation", importance: 1.0 },
        randomEmbedding(),
      );
      store.updateTier(m1.id, "hot");
      const before = tm.getHotMemoriesStableToken();

      // Add a second hot memory — composition changed.
      const m2 = store.insert(
        { content: "mem two", source: "conversation", importance: 0.9 },
        randomEmbedding(),
      );
      store.updateTier(m2.id, "hot");

      const after = tm.getHotMemoriesStableToken();
      expect(after).not.toBe(before);
    });

    it("returns sha256('') when no hot memories exist", () => {
      const tm = createTierManager();
      const token = tm.getHotMemoriesStableToken();
      // sha256 of empty string has a known hex value.
      const emptyHash =
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
      expect(token).toBe(emptyHash);
    });
  });
});
