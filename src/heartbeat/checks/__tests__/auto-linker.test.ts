import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { MemoryStore } from "../../../memory/store.js";
import { cosineSimilarity, discoverAutoLinks } from "../../../memory/similarity.js";
import autoLinkerCheck from "../auto-linker.js";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdirSync, rmSync } from "node:fs";
import type { CheckContext, CheckResult } from "../../types.js";

/**
 * Generate a deterministic L2-normalized 384-dim embedding from a seed.
 * Vectors with close seeds will have HIGH cosine similarity.
 * Vectors with distant seeds will have LOW similarity.
 */
function makeNormalizedEmbedding(seed: number): Float32Array {
  const vec = new Float32Array(384);
  // Use seed to create a pattern - close seeds produce similar vectors
  for (let i = 0; i < 384; i++) {
    vec[i] = Math.sin(seed * 0.1 + i * 0.01) + Math.cos(seed * 0.05 + i * 0.02);
  }
  // L2 normalize
  let norm = 0;
  for (let i = 0; i < 384; i++) {
    norm += vec[i] * vec[i];
  }
  norm = Math.sqrt(norm);
  for (let i = 0; i < 384; i++) {
    vec[i] /= norm;
  }
  return vec;
}

/**
 * Generate an orthogonal embedding (completely different direction).
 */
function makeOrthogonalEmbedding(seed: number): Float32Array {
  const vec = new Float32Array(384);
  // Completely different frequency pattern ensures low similarity
  for (let i = 0; i < 384; i++) {
    vec[i] = Math.sin(seed * 100 + i * 3.7) * Math.cos(seed * 200 + i * 5.3);
  }
  // L2 normalize
  let norm = 0;
  for (let i = 0; i < 384; i++) {
    norm += vec[i] * vec[i];
  }
  norm = Math.sqrt(norm);
  for (let i = 0; i < 384; i++) {
    vec[i] /= norm;
  }
  return vec;
}

describe("cosineSimilarity", () => {
  it("returns 1.0 for identical normalized vectors", () => {
    const vec = makeNormalizedEmbedding(42);
    const result = cosineSimilarity(vec, vec);
    expect(result).toBeCloseTo(1.0, 5);
  });

  it("returns ~0.0 for orthogonal vectors", () => {
    // Create two genuinely orthogonal vectors using Gram-Schmidt
    const a = makeNormalizedEmbedding(1);
    const b = makeOrthogonalEmbedding(999);

    const result = cosineSimilarity(a, b);
    // Should be near zero (not exactly due to finite dims)
    expect(Math.abs(result)).toBeLessThan(0.15);
  });
});

describe("discoverAutoLinks", () => {
  let store: MemoryStore;
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `auto-linker-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(testDir, { recursive: true });
    store = new MemoryStore(join(testDir, "memory.db"));
  });

  afterEach(() => {
    store.close();
    rmSync(testDir, { recursive: true, force: true });
  });

  function insertMemory(id: string, embedding: Float32Array, tier: string = "warm"): void {
    const db = store.getDatabase();
    const now = new Date().toISOString();
    db.prepare(
      "INSERT INTO memories (id, content, source, importance, tags, created_at, updated_at, accessed_at, tier) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(id, `content for ${id}`, "manual", 0.5, "[]", now, now, now, tier);
    db.prepare("INSERT INTO vec_memories (memory_id, embedding) VALUES (?, ?)").run(id, embedding);
  }

  it("finds similar unlinked memory pairs above threshold (0.6 default)", () => {
    // Insert two very similar embeddings (same seed = identical = similarity 1.0)
    const emb1 = makeNormalizedEmbedding(1);
    const emb2 = makeNormalizedEmbedding(1); // identical = 1.0 similarity
    insertMemory("mem-a", emb1);
    insertMemory("mem-b", emb2);

    const result = discoverAutoLinks(store);
    expect(result.linksCreated).toBeGreaterThan(0);
  });

  it("skips pairs that already have edges (either direction)", () => {
    const emb1 = makeNormalizedEmbedding(1);
    const emb2 = makeNormalizedEmbedding(1);
    insertMemory("mem-a", emb1);
    insertMemory("mem-b", emb2);

    // Pre-create an edge
    const stmts = store.getGraphStatements();
    stmts.insertLink.run("mem-a", "mem-b", "manual:ref", new Date().toISOString());

    const result = discoverAutoLinks(store);
    expect(result.skippedExisting).toBeGreaterThan(0);
  });

  it("respects batchSize limit (default 50)", () => {
    // Insert 60 memories
    for (let i = 0; i < 60; i++) {
      insertMemory(`mem-${i}`, makeNormalizedEmbedding(i));
    }

    const result = discoverAutoLinks(store, { batchSize: 5 });
    expect(result.pairsScanned).toBeLessThanOrEqual(5);
  });

  it("creates bidirectional edges (A->B AND B->A) with link_text 'auto:similar'", () => {
    const emb = makeNormalizedEmbedding(1);
    insertMemory("mem-x", emb);
    insertMemory("mem-y", emb); // identical embedding

    discoverAutoLinks(store);

    const db = store.getDatabase();
    const forwardEdge = db
      .prepare("SELECT * FROM memory_links WHERE source_id = ? AND target_id = ? AND link_text = ?")
      .get("mem-x", "mem-y", "auto:similar");
    const reverseEdge = db
      .prepare("SELECT * FROM memory_links WHERE source_id = ? AND target_id = ? AND link_text = ?")
      .get("mem-y", "mem-x", "auto:similar");

    expect(forwardEdge).toBeTruthy();
    expect(reverseEdge).toBeTruthy();
  });

  it("skips memories without embeddings", () => {
    // Insert memory without embedding
    const db = store.getDatabase();
    const now = new Date().toISOString();
    db.prepare(
      "INSERT INTO memories (id, content, source, importance, tags, created_at, updated_at, accessed_at, tier) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run("mem-no-emb", "no embedding", "manual", 0.5, "[]", now, now, now, "warm");

    // Insert memory with embedding
    const emb = makeNormalizedEmbedding(1);
    insertMemory("mem-with-emb", emb);

    const result = discoverAutoLinks(store);
    // Should not crash and no links created to mem-no-emb
    const edges = db
      .prepare("SELECT * FROM memory_links WHERE source_id = ? OR target_id = ?")
      .all("mem-no-emb", "mem-no-emb");
    expect(edges).toHaveLength(0);
  });

  it("skips cold-tier memories", () => {
    const emb = makeNormalizedEmbedding(1);
    insertMemory("mem-cold", emb, "cold");
    insertMemory("mem-warm", emb);

    const result = discoverAutoLinks(store);
    // Cold memory should not be a candidate
    const db = store.getDatabase();
    const edges = db
      .prepare("SELECT * FROM memory_links WHERE source_id = ? OR target_id = ?")
      .all("mem-cold", "mem-cold");
    expect(edges).toHaveLength(0);
  });
});

describe("autoLinkerCheck", () => {
  let store: MemoryStore;
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `auto-linker-check-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(testDir, { recursive: true });
    store = new MemoryStore(join(testDir, "memory.db"));
  });

  afterEach(() => {
    store.close();
    rmSync(testDir, { recursive: true, force: true });
  });

  it("returns healthy status with metadata about links created", async () => {
    // Insert similar memories
    const emb = makeNormalizedEmbedding(1);
    const db = store.getDatabase();
    const now = new Date().toISOString();
    for (let i = 0; i < 3; i++) {
      db.prepare(
        "INSERT INTO memories (id, content, source, importance, tags, created_at, updated_at, accessed_at, tier) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(`mem-${i}`, `content ${i}`, "manual", 0.5, "[]", now, now, now, "warm");
      db.prepare("INSERT INTO vec_memories (memory_id, embedding) VALUES (?, ?)").run(`mem-${i}`, emb);
    }

    const mockSessionManager = {
      getMemoryStore: () => store,
    } as unknown as CheckContext["sessionManager"];

    const context: CheckContext = {
      agentName: "test-agent",
      sessionManager: mockSessionManager,
      registry: {} as CheckContext["registry"],
      config: { enabled: true, intervalSeconds: 60, checkTimeoutSeconds: 10, contextFill: { warningThreshold: 0.8, criticalThreshold: 0.95 } },
    };

    const result: CheckResult = await autoLinkerCheck.execute(context);
    expect(result.status).toBe("healthy");
    expect(result.metadata).toBeDefined();
    expect(result.metadata!.linksCreated).toBeGreaterThanOrEqual(0);
    expect(result.metadata!.pairsScanned).toBeGreaterThanOrEqual(0);
  });
});

describe("autoLinkerCheck — Phase 999.119 hardening", () => {
  let store: MemoryStore;
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `auto-linker-999119-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(testDir, { recursive: true });
    store = new MemoryStore(join(testDir, "memory.db"));
  });

  afterEach(() => {
    store.close();
    rmSync(testDir, { recursive: true, force: true });
  });

  function makeContext(agentName: string): CheckContext {
    return {
      agentName,
      sessionManager: { getMemoryStore: () => store } as unknown as CheckContext["sessionManager"],
      registry: {} as CheckContext["registry"],
      config: { enabled: true, intervalSeconds: 60, checkTimeoutSeconds: 10, contextFill: { warningThreshold: 0.8, criticalThreshold: 0.95 } },
    };
  }

  it("skips a fork — it shares the parent agent's store", async () => {
    const result = await autoLinkerCheck.execute(makeContext("projects-fork-6NMty0"));
    expect(result.status).toBe("healthy");
    expect(result.metadata).toEqual({ skipped: true, reason: "shared-parent-store" });
  });

  it("repairs orphan vec rows before linking so a KNN ghost can no longer fail the batch", async () => {
    const db = store.getDatabase();
    const emb = makeNormalizedEmbedding(1);
    const now = new Date().toISOString();
    for (const id of ["live-a", "live-b"]) {
      db.prepare(
        "INSERT INTO memories (id, content, source, importance, tags, created_at, updated_at, accessed_at, tier) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(id, `content ${id}`, "manual", 0.5, "[]", now, now, now, "warm");
      db.prepare("INSERT INTO vec_memories (memory_id, embedding) VALUES (?, ?)").run(id, emb);
    }
    // The production shape: a vec row whose memory row was deleted out-of-band.
    db.prepare("INSERT INTO vec_memories (memory_id, embedding) VALUES (?, ?)").run("ghost", emb);

    const result: CheckResult = await autoLinkerCheck.execute(makeContext("projects"));

    expect(result.status).toBe("healthy");
    expect(result.message).toContain("repaired 1 dangling row(s)");
    const repaired = result.metadata!.repaired as { orphanVecV1Removed: number };
    expect(repaired.orphanVecV1Removed).toBe(1);
    expect(result.metadata!.linksCreated).toBe(2);
    expect(db.prepare("SELECT COUNT(*) AS n FROM vec_memories").get()).toEqual({ n: 2 });
  });

  it("reports candidate errors as a warning with the first message", async () => {
    const db = store.getDatabase();
    const now = new Date().toISOString();
    db.prepare(
      "INSERT INTO memories (id, content, source, importance, tags, created_at, updated_at, accessed_at, tier) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run("boom", "content", "manual", 0.5, "[]", now, now, now, "warm");
    db.prepare("INSERT INTO vec_memories (memory_id, embedding) VALUES (?, ?)").run("boom", makeNormalizedEmbedding(2));
    const original = store.getEmbedding.bind(store);
    store.getEmbedding = ((id: string) => {
      if (id === "boom") throw new Error("simulated failure");
      return original(id);
    }) as typeof store.getEmbedding;

    const result = await autoLinkerCheck.execute(makeContext("projects"));

    expect(result.status).toBe("warning");
    expect(result.message).toContain("1 candidate error(s)");
    expect(result.message).toContain("simulated failure");
  });
});
