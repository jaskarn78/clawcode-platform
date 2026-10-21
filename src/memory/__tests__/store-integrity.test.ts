/**
 * Phase 999.119 — MemoryStore integrity: FK-safe delete, the dangling-row
 * census/repair, the auto-linker cursor migration, the retrieval recency
 * touch, and the tier-scan listings.
 *
 * The "damage" fixtures reproduce what production carried on 2026-09-05:
 * rows deleted from `memories` with `foreign_keys` OFF (manual clean-ups),
 * leaving memory_links rows, vec_memories rows and
 * conversation_sessions.summary_memory_id values pointing at nothing.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { MemoryStore } from "../store.js";

function embedding(seed: number): Float32Array {
  const vec = new Float32Array(384);
  for (let i = 0; i < 384; i++) vec[i] = Math.sin(seed * 0.1 + i * 0.01);
  let norm = 0;
  for (let i = 0; i < 384; i++) norm += vec[i] * vec[i];
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < 384; i++) vec[i] /= norm;
  return vec;
}

function insertSession(store: MemoryStore, id: string, summaryMemoryId: string | null): void {
  store
    .getDatabase()
    .prepare(
      `INSERT INTO conversation_sessions (id, agent_name, started_at, status, summary_memory_id)
       VALUES (?, 'agent', '2026-05-01T00:00:00.000Z', ?, ?)`,
    )
    .run(id, summaryMemoryId ? "summarized" : "ended", summaryMemoryId);
}

/**
 * Delete a memory row the way a manual sqlite3 clean-up did: FK enforcement
 * off, vec row untouched, link rows untouched.
 */
function bypassDelete(store: MemoryStore, id: string): void {
  const db = store.getDatabase();
  db.pragma("foreign_keys = OFF");
  db.prepare("DELETE FROM memories WHERE id = ?").run(id);
  db.pragma("foreign_keys = ON");
}

describe("MemoryStore.delete — session-summary FK (Phase 999.119)", () => {
  let store: MemoryStore;
  beforeEach(() => {
    store = new MemoryStore(":memory:", { enabled: false, similarityThreshold: 0.85 });
  });
  afterEach(() => store.close());

  it("detaches the memory from conversation_sessions.summary_memory_id instead of failing", () => {
    const summary = store.insert({ content: "session summary", source: "conversation" }, embedding(1));
    insertSession(store, "s1", summary.id);
    insertSession(store, "s2", summary.id);

    expect(store.delete(summary.id)).toBe(true);

    const rows = store
      .getDatabase()
      .prepare("SELECT id, status, summary_memory_id FROM conversation_sessions ORDER BY id")
      .all() as Array<{ id: string; status: string; summary_memory_id: string | null }>;
    expect(rows).toEqual([
      { id: "s1", status: "summarized", summary_memory_id: null },
      { id: "s2", status: "summarized", summary_memory_id: null },
    ]);
    expect(store.getDatabase().prepare("SELECT COUNT(*) AS n FROM memories").get()).toEqual({ n: 0 });
    expect(store.getDatabase().prepare("SELECT COUNT(*) AS n FROM vec_memories").get()).toEqual({ n: 0 });
  });

  it("does not touch sessions that point at other memories", () => {
    const a = store.insert({ content: "a", source: "conversation" }, embedding(1));
    const b = store.insert({ content: "b", source: "conversation" }, embedding(2));
    insertSession(store, "sa", a.id);
    insertSession(store, "sb", b.id);

    store.delete(a.id);

    const sb = store
      .getDatabase()
      .prepare("SELECT summary_memory_id FROM conversation_sessions WHERE id = 'sb'")
      .get() as { summary_memory_id: string };
    expect(sb.summary_memory_id).toBe(b.id);
  });
});

describe("MemoryStore.checkIntegrity / repairIntegrity (Phase 999.119)", () => {
  let store: MemoryStore;
  beforeEach(() => {
    store = new MemoryStore(":memory:", { enabled: false, similarityThreshold: 0.85 });
  });
  afterEach(() => store.close());

  it("reports a clean store as clean", () => {
    store.insert({ content: "fine", source: "manual" }, embedding(1));
    const report = store.checkIntegrity();
    expect(report.total).toBe(0);
    expect(report.fkViolations).toBe(0);
  });

  it("counts dangling links, orphan vec rows and dangling session summaries left by a bypass delete", () => {
    const keep = store.insert({ content: "keep", source: "manual" }, embedding(1));
    const gone = store.insert({ content: "gone", source: "conversation" }, embedding(2));
    const db = store.getDatabase();
    const now = new Date().toISOString();
    db.prepare("INSERT OR IGNORE INTO memory_links (source_id, target_id, link_text, created_at) VALUES (?, ?, 'auto:similar', ?)").run(keep.id, gone.id, now);
    db.prepare("INSERT OR IGNORE INTO memory_links (source_id, target_id, link_text, created_at) VALUES (?, ?, 'auto:similar', ?)").run(gone.id, keep.id, now);
    insertSession(store, "s-gone", gone.id);
    insertSession(store, "s-keep", keep.id);

    bypassDelete(store, gone.id);

    const report = store.checkIntegrity();
    expect(report.danglingLinks).toBe(2);
    expect(report.orphanVecV1).toBe(1);
    expect(report.danglingSessionSummaries).toBe(1);
    expect(report.fkViolations).toBe(3); // 2 link rows + 1 session row
    expect(report.total).toBe(4);
  });

  it("repairIntegrity removes exactly those rows, never a live memory, and is idempotent", () => {
    const keep = store.insert({ content: "keep", source: "manual" }, embedding(1));
    const gone = store.insert({ content: "gone", source: "conversation" }, embedding(2));
    const db = store.getDatabase();
    const now = new Date().toISOString();
    db.prepare("INSERT OR IGNORE INTO memory_links (source_id, target_id, link_text, created_at) VALUES (?, ?, 'auto:similar', ?)").run(keep.id, gone.id, now);
    db.prepare("INSERT OR IGNORE INTO memory_links (source_id, target_id, link_text, created_at) VALUES (?, ?, 'auto:similar', ?)").run(gone.id, keep.id, now);
    insertSession(store, "s-gone", gone.id);
    bypassDelete(store, gone.id);

    const first = store.repairIntegrity();
    expect(first.danglingLinksRemoved).toBe(2);
    expect(first.orphanVecV1Removed).toBe(1);
    expect(first.sessionSummariesDetached).toBe(1);
    expect(first.total).toBe(4);

    expect(store.checkIntegrity().total).toBe(0);
    expect(store.checkIntegrity().fkViolations).toBe(0);
    expect(store.repairIntegrity().total).toBe(0);

    // The live memory + its vector are untouched.
    expect(db.prepare("SELECT COUNT(*) AS n FROM memories").get()).toEqual({ n: 1 });
    expect(db.prepare("SELECT memory_id FROM vec_memories").all()).toEqual([{ memory_id: keep.id }]);
    const session = db.prepare("SELECT status, summary_memory_id FROM conversation_sessions WHERE id = 's-gone'").get() as { status: string; summary_memory_id: string | null };
    expect(session).toEqual({ status: "summarized", summary_memory_id: null });
  });

  it("preserves the cold-episode shape (memory row present, vec row absent)", () => {
    const episode = store.insert({ content: "episode", source: "episode" }, embedding(3));
    store.getDatabase().prepare("DELETE FROM vec_memories WHERE memory_id = ?").run(episode.id);
    store.updateTier(episode.id, "cold");

    expect(store.repairIntegrity().total).toBe(0);
    expect(store.getDatabase().prepare("SELECT COUNT(*) AS n FROM memories").get()).toEqual({ n: 1 });
  });

  it("removes orphan chunk vectors and FTS rows whose chunk is gone", () => {
    const db = store.getDatabase();
    store.insertMemoryChunk({
      path: "/ws/memory/x.md",
      chunkIndex: 0,
      heading: "h",
      body: "chunk body",
      tokenCount: 2,
      scoreWeight: 0,
      fileMtimeMs: Date.now(),
      fileSha256: "sha",
      embedding: embedding(9),
    });
    db.prepare("DELETE FROM memory_chunks").run();

    const before = store.checkIntegrity();
    expect(before.orphanChunkVecV1).toBe(1);
    expect(before.orphanChunkFts).toBe(1);

    const repaired = store.repairIntegrity();
    expect(repaired.orphanChunkVecV1Removed).toBe(1);
    expect(repaired.orphanChunkFtsRemoved).toBe(1);
    expect(store.checkIntegrity().total).toBe(0);
  });
});

describe("auto_linked_at migration (Phase 999.119)", () => {
  let dir: string;
  beforeEach(() => {
    dir = join(tmpdir(), `store-integrity-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(dir, { recursive: true });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("adds the column on an older DB and backfills rows that already carry outbound auto:similar edges", () => {
    const dbPath = join(dir, "memories.db");
    // Build a pre-999.119 shaped DB: open once (creates everything), then
    // drop the cursor column + its index, insert rows, close.
    const first = new MemoryStore(dbPath, { enabled: false, similarityThreshold: 0.85 });
    const linked = first.insert({ content: "linked", source: "manual" }, embedding(1));
    const twin = first.insert({ content: "linked twin", source: "manual" }, embedding(1));
    const lonely = first.insert({ content: "lonely", source: "manual" }, embedding(50));
    // Eager linking stamped everything — clear the column entirely so the
    // migration is what fills it, not the insert path.
    const db1 = first.getDatabase();
    db1.exec("DROP INDEX IF EXISTS idx_memories_auto_linked");
    db1.exec("ALTER TABLE memories DROP COLUMN auto_linked_at");
    const linkCount = (db1.prepare("SELECT COUNT(*) AS n FROM memory_links WHERE source_id = ? AND link_text = 'auto:similar'").get(linked.id) as { n: number }).n;
    expect(linkCount).toBeGreaterThan(0);
    first.close();

    const raw = new Database(dbPath);
    const colsBefore = (raw.prepare("PRAGMA table_info(memories)").all() as Array<{ name: string }>).map((c) => c.name);
    raw.close();
    expect(colsBefore).not.toContain("auto_linked_at");

    const second = new MemoryStore(dbPath, { enabled: false, similarityThreshold: 0.85 });
    const rows = second
      .getDatabase()
      .prepare("SELECT id, auto_linked_at FROM memories")
      .all() as Array<{ id: string; auto_linked_at: string | null }>;
    const byId = new Map(rows.map((r) => [r.id, r.auto_linked_at]));
    expect(byId.get(linked.id)).not.toBeNull();
    expect(byId.get(twin.id)).not.toBeNull();
    expect(byId.get(lonely.id)).toBeNull(); // genuine backlog
    expect(second.listAutoLinkCandidates(10, "1970-01-01T00:00:00.000Z")).toEqual([lonely.id]);
    second.close();
  });

  it("is idempotent across re-opens", () => {
    const dbPath = join(dir, "memories.db");
    const a = new MemoryStore(dbPath);
    a.close();
    const b = new MemoryStore(dbPath);
    const cols = (b.getDatabase().prepare("PRAGMA table_info(memories)").all() as Array<{ name: string }>)
      .filter((c) => c.name === "auto_linked_at");
    expect(cols).toHaveLength(1);
    const indexes = (b.getDatabase().prepare("SELECT name FROM sqlite_master WHERE type='index'").all() as Array<{ name: string }>).map((i) => i.name);
    expect(indexes).toContain("idx_memories_tier_accessed");
    expect(indexes).toContain("idx_memories_auto_linked");
    expect(indexes).toContain("idx_sessions_summary_memory");
    b.close();
  });
});

describe("tier-scan listings + recency touch (Phase 999.119)", () => {
  let store: MemoryStore;
  beforeEach(() => {
    store = new MemoryStore(":memory:", { enabled: false, similarityThreshold: 0.85 });
  });
  afterEach(() => store.close());

  it("listAutoLinkCandidates: never-scanned first (newest first), then stale stamps, recent stamps excluded", () => {
    const db = store.getDatabase();
    const ids = ["c1", "c2", "c3", "c4"];
    const base = Date.parse("2026-01-01T00:00:00.000Z");
    ids.forEach((id, i) => {
      const created = new Date(base + i * 60_000).toISOString();
      db.prepare(
        `INSERT INTO memories (id, content, source, importance, tags, created_at, updated_at, accessed_at, tier)
         VALUES (?, ?, 'manual', 0.5, '[]', ?, ?, ?, 'warm')`,
      ).run(id, id, created, created, created);
    });
    db.prepare("UPDATE memories SET auto_linked_at = '2026-01-10T00:00:00.000Z' WHERE id = 'c1'").run(); // stale
    db.prepare("UPDATE memories SET auto_linked_at = '2026-08-01T00:00:00.000Z' WHERE id = 'c2'").run(); // recent
    db.prepare("UPDATE memories SET tier = 'cold' WHERE id = 'c3'").run(); // cold → never a candidate

    const candidates = store.listAutoLinkCandidates(10, "2026-06-01T00:00:00.000Z");
    expect(candidates).toEqual(["c4", "c1"]);
  });

  it("touchAccessedAt updates accessed_at but leaves access_count alone", () => {
    const entry = store.insert({ content: "touched", source: "manual" }, embedding(1));
    store.touchAccessedAt([entry.id], "2026-09-05T12:00:00.000Z");
    const row = store
      .getDatabase()
      .prepare("SELECT accessed_at, access_count FROM memories WHERE id = ?")
      .get(entry.id) as { accessed_at: string; access_count: number };
    expect(row.accessed_at).toBe("2026-09-05T12:00:00.000Z");
    expect(row.access_count).toBe(0);
    store.touchAccessedAt([]); // no-op
  });

  it("listColdArchiveCandidates orders least-recently-accessed first and carries backlinkCount", () => {
    const db = store.getDatabase();
    const old = store.insert({ content: "old", source: "manual" }, embedding(1));
    const older = store.insert({ content: "older", source: "manual" }, embedding(20));
    const fresh = store.insert({ content: "fresh", source: "manual" }, embedding(40));
    db.prepare("UPDATE memories SET accessed_at = '2026-03-01T00:00:00.000Z' WHERE id = ?").run(old.id);
    db.prepare("UPDATE memories SET accessed_at = '2026-01-01T00:00:00.000Z' WHERE id = ?").run(older.id);
    db.prepare("INSERT OR IGNORE INTO memory_links (source_id, target_id, link_text, created_at) VALUES (?, ?, 'auto:similar', ?)").run(fresh.id, older.id, "2026-09-01T00:00:00.000Z");

    const candidates = store.listColdArchiveCandidates(2);
    expect(candidates.map((c) => c.id)).toEqual([older.id, old.id]);
    expect(candidates[0].backlinkCount).toBe(1);
    expect(candidates[1].backlinkCount).toBe(0);
  });

  it("listWarmCandidatesForPromotion carries backlinkCount (no per-row COUNT query)", () => {
    const db = store.getDatabase();
    const hub = store.insert({ content: "hub", source: "manual" }, embedding(1));
    const leaf = store.insert({ content: "leaf", source: "manual" }, embedding(30));
    const sources = [0, 1, 2].map((i) =>
      store.insert({ content: `s${i}`, source: "manual" }, embedding(100 + i * 7)),
    );
    db.prepare("DELETE FROM memory_links").run(); // drop eager auto-links; wire the graph explicitly
    for (const s of sources) {
      db.prepare("INSERT OR IGNORE INTO memory_links (source_id, target_id, link_text, created_at) VALUES (?, ?, 'auto:similar', ?)").run(s.id, hub.id, "2026-09-01T00:00:00.000Z");
    }
    const candidates = store.listWarmCandidatesForPromotion(10);
    expect(candidates[0].id).toBe(hub.id);
    expect(candidates[0].backlinkCount).toBe(3);
    expect(candidates.find((c) => c.id === leaf.id)?.backlinkCount).toBe(0);
  });

  it("rewarmRecentlyAccessedCold flips only cold rows accessed after the cutoff", () => {
    const db = store.getDatabase();
    const recent = store.insert({ content: "recent cold", source: "manual" }, embedding(1));
    const ancient = store.insert({ content: "ancient cold", source: "manual" }, embedding(30));
    const warm = store.insert({ content: "warm", source: "manual" }, embedding(60));
    db.prepare("UPDATE memories SET tier = 'cold', accessed_at = '2026-09-04T00:00:00.000Z' WHERE id = ?").run(recent.id);
    db.prepare("UPDATE memories SET tier = 'cold', accessed_at = '2026-01-04T00:00:00.000Z' WHERE id = ?").run(ancient.id);
    db.prepare("UPDATE memories SET accessed_at = '2026-09-04T00:00:00.000Z' WHERE id = ?").run(warm.id);

    expect(store.rewarmRecentlyAccessedCold("2026-08-29T00:00:00.000Z")).toBe(1);
    const tiers = db.prepare("SELECT id, tier FROM memories").all() as Array<{ id: string; tier: string }>;
    const byId = new Map(tiers.map((t) => [t.id, t.tier]));
    expect(byId.get(recent.id)).toBe("warm");
    expect(byId.get(ancient.id)).toBe("cold");
    expect(byId.get(warm.id)).toBe("warm");
  });
});

describe("memories without a vector (Phase 999.119 pass 2)", () => {
  let store: MemoryStore;
  beforeEach(() => {
    store = new MemoryStore(":memory:", { enabled: false, similarityThreshold: 0.85 });
  });
  afterEach(() => store.close());

  it("counts, lists oldest-first, and re-inserts a v1 vector", () => {
    const db = store.getDatabase();
    const vec = embedding(4);
    const ok = store.insert({ content: "has vector", source: "manual" }, vec);
    for (const [id, created] of [["no-vec-new", "2026-08-01T00:00:00.000Z"], ["no-vec-old", "2026-03-14T00:00:00.000Z"]]) {
      db.prepare(
        `INSERT INTO memories (id, content, source, importance, tags, created_at, updated_at, accessed_at, tier)
         VALUES (?, ?, 'conversation', 0.5, '[]', ?, ?, ?, 'warm')`,
      ).run(id, `content ${id}`, created, created, created);
    }

    expect(store.countMemoriesMissingEmbedding()).toBe(2);
    expect(store.checkIntegrity().memoriesWithoutEmbedding).toBe(2);
    expect(store.checkIntegrity().total).toBe(0); // not a delete-repair class
    expect(store.listMemoriesMissingEmbedding(10).map((r) => r.id)).toEqual(["no-vec-old", "no-vec-new"]);

    store.insertEmbeddingV1("no-vec-old", embedding(5));
    expect(store.countMemoriesMissingEmbedding()).toBe(1);
    expect(store.searchMemoriesVec(embedding(5), 1)[0]?.memory_id).toBe("no-vec-old");
    // Re-inserting for a row that already has one replaces it.
    store.insertEmbeddingV1(ok.id, embedding(6));
    expect(db.prepare("SELECT COUNT(*) AS n FROM vec_memories WHERE memory_id = ?").get(ok.id)).toEqual({ n: 1 });
    expect(() => store.insertEmbeddingV1("no-vec-new", new Float32Array(3))).toThrow(/384/);
  });

  it("searchMemoriesVec never returns a ghost vec row", () => {
    const vec = embedding(1);
    const gone = store.insert({ content: "gone", source: "manual" }, vec);
    bypassDelete(store, gone.id);
    expect(store.searchMemoriesVec(vec, 5)).toEqual([]);
  });
});
