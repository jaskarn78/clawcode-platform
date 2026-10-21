/**
 * Phase 84 Plan 02 Task 2 — self-improving-agent .learnings/ dedup tests.
 *
 * Exercises the dedup helper against an in-memory MemoryStore. Locks:
 *   (a) readLearningsDir returns the same count as readdir
 *   (b) a MemoryStore preloaded with a matching 'learning' entry moves
 *       that learning to `skipped`
 *   (c) empty / missing .learnings dir returns [] without throwing
 *   (d) idempotent: after importing all, second dedupe → 0 in toImport
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { readdir, writeFile, mkdir } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { MemoryStore } from "../../memory/store.js";
import {
  readLearningsDir,
  dedupeLearnings,
} from "../skills-learnings-dedup.js";

const OPENCLAW_LEARNINGS = join(
  homedir(),
  ".openclaw",
  "skills",
  "self-improving-agent",
  ".learnings",
);

describe("skills-learnings-dedup — readLearningsDir", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "learnings-"));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("(a) real self-improving-agent/.learnings/ → count matches readdir .md count", async () => {
    const entries = await readdir(OPENCLAW_LEARNINGS);
    const mdCount = entries.filter((e) => e.endsWith(".md")).length;
    const learnings = await readLearningsDir(OPENCLAW_LEARNINGS);
    expect(learnings.length).toBe(mdCount);
    // Each learning has a non-empty content + hash
    for (const l of learnings) {
      expect(l.path).toMatch(/\.md$/);
      expect(l.content.length).toBeGreaterThan(0);
      expect(l.hash).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it("(c) non-existent .learnings dir → [] without throwing", async () => {
    const missing = join(tmp, "nope");
    const learnings = await readLearningsDir(missing);
    expect(learnings).toEqual([]);
  });
});

describe("skills-learnings-dedup — dedupeLearnings", () => {
  let tmp: string;
  let dbPath: string;
  let store: MemoryStore;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "dedup-"));
    dbPath = join(tmp, "test.db");
    store = new MemoryStore(dbPath);
  });
  afterEach(() => {
    // MemoryStore holds an open DB handle. No close method needed for
    // in-memory better-sqlite3 usage; tests clean up the dir.
    rmSync(tmp, { recursive: true, force: true });
  });

  it("(b) MemoryStore preloaded with one matching 'learning' entry → that entry moves to skipped", async () => {
    // Build two synthetic learnings in a tmp .learnings dir
    const learningsDir = join(tmp, ".learnings");
    await mkdir(learningsDir);
    const aContent = "# Learning A\n\nBody A.";
    const bContent = "# Learning B\n\nBody B.";
    await writeFile(join(learningsDir, "A.md"), aContent);
    await writeFile(join(learningsDir, "B.md"), bContent);

    // Preload Store with the trimmed content of A, tagged 'learning'.
    // Embedding is any zero vector (size doesn't matter for tag+content lookup).
    const emptyEmbedding = new Float32Array(384);
    store.insert(
      {
        content: aContent.trim(),
        source: "manual",
        importance: 0.5,
        tags: ["learning", "seed"],
        origin_id: "seed-A",
      },
      emptyEmbedding,
    );

    const learnings = await readLearningsDir(learningsDir);
    const { toImport, skipped } = await dedupeLearnings(learnings, store);
    const names = (arr: typeof learnings) => arr.map((e) => e.path);
    expect(names(skipped).some((p) => p.endsWith("A.md"))).toBe(true);
    expect(names(toImport).some((p) => p.endsWith("B.md"))).toBe(true);
    expect(names(toImport).some((p) => p.endsWith("A.md"))).toBe(false);
  });

  it("(d) idempotency — after importing all, re-dedupe → zero in toImport", async () => {
    const learningsDir = join(tmp, ".learnings");
    await mkdir(learningsDir);
    const aContent = "# Only\n\nBody.";
    await writeFile(join(learningsDir, "only.md"), aContent);

    const learnings = await readLearningsDir(learningsDir);
    const first = await dedupeLearnings(learnings, store);
    expect(first.toImport.length).toBe(1);

    // Import the entries via origin_id so the 2nd pass picks them up.
    const emptyEmbedding = new Float32Array(384);
    for (const e of first.toImport) {
      store.insert(
        {
          content: e.content.trim(),
          source: "manual",
          importance: 0.5,
          tags: ["learning", "migrated-from-openclaw"],
          origin_id: `openclaw-learning-${e.hash.slice(0, 16)}`,
        },
        emptyEmbedding,
      );
    }

    const second = await dedupeLearnings(learnings, store);
    expect(second.toImport.length).toBe(0);
    expect(second.skipped.length).toBe(learnings.length);
  });

  it("(e) hash of LearningEntry is sha256 of trimmed content", async () => {
    const learningsDir = join(tmp, ".learnings");
    await mkdir(learningsDir);
    const body = "  Some body with surrounding whitespace.  \n";
    await writeFile(join(learningsDir, "x.md"), body);
    const learnings = await readLearningsDir(learningsDir);
    expect(learnings.length).toBe(1);
    const expected = createHash("sha256")
      .update(body.trim())
      .digest("hex");
    expect(learnings[0]!.hash).toBe(expected);
  });
});
