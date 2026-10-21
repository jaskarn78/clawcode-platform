/**
 * Phase 999.154 WS-5 — cleanup against the REAL store schemas (MemoryStore +
 * DocumentStore on a file DB), seeded like prod: refusal blocks mixed with a
 * real analysis that must survive untouched.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { MemoryStore } from "../../memory/store.js";
import { DocumentStore } from "../../documents/store.js";
import {
  cleanupVisionContamination,
  stripFakeVision,
  type CleanupEmbedder,
} from "../contamination-cleanup.js";

const REFUSAL_SS =
  "I don't see an image attached to your message. Please provide the image path or file you'd like me to analyze.";
const REFUSAL_CHART =
  "I need the chart or graph image to analyze. Please provide: - A file path to an image (PNG, JPG, etc.)";
const REAL_SS = "TYPE: screenshot\nSUMMARY: Gmail draft to Tara about 2027 dues\nTEXT:\n- Dues";

const embed: CleanupEmbedder = async (texts, includeV1) => ({
  v1: includeV1 ? texts.map(() => new Float32Array(384).fill(0.01)) : null,
  v2: texts.map(() => new Int8Array(384).fill(1)),
});

const f32 = () => new Float32Array(384).fill(0.5);
const i8 = () => Buffer.from(new Int8Array(384).fill(3).buffer);

let dir: string;
let dbPath: string;
let db: Database.Database;

function seed(): void {
  const mem = new MemoryStore(dbPath, { enabled: false, similarityThreshold: 0.85 });
  const docs = new DocumentStore(mem.getDatabase());
  db = mem.getDatabase();
  const now = "2026-06-01T00:00:00.000Z";
  const insMem = db.prepare(
    "INSERT INTO memories (id, content, source, importance, access_count, tags, created_at, updated_at, accessed_at) VALUES (?, ?, 'conversation', 0.5, 0, '[]', ?, ?, ?)",
  );
  insMem.run("m-fake", `<channel>look</channel>\n<screenshot-analysis>\n${REFUSAL_SS}\n</screenshot-analysis>`, now, now, now);
  insMem.run("m-real", `<channel>x</channel>\n<screenshot-analysis>\n${REAL_SS}\n</screenshot-analysis>`, now, now, now);
  for (const id of ["m-fake", "m-real"]) {
    db.prepare("INSERT INTO vec_memories (memory_id, embedding) VALUES (?, ?)").run(id, f32());
    db.prepare("INSERT INTO vec_memories_v2 (memory_id, embedding) VALUES (?, vec_int8(?))").run(id, i8());
  }

  db.prepare(
    "INSERT INTO conversation_sessions (id, agent_name, started_at, status) VALUES ('s1', 'a', ?, 'ended')",
  ).run(now);
  db.prepare(
    "INSERT INTO conversation_turns (id, session_id, turn_index, role, content, created_at) VALUES ('t1', 's1', 0, 'user', ?, ?)",
  ).run(`hi\n<screenshot-analysis>\n${REFUSAL_SS}\n</screenshot-analysis>`, now);

  docs.ingest(
    "/inbox/1790-image.png",
    [
      { content: `OCR labels AAPL 180 ## Chart shape analysis ${REFUSAL_CHART}`, chunkIndex: 0, startChar: 0, endChar: 10 },
      { content: `## Chart shape analysis I don't see a`, chunkIndex: 1, startChar: 10, endChar: 20 },
    ] as never,
    [new Int8Array(384).fill(2), new Int8Array(384).fill(2)],
  );
  docs.upsertDocumentRow({
    source: "/inbox/1790-image.png",
    agentName: "a",
    ingestedAt: now,
    sourceKind: "discord_attachment",
    autoClassifiedClass: "high", // steered by the refusal's "I'll return…"
    contentWeight: 1.5,
    agentWeightAtIngest: 1,
    sourceImagePath: "/inbox/1790-image.png",
  });

  db.prepare(
    "INSERT INTO memory_chunks (id, path, chunk_index, heading, body, token_count, file_mtime_ms, created_at) VALUES ('c1', 'document:image', 0, 'h', ?, 10, 0, ?)",
  ).run(`OCR text ## Chart shape analysis ${REFUSAL_CHART}`, now);
  db.prepare("INSERT INTO memory_chunks_fts (chunk_id, heading, body) VALUES ('c1', 'h', ?)").run(
    `OCR text ## Chart shape analysis ${REFUSAL_CHART}`,
  );
  db.prepare("INSERT INTO vec_memory_chunks (chunk_id, embedding) VALUES ('c1', ?)").run(f32());
  db.prepare("INSERT INTO vec_memory_chunks_v2 (chunk_id, embedding) VALUES ('c1', vec_int8(?))").run(i8());
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "vision-cleanup-"));
  dbPath = join(dir, "memories.db");
  seed();
});

const count = (sql: string, ...args: unknown[]) =>
  (db.prepare(sql).get(...args) as { n: number }).n;

describe("stripFakeVision", () => {
  it("removes refusal blocks only; real analyses and surrounding text survive", () => {
    const text = `a\n<screenshot-analysis>\n${REFUSAL_SS}\n</screenshot-analysis>\n<screenshot-analysis>\n${REAL_SS}\n</screenshot-analysis>`;
    const { cleaned, removed } = stripFakeVision(text);
    expect(removed).toHaveLength(1);
    expect(cleaned).toContain(REAL_SS);
    expect(cleaned).not.toContain("provide the image");
    expect(cleaned.startsWith("a")).toBe(true);
  });

  it("handles flattened chunk text and truncated refusals", () => {
    expect(stripFakeVision(`x ## Chart shape analysis ${REFUSAL_CHART}`).cleaned).toBe("x");
    expect(stripFakeVision("## Chart shape analysis I don't see a").cleaned).toBe("");
    expect(stripFakeVision("## Chart shape analysis CHART_TYPE: line TREND: rising").removed).toHaveLength(0);
  });
});

describe("cleanupVisionContamination", () => {
  it("dry run reports and changes nothing", async () => {
    const r = await cleanupVisionContamination(db, { apply: false, embed, backupPath: join(dir, "bak") });
    expect(r.applied).toBe(false);
    const byTable = Object.fromEntries(r.tables.map((t) => [t.table, t]));
    expect(byTable.memories).toMatchObject({ changed: 1 });
    expect(byTable.conversation_turns).toMatchObject({ changed: 1 });
    expect(byTable.document_chunks).toMatchObject({ changed: 2, emptied: 1 });
    expect(byTable.memory_chunks).toMatchObject({ changed: 1 });
    expect(r.reclassified).toBe(1);
    expect(existsSync(join(dir, "bak"))).toBe(false);
    expect(count("SELECT count(*) n FROM memories WHERE content LIKE '%provide the image%'")).toBe(1);
  });

  it("apply: backs up first, strips surgically, re-embeds, fixes FTS and classes", async () => {
    const bak = join(dir, "memories.db.bak-999154");
    const r = await cleanupVisionContamination(db, { apply: true, embed, backupPath: bak });
    expect(r.applied).toBe(true);
    expect(existsSync(bak)).toBe(true);
    const backup = new Database(bak, { readonly: true });
    expect((backup.prepare("SELECT content FROM memories WHERE id='m-fake'").get() as { content: string }).content).toContain(REFUSAL_SS);
    backup.close();

    // memories: fake stripped + re-embedded; real untouched
    const fake = db.prepare("SELECT content FROM memories WHERE id='m-fake'").get() as { content: string };
    expect(fake.content).toBe("<channel>look</channel>");
    const real = db.prepare("SELECT content, updated_at FROM memories WHERE id='m-real'").get() as { content: string };
    expect(real.content).toContain(REAL_SS);
    expect(count("SELECT count(*) n FROM vec_memories WHERE memory_id='m-fake'")).toBe(1);
    expect(count("SELECT count(*) n FROM vec_memories_v2 WHERE memory_id='m-fake'")).toBe(1);

    // conversation_turns + FTS (trigger-maintained)
    expect(count("SELECT count(*) n FROM conversation_turns_fts WHERE conversation_turns_fts MATCH '\"provide the image\"'")).toBe(0);
    expect(count("SELECT count(*) n FROM conversation_turns_fts WHERE conversation_turns_fts MATCH 'hi'")).toBe(1);

    // document chunks: one edited (vector re-inserted), one emptied (row + vector gone)
    expect(count("SELECT count(*) n FROM document_chunks")).toBe(1);
    expect((db.prepare("SELECT content FROM document_chunks").get() as { content: string }).content).toBe("OCR labels AAPL 180");
    expect(count("SELECT count(*) n FROM vec_document_chunks")).toBe(1);

    // memory chunks: body, FTS row, both vectors
    expect((db.prepare("SELECT body FROM memory_chunks WHERE id='c1'").get() as { body: string }).body).toBe("OCR text");
    expect(count("SELECT count(*) n FROM memory_chunks_fts WHERE memory_chunks_fts MATCH 'analyze'")).toBe(0);
    expect(count("SELECT count(*) n FROM vec_memory_chunks WHERE chunk_id='c1'")).toBe(1);
    expect(count("SELECT count(*) n FROM vec_memory_chunks_v2 WHERE chunk_id='c1'")).toBe(1);

    // steered class recomputed without the refusal text
    const doc = db.prepare("SELECT auto_classified_class c, content_priority_weight w FROM documents").get() as { c: string; w: number };
    expect(doc).toEqual({ c: "medium", w: 1.0 });

    // idempotent
    const again = await cleanupVisionContamination(db, { apply: true, embed, backupPath: join(dir, "bak2") });
    expect(again.tables.every((t) => t.changed === 0)).toBe(true);
    expect(again.applied).toBe(false);
  });
});
