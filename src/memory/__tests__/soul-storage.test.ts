import { describe, it, expect, afterEach, vi, beforeEach } from "vitest";
import { MemoryStore } from "../store.js";

function createTestStore(): MemoryStore {
  return new MemoryStore(":memory:");
}

function randomEmbedding(): Float32Array {
  const arr = new Float32Array(384);
  for (let i = 0; i < 384; i++) {
    arr[i] = Math.random() * 2 - 1;
  }
  return arr;
}

describe("MemoryStore.findByTag", () => {
  let store: MemoryStore;

  afterEach(() => {
    store?.close();
  });

  it("returns entries matching the given tag", () => {
    store = createTestStore();
    const embedding = randomEmbedding();

    store.insert(
      { content: "Soul content here", source: "system", importance: 1.0, tags: ["soul", "identity"], skipDedup: true },
      embedding,
    );
    store.insert(
      { content: "Regular memory", source: "conversation", importance: 0.5, tags: ["general"] },
      randomEmbedding(),
    );

    const results = store.findByTag("soul");
    expect(results).toHaveLength(1);
    expect(results[0].content).toBe("Soul content here");
    expect(results[0].tags).toContain("soul");
    expect(results[0].tags).toContain("identity");
  });

  it("returns empty array when no entries match the tag", () => {
    store = createTestStore();
    store.insert(
      { content: "Some memory", source: "conversation", importance: 0.5, tags: ["general"] },
      randomEmbedding(),
    );

    const results = store.findByTag("nonexistent");
    expect(results).toHaveLength(0);
  });

  it("returns frozen array of frozen entries", () => {
    store = createTestStore();
    store.insert(
      { content: "Soul content", source: "system", importance: 1.0, tags: ["soul"], skipDedup: true },
      randomEmbedding(),
    );

    const results = store.findByTag("soul");
    expect(Object.isFrozen(results)).toBe(true);
    expect(Object.isFrozen(results[0])).toBe(true);
  });

  it("returns multiple entries when several match the same tag", () => {
    store = createTestStore();
    store.insert(
      { content: "First soul entry", source: "system", importance: 1.0, tags: ["soul"], skipDedup: true },
      randomEmbedding(),
    );
    store.insert(
      { content: "Second soul entry", source: "system", importance: 0.9, tags: ["soul"], skipDedup: true },
      randomEmbedding(),
    );

    const results = store.findByTag("soul");
    expect(results).toHaveLength(2);
  });
});

describe("SOUL.md storage idempotency", () => {
  let store: MemoryStore;

  afterEach(() => {
    store?.close();
  });

  it("does not insert duplicate when soul tag entry already exists", () => {
    store = createTestStore();
    const embedding = randomEmbedding();

    // First insert
    store.insert(
      { content: "Full SOUL.md content", source: "system", importance: 1.0, tags: ["soul", "identity"], skipDedup: true },
      embedding,
    );

    // Simulate idempotency check
    const existing = store.findByTag("soul");
    expect(existing).toHaveLength(1);

    // If existing.length > 0, skip insert (this is the logic in session-memory)
    if (existing.length === 0) {
      store.insert(
        { content: "Full SOUL.md content", source: "system", importance: 1.0, tags: ["soul", "identity"], skipDedup: true },
        randomEmbedding(),
      );
    }

    // Verify still only one entry
    const afterCheck = store.findByTag("soul");
    expect(afterCheck).toHaveLength(1);
  });
});
