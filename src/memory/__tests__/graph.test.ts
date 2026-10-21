import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { stringify as yamlStringify } from "yaml";
import { extractWikilinks, traverseGraph, getBacklinks, getForwardLinks } from "../graph.js";
import { MemoryStore } from "../store.js";
import { TierManager, embeddingToBase64 } from "../tier-manager.js";
import type { TierConfig } from "../tiers.js";
import { DEFAULT_TIER_CONFIG } from "../tiers.js";
import type { ScoringConfig } from "../relevance.js";
import type { Database as DatabaseType } from "better-sqlite3";

describe("extractWikilinks", () => {
  it("extracts a single wikilink", () => {
    expect(extractWikilinks("Hello [[abc123]] world")).toEqual(["abc123"]);
  });

  it("extracts multiple wikilinks", () => {
    expect(extractWikilinks("[[a]] and [[b]] linked")).toEqual(["a", "b"]);
  });

  it("deduplicates repeated wikilinks", () => {
    expect(extractWikilinks("[[a]] duplicate [[a]]")).toEqual(["a"]);
  });

  it("returns empty array for no links", () => {
    expect(extractWikilinks("no links here")).toEqual([]);
  });

  it("ignores empty brackets", () => {
    expect(extractWikilinks("empty [[]] brackets")).toEqual([]);
  });

  it("trims whitespace inside brackets", () => {
    expect(extractWikilinks("  [[ spaced ]]  ")).toEqual(["spaced"]);
  });

  it("handles regex lastIndex correctly across calls", () => {
    const first = extractWikilinks("[[x]] and [[y]]");
    const second = extractWikilinks("[[z]]");
    expect(first).toEqual(["x", "y"]);
    expect(second).toEqual(["z"]);
  });
});

describe("traverseGraph", () => {
  it("traverses a linear chain", () => {
    const neighbors: Record<string, readonly string[]> = {
      A: ["B"],
      B: ["C"],
      C: [],
    };
    const result = traverseGraph("A", (id) => neighbors[id] ?? [], 2);
    expect(result).toEqual(new Set(["B", "C"]));
  });

  it("terminates on circular references", () => {
    const neighbors: Record<string, readonly string[]> = {
      A: ["B"],
      B: ["C"],
      C: ["A"],
    };
    const result = traverseGraph("A", (id) => neighbors[id] ?? [], 10);
    expect(result).toEqual(new Set(["B", "C"]));
  });

  it("respects depth limit", () => {
    const neighbors: Record<string, readonly string[]> = {
      A: ["B"],
      B: ["C"],
      C: [],
    };
    const result = traverseGraph("A", (id) => neighbors[id] ?? [], 1);
    expect(result).toEqual(new Set(["B"]));
  });

  it("returns empty set when no neighbors", () => {
    const result = traverseGraph("A", () => [], 5);
    expect(result).toEqual(new Set());
  });
});

/** Zero-vector embedding for test inserts. */
const zeroEmbedding = () => new Float32Array(384);

/** Row shape from memory_links table. */
type LinkRow = {
  readonly source_id: string;
  readonly target_id: string;
  readonly link_text: string;
  readonly created_at: string;
};

describe("MemoryStore graph integration", () => {
  let store: MemoryStore;
  let db: DatabaseType;

  beforeEach(() => {
    store = new MemoryStore(":memory:", { enabled: false, similarityThreshold: 0.85 });
    db = store.getDatabase();
  });

  afterEach(() => {
    store.close();
  });

  it("creates an edge when inserting memory with wikilink to existing memory", () => {
    // Insert target memory B first
    const memB = store.insert(
      { content: "I am memory B", source: "manual", skipDedup: true },
      zeroEmbedding(),
    );

    // Insert memory A linking to B
    store.insert(
      { content: `links to [[${memB.id}]]`, source: "manual", skipDedup: true },
      zeroEmbedding(),
    );

    const links = db.prepare("SELECT * FROM memory_links").all() as LinkRow[];
    expect(links).toHaveLength(1);
    expect(links[0].target_id).toBe(memB.id);
  });

  it("creates no edge for nonexistent target", () => {
    store.insert(
      { content: "links to [[nonexistent-id]]", source: "manual", skipDedup: true },
      zeroEmbedding(),
    );

    const links = db.prepare("SELECT * FROM memory_links").all() as LinkRow[];
    expect(links).toHaveLength(0);
  });

  it("creates multiple edges for multiple existing targets", () => {
    const memB = store.insert(
      { content: "B content", source: "manual", skipDedup: true },
      zeroEmbedding(),
    );
    const memC = store.insert(
      { content: "C content", source: "manual", skipDedup: true },
      zeroEmbedding(),
    );

    store.insert(
      { content: `links to [[${memB.id}]] and [[${memC.id}]]`, source: "manual", skipDedup: true },
      zeroEmbedding(),
    );

    // Filter to wikilink-created edges (auto:similar edges also created by eager auto-linker)
    const links = db.prepare("SELECT * FROM memory_links WHERE link_text != 'auto:similar'").all() as LinkRow[];
    expect(links).toHaveLength(2);
    const targetIds = links.map((l) => l.target_id).sort();
    expect(targetIds).toEqual([memB.id, memC.id].sort());
  });

  it("cascades edge deletion when target memory is deleted", () => {
    const memB = store.insert(
      { content: "B content", source: "manual", skipDedup: true },
      zeroEmbedding(),
    );
    store.insert(
      { content: `links to [[${memB.id}]]`, source: "manual", skipDedup: true },
      zeroEmbedding(),
    );

    // Verify edge exists
    let links = db.prepare("SELECT * FROM memory_links").all() as LinkRow[];
    expect(links).toHaveLength(1);

    // Delete target -- CASCADE should remove edges
    store.delete(memB.id);

    links = db.prepare("SELECT * FROM memory_links").all() as LinkRow[];
    expect(links).toHaveLength(0);
  });

  it("prevents duplicate edges via composite primary key", () => {
    const memB = store.insert(
      { content: "B content", source: "manual", skipDedup: true },
      zeroEmbedding(),
    );

    // Insert two memories with the same wikilink to B
    store.insert(
      { content: `first [[${memB.id}]]`, source: "manual", skipDedup: true },
      zeroEmbedding(),
    );
    store.insert(
      { content: `second [[${memB.id}]]`, source: "manual", skipDedup: true },
      zeroEmbedding(),
    );

    const links = db.prepare("SELECT * FROM memory_links WHERE target_id = ?").all(memB.id) as LinkRow[];
    // Two different sources linking to B = 2 edges (different source_ids)
    expect(links).toHaveLength(2);
  });
});

describe("getBacklinks and getForwardLinks", () => {
  let store: MemoryStore;
  let db: DatabaseType;

  beforeEach(() => {
    store = new MemoryStore(":memory:", { enabled: false, similarityThreshold: 0.85 });
    db = store.getDatabase();
  });

  afterEach(() => {
    store.close();
  });

  /** Insert a memory with a known ID directly into SQLite. */
  function insertWithKnownId(id: string, content: string): void {
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO memories (id, content, source, importance, access_count, tags, created_at, updated_at, accessed_at, tier)
       VALUES (?, ?, 'manual', 0.5, 0, '[]', ?, ?, ?, 'warm')`,
    ).run(id, content, now, now, now);
    db.prepare("INSERT INTO vec_memories (memory_id, embedding) VALUES (?, ?)").run(
      id,
      zeroEmbedding(),
    );
  }

  it("getBacklinks returns memories that link to a target", () => {
    // Insert target B with known ID
    insertWithKnownId("B-id", "I am memory B");

    // Insert memory A that links to B via store.insert (triggers edge creation)
    const memA = store.insert(
      { content: "A links to [[B-id]]", source: "manual", skipDedup: true },
      zeroEmbedding(),
    );

    const results = getBacklinks(store, "B-id");
    expect(results).toHaveLength(1);
    expect(results[0].memory.id).toBe(memA.id);
    expect(results[0].linkText).toBe("B-id");
  });

  it("getBacklinks returns empty array for nonexistent target", () => {
    const results = getBacklinks(store, "nonexistent");
    expect(results).toHaveLength(0);
  });

  it("getForwardLinks returns memories that a source links to", () => {
    // Insert targets B and C with known IDs
    insertWithKnownId("B-id", "I am B");
    insertWithKnownId("C-id", "I am C");

    // Insert A linking to both B and C
    store.insert(
      { content: "A links to [[B-id]] and [[C-id]]", source: "manual", skipDedup: true },
      zeroEmbedding(),
    );

    // Get forward links from A (need to find A's ID first)
    const links = db.prepare("SELECT source_id FROM memory_links LIMIT 1").get() as { source_id: string };
    const results = getForwardLinks(store, links.source_id);
    expect(results).toHaveLength(2);
    const targetIds = results.map((r) => r.memory.id).sort();
    expect(targetIds).toEqual(["B-id", "C-id"]);
  });

  it("getForwardLinks returns empty array for memory with no outbound links", () => {
    insertWithKnownId("isolated", "No outbound links here");
    const results = getForwardLinks(store, "isolated");
    expect(results).toHaveLength(0);
  });

  it("results are frozen", () => {
    insertWithKnownId("B-id", "target");
    store.insert(
      { content: "links to [[B-id]]", source: "manual", skipDedup: true },
      zeroEmbedding(),
    );

    const backlinks = getBacklinks(store, "B-id");
    expect(Object.isFrozen(backlinks)).toBe(true);
    expect(Object.isFrozen(backlinks[0])).toBe(true);

    const links = db.prepare("SELECT source_id FROM memory_links LIMIT 1").get() as { source_id: string };
    const forwards = getForwardLinks(store, links.source_id);
    expect(Object.isFrozen(forwards)).toBe(true);
    expect(Object.isFrozen(forwards[0])).toBe(true);
  });

  it("results are ordered by created_at DESC", () => {
    insertWithKnownId("target-id", "the target");

    // Insert two memories linking to target at different times
    // Use direct SQL to control created_at ordering
    const oldTime = "2024-01-01T00:00:00Z";
    const newTime = "2025-01-01T00:00:00Z";
    db.prepare(
      `INSERT INTO memories (id, content, source, importance, access_count, tags, created_at, updated_at, accessed_at, tier)
       VALUES (?, ?, 'manual', 0.5, 0, '[]', ?, ?, ?, 'warm')`,
    ).run("old-linker", "links to [[target-id]]", oldTime, oldTime, oldTime);
    db.prepare("INSERT INTO vec_memories (memory_id, embedding) VALUES (?, ?)").run("old-linker", zeroEmbedding());
    db.prepare("INSERT INTO memory_links (source_id, target_id, link_text, created_at) VALUES (?, ?, ?, ?)").run(
      "old-linker", "target-id", "target-id", oldTime,
    );

    db.prepare(
      `INSERT INTO memories (id, content, source, importance, access_count, tags, created_at, updated_at, accessed_at, tier)
       VALUES (?, ?, 'manual', 0.5, 0, '[]', ?, ?, ?, 'warm')`,
    ).run("new-linker", "also links to [[target-id]]", newTime, newTime, newTime);
    db.prepare("INSERT INTO vec_memories (memory_id, embedding) VALUES (?, ?)").run("new-linker", zeroEmbedding());
    db.prepare("INSERT INTO memory_links (source_id, target_id, link_text, created_at) VALUES (?, ?, ?, ?)").run(
      "new-linker", "target-id", "target-id", newTime,
    );

    const results = getBacklinks(store, "target-id");
    expect(results).toHaveLength(2);
    // DESC order: newest first
    expect(results[0].memory.id).toBe("new-linker");
    expect(results[1].memory.id).toBe("old-linker");
  });
});

/** Fake logger for TierManager tests. */
function fakeLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
    child: vi.fn().mockReturnThis(),
    level: "info",
  };
}

// ScoringConfig (src/memory/relevance.ts) is the 3-field shape used by
// TierManager. The previous 5-field literal here was a stale fixture from
// an earlier scoring API and no longer compiles against the current type.
const DEFAULT_SCORING: ScoringConfig = {
  semanticWeight: 0.7,
  decayWeight: 0.3,
  halfLifeDays: 30,
};

describe("edge lifecycle", () => {
  let store: MemoryStore;
  let db: DatabaseType;

  beforeEach(() => {
    store = new MemoryStore(":memory:", { enabled: false, similarityThreshold: 0.85 });
    db = store.getDatabase();
  });

  afterEach(() => {
    store.close();
  });

  /** Insert a memory with a known ID directly into SQLite. */
  function insertWithKnownId(id: string, content: string): void {
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO memories (id, content, source, importance, access_count, tags, created_at, updated_at, accessed_at, tier)
       VALUES (?, ?, 'manual', 0.5, 0, '[]', ?, ?, ?, 'warm')`,
    ).run(id, content, now, now, now);
    db.prepare("INSERT INTO vec_memories (memory_id, embedding) VALUES (?, ?)").run(
      id,
      zeroEmbedding(),
    );
  }

  it("cold archival removes edges via CASCADE (source deleted)", () => {
    insertWithKnownId("B-id", "target memory B");
    // Insert A linking to B
    const memA = store.insert(
      { content: "A links to [[B-id]]", source: "manual", skipDedup: true },
      zeroEmbedding(),
    );

    // Verify edge exists
    let links = db.prepare("SELECT * FROM memory_links WHERE source_id = ?").all(memA.id) as LinkRow[];
    expect(links).toHaveLength(1);

    // Delete source A
    store.delete(memA.id);

    links = db.prepare("SELECT * FROM memory_links WHERE source_id = ?").all(memA.id) as LinkRow[];
    expect(links).toHaveLength(0);
  });

  it("deleting target removes inbound edges via CASCADE", () => {
    insertWithKnownId("B-id", "target memory B");
    store.insert(
      { content: "A links to [[B-id]]", source: "manual", skipDedup: true },
      zeroEmbedding(),
    );

    // Verify edge exists
    let links = db.prepare("SELECT * FROM memory_links WHERE target_id = ?").all("B-id") as LinkRow[];
    expect(links).toHaveLength(1);

    // Delete target B
    store.delete("B-id");

    links = db.prepare("SELECT * FROM memory_links WHERE target_id = ?").all("B-id") as LinkRow[];
    expect(links).toHaveLength(0);
  });

  it("circular references: A->B->C->A terminates via traverseGraph", () => {
    // Insert A, B, C with known IDs and circular links
    insertWithKnownId("circ-A", "placeholder A");
    insertWithKnownId("circ-B", "placeholder B");
    insertWithKnownId("circ-C", "placeholder C");

    // Create edges manually: A->B, B->C, C->A
    const now = new Date().toISOString();
    db.prepare("INSERT INTO memory_links (source_id, target_id, link_text, created_at) VALUES (?, ?, ?, ?)").run(
      "circ-A", "circ-B", "circ-B", now,
    );
    db.prepare("INSERT INTO memory_links (source_id, target_id, link_text, created_at) VALUES (?, ?, ?, ?)").run(
      "circ-B", "circ-C", "circ-C", now,
    );
    db.prepare("INSERT INTO memory_links (source_id, target_id, link_text, created_at) VALUES (?, ?, ?, ?)").run(
      "circ-C", "circ-A", "circ-A", now,
    );

    // Traverse from A using forward links from memory_links
    const getNeighborsFn = (id: string): readonly string[] => {
      const rows = db.prepare("SELECT target_id FROM memory_links WHERE source_id = ?").all(id) as Array<{ target_id: string }>;
      return rows.map((r) => r.target_id);
    };

    const result = traverseGraph("circ-A", getNeighborsFn, 10);
    expect(result).toEqual(new Set(["circ-B", "circ-C"]));
  });

  it("rewarmFromCold restores graph edges from content wikilinks", async () => {
    const testDir = join(tmpdir(), `graph-rewarm-test-${Date.now()}`);
    const coldDir = join(testDir, "archive", "cold");
    mkdirSync(coldDir, { recursive: true });

    // Insert target memory so edge can be created
    insertWithKnownId("rewarm-target", "I am the target");

    // Create cold archive file with wikilink to target
    const archiveContent = "This memory links to [[rewarm-target]]";
    const frontmatter = {
      id: "rewarm-source",
      source: "manual",
      importance: 0.7,
      access_count: 3,
      tags: ["test"],
      created_at: "2024-06-01T00:00:00Z",
      updated_at: "2024-06-01T00:00:00Z",
      accessed_at: "2024-06-01T00:00:00Z",
      tier: "cold",
      archived_at: "2024-07-01T00:00:00Z",
      embedding_base64: embeddingToBase64(zeroEmbedding()),
    };
    const markdown = `---\n${yamlStringify(frontmatter)}---\n\n# Memory: ${archiveContent.slice(0, 80)}\n\n${archiveContent}\n`;
    const filePath = join(coldDir, "rewarm-source-test.md");
    writeFileSync(filePath, markdown, "utf-8");

    // Create mock embedder
    const mockEmbedder = {
      embed: vi.fn().mockResolvedValue(zeroEmbedding()),
      warmup: vi.fn().mockResolvedValue(undefined),
      isReady: vi.fn().mockReturnValue(true),
    };

    // Create TierManager and rewarm
    const tm = new TierManager({
      store,
      embedder: mockEmbedder as any,
      memoryDir: testDir,
      tierConfig: DEFAULT_TIER_CONFIG,
      scoringConfig: DEFAULT_SCORING,
      log: fakeLogger() as any,
    });

    await tm.rewarmFromCold(filePath);

    // Verify edge was created from rewarmed memory to target
    const links = db.prepare("SELECT * FROM memory_links WHERE source_id = ?").all("rewarm-source") as LinkRow[];
    expect(links).toHaveLength(1);
    expect(links[0].target_id).toBe("rewarm-target");

    // Cleanup
    rmSync(testDir, { recursive: true, force: true });
  });
});
