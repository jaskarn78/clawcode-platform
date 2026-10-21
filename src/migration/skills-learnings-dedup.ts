/**
 * Phase 84 Plan 02 Task 2 — self-improving-agent `.learnings/*.md` dedup.
 *
 * Reads `.learnings/*.md` files from an OpenClaw skill directory, hashes
 * each trimmed body with sha256, and partitions the entries into:
 *   - `toImport`: not already present in the target MemoryStore (by
 *     exact `tags="learning"` + content match)
 *   - `skipped`:  already present (migration is idempotent)
 *
 * The caller (migrate-skills CLI apply path) then stores each `toImport`
 * entry with `tags: ["learning", "migrated-from-openclaw"]` and
 * `origin_id: openclaw-learning-<hash-prefix>` so that subsequent
 * invocations hit the MemoryStore's Phase-80 MEM-02 origin_id idempotency
 * gate before even reaching this dedup layer.
 *
 * Zero fs writes — `readLearningsDir` is read-only; `dedupeLearnings`
 * only queries the MemoryStore.
 */
import { readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, extname } from "node:path";
import type { MemoryStore } from "../memory/store.js";

export type LearningEntry = {
  readonly path: string;
  readonly content: string;
  readonly hash: string;
};

export type DedupeResult = {
  readonly toImport: readonly LearningEntry[];
  readonly skipped: readonly LearningEntry[];
};

/**
 * Walk a `.learnings/` directory and return one entry per `.md` file.
 * Hash is `sha256(trimmedContent)` — whitespace-only changes don't
 * split the dedup identity, matching natural edit patterns.
 *
 * Non-existent directories return `[]`. Files that fail to read (broken
 * symlinks, permission errors) are silently skipped.
 */
export async function readLearningsDir(
  learningsDir: string,
): Promise<readonly LearningEntry[]> {
  if (!existsSync(learningsDir)) return [];
  let entries;
  try {
    entries = await readdir(learningsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const results: LearningEntry[] = [];
  for (const ent of entries) {
    if (!ent.isFile()) continue;
    if (extname(ent.name).toLowerCase() !== ".md") continue;
    const abs = join(learningsDir, ent.name);
    let content: string;
    try {
      content = await readFile(abs, "utf8");
    } catch {
      continue;
    }
    const trimmed = content.trim();
    if (trimmed.length === 0) continue;
    const hash = createHash("sha256").update(trimmed).digest("hex");
    results.push({ path: abs, content, hash });
  }
  return results;
}

/**
 * Partition learnings into "already in MemoryStore" vs "need import".
 * Match key: (tag="learning", content === trimmedContent).
 *
 * We intentionally use trimmed content (matching the hash input) so a
 * learning with trailing whitespace edits doesn't double-import.
 */
export async function dedupeLearnings(
  learnings: readonly LearningEntry[],
  memoryStore: MemoryStore,
): Promise<DedupeResult> {
  const toImport: LearningEntry[] = [];
  const skipped: LearningEntry[] = [];
  for (const entry of learnings) {
    const existing = memoryStore.findByTagAndContent(
      "learning",
      entry.content.trim(),
    );
    if (existing) {
      skipped.push(entry);
    } else {
      toImport.push(entry);
    }
  }
  return { toImport, skipped };
}
