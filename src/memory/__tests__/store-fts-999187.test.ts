/**
 * Phase 999.187 — porter-stemmed chunk index (with legacy rebuild) and the
 * new memories_fts index kept in sync by triggers.
 */
import { describe, it, expect, afterEach } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore } from "../store.js";

const vec = new Float32Array(384).fill(0.1);
let tmp: string | null = null;
afterEach(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  tmp = null;
});

function chunk(store: MemoryStore, body: string, heading = "h") {
  return store.insertMemoryChunk({
    path: "/ws/memory/2026-09-01.md",
    chunkIndex: 0,
    heading,
    body,
    tokenCount: 4,
    scoreWeight: 0,
    fileMtimeMs: Date.now(),
    fileSha256: nanoid(),
    embedding: vec,
  });
}
let n = 0;
const nanoid = () => `sha-${n++}`;

describe("memory_chunks_fts (999.187)", () => {
  it("a fresh store uses the porter tokenizer and stems query terms", () => {
    const store = new MemoryStore(":memory:");
    const sql = (store.getDatabase().prepare("SELECT sql FROM sqlite_master WHERE name='memory_chunks_fts'").get() as { sql: string }).sql;
    expect(sql).toMatch(/porter/);
    const id = chunk(store, "we decided on sqlite-vec for vector search");
    expect(store.searchMemoryChunksFts("what did we decide about vectors?", 5).map((r) => r.chunk_id)).toEqual([id]);
    store.close();
  });

  it("a legacy unicode61 index is rebuilt to porter without losing rows", () => {
    tmp = mkdtempSync(join(tmpdir(), "fts-legacy-"));
    const file = join(tmp, "memories.db");
    const first = new MemoryStore(file);
    const id = chunk(first, "quarterly rebalancing decisions");
    first.close();
    // Downgrade the index the way a Phase-90-era DB would look.
    const raw = new Database(file);
    raw.exec(`
      DROP TABLE memory_chunks_fts;
      CREATE VIRTUAL TABLE memory_chunks_fts USING fts5(chunk_id UNINDEXED, heading, body, tokenize='unicode61 remove_diacritics 2');
      INSERT INTO memory_chunks_fts (chunk_id, heading, body) SELECT id, COALESCE(heading,''), body FROM memory_chunks;
    `);
    raw.close();
    const second = new MemoryStore(file);
    const sql = (second.getDatabase().prepare("SELECT sql FROM sqlite_master WHERE name='memory_chunks_fts'").get() as { sql: string }).sql;
    expect(sql).toMatch(/porter/);
    // Stemmed match proves the rebuilt index is live: "rebalance" finds "rebalancing".
    expect(second.searchMemoryChunksFts("rebalance decision", 5).map((r) => r.chunk_id)).toEqual([id]);
    second.close();
  });
});

describe("memories_fts (999.187)", () => {
  it("insert, update and delete stay in sync through triggers", () => {
    const store = new MemoryStore(":memory:");
    const m = store.insert({ content: "Client A prefers BSX over BSXX", source: "manual", skipDedup: true }, vec);
    expect(store.searchMemoriesFts("BSX", 5).map((r) => r.memory_id)).toEqual([m.id]);
    store.getDatabase().prepare("UPDATE memories SET content = ? WHERE id = ?").run("Client A prefers VTI", m.id);
    expect(store.searchMemoriesFts("BSX", 5)).toHaveLength(0);
    expect(store.searchMemoriesFts("VTI", 5).map((r) => r.memory_id)).toEqual([m.id]);
    store.delete(m.id);
    expect(store.searchMemoriesFts("VTI", 5)).toHaveLength(0);
    store.close();
  });

  it("an existing DB gets a one-shot backfill when the index is first created", () => {
    tmp = mkdtempSync(join(tmpdir(), "fts-backfill-"));
    const file = join(tmp, "memories.db");
    const first = new MemoryStore(file);
    const m = first.insert({ content: "standing rule: never auto-deploy", source: "manual", skipDedup: true }, vec);
    first.close();
    const raw = new Database(file);
    raw.exec("DROP TRIGGER memories_fts_ai; DROP TRIGGER memories_fts_ad; DROP TRIGGER memories_fts_au; DROP TABLE memories_fts;");
    raw.close();
    const second = new MemoryStore(file);
    expect(second.searchMemoriesFts("auto-deploy rule", 5).map((r) => r.memory_id)).toEqual([m.id]);
    second.close();
  });
});
