#!/usr/bin/env npx tsx
/**
 * Import RAG chunks from an OpenClaw-shaped SQLite into a ClawCode agent's
 * document store. Re-embeds every chunk with ClawCode's embedder so the
 * source's stored embeddings are discarded (different models would corrupt
 * similarity search).
 *
 * Expected source schema:
 *   chunks(id TEXT, path TEXT, source TEXT, start_line INT, end_line INT,
 *          hash TEXT, model TEXT, text TEXT, embedding TEXT, updated_at INT)
 *
 * Writes into the agent's shared SQLite (document_chunks + vec_document_chunks
 * tables managed by DocumentStore).
 *
 * Usage:
 *   npx tsx scripts/import-rag-chunks.ts <source.sqlite> <agent-name> [db-base]
 *
 * db-base defaults to ~/.clawcode/agents. The target DB is
 * <db-base>/<agent-name>/memory/memories.db.
 *
 * IMPORTANT: stop the agent before running — the agent holds the DB open and
 * concurrent writes through sqlite-vec can corrupt the vector index.
 */

import Database from "better-sqlite3";
import { join } from "node:path";
import { homedir } from "node:os";
import { MemoryStore } from "../src/memory/store.js";
import { DocumentStore } from "../src/documents/store.js";
import { EmbeddingService } from "../src/memory/embedder.js";
import { getAgentMemoryDbPath } from "../src/shared/agent-paths.js";
import type { ChunkInput } from "../src/documents/chunker.js";

type SourceRow = {
  id: string;
  path: string;
  source: string;
  start_line: number;
  end_line: number;
  text: string;
};

const SOURCE = process.argv[2];
const AGENT_NAME = process.argv[3];
const DB_BASE = process.argv[4] ?? join(homedir(), ".clawcode", "agents");

if (!SOURCE || !AGENT_NAME) {
  console.error("Usage: npx tsx scripts/import-rag-chunks.ts <source.sqlite> <agent-name> [db-base]");
  process.exit(1);
}

async function main(): Promise<void> {
  console.log(`Source:  ${SOURCE}`);
  console.log(`Agent:   ${AGENT_NAME}`);

  const srcDb = new Database(SOURCE, { readonly: true });
  const rows = srcDb.prepare(
    "SELECT id, path, source, start_line, end_line, text FROM chunks ORDER BY path, start_line",
  ).all() as SourceRow[];
  srcDb.close();

  console.log(`Chunks:  ${rows.length}`);

  const byPath = new Map<string, SourceRow[]>();
  for (const r of rows) {
    if (!r.text || !r.text.trim()) continue;
    const group = byPath.get(r.path) ?? [];
    group.push(r);
    byPath.set(r.path, group);
  }
  console.log(`Paths:   ${byPath.size}`);

  const targetDbPath = getAgentMemoryDbPath(join(DB_BASE, AGENT_NAME));
  console.log(`Target:  ${targetDbPath}`);

  // MemoryStore initializes the shared DB with sqlite-vec loaded + all
  // tables created. DocumentStore reuses the same DB handle.
  const memStore = new MemoryStore(targetDbPath);
  const docStore = new DocumentStore(memStore.getDatabase());

  console.log("");
  console.log("Warming up embedder...");
  const embedder = new EmbeddingService();
  await embedder.warmup();
  console.log("Ready.");
  console.log("");

  let totalChunks = 0;
  let totalChars = 0;
  let pathIdx = 0;

  for (const [path, group] of byPath) {
    pathIdx += 1;
    const chunks: ChunkInput[] = group.map((r, i) => ({
      content: r.text,
      chunkIndex: i,
      startChar: r.start_line,
      endChar: r.end_line,
    }));
    const embeddings: Float32Array[] = [];
    for (const c of chunks) {
      embeddings.push(await embedder.embed(c.content));
    }
    const res = docStore.ingest(path, chunks, embeddings);
    totalChunks += res.chunksCreated;
    totalChars += res.totalChars;
    process.stdout.write(
      `  [${pathIdx}/${byPath.size}] ${path} — ${res.chunksCreated} chunks\n`,
    );
  }

  memStore.close();

  console.log("");
  console.log("Done.");
  console.log(`  Paths ingested: ${byPath.size}`);
  console.log(`  Chunks written: ${totalChunks}`);
  console.log(`  Characters:     ${totalChars}`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
