import { describe, it, expect, afterEach } from "vitest";
import { MemoryStore } from "../store.js";
import { MemoryError } from "../errors.js";

function createTestStore(): MemoryStore {
  return new MemoryStore(":memory:");
}

function randomEmbedding(): Float32Array {
  const arr = new Float32Array(384);
  for (let i = 0; i < 384; i++) {
    arr[i] = Math.random() * 2 - 1;
  }
  return arr;
}

describe("MemoryStore", () => {
  let store: MemoryStore;

  afterEach(() => {
    store?.close();
  });

  describe("constructor", () => {
    it("creates all required tables", () => {
      store = createTestStore();
      const db = store.getDatabase();

      // Check memories table
      const memoriesInfo = db
        .prepare("PRAGMA table_info(memories)")
        .all() as Array<{ name: string }>;
      const memoryColumns = memoriesInfo.map((c) => c.name);
      expect(memoryColumns).toContain("id");
      expect(memoryColumns).toContain("content");
      expect(memoryColumns).toContain("source");
      expect(memoryColumns).toContain("importance");
      expect(memoryColumns).toContain("access_count");
      expect(memoryColumns).toContain("tags");
      expect(memoryColumns).toContain("created_at");
      expect(memoryColumns).toContain("updated_at");
      expect(memoryColumns).toContain("accessed_at");

      // Check session_logs table
      const sessionInfo = db
        .prepare("PRAGMA table_info(session_logs)")
        .all() as Array<{ name: string }>;
      const sessionColumns = sessionInfo.map((c) => c.name);
      expect(sessionColumns).toContain("id");
      expect(sessionColumns).toContain("date");
      expect(sessionColumns).toContain("file_path");
      expect(sessionColumns).toContain("entry_count");
      expect(sessionColumns).toContain("created_at");

      // Check vec_memories virtual table exists (query it)
      const vecCount = db
        .prepare("SELECT count(*) as cnt FROM vec_memories")
        .get() as { cnt: number };
      expect(vecCount.cnt).toBe(0);
    });
  });

  describe("insert", () => {
    it("creates memory with all fields populated", () => {
      store = createTestStore();
      const embedding = randomEmbedding();

      const entry = store.insert(
        {
          content: "test content",
          source: "conversation",
          importance: 0.8,
          tags: ["tag1", "tag2"],
        },
        embedding,
      );

      expect(entry.id).toBeTruthy();
      expect(entry.content).toBe("test content");
      expect(entry.source).toBe("conversation");
      expect(entry.importance).toBe(0.8);
      expect(entry.accessCount).toBe(0);
      expect(entry.tags).toEqual(["tag1", "tag2"]);
      expect(entry.embedding).toBe(embedding);
      expect(entry.createdAt).toBeTruthy();
      expect(entry.updatedAt).toBeTruthy();
      expect(entry.accessedAt).toBeTruthy();
    });

    it("returns a frozen (readonly) entry", () => {
      store = createTestStore();
      const entry = store.insert(
        { content: "test", source: "manual" },
        randomEmbedding(),
      );

      expect(Object.isFrozen(entry)).toBe(true);
    });

    it("stores embedding in vec_memories", () => {
      store = createTestStore();
      const db = store.getDatabase();

      store.insert(
        { content: "test", source: "manual" },
        randomEmbedding(),
      );

      const vecCount = db
        .prepare("SELECT count(*) as cnt FROM vec_memories")
        .get() as { cnt: number };
      expect(vecCount.cnt).toBe(1);
    });

    it("auto-calculates importance when not explicitly provided", () => {
      store = createTestStore();
      const entry = store.insert(
        { content: "test", source: "system" },
        randomEmbedding(),
      );

      // Short content gets low score from calculateImportance (recencyBoost + tiny lengthScore)
      expect(entry.importance).toBeGreaterThan(0);
      expect(entry.importance).toBeLessThan(0.5);
    });

    it("defaults tags to empty array", () => {
      store = createTestStore();
      const entry = store.insert(
        { content: "test", source: "system" },
        randomEmbedding(),
      );

      expect(entry.tags).toEqual([]);
    });
  });

  describe("getById", () => {
    it("returns entry and increments access_count", () => {
      store = createTestStore();
      const created = store.insert(
        { content: "findme", source: "conversation" },
        randomEmbedding(),
      );

      const found = store.getById(created.id);
      expect(found).not.toBeNull();
      expect(found!.content).toBe("findme");
      expect(found!.accessCount).toBe(1);

      // Second access should increment again
      const found2 = store.getById(created.id);
      expect(found2!.accessCount).toBe(2);
    });

    it("updates accessed_at on retrieval", () => {
      store = createTestStore();
      const created = store.insert(
        { content: "test", source: "manual" },
        randomEmbedding(),
      );

      const found = store.getById(created.id);
      expect(found!.accessedAt).toBeTruthy();
      // accessed_at should be >= created_at
      expect(found!.accessedAt >= created.createdAt).toBe(true);
    });

    it("returns null for non-existent ID", () => {
      store = createTestStore();
      const result = store.getById("nonexistent-id");
      expect(result).toBeNull();
    });
  });

  describe("delete", () => {
    it("removes from both memories and vec_memories", () => {
      store = createTestStore();
      const db = store.getDatabase();
      const created = store.insert(
        { content: "deleteme", source: "manual" },
        randomEmbedding(),
      );

      const deleted = store.delete(created.id);
      expect(deleted).toBe(true);

      // Verify gone from memories
      expect(store.getById(created.id)).toBeNull();

      // Verify gone from vec_memories
      const vecCount = db
        .prepare("SELECT count(*) as cnt FROM vec_memories")
        .get() as { cnt: number };
      expect(vecCount.cnt).toBe(0);
    });

    it("returns false for non-existent ID", () => {
      store = createTestStore();
      expect(store.delete("nonexistent")).toBe(false);
    });
  });

  // Phase 107 VEC-CLEAN-01 / VEC-CLEAN-02 regression — pin the invariant
  // that `MemoryStore.delete(id)` cascades to `vec_memories` ATOMICALLY
  // (single transaction, paired rows always go together). RESEARCH.md
  // confirms `MemoryStore.delete` is the only production
  // `DELETE FROM memories` site; this test prevents future drift.
  describe("Phase 107 VEC-CLEAN-01 regression — delete cascades to vec_memories", () => {
    it("delete-cascades-vec — paired vec_memories row removed inside the same transaction", () => {
      store = createTestStore();
      const db = store.getDatabase();
      const a = store.insert(
        { content: "alpha", source: "manual", skipDedup: true },
        randomEmbedding(),
      );
      const b = store.insert(
        { content: "beta", source: "manual", skipDedup: true },
        randomEmbedding(),
      );

      // Pre-state: both pairs present.
      const beforeMemories = db
        .prepare("SELECT count(*) as cnt FROM memories")
        .get() as { cnt: number };
      const beforeVec = db
        .prepare("SELECT count(*) as cnt FROM vec_memories")
        .get() as { cnt: number };
      expect(beforeMemories.cnt).toBe(2);
      expect(beforeVec.cnt).toBe(2);

      // Delete `a`.
      const deleted = store.delete(a.id);
      expect(deleted).toBe(true);

      // Cascade invariant: BOTH tables now lack `a.id`. The vec row was
      // removed by `MemoryStore.delete` inside `db.transaction()` so the
      // vec_memories table cannot be left with an orphan.
      const aMemoryRow = db
        .prepare("SELECT id FROM memories WHERE id = ?")
        .get(a.id) as { id: string } | undefined;
      const aVecRow = db
        .prepare("SELECT memory_id FROM vec_memories WHERE memory_id = ?")
        .get(a.id) as { memory_id: string } | undefined;
      expect(aMemoryRow).toBeUndefined();
      expect(aVecRow).toBeUndefined();

      // `b` still paired in both tables (cascade is targeted, not blanket).
      const bMemoryRow = db
        .prepare("SELECT id FROM memories WHERE id = ?")
        .get(b.id) as { id: string } | undefined;
      const bVecRow = db
        .prepare("SELECT memory_id FROM vec_memories WHERE memory_id = ?")
        .get(b.id) as { memory_id: string } | undefined;
      expect(bMemoryRow?.id).toBe(b.id);
      expect(bVecRow?.memory_id).toBe(b.id);
    });
  });

  describe("listRecent", () => {
    it("returns entries ordered by created_at DESC", () => {
      store = createTestStore();

      // Insert with slight delays to ensure different timestamps
      store.insert({ content: "first", source: "manual" }, randomEmbedding());
      store.insert(
        { content: "second", source: "manual" },
        randomEmbedding(),
      );
      store.insert({ content: "third", source: "manual" }, randomEmbedding());

      const recent = store.listRecent(10);
      expect(recent).toHaveLength(3);
      // Most recent first
      expect(recent[0].content).toBe("third");
      expect(recent[2].content).toBe("first");
    });

    it("respects limit parameter", () => {
      store = createTestStore();
      store.insert({ content: "a", source: "manual" }, randomEmbedding());
      store.insert({ content: "b", source: "manual" }, randomEmbedding());
      store.insert({ content: "c", source: "manual" }, randomEmbedding());

      const recent = store.listRecent(2);
      expect(recent).toHaveLength(2);
    });
  });

  describe("recordSessionLog", () => {
    it("creates session log entry with all fields", () => {
      store = createTestStore();

      const entry = store.recordSessionLog({
        date: "2026-04-09",
        filePath: "/memory/2026-04-09.md",
        entryCount: 5,
      });

      expect(entry.id).toBeTruthy();
      expect(entry.date).toBe("2026-04-09");
      expect(entry.filePath).toBe("/memory/2026-04-09.md");
      expect(entry.entryCount).toBe(5);
      expect(entry.createdAt).toBeTruthy();
      expect(Object.isFrozen(entry)).toBe(true);
    });
  });

  describe("deduplication on insert", () => {
    /** Create a normalized directional embedding. */
    function directionalEmbedding(dim: number, value: number): Float32Array {
      const arr = new Float32Array(384);
      arr[dim] = value;
      const norm = Math.abs(value);
      if (norm > 0) arr[dim] /= norm;
      return arr;
    }

    it("merges near-duplicate embedding instead of creating two entries", () => {
      store = new MemoryStore(":memory:", { enabled: true, similarityThreshold: 0.85 });
      const vec = directionalEmbedding(0, 1.0);

      store.insert({ content: "original", source: "manual" }, vec);
      store.insert({ content: "duplicate", source: "manual" }, vec);

      const list = store.listRecent(100);
      expect(list.length).toBe(1);
      expect(list[0].content).toBe("duplicate");
    });

    it("merged entry keeps max importance and union of tags", () => {
      store = new MemoryStore(":memory:", { enabled: true, similarityThreshold: 0.85 });
      const vec = directionalEmbedding(0, 1.0);

      store.insert(
        { content: "original", source: "manual", importance: 0.3, tags: ["a"] },
        vec,
      );
      store.insert(
        { content: "updated", source: "manual", importance: 0.8, tags: ["b"] },
        vec,
      );

      const list = store.listRecent(100);
      expect(list.length).toBe(1);
      expect(list[0].importance).toBe(0.8);
      expect([...list[0].tags].sort()).toEqual(["a", "b"]);
    });

    it("skipDedup creates new entry even with duplicate embedding", () => {
      store = new MemoryStore(":memory:", { enabled: true, similarityThreshold: 0.85 });
      const vec = directionalEmbedding(0, 1.0);

      store.insert({ content: "original", source: "manual" }, vec);
      store.insert({ content: "skip-dedup", source: "manual", skipDedup: true }, vec);

      const list = store.listRecent(100);
      expect(list.length).toBe(2);
    });

    it("first insert into empty DB succeeds normally", () => {
      store = new MemoryStore(":memory:", { enabled: true, similarityThreshold: 0.85 });
      const vec = directionalEmbedding(0, 1.0);

      const entry = store.insert({ content: "first", source: "manual" }, vec);
      expect(entry.content).toBe("first");
      expect(entry.id).toBeTruthy();
    });
  });

  describe("tier column migration", () => {
    it("tier column exists after store creation", () => {
      store = createTestStore();
      const db = store.getDatabase();

      const columns = db
        .prepare("PRAGMA table_info(memories)")
        .all() as Array<{ name: string }>;
      const columnNames = columns.map((c) => c.name);
      expect(columnNames).toContain("tier");
    });

    it("new memories default to warm tier", () => {
      store = createTestStore();
      const entry = store.insert(
        { content: "tier test", source: "manual" },
        randomEmbedding(),
      );

      expect(entry.tier).toBe("warm");

      // Also verify from DB directly
      const db = store.getDatabase();
      const row = db
        .prepare("SELECT tier FROM memories WHERE id = ?")
        .get(entry.id) as { tier: string };
      expect(row.tier).toBe("warm");
    });
  });

  describe("updateTier", () => {
    it("changes the tier value", () => {
      store = createTestStore();
      const entry = store.insert(
        { content: "update tier", source: "manual" },
        randomEmbedding(),
      );

      const updated = store.updateTier(entry.id, "hot");
      expect(updated).toBe(true);

      const db = store.getDatabase();
      const row = db
        .prepare("SELECT tier FROM memories WHERE id = ?")
        .get(entry.id) as { tier: string };
      expect(row.tier).toBe("hot");
    });

    it("returns false for non-existent ID", () => {
      store = createTestStore();
      expect(store.updateTier("nonexistent", "cold")).toBe(false);
    });

    it("can set tier to cold", () => {
      store = createTestStore();
      const entry = store.insert(
        { content: "cold test", source: "manual" },
        randomEmbedding(),
      );

      store.updateTier(entry.id, "cold");

      const db = store.getDatabase();
      const row = db
        .prepare("SELECT tier FROM memories WHERE id = ?")
        .get(entry.id) as { tier: string };
      expect(row.tier).toBe("cold");
    });
  });

  describe("listByTier", () => {
    it("filters by tier correctly", () => {
      store = createTestStore();
      const e1 = store.insert(
        { content: "warm1", source: "manual" },
        randomEmbedding(),
      );
      const e2 = store.insert(
        { content: "warm2", source: "manual" },
        randomEmbedding(),
      );
      store.insert(
        { content: "warm3", source: "manual" },
        randomEmbedding(),
      );

      // Promote one to hot, one to cold
      store.updateTier(e1.id, "hot");
      store.updateTier(e2.id, "cold");

      const warm = store.listByTier("warm", 100);
      expect(warm).toHaveLength(1);
      expect(warm[0].content).toBe("warm3");

      const hot = store.listByTier("hot", 100);
      expect(hot).toHaveLength(1);
      expect(hot[0].content).toBe("warm1");

      const cold = store.listByTier("cold", 100);
      expect(cold).toHaveLength(1);
      expect(cold[0].content).toBe("warm2");
    });

    it("respects limit parameter", () => {
      store = createTestStore();
      for (let i = 0; i < 5; i++) {
        store.insert(
          { content: `entry${i}`, source: "manual" },
          randomEmbedding(),
        );
      }

      const limited = store.listByTier("warm", 2);
      expect(limited).toHaveLength(2);
    });

    it("returns frozen array", () => {
      store = createTestStore();
      store.insert(
        { content: "test", source: "manual" },
        randomEmbedding(),
      );

      const results = store.listByTier("warm", 10);
      expect(Object.isFrozen(results)).toBe(true);
    });
  });

  describe("listWarmCandidatesForPromotion (Phase 999.8 follow-up)", () => {
    it("orders warm memories by backlink count DESC then accessed_at DESC", () => {
      store = createTestStore();
      const lowLink = store.insert(
        { content: "low-link hub", source: "manual" },
        randomEmbedding(),
      );
      const highLink = store.insert(
        { content: "high-link hub", source: "manual" },
        randomEmbedding(),
      );
      const noLinks = store.insert(
        { content: "isolated", source: "manual" },
        randomEmbedding(),
      );
      // Add 6 inbound links → highLink gets 6, lowLink gets 1
      for (let i = 0; i < 6; i++) {
        const src = store.insert(
          { content: `src${i}`, source: "manual" },
          randomEmbedding(),
        );
        store.getGraphStatements().insertLink.run(
          src.id,
          highLink.id,
          "ref",
          new Date().toISOString(),
        );
      }
      const oneSrc = store.insert(
        { content: "one-src", source: "manual" },
        randomEmbedding(),
      );
      store.getGraphStatements().insertLink.run(
        oneSrc.id,
        lowLink.id,
        "ref",
        new Date().toISOString(),
      );

      const warm = store.listWarmCandidatesForPromotion(100);
      // highLink (6 backlinks) must come BEFORE lowLink (1) and noLinks (0)
      const idsInOrder = warm.map((m) => m.id);
      const highIdx = idsInOrder.indexOf(highLink.id);
      const lowIdx = idsInOrder.indexOf(lowLink.id);
      const noIdx = idsInOrder.indexOf(noLinks.id);
      expect(highIdx).toBeGreaterThanOrEqual(0);
      expect(highIdx).toBeLessThan(lowIdx);
      expect(lowIdx).toBeLessThan(noIdx);
    });

    it("respects limit parameter", () => {
      store = createTestStore();
      for (let i = 0; i < 7; i++) {
        store.insert(
          { content: `entry${i}`, source: "manual" },
          randomEmbedding(),
        );
      }
      const result = store.listWarmCandidatesForPromotion(3);
      expect(result).toHaveLength(3);
    });

    it("only returns warm-tier memories (excludes hot and cold)", () => {
      store = createTestStore();
      const e1 = store.insert(
        { content: "warm-keeper", source: "manual" },
        randomEmbedding(),
      );
      const e2 = store.insert(
        { content: "promoted-to-hot", source: "manual" },
        randomEmbedding(),
      );
      const e3 = store.insert(
        { content: "archived-to-cold", source: "manual" },
        randomEmbedding(),
      );
      store.updateTier(e2.id, "hot");
      store.updateTier(e3.id, "cold");
      const warm = store.listWarmCandidatesForPromotion(100);
      expect(warm).toHaveLength(1);
      expect(warm[0].id).toBe(e1.id);
    });

    it("returns frozen array", () => {
      store = createTestStore();
      store.insert({ content: "x", source: "manual" }, randomEmbedding());
      const result = store.listWarmCandidatesForPromotion(10);
      expect(Object.isFrozen(result)).toBe(true);
    });
  });

  describe("getEmbedding", () => {
    it("returns Float32Array for existing memory", () => {
      store = createTestStore();
      const embedding = randomEmbedding();
      const entry = store.insert(
        { content: "embed test", source: "manual" },
        embedding,
      );

      const retrieved = store.getEmbedding(entry.id);
      expect(retrieved).toBeInstanceOf(Float32Array);
      expect(retrieved).toHaveLength(384);
    });

    it("returns null for non-existent memory", () => {
      store = createTestStore();
      const result = store.getEmbedding("nonexistent-id");
      expect(result).toBeNull();
    });
  });

  describe("source validation", () => {
    it("rejects invalid source values", () => {
      store = createTestStore();

      expect(() =>
        store.insert(
          { content: "test", source: "invalid" as any },
          randomEmbedding(),
        ),
      ).toThrow();
    });

    it("accepts all valid source values", () => {
      store = createTestStore();
      const sources = ["conversation", "manual", "system", "episode"] as const;

      for (const source of sources) {
        const entry = store.insert(
          { content: `test-${source}`, source },
          randomEmbedding(),
        );
        expect(entry.source).toBe(source);
      }
    });
  });

  describe("origin_id idempotency (Phase 80 MEM-02)", () => {
    it("origin_id column exists after MemoryStore construction", () => {
      store = createTestStore();
      const db = store.getDatabase();
      const columns = db
        .prepare("PRAGMA table_info(memories)")
        .all() as Array<{ name: string; type: string }>;
      const originRow = columns.find((c) => c.name === "origin_id");
      expect(originRow).toBeDefined();
      expect(originRow!.type).toBe("TEXT");
    });

    it("origin_id UNIQUE index is present on memories table", () => {
      store = createTestStore();
      const db = store.getDatabase();
      const indexes = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='memories'",
        )
        .all() as Array<{ name: string }>;
      const hasOriginIdIndex = indexes.some((i) => /origin_id/i.test(i.name));
      expect(hasOriginIdIndex).toBe(true);
    });

    it("migration is idempotent — re-opening DB does not throw and column count is stable", () => {
      // Use a tmp-file DB so it survives close/reopen (":memory:" doesn't).
      const tmpPath = `/tmp/store-origin-id-idempotent-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
      const first = new MemoryStore(tmpPath);
      const colsBefore = (first.getDatabase()
        .prepare("PRAGMA table_info(memories)")
        .all() as Array<{ name: string }>).length;
      first.close();

      // Re-opening must not throw and must leave column count unchanged.
      expect(() => {
        const second = new MemoryStore(tmpPath);
        const colsAfter = (second.getDatabase()
          .prepare("PRAGMA table_info(memories)")
          .all() as Array<{ name: string }>).length;
        expect(colsAfter).toBe(colsBefore);
        second.close();
      }).not.toThrow();
    });

    it("existing rows with NULL origin_id coexist under UNIQUE (no collision on NULL=NULL)", () => {
      store = createTestStore();
      const db = store.getDatabase();

      store.insert(
        { content: "row one", source: "manual" },
        randomEmbedding(),
      );
      store.insert(
        { content: "row two", source: "manual" },
        randomEmbedding(),
      );

      const nullCount = db
        .prepare(
          "SELECT COUNT(*) as cnt FROM memories WHERE origin_id IS NULL",
        )
        .get() as { cnt: number };
      expect(nullCount.cnt).toBe(2);
    });

    it("CreateMemoryInput.origin_id is optional — insert accepts with AND without", () => {
      store = createTestStore();

      // Without origin_id (existing behavior).
      const withoutOrigin = store.insert(
        { content: "no origin", source: "manual", skipDedup: true },
        randomEmbedding(),
      );
      expect(withoutOrigin.id).toBeTruthy();

      // With origin_id (Task 2 tests full semantics; here we only assert the
      // type accepts the field and insert() does not throw).
      const withOrigin = store.insert(
        {
          content: "has origin",
          source: "manual",
          skipDedup: true,
          origin_id: "openclaw:test:column-accepts-field",
        },
        randomEmbedding(),
      );
      expect(withOrigin.id).toBeTruthy();
    });

    it("origin_id insert returns new entry on first call and persists origin_id + vec row", () => {
      store = createTestStore();
      const db = store.getDatabase();
      const originId = "openclaw:test:abc123";

      const entry = store.insert(
        { content: "first-import", source: "manual", origin_id: originId },
        randomEmbedding(),
      );
      expect(entry.id).toBeTruthy();
      expect(entry.content).toBe("first-import");

      const memRow = db
        .prepare("SELECT origin_id FROM memories WHERE id = ?")
        .get(entry.id) as { origin_id: string };
      expect(memRow.origin_id).toBe(originId);

      const memCount = db
        .prepare("SELECT COUNT(*) as cnt FROM memories")
        .get() as { cnt: number };
      expect(memCount.cnt).toBe(1);

      const vecCount = db
        .prepare("SELECT COUNT(*) as cnt FROM vec_memories")
        .get() as { cnt: number };
      expect(vecCount.cnt).toBe(1);
    });

    it("origin_id insert on duplicate returns the EXISTING entry (INSERT OR IGNORE — no upsert)", () => {
      store = createTestStore();
      const db = store.getDatabase();
      const originId = "openclaw:test:duplicate-path";

      const first = store.insert(
        { content: "FIRST content", source: "manual", origin_id: originId },
        randomEmbedding(),
      );

      // Same origin_id, DIFFERENT content + embedding.
      const second = store.insert(
        { content: "SECOND content", source: "manual", origin_id: originId },
        randomEmbedding(),
      );

      // Collision returns the existing row. Content is NOT updated.
      expect(second.id).toBe(first.id);
      expect(second.content).toBe("FIRST content");

      const memCount = db
        .prepare("SELECT COUNT(*) as cnt FROM memories")
        .get() as { cnt: number };
      expect(memCount.cnt).toBe(1);

      // Crucially: no orphan vec row for the IGNORED insert.
      const vecCount = db
        .prepare("SELECT COUNT(*) as cnt FROM vec_memories")
        .get() as { cnt: number };
      expect(vecCount.cnt).toBe(1);
    });

    it("origin_id path SKIPS dedup — different origin_ids with near-duplicate embeddings create 2 rows", () => {
      store = new MemoryStore(":memory:", { enabled: true, similarityThreshold: 0.85 });

      // Construct identical direction vectors that would normally trigger merge.
      const vec = new Float32Array(384);
      vec[0] = 1.0;

      store.insert(
        {
          content: "near-dup A",
          source: "manual",
          origin_id: "openclaw:test:A",
        },
        vec,
      );
      store.insert(
        {
          content: "near-dup B",
          source: "manual",
          origin_id: "openclaw:test:B",
        },
        vec,
      );

      // Both rows exist — dedup was skipped because origin_id was present.
      const list = store.listRecent(100);
      expect(list.length).toBe(2);
    });

    it("absent origin_id preserves existing dedup behavior (461-test baseline regression pin)", () => {
      store = new MemoryStore(":memory:", { enabled: true, similarityThreshold: 0.85 });
      const vec = new Float32Array(384);
      vec[0] = 1.0;

      // No origin_id on either insert → dedup merge path fires as before.
      store.insert({ content: "original", source: "manual" }, vec);
      store.insert({ content: "duplicate", source: "manual" }, vec);

      const list = store.listRecent(100);
      expect(list.length).toBe(1);
      expect(list[0].content).toBe("duplicate");
    });

    it("duplicate-origin_id insert preserves the FIRST row's createdAt (CLI upserted-vs-skipped contract)", () => {
      store = createTestStore();
      const originId = "openclaw:test:timestamp-contract";

      const first = store.insert(
        { content: "first", source: "manual", origin_id: originId },
        randomEmbedding(),
      );

      // Small busy-wait to ensure wall-clock ISO timestamp would differ if
      // the second insert were actually writing its own row.
      const waitUntil = Date.now() + 5;
      while (Date.now() < waitUntil) { /* spin */ }

      const second = store.insert(
        { content: "second", source: "manual", origin_id: originId },
        randomEmbedding(),
      );

      // Plan 02's translator compares entry.createdAt to its "this run"
      // marker to classify upserted vs skipped. Test pins the contract:
      // the returned entry from a collision is the FIRST row, bit-for-bit.
      expect(second.createdAt).toBe(first.createdAt);
      expect(second.id).toBe(first.id);
    });
  });

  describe("sourceTurnIds (CONV-03 write path)", () => {
    it("sourceTurnIds input is returned on insert (not null)", () => {
      store = createTestStore();
      const entry = store.insert(
        {
          content: "test content with lineage",
          source: "conversation",
          skipDedup: true,
          sourceTurnIds: ["turn-a", "turn-b"],
        },
        randomEmbedding(),
      );
      expect(entry.sourceTurnIds).toEqual(["turn-a", "turn-b"]);
      expect(Object.isFrozen(entry.sourceTurnIds)).toBe(true);
    });

    it("source_turn_ids roundtrip preserves exact array on getById", () => {
      store = createTestStore();
      const entry = store.insert(
        {
          content: "roundtrip test content",
          source: "conversation",
          skipDedup: true,
          sourceTurnIds: ["t1", "t2", "t3"],
        },
        randomEmbedding(),
      );
      const fetched = store.getById(entry.id);
      expect(fetched).not.toBeNull();
      expect(fetched!.sourceTurnIds).toEqual(["t1", "t2", "t3"]);
      expect(Object.isFrozen(fetched!.sourceTurnIds)).toBe(true);
    });

    it("omitted sourceTurnIds yields null", () => {
      store = createTestStore();
      const entry = store.insert(
        {
          content: "no lineage here",
          source: "manual",
          skipDedup: true,
        },
        randomEmbedding(),
      );
      expect(entry.sourceTurnIds).toBeNull();
      const fetched = store.getById(entry.id);
      expect(fetched!.sourceTurnIds).toBeNull();
    });

    it("empty sourceTurnIds array yields null (treated as no lineage)", () => {
      store = createTestStore();
      const entry = store.insert(
        {
          content: "empty lineage",
          source: "conversation",
          skipDedup: true,
          sourceTurnIds: [],
        },
        randomEmbedding(),
      );
      expect(entry.sourceTurnIds).toBeNull();
    });

    it("source_turn_ids column stores JSON string in DB", () => {
      store = createTestStore();
      const entry = store.insert(
        {
          content: "check raw column",
          source: "conversation",
          skipDedup: true,
          sourceTurnIds: ["alpha", "beta"],
        },
        randomEmbedding(),
      );
      const db = store.getDatabase();
      const row = db
        .prepare("SELECT source_turn_ids FROM memories WHERE id = ?")
        .get(entry.id) as { source_turn_ids: string | null };
      expect(row.source_turn_ids).toBe('["alpha","beta"]');
    });
  });

  // Phase 90 Plan 02 — MEM-02: memory_chunks + vec_memory_chunks + FTS5 + memory_files tables
  describe("memory_chunks (Phase 90 MEM-02)", () => {
    function randomEmbedding384(): Float32Array {
      const arr = new Float32Array(384);
      for (let i = 0; i < 384; i++) arr[i] = Math.random() * 2 - 1;
      return arr;
    }

    it("MEM-02-S1: migrateMemoryChunks creates memory_chunks + memory_files + vec_memory_chunks + memory_chunks_fts", () => {
      store = createTestStore();
      const db = store.getDatabase();

      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('memory_chunks','memory_files')")
        .all() as Array<{ name: string }>;
      const names = tables.map((t) => t.name).sort();
      expect(names).toEqual(["memory_chunks", "memory_files"]);

      // Virtual tables register differently — query them directly
      const vcount = db
        .prepare("SELECT count(*) AS n FROM vec_memory_chunks")
        .get() as { n: number };
      expect(vcount.n).toBe(0);
      const fcount = db
        .prepare("SELECT count(*) AS n FROM memory_chunks_fts")
        .get() as { n: number };
      expect(fcount.n).toBe(0);
    });

    it("MEM-02-S2: insertMemoryChunk writes to all three chunk tables + memory_files", () => {
      store = createTestStore();
      const chunkId = store.insertMemoryChunk({
        path: "/ws/memory/2026-04-24-test.md",
        chunkIndex: 0,
        heading: "Section A",
        body: "Zaid wants 40% allocation in SGOV for safety.",
        tokenCount: 50,
        scoreWeight: 0,
        fileMtimeMs: Date.now(),
        fileSha256: "abc123",
        embedding: randomEmbedding384(),
      });
      expect(chunkId).toBeTruthy();

      const db = store.getDatabase();
      const chunkCount = db
        .prepare("SELECT count(*) AS n FROM memory_chunks WHERE path = ?")
        .get("/ws/memory/2026-04-24-test.md") as { n: number };
      expect(chunkCount.n).toBe(1);

      const fileCount = db
        .prepare("SELECT count(*) AS n FROM memory_files WHERE path = ?")
        .get("/ws/memory/2026-04-24-test.md") as { n: number };
      expect(fileCount.n).toBe(1);

      const vecCount = db
        .prepare("SELECT count(*) AS n FROM vec_memory_chunks WHERE chunk_id = ?")
        .get(chunkId) as { n: number };
      expect(vecCount.n).toBe(1);

      const ftsCount = db
        .prepare("SELECT count(*) AS n FROM memory_chunks_fts WHERE chunk_id = ?")
        .get(chunkId) as { n: number };
      expect(ftsCount.n).toBe(1);
    });

    it("MEM-02-S3: deleteMemoryChunksByPath removes rows from all tables", () => {
      store = createTestStore();
      const path = "/ws/memory/2026-04-24-doomed.md";
      store.insertMemoryChunk({
        path,
        chunkIndex: 0,
        heading: "Doomed",
        body: "about to die",
        tokenCount: 10,
        scoreWeight: 0,
        fileMtimeMs: Date.now(),
        fileSha256: "sha",
        embedding: randomEmbedding384(),
      });
      const removed = store.deleteMemoryChunksByPath(path);
      expect(removed).toBe(1);

      const db = store.getDatabase();
      const chunkCount = db
        .prepare("SELECT count(*) AS n FROM memory_chunks WHERE path = ?")
        .get(path) as { n: number };
      expect(chunkCount.n).toBe(0);
      const fileCount = db
        .prepare("SELECT count(*) AS n FROM memory_files WHERE path = ?")
        .get(path) as { n: number };
      expect(fileCount.n).toBe(0);
    });

    it("MEM-02-S4: re-insert after delete works (idempotency)", () => {
      store = createTestStore();
      const path = "/ws/memory/2026-04-24-redo.md";
      store.insertMemoryChunk({
        path,
        chunkIndex: 0,
        heading: "v1",
        body: "old body",
        tokenCount: 5,
        scoreWeight: 0,
        fileMtimeMs: Date.now(),
        fileSha256: "v1hash",
        embedding: randomEmbedding384(),
      });
      store.deleteMemoryChunksByPath(path);
      store.insertMemoryChunk({
        path,
        chunkIndex: 0,
        heading: "v2",
        body: "new body",
        tokenCount: 5,
        scoreWeight: 0,
        fileMtimeMs: Date.now(),
        fileSha256: "v2hash",
        embedding: randomEmbedding384(),
      });
      const db = store.getDatabase();
      const rows = db
        .prepare("SELECT heading, body FROM memory_chunks WHERE path = ?")
        .all(path) as Array<{ heading: string; body: string }>;
      expect(rows).toHaveLength(1);
      expect(rows[0].heading).toBe("v2");
      expect(rows[0].body).toBe("new body");
    });

    it("listRecentMemoryChunks orders by file_mtime_ms DESC and respects limit", () => {
      store = createTestStore();
      const base = 1700000000000;
      store.insertMemoryChunk({
        path: "/ws/memory/oldest.md",
        chunkIndex: 0,
        heading: "Oldest",
        body: "oldest body",
        tokenCount: 10,
        scoreWeight: 0,
        fileMtimeMs: base,
        fileSha256: "old",
        embedding: randomEmbedding384(),
      });
      store.insertMemoryChunk({
        path: "/ws/memory/middle.md",
        chunkIndex: 0,
        heading: "Middle",
        body: "middle body",
        tokenCount: 10,
        scoreWeight: 0,
        fileMtimeMs: base + 1000,
        fileSha256: "mid",
        embedding: randomEmbedding384(),
      });
      store.insertMemoryChunk({
        path: "/ws/memory/newest.md",
        chunkIndex: 0,
        heading: "Newest",
        body: "newest body",
        tokenCount: 10,
        scoreWeight: 0,
        fileMtimeMs: base + 2000,
        fileSha256: "new",
        embedding: randomEmbedding384(),
      });

      const all = store.listRecentMemoryChunks(10);
      expect(all).toHaveLength(3);
      expect(all[0].path).toBe("/ws/memory/newest.md");
      expect(all[0].body).toBe("newest body");
      expect(all[0].lastModified).toBeInstanceOf(Date);
      expect(all[0].lastModified.getTime()).toBe(base + 2000);
      expect(all[2].path).toBe("/ws/memory/oldest.md");

      const limited = store.listRecentMemoryChunks(2);
      expect(limited).toHaveLength(2);
      expect(limited[0].path).toBe("/ws/memory/newest.md");
      expect(limited[1].path).toBe("/ws/memory/middle.md");
    });

    it("listRecentMemoryChunks returns empty array when no chunks present", () => {
      store = createTestStore();
      expect(store.listRecentMemoryChunks(10)).toHaveLength(0);
    });

    it("MEM-02-S5: searchMemoryChunksFts finds inserted body text", () => {
      store = createTestStore();
      store.insertMemoryChunk({
        path: "/ws/memory/fts-test.md",
        chunkIndex: 0,
        heading: "Investment",
        body: "Zaid wants 40% SGOV allocation for safety",
        tokenCount: 10,
        scoreWeight: 0,
        fileMtimeMs: Date.now(),
        fileSha256: "x",
        embedding: randomEmbedding384(),
      });
      const results = store.searchMemoryChunksFts("Zaid", 10);
      expect(results.length).toBeGreaterThan(0);
    });
  });

  describe("bumpAccess (Phase 100-fu)", () => {
    // MS-B1: bumpAccess increments access_count by 1 and updates accessed_at
    // to the supplied timestamp. Mirrors the SemanticSearch.updateAccessStmt
    // semantics so non-search callers (GraphSearch graph walk) can keep heat
    // metrics flowing on graph-walked neighbors.
    it("MS-B1: increments access_count by 1 and updates accessed_at", () => {
      store = createTestStore();
      const entry = store.insert(
        { content: "bump target", source: "manual" },
        randomEmbedding(),
      );

      const before = store.getDatabase()
        .prepare("SELECT access_count, accessed_at FROM memories WHERE id = ?")
        .get(entry.id) as { access_count: number; accessed_at: string };
      expect(before.access_count).toBe(0);

      const stamp = "2026-04-27T12:34:56.000Z";
      store.bumpAccess(entry.id, stamp);

      const after = store.getDatabase()
        .prepare("SELECT access_count, accessed_at FROM memories WHERE id = ?")
        .get(entry.id) as { access_count: number; accessed_at: string };
      expect(after.access_count).toBe(1);
      expect(after.accessed_at).toBe(stamp);

      // Bump again — confirm increment-by-1 (not set-to-1)
      const stamp2 = "2026-04-27T13:00:00.000Z";
      store.bumpAccess(entry.id, stamp2);
      const after2 = store.getDatabase()
        .prepare("SELECT access_count, accessed_at FROM memories WHERE id = ?")
        .get(entry.id) as { access_count: number; accessed_at: string };
      expect(after2.access_count).toBe(2);
      expect(after2.accessed_at).toBe(stamp2);
    });

    // MS-B2: bumpAccess on a non-existent memory ID is a no-op — no exception,
    // no row created. Matches the silently-tolerant behavior of the SemanticSearch
    // UPDATE path (UPDATE...WHERE id=? against a missing row is a 0-row affect).
    it("MS-B2: no-op on non-existent memory ID (no exception, no row created)", () => {
      store = createTestStore();
      const db = store.getDatabase();
      const beforeCount = (db
        .prepare("SELECT COUNT(*) AS n FROM memories")
        .get() as { n: number }).n;

      expect(() =>
        store.bumpAccess("does-not-exist", "2026-04-27T00:00:00.000Z"),
      ).not.toThrow();

      const afterCount = (db
        .prepare("SELECT COUNT(*) AS n FROM memories")
        .get() as { n: number }).n;
      expect(afterCount).toBe(beforeCount);
    });

    it("bumpAccess defaults accessed_at to now() when timestamp omitted", () => {
      store = createTestStore();
      const entry = store.insert(
        { content: "default ts", source: "manual" },
        randomEmbedding(),
      );

      const beforeNow = Date.now();
      store.bumpAccess(entry.id);
      const afterNow = Date.now();

      const row = store.getDatabase()
        .prepare("SELECT access_count, accessed_at FROM memories WHERE id = ?")
        .get(entry.id) as { access_count: number; accessed_at: string };
      expect(row.access_count).toBe(1);
      const stampMs = new Date(row.accessed_at).getTime();
      expect(stampMs).toBeGreaterThanOrEqual(beforeNow);
      expect(stampMs).toBeLessThanOrEqual(afterNow);
    });
  });

  // Phase 100-fu — graph-centrality promotion. The TierManager queries
  // backlink counts to decide whether a memory is a structural hub
  // (target of many wikilink edges) and should be promoted to hot tier
  // independent of direct access count.
  describe("getBacklinkCount (Phase 100-fu)", () => {
    // GBC-1: returns the exact count for a memory with N inbound links.
    // Backlinks are inserted via the same memory_links table that
    // graph-search uses, mirroring the production wiring.
    it("GBC-1: returns correct count for a memory with N backlinks", () => {
      store = createTestStore();
      const target = store.insert(
        { content: "hub memory", source: "manual" },
        randomEmbedding(),
      );

      // Insert 3 source memories, each linking to `target`.
      const stmts = store.getGraphStatements();
      const linkAt = "2026-04-27T00:00:00.000Z";
      for (let i = 0; i < 3; i++) {
        const src = store.insert(
          { content: `source ${i} linking to hub`, source: "manual" },
          randomEmbedding(),
        );
        stmts.insertLink.run(src.id, target.id, target.id, linkAt);
      }

      expect(store.getBacklinkCount(target.id)).toBe(3);
    });

    // GBC-2: a memory that exists but has no inbound links returns 0
    // (not undefined, not null, not an exception).
    it("GBC-2: returns 0 for a memory with no backlinks", () => {
      store = createTestStore();
      const entry = store.insert(
        { content: "isolated", source: "manual" },
        randomEmbedding(),
      );

      expect(store.getBacklinkCount(entry.id)).toBe(0);
    });

    // GBC-3: querying a non-existent ID returns 0 — same shape as the
    // no-backlinks path. The COUNT(*) aggregate naturally yields 0 when
    // the WHERE clause matches no rows.
    it("GBC-3: returns 0 for a non-existent memory ID", () => {
      store = createTestStore();
      expect(store.getBacklinkCount("does-not-exist")).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // Phase 999.13 TZ-05 — DB writes stay UTC ISO (regression)
  //
  // Internal storage MUST stay UTC ISO 8601 with millisecond precision and
  // trailing 'Z' — only agent-visible *rendering* converts to operator-local
  // TZ via renderAgentVisibleTimestamp. Pillar B's TZ-04 conversions touch
  // only the prompt-emission boundary (bridge.ts, context-summary.ts,
  // conversation-brief.ts, dream-prompt-builder.ts) — never the storage
  // layer. This regression pins the invariant against future drift.
  // ---------------------------------------------------------------------------
  describe("Phase 999.13 TZ-05 — DB writes stay UTC", () => {
    const ISO_UTC_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

    it("createdAt/updatedAt/accessedAt are UTC ISO with millisecond precision and 'Z' suffix", () => {
      store = createTestStore();
      const entry = store.insert(
        { content: "tz-05 regression", source: "manual" },
        randomEmbedding(),
      );

      // All three timestamps must match the canonical UTC ISO format —
      // never the agent-visible "YYYY-MM-DD HH:mm:ss ZZZ" format.
      expect(entry.createdAt).toMatch(ISO_UTC_REGEX);
      expect(entry.updatedAt).toMatch(ISO_UTC_REGEX);
      expect(entry.accessedAt).toMatch(ISO_UTC_REGEX);

      // Negative assertion — ensure no agent-visible TZ-aware token slipped
      // into storage. The TZ-aware format has a SPACE separator and a TZ
      // abbreviation suffix (PDT/PST/EST/UTC); the UTC ISO format has 'T'
      // and ends in '.NNN Z'.
      expect(entry.createdAt).not.toMatch(/ (PDT|PST|EST|UTC)$/);
      expect(entry.createdAt).toContain("T"); // ISO separator
    });

    it("re-reading a written entry returns the same UTC ISO format (round-trip)", () => {
      store = createTestStore();
      const inserted = store.insert(
        { content: "round-trip body", source: "manual" },
        randomEmbedding(),
      );
      const read = store.getById(inserted.id);
      expect(read).not.toBeNull();
      expect(read!.createdAt).toMatch(ISO_UTC_REGEX);
      expect(read!.createdAt).toBe(inserted.createdAt);
    });
  });
});
