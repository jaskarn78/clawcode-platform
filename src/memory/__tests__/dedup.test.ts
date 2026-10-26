import { describe, it, expect, afterEach } from "vitest";
import { MemoryStore } from "../store.js";
import { checkForDuplicate, mergeMemory, DEDUP_EXCLUDED_TAGS } from "../dedup.js";
import type { DedupConfig, MergeInput } from "../dedup.js";
import { MemoryError } from "../errors.js";

function createTestStore(): MemoryStore {
  return new MemoryStore(":memory:");
}

/** Create a normalized random vector. */
function randomEmbedding(): Float32Array {
  const arr = new Float32Array(384);
  let norm = 0;
  for (let i = 0; i < 384; i++) {
    arr[i] = Math.random() * 2 - 1;
    norm += arr[i] * arr[i];
  }
  norm = Math.sqrt(norm);
  for (let i = 0; i < 384; i++) {
    arr[i] /= norm;
  }
  return arr;
}

/** Create a vector pointing in a specific direction (for predictable similarity). */
function directionalEmbedding(dim: number, value: number): Float32Array {
  const arr = new Float32Array(384);
  arr[dim] = value;
  const norm = Math.abs(value);
  if (norm > 0) {
    arr[dim] /= norm;
  }
  return arr;
}

const DEFAULT_CONFIG: DedupConfig = { similarityThreshold: 0.85 };

/** Unit vector whose cosine to `directionalEmbedding(0, 1)` is exactly `c`. */
function cosineTo0(c: number): Float32Array {
  const arr = new Float32Array(384);
  arr[0] = c;
  arr[1] = Math.sqrt(1 - c * c);
  return arr;
}

describe("checkForDuplicate", () => {
  let store: MemoryStore;

  afterEach(() => {
    store?.close();
  });

  it("returns insert when database has no memories", () => {
    store = createTestStore();
    const db = store.getDatabase();
    const embedding = directionalEmbedding(0, 1.0);

    const result = checkForDuplicate(embedding, db, DEFAULT_CONFIG);

    expect(result).toEqual({ action: "insert" });
  });

  it("returns duplicate when the nearest live memory is at or above 0.95 cosine (WP5)", () => {
    store = createTestStore();
    const db = store.getDatabase();

    // Insert an existing memory pointing in dimension 0
    const existingVec = directionalEmbedding(0, 1.0);
    const entry = store.insert(
      { content: "existing fact", source: "manual" },
      existingVec,
    );

    // Query with an identical vector: cosine ~1.0, inside the drop band.
    const queryVec = directionalEmbedding(0, 1.0);
    const result = checkForDuplicate(queryVec, db, DEFAULT_CONFIG);

    expect(result.action).toBe("duplicate");
    if (result.action === "duplicate") {
      expect(result.existingId).toBe(entry.id);
      expect(result.similarity).toBeGreaterThanOrEqual(0.95);
    }
  });

  it("returns supersede when the threshold <= cosine < 0.95 (WP5)", () => {
    store = createTestStore();
    const db = store.getDatabase();
    const entry = store.insert(
      { content: "deadline is March 3", source: "manual" },
      directionalEmbedding(0, 1.0),
    );

    const result = checkForDuplicate(cosineTo0(0.9), db, DEFAULT_CONFIG);

    expect(result.action).toBe("supersede");
    if (result.action === "supersede") {
      expect(result.existingId).toBe(entry.id);
      expect(result.similarity).toBeCloseTo(0.9, 3);
    }
  });

  it("ignores superseded rows and summary / flush / digest rows (WP5)", () => {
    store = createTestStore();
    const db = store.getDatabase();
    const retired = store.insert(
      { content: "old fact", source: "manual", skipDedup: true },
      directionalEmbedding(0, 1.0),
    );
    const successor = store.insert(
      { content: "unrelated", source: "manual", skipDedup: true },
      directionalEmbedding(5, 1.0),
    );
    expect(store.supersede(retired.id, successor.id)).toBe(true);
    expect(DEDUP_EXCLUDED_TAGS).toEqual([
      "session-summary",
      "mid-session",
      "raw-fallback",
      "weekly-digest",
      "monthly-digest",
    ]);
    for (const tag of DEDUP_EXCLUDED_TAGS) {
      store.insert(
        { content: `summary ${tag}`, source: "conversation", tags: [tag], skipDedup: true },
        directionalEmbedding(0, 1.0),
      );
    }

    expect(checkForDuplicate(directionalEmbedding(0, 1.0), db, DEFAULT_CONFIG)).toEqual({
      action: "insert",
    });
  });

  it("a threshold above 0.95 drops only at or above that threshold and has no supersede band (WP5)", () => {
    store = createTestStore();
    const db = store.getDatabase();
    store.insert({ content: "fact", source: "manual" }, directionalEmbedding(0, 1.0));

    const strict: DedupConfig = { similarityThreshold: 0.97 };
    expect(checkForDuplicate(cosineTo0(0.96), db, strict)).toEqual({ action: "insert" });
    expect(checkForDuplicate(cosineTo0(0.98), db, strict).action).toBe("duplicate");
  });

  it("returns insert when existing memory has similarity below threshold", () => {
    store = createTestStore();
    const db = store.getDatabase();

    // Insert memory pointing in dimension 0
    store.insert(
      { content: "some fact", source: "manual" },
      directionalEmbedding(0, 1.0),
    );

    // Query with orthogonal vector (dimension 1) -> similarity ~0
    const queryVec = directionalEmbedding(1, 1.0);
    const result = checkForDuplicate(queryVec, db, DEFAULT_CONFIG);

    expect(result).toEqual({ action: "insert" });
  });
});

describe("mergeMemory", () => {
  let store: MemoryStore;

  afterEach(() => {
    store?.close();
  });

  it("updates content to new value", () => {
    store = createTestStore();
    const db = store.getDatabase();

    const entry = store.insert(
      { content: "old content", source: "manual", importance: 0.5, tags: ["a"] },
      directionalEmbedding(0, 1.0),
    );

    const mergeInput: MergeInput = {
      content: "new content",
      importance: 0.3,
      tags: ["b"],
      embedding: directionalEmbedding(1, 1.0),
    };

    mergeMemory(db, entry.id, mergeInput);

    const row = db
      .prepare("SELECT content FROM memories WHERE id = ?")
      .get(entry.id) as { content: string };
    expect(row.content).toBe("new content");
  });

  it("keeps Math.max of existing and new importance", () => {
    store = createTestStore();
    const db = store.getDatabase();

    const entry = store.insert(
      { content: "fact", source: "manual", importance: 0.8 },
      directionalEmbedding(0, 1.0),
    );

    const mergeInput: MergeInput = {
      content: "updated fact",
      importance: 0.5,
      tags: [],
      embedding: directionalEmbedding(0, 1.0),
    };

    mergeMemory(db, entry.id, mergeInput);

    const row = db
      .prepare("SELECT importance FROM memories WHERE id = ?")
      .get(entry.id) as { importance: number };
    expect(row.importance).toBe(0.8);
  });

  it("unions tags from both entries without duplicates", () => {
    store = createTestStore();
    const db = store.getDatabase();

    const entry = store.insert(
      { content: "fact", source: "manual", tags: ["a", "b"] },
      directionalEmbedding(0, 1.0),
    );

    const mergeInput: MergeInput = {
      content: "updated fact",
      importance: 0.5,
      tags: ["b", "c"],
      embedding: directionalEmbedding(0, 1.0),
    };

    mergeMemory(db, entry.id, mergeInput);

    const row = db
      .prepare("SELECT tags FROM memories WHERE id = ?")
      .get(entry.id) as { tags: string };
    const tags = JSON.parse(row.tags) as string[];
    expect(tags.sort()).toEqual(["a", "b", "c"]);
  });

  it("increments access_count", () => {
    store = createTestStore();
    const db = store.getDatabase();

    const entry = store.insert(
      { content: "fact", source: "manual" },
      directionalEmbedding(0, 1.0),
    );

    const mergeInput: MergeInput = {
      content: "updated fact",
      importance: 0.5,
      tags: [],
      embedding: directionalEmbedding(0, 1.0),
    };

    mergeMemory(db, entry.id, mergeInput);

    const row = db
      .prepare("SELECT access_count FROM memories WHERE id = ?")
      .get(entry.id) as { access_count: number };
    expect(row.access_count).toBe(1);
  });

  it("updates accessed_at and updated_at timestamps", () => {
    store = createTestStore();
    const db = store.getDatabase();

    const entry = store.insert(
      { content: "fact", source: "manual" },
      directionalEmbedding(0, 1.0),
    );

    const mergeInput: MergeInput = {
      content: "updated fact",
      importance: 0.5,
      tags: [],
      embedding: directionalEmbedding(0, 1.0),
    };

    mergeMemory(db, entry.id, mergeInput);

    const row = db
      .prepare("SELECT updated_at, accessed_at FROM memories WHERE id = ?")
      .get(entry.id) as { updated_at: string; accessed_at: string };
    expect(row.updated_at >= entry.updatedAt).toBe(true);
    expect(row.accessed_at >= entry.accessedAt).toBe(true);
  });

  it("replaces embedding in vec_memories", () => {
    store = createTestStore();
    const db = store.getDatabase();

    // Insert with embedding pointing in dim 0
    const entry = store.insert(
      { content: "fact", source: "manual" },
      directionalEmbedding(0, 1.0),
    );

    // Merge with embedding pointing in dim 1
    const newEmbedding = directionalEmbedding(1, 1.0);
    const mergeInput: MergeInput = {
      content: "updated fact",
      importance: 0.5,
      tags: [],
      embedding: newEmbedding,
    };

    mergeMemory(db, entry.id, mergeInput);

    // Search with dim 1 vector should find our entry as nearest
    const searchResult = db
      .prepare(
        "SELECT memory_id, distance FROM vec_memories WHERE embedding MATCH ? AND k = 1",
      )
      .get(directionalEmbedding(1, 1.0)) as { memory_id: string; distance: number };
    expect(searchResult.memory_id).toBe(entry.id);
    expect(searchResult.distance).toBeCloseTo(0, 1); // distance ~0 means very similar
  });

  it("throws MemoryError for non-existent ID", () => {
    store = createTestStore();
    const db = store.getDatabase();

    const mergeInput: MergeInput = {
      content: "content",
      importance: 0.5,
      tags: [],
      embedding: directionalEmbedding(0, 1.0),
    };

    expect(() => mergeMemory(db, "nonexistent-id", mergeInput)).toThrow(
      MemoryError,
    );
  });
});
