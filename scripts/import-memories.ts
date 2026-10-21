#!/usr/bin/env npx tsx
/**
 * Import markdown memory files from OpenClaw into a ClawCode agent's memory store.
 *
 * Usage:
 *   npx tsx scripts/import-memories.ts <agent-name> <memory-dir>
 *
 * Example:
 *   npx tsx scripts/import-memories.ts test-agent /home/example-user/.openclaw/workspace-general/memory
 *
 * What it does:
 * - Reads all .md files from the source directory
 * - Splits large files into chunks (~500 words each)
 * - Generates embeddings for each chunk
 * - Inserts into the agent's SQLite memory store with wikilink extraction
 * - Skips duplicates (by content hash)
 */

import { readdir, readFile } from "node:fs/promises";
import { join, basename } from "node:path";
import { homedir } from "node:os";
import { MemoryStore } from "../src/memory/store.js";
import { EmbeddingService } from "../src/memory/embedder.js";
import { extractWikilinks } from "../src/memory/graph.js";
import { getAgentMemoryDbPath } from "../src/shared/agent-paths.js";
import { nanoid } from "nanoid";
import { createHash } from "node:crypto";

const CHUNK_SIZE_WORDS = 400;
const AGENT_NAME = process.argv[2];
const MEMORY_DIR = process.argv[3];

if (!AGENT_NAME || !MEMORY_DIR) {
  console.error("Usage: npx tsx scripts/import-memories.ts <agent-name> <memory-dir>");
  console.error("Example: npx tsx scripts/import-memories.ts test-agent ~/.openclaw/workspace-general/memory");
  process.exit(1);
}

/** Split text into chunks of roughly CHUNK_SIZE_WORDS words. */
function chunkText(text: string): string[] {
  const lines = text.split("\n");
  const chunks: string[] = [];
  let current: string[] = [];
  let wordCount = 0;

  for (const line of lines) {
    const lineWords = line.split(/\s+/).filter(Boolean).length;

    // Start new chunk at headers or when size exceeded
    if (wordCount > 0 && (wordCount + lineWords > CHUNK_SIZE_WORDS || (line.startsWith("## ") && wordCount > 50))) {
      chunks.push(current.join("\n").trim());
      current = [];
      wordCount = 0;
    }

    current.push(line);
    wordCount += lineWords;
  }

  if (current.length > 0) {
    const remaining = current.join("\n").trim();
    if (remaining.length > 20) {
      chunks.push(remaining);
    }
  }

  return chunks;
}

/** Generate a content hash for dedup. */
function contentHash(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

/** Derive importance from content heuristics. */
function deriveImportance(content: string): number {
  let score = 0.5;
  // Boost for structured content
  if (content.includes("##")) score += 0.1;
  if (content.includes("- ")) score += 0.05;
  // Boost for credentials/config (high value)
  if (/credential|password|token|api.key|secret/i.test(content)) score += 0.15;
  // Boost for wikilinks (connected knowledge)
  const links = extractWikilinks(content);
  score += Math.min(links.length * 0.05, 0.15);
  return Math.min(score, 1.0);
}

/** Derive tags from filename and content. */
function deriveTags(filename: string, content: string): string[] {
  const tags: string[] = [];

  // Date tag from filename
  const dateMatch = filename.match(/^(\d{4}-\d{2}-\d{2})/);
  if (dateMatch) tags.push(dateMatch[1]);

  // Topic tags from filename
  const nameParts = filename.replace(/^\d{4}-\d{2}-\d{2}-?/, "").replace(/\.md$/, "");
  if (nameParts) tags.push(nameParts);

  // Content-based tags
  if (/discord/i.test(content)) tags.push("discord");
  if (/unraid|docker|container/i.test(content)) tags.push("infrastructure");
  if (/acme/i.test(content)) tags.push("acme");
  if (/heygen/i.test(content)) tags.push("heygen");
  if (/api|endpoint|webhook/i.test(content)) tags.push("api");
  if (/bug|fix|error|issue/i.test(content)) tags.push("bugfix");

  return [...new Set(tags)].slice(0, 8);
}

async function main() {
  const dbPath = getAgentMemoryDbPath(
    join(
      process.env.CLAWCODE_HOME ?? join(homedir(), ".clawcode"),
      "agents",
      AGENT_NAME,
    ),
  );

  console.log(`Importing memories for agent '${AGENT_NAME}'`);
  console.log(`Source: ${MEMORY_DIR}`);
  console.log(`Database: ${dbPath}`);
  console.log("");

  // Initialize store and embedder
  const store = new MemoryStore(dbPath);
  const embedder = new EmbeddingService();

  console.log("Warming up embedding model...");
  await embedder.warmup();
  console.log("Model ready.\n");

  // Read all .md files
  const files = (await readdir(MEMORY_DIR))
    .filter((f) => f.endsWith(".md"))
    .sort();

  console.log(`Found ${files.length} memory files.\n`);

  // Track seen content hashes for dedup
  const seenHashes = new Set<string>();
  let imported = 0;
  let skipped = 0;
  let chunks = 0;

  for (const file of files) {
    const filePath = join(MEMORY_DIR, file);
    const raw = await readFile(filePath, "utf-8");

    if (raw.trim().length < 30) {
      skipped++;
      continue;
    }

    const textChunks = chunkText(raw);

    for (const chunk of textChunks) {
      if (chunk.length < 30) continue;

      const hash = contentHash(chunk);
      if (seenHashes.has(hash)) {
        skipped++;
        continue;
      }
      seenHashes.add(hash);

      const id = nanoid();
      const importance = deriveImportance(chunk);
      const tags = deriveTags(file, chunk);
      const now = new Date().toISOString();

      // Extract date from filename for createdAt
      const dateMatch = file.match(/^(\d{4}-\d{2}-\d{2})/);
      const createdAt = dateMatch ? `${dateMatch[1]}T00:00:00.000Z` : now;

      try {
        const embedding = await embedder.embed(chunk);

        store.insert(
          {
            id,
            content: chunk,
            source: "manual",
            importance,
            tags,
            createdAt,
          },
          embedding,
        );

        // Extract and store wikilinks
        const wikilinks = extractWikilinks(chunk);
        if (wikilinks.length > 0) {
          const graphStmts = store.getGraphStatements();
          for (const targetId of wikilinks) {
            // Only insert link if target exists
            const exists = graphStmts.checkMemoryExists.get(targetId);
            if (exists) {
              try {
                graphStmts.insertLink.run(id, targetId, targetId, now);
              } catch { /* duplicate link or FK violation — skip */ }
            }
          }
        }

        imported++;
        chunks++;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`  Error embedding chunk from ${file}: ${msg}`);
        skipped++;
      }
    }

    process.stdout.write(`\r  Processed: ${file} (${imported} imported, ${skipped} skipped)`);
  }

  console.log(`\n\nDone!`);
  console.log(`  Files processed: ${files.length}`);
  console.log(`  Chunks imported: ${imported}`);
  console.log(`  Skipped (dedup/empty): ${skipped}`);
  console.log(`\nView the knowledge graph at http://localhost:3100/graph`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
