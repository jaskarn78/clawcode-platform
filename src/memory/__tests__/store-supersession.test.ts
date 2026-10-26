/**
 * Memory overhaul 2026-10-25 (WP5) - supersession columns, non-destructive
 * dedup outcomes, and the "superseded rows are hidden by default" rule on
 * every read path that feeds search, retrieval, listing and the hot tier.
 */

import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { MemoryStore } from "../store.js";
import { SemanticSearch } from "../search.js";
import { GraphSearch } from "../graph-search.js";
import { retrieveMemoryChunks } from "../memory-retrieval.js";
import { FORGOTTEN_MARKER } from "../types.js";

/** Unit vector along `axis`. */
function unit(axis: number): Float32Array {
  const v = new Float32Array(384);
  v[axis] = 1;
  return v;
}

/** Unit vector whose cosine to unit(axis) is exactly `c` (tilted toward axis+1). */
function cosineTo(axis: number, c: number): Float32Array {
  const v = new Float32Array(384);
  v[axis] = c;
  v[axis + 1] = Math.sqrt(1 - c * c);
  return v;
}

function columnNames(store: MemoryStore): string[] {
  return (store.getDatabase().prepare("PRAGMA table_info(memories)").all() as Array<{ name: string }>).map(
    (c) => c.name,
  );
}

function supersessionOf(store: MemoryStore, id: string): { superseded_by: string | null; superseded_at: string | null } {
  return store
    .getDatabase()
    .prepare("SELECT superseded_by, superseded_at FROM memories WHERE id = ?")
    .get(id) as { superseded_by: string | null; superseded_at: string | null };
}

describe("supersession migration", () => {
  let dir: string | undefined;
  let store: MemoryStore | undefined;

  afterEach(() => {
    store?.close();
    store = undefined;
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it("adds superseded_by / superseded_at and a partial index on a fresh store", () => {
    store = new MemoryStore(":memory:");
    expect(columnNames(store)).toEqual(expect.arrayContaining(["superseded_by", "superseded_at"]));
    const idx = store
      .getDatabase()
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_memories_superseded'")
      .get() as { sql: string } | undefined;
    expect(idx?.sql).toMatch(/WHERE superseded_by IS NOT NULL/);
  });

  it("is idempotent across reopen and upgrades a pre-WP5 database in place", () => {
    dir = mkdtempSync(join(tmpdir(), "wp5-migration-"));
    const dbPath = join(dir, "memories.db");

    // Build the store once, write a live row, then strip the WP5 columns
    // to reproduce a database created before this migration existed.
    store = new MemoryStore(dbPath, { enabled: false, similarityThreshold: 0.85 });
    const kept = store.insert({ content: "pre-existing fact", source: "manual" }, unit(0));
    store.close();
    store = undefined;
    const raw = new Database(dbPath);
    raw.exec("DROP INDEX idx_memories_superseded");
    raw.exec("ALTER TABLE memories DROP COLUMN superseded_by");
    raw.exec("ALTER TABLE memories DROP COLUMN superseded_at");
    raw.close();

    // First reopen migrates; a second reopen is a no-op (no throw).
    store = new MemoryStore(dbPath, { enabled: false, similarityThreshold: 0.85 });
    store.close();
    store = new MemoryStore(dbPath, { enabled: false, similarityThreshold: 0.85 });

    expect(columnNames(store)).toEqual(expect.arrayContaining(["superseded_by", "superseded_at"]));
    // Existing rows come through live and untouched.
    expect(supersessionOf(store, kept.id)).toEqual({ superseded_by: null, superseded_at: null });
    expect(store.listRecent(10).map((m) => m.id)).toEqual([kept.id]);
    const indexes = store
      .getDatabase()
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_memories_superseded'")
      .all();
    expect(indexes).toHaveLength(1);
  });
});

describe("dedup outcomes (insertWithStatus)", () => {
  let store: MemoryStore;

  afterEach(() => {
    store?.close();
  });

  it("created: nothing close enough", () => {
    store = new MemoryStore(":memory:");
    store.insert({ content: "budget review on Monday", source: "manual" }, unit(0));
    const out = store.insertWithStatus({ content: "dentist on Friday", source: "manual" }, unit(7));
    expect(out.status).toBe("created");
    expect(out.supersedes).toBeUndefined();
    expect(store.listRecent(10)).toHaveLength(2);
  });

  it("duplicate: cosine >= 0.95 drops the new row and returns the existing one unchanged", () => {
    store = new MemoryStore(":memory:");
    const existing = store.insert(
      { content: "Operator prefers brief answers", source: "manual", importance: 0.4, tags: ["pref"] },
      unit(0),
    );
    const out = store.insertWithStatus(
      { content: "Operator prefers short answers", source: "conversation", importance: 0.9, tags: ["other"] },
      cosineTo(0, 0.97),
    );

    expect(out.status).toBe("duplicate");
    expect(out.entry.id).toBe(existing.id);
    expect(out.similarity).toBeGreaterThanOrEqual(0.95);
    const rows = store.listRecent(10);
    expect(rows).toHaveLength(1);
    expect(rows[0].content).toBe("Operator prefers brief answers");
    expect(rows[0].importance).toBe(0.4);
    expect([...rows[0].tags]).toEqual(["pref"]);
    expect(rows[0].accessCount).toBe(0);
    // insert() keeps returning the surviving id for existing callers.
    expect(store.insert({ content: "again", source: "manual" }, unit(0)).id).toBe(existing.id);
  });

  it("superseded: threshold <= cosine < 0.95 inserts the new row and retires the old one", () => {
    store = new MemoryStore(":memory:");
    const old = store.insert({ content: "deadline is 2026-03-03", source: "manual" }, unit(0));
    const out = store.insertWithStatus(
      { content: "deadline moved to 2026-03-10", source: "manual" },
      cosineTo(0, 0.9),
    );

    expect(out.status).toBe("superseded");
    expect(out.supersedes).toBe(old.id);
    expect(out.entry.id).not.toBe(old.id);
    expect(out.similarity).toBeCloseTo(0.9, 3);
    const mark = supersessionOf(store, old.id);
    expect(mark.superseded_by).toBe(out.entry.id);
    expect(mark.superseded_at).toBe(out.entry.createdAt);
    // Old text is kept; default listing shows only the successor.
    expect(store.peekById(old.id)?.content).toBe("deadline is 2026-03-03");
    expect(store.peekById(old.id)?.supersededBy).toBe(out.entry.id);
    expect(store.listRecent(10).map((m) => m.id)).toEqual([out.entry.id]);
    expect(store.listRecent(10, { includeSuperseded: true })).toHaveLength(2);
    // A live entry keeps the pre-WP5 shape (no supersession keys).
    expect("supersededBy" in out.entry).toBe(false);
  });

  it("a later restatement compares against the live successor, not the retired row", () => {
    store = new MemoryStore(":memory:");
    store.insert({ content: "v1", source: "manual" }, unit(0));
    const v2 = store.insertWithStatus({ content: "v2", source: "manual" }, cosineTo(0, 0.9));
    // Identical to the retired v1 vector, cosine 0.9 to v2: supersedes v2.
    const v3 = store.insertWithStatus({ content: "v3", source: "manual" }, unit(0));
    expect(v3.status).toBe("superseded");
    expect(v3.supersedes).toBe(v2.entry.id);
  });

  it("dedup disabled or skipDedup always creates", () => {
    store = new MemoryStore(":memory:", { enabled: false, similarityThreshold: 0.85 });
    store.insert({ content: "a", source: "manual" }, unit(0));
    expect(store.insertWithStatus({ content: "a", source: "manual" }, unit(0)).status).toBe("created");
    store.close();

    store = new MemoryStore(":memory:");
    store.insert({ content: "a", source: "manual" }, unit(0));
    expect(store.insertWithStatus({ content: "a", source: "manual", skipDedup: true }, unit(0)).status).toBe(
      "created",
    );
    expect(store.listRecent(10)).toHaveLength(2);
  });

  it("a fact is never dropped as a duplicate of, nor retires, a session summary", () => {
    store = new MemoryStore(":memory:");
    const summary = store.insert(
      { content: "session summary", source: "conversation", tags: ["session-summary"], skipDedup: true },
      unit(0),
    );
    const out = store.insertWithStatus({ content: "a fact", source: "conversation" }, unit(0));
    expect(out.status).toBe("created");
    expect(supersessionOf(store, summary.id).superseded_by).toBeNull();
  });

  it("explicit supersedes retires only a live row and skips the similarity probe", () => {
    store = new MemoryStore(":memory:");
    const target = store.insert({ content: "wrong fact", source: "manual" }, unit(0));
    // A third, near-identical memory that the probe would otherwise hit.
    store.insert({ content: "bystander", source: "manual", skipDedup: true }, unit(3));

    const fixed = store.insertWithStatus(
      { content: "right fact", source: "manual", supersedes: target.id },
      unit(3),
    );
    expect(fixed.status).toBe("superseded");
    expect(fixed.supersedes).toBe(target.id);
    expect(supersessionOf(store, target.id).superseded_by).toBe(fixed.entry.id);

    // Naming an already retired row writes the new row but leaves the
    // old pointer alone.
    const again = store.insertWithStatus(
      { content: "another", source: "manual", supersedes: target.id },
      unit(9),
    );
    expect(again.status).toBe("created");
    expect(supersessionOf(store, target.id).superseded_by).toBe(fixed.entry.id);
  });
});

describe("supersede / forget", () => {
  let store: MemoryStore;

  afterEach(() => {
    store?.close();
  });

  it("forget marks a live row forgotten once, keeps the content, and drops it from the hot tier", () => {
    store = new MemoryStore(":memory:");
    const m = store.insert({ content: "obsolete", source: "manual" }, unit(0));
    store.updateTier(m.id, "hot");
    expect(store.listByTier("hot", 10).map((r) => r.id)).toEqual([m.id]);

    expect(store.forget(m.id, "2026-10-26T00:00:00.000Z")).toBe(true);
    expect(store.forget(m.id)).toBe(false);
    expect(supersessionOf(store, m.id)).toEqual({
      superseded_by: FORGOTTEN_MARKER,
      superseded_at: "2026-10-26T00:00:00.000Z",
    });
    expect(store.peekById(m.id)?.content).toBe("obsolete");
    expect(store.listByTier("hot", 10)).toEqual([]);
    expect(store.peekById(m.id)?.tier).toBe("warm");
  });

  it("supersede refuses self-links and already retired rows", () => {
    store = new MemoryStore(":memory:");
    const a = store.insert({ content: "a", source: "manual", skipDedup: true }, unit(0));
    const b = store.insert({ content: "b", source: "manual", skipDedup: true }, unit(2));
    expect(store.supersede(a.id, a.id)).toBe(false);
    expect(store.supersede(a.id, b.id)).toBe(true);
    expect(store.supersede(a.id, "someone-else")).toBe(false);
    expect(supersessionOf(store, a.id).superseded_by).toBe(b.id);
    expect(store.supersede("missing", b.id)).toBe(false);
  });

  it("peekById does not bump access state; getById still does", () => {
    store = new MemoryStore(":memory:");
    const m = store.insert({ content: "x", source: "manual" }, unit(0));
    store.peekById(m.id);
    expect(store.peekById(m.id)?.accessCount).toBe(0);
    store.getById(m.id);
    expect(store.peekById(m.id)?.accessCount).toBe(1);
  });
});

describe("superseded rows are hidden on every read path by default", () => {
  let store: MemoryStore;
  let retiredId: string;
  let liveId: string;

  function seed(): void {
    store = new MemoryStore(":memory:", { enabled: false, similarityThreshold: 0.85 });
    // The retired row is the nearest to the query vector unit(0).
    const retired = store.insert(
      { content: "zebrafish deadline is 2026-03-03", source: "manual", tags: ["deadline"] },
      unit(0),
    );
    const live = store.insert(
      { content: "zebrafish deadline moved to 2026-03-10", source: "manual", tags: ["deadline"] },
      cosineTo(0, 0.8),
    );
    expect(store.supersede(retired.id, live.id)).toBe(true);
    retiredId = retired.id;
    liveId = live.id;
  }

  afterEach(() => {
    store?.close();
  });

  it("searchMemoriesVec", () => {
    seed();
    expect(store.searchMemoriesVec(unit(0), 5).map((r) => r.memory_id)).toEqual([liveId]);
    expect(store.searchMemoriesVec(unit(0), 5, { includeSuperseded: true }).map((r) => r.memory_id)).toEqual([
      retiredId,
      liveId,
    ]);
  });

  it("searchMemoriesVec over-fetches so retired neighbours cannot starve the result", () => {
    store = new MemoryStore(":memory:", { enabled: false, similarityThreshold: 0.85 });
    const live = store.insert({ content: "far but live", source: "manual" }, cosineTo(0, 0.5));
    for (let i = 0; i < 6; i++) {
      const r = store.insert({ content: `retired ${i}`, source: "manual" }, cosineTo(0, 0.99 - i * 0.01));
      store.forget(r.id);
    }
    expect(store.searchMemoriesVec(unit(0), 1).map((r) => r.memory_id)).toEqual([live.id]);
  });

  it("searchMemoriesFts", () => {
    seed();
    expect(store.searchMemoriesFts("zebrafish deadline", 5).map((r) => r.memory_id)).toEqual([liveId]);
    expect(
      new Set(store.searchMemoriesFts("zebrafish deadline", 5, { includeSuperseded: true }).map((r) => r.memory_id)),
    ).toEqual(new Set([retiredId, liveId]));
  });

  it("getMemoryForRetrieval", () => {
    seed();
    expect(store.getMemoryForRetrieval(retiredId)).toBeNull();
    expect(store.getMemoryForRetrieval(retiredId, { includeSuperseded: true })?.memory_id).toBe(retiredId);
    expect(store.getMemoryForRetrieval(liveId)?.source).toBe("manual");
  });

  it("SemanticSearch candidates", () => {
    seed();
    const results = new SemanticSearch(store.getDatabase()).search(unit(0), 5);
    expect(results.map((r) => r.id)).toEqual([liveId]);
  });

  it("GraphSearch never expands to a retired neighbour", () => {
    seed();
    const db = store.getDatabase();
    // The live KNN hit links to the retired row (the eager auto-linker
    // usually created this edge already at insert time).
    db.prepare(
      "INSERT OR IGNORE INTO memory_links (source_id, target_id, link_text, created_at) VALUES (?, ?, ?, ?)",
    ).run(liveId, retiredId, "ref", new Date().toISOString());
    const graph = new GraphSearch(store, { neighborSimilarityThreshold: 0 });

    // Sanity: while the row is live it IS reached as a neighbour.
    const mark = supersessionOf(store, retiredId);
    db.prepare("UPDATE memories SET superseded_by = NULL WHERE id = ?").run(retiredId);
    expect(graph.search(unit(0), 1).map((r) => r.id)).toContain(retiredId);

    db.prepare("UPDATE memories SET superseded_by = ? WHERE id = ?").run(mark.superseded_by, retiredId);
    const ids = graph.search(unit(0), 1).map((r) => r.id);
    expect(ids).toContain(liveId);
    expect(ids).not.toContain(retiredId);
  });

  it("listRecent, listInRange and listByTier", () => {
    seed();
    expect(store.listRecent(10).map((m) => m.id)).toEqual([liveId]);
    expect(store.listInRange("2000-01-01T00:00:00.000Z", "2999-01-01T00:00:00.000Z", 10).map((m) => m.id)).toEqual([
      liveId,
    ]);
    store.updateTier(liveId, "hot");
    // Force the retired row hot behind the store's back: it still never lists.
    store.getDatabase().prepare("UPDATE memories SET tier = 'hot' WHERE id = ?").run(retiredId);
    expect(store.listByTier("hot", 10).map((m) => m.id)).toEqual([liveId]);
  });

  it("pre-turn retrieval (retrieveMemoryChunks) never returns a superseded memory", async () => {
    seed();
    const out = await retrieveMemoryChunks({
      query: "zebrafish deadline",
      store,
      embed: async () => unit(0),
      topK: 5,
      timeWindowDays: 0,
      tokenBudget: 4000,
    });
    const ids = out.map((h) => h.chunkId);
    expect(ids).toContain(liveId);
    expect(ids).not.toContain(retiredId);
  });
});
