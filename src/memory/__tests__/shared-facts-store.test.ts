/**
 * Phase 999.131 — owner-scoped shared facts: save/refresh, owner isolation,
 * retrieval chunks.
 */

import { describe, it, expect, afterEach } from "vitest";
import { SharedFactsStore, ownerFactsAsChunks } from "../shared-facts-store.js";

function unit(index: number, lean: { index: number; weight: number } | null = null): Float32Array {
  const v = new Float32Array(384);
  v[index] = 1;
  if (lean) v[lean.index] = lean.weight;
  let norm = 0;
  for (let i = 0; i < 384; i++) norm += v[i]! * v[i]!;
  norm = Math.sqrt(norm);
  for (let i = 0; i < 384; i++) v[i] = v[i]! / norm;
  return v;
}

describe("SharedFactsStore", () => {
  let store: SharedFactsStore;
  afterEach(() => store?.close());

  it("inserts, refreshes a near-duplicate (same owner), and keeps owners apart", () => {
    store = new SharedFactsStore(":memory:");
    const a = store.save({ owner: "owner_a", content: "Operator prefers brief answers", tags: ["style"], sourceAgent: "shopping" }, unit(1));
    expect(a.action).toBe("inserted");
    const b = store.save(
      { owner: "owner_a", content: "Operator prefers brief answers.", tags: ["tone"], importance: 0.9, sourceAgent: "projects" },
      unit(1, { index: 2, weight: 0.1 }),
    );
    expect(b.action).toBe("refreshed");
    expect(b.fact.id).toBe(a.fact.id);
    expect(b.fact.content).toBe("Operator prefers brief answers.");
    expect([...b.fact.tags].sort()).toEqual(["style", "tone"]);
    expect(b.fact.importance).toBe(0.9);
    expect(b.fact.sourceAgent).toBe("projects");
    // Same vector, different owner → a separate fact, never a refresh.
    const c = store.save({ owner: "client_a", content: "Client A prefers brief answers", sourceAgent: "client-a-personal" }, unit(1));
    expect(c.action).toBe("inserted");
    expect(store.count("owner_a")).toBe(1);
    expect(store.count("client_a")).toBe(1);
  });

  it("search and list are owner-scoped; delete requires the owner", () => {
    store = new SharedFactsStore(":memory:");
    const owner_a = store.save({ owner: "owner_a", content: "Operator runs on Sundays", sourceAgent: "client-a-personal" }, unit(1)).fact;
    store.save({ owner: "client_a", content: "Client A swims on Sundays", sourceAgent: "client-a-personal" }, unit(1, { index: 3, weight: 0.05 }));
    store.save({ owner: "owner_a", content: "Operator dislikes em dashes", sourceAgent: "projects" }, unit(5));

    const hits = store.search("owner_a", unit(1), 3);
    expect(hits.map((h) => h.content)).toEqual(["Operator runs on Sundays", "Operator dislikes em dashes"]);
    expect(hits[0]!.similarity).toBeGreaterThan(0.99);
    expect(store.search("client_a", unit(1), 3).map((h) => h.content)).toEqual(["Client A swims on Sundays"]);
    expect(store.search("nobody", unit(1), 3)).toEqual([]);
    expect(store.list("owner_a").map((f) => f.content)).toEqual(["Operator dislikes em dashes", "Operator runs on Sundays"]);

    expect(store.delete(owner_a.id, "client_a")).toBe(false);
    expect(store.delete(owner_a.id, "owner_a")).toBe(true);
    expect(store.get(owner_a.id)).toBeNull();
    expect(store.search("owner_a", unit(1), 3).map((h) => h.content)).toEqual(["Operator dislikes em dashes"]);
  });

  it("ownerFactsAsChunks labels the facts for the memory context and drops weak matches", () => {
    store = new SharedFactsStore(":memory:");
    store.save({ owner: "owner_a", content: "Operator prefers brief answers", sourceAgent: "shopping" }, unit(1));
    store.save({ owner: "owner_a", content: "Unrelated", sourceAgent: "shopping" }, unit(7));
    const chunks = ownerFactsAsChunks(store, "owner_a", unit(1), 3);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({
      chunkId: expect.stringMatching(/^shared:/),
      path: "owner-facts",
      heading: "Owner fact (shared by shopping)",
      body: "Operator prefers brief answers",
      source: "chunk",
    });
    expect(chunks[0]!.createdAt).toBeDefined();
    expect(ownerFactsAsChunks(store, "client_a", unit(1), 3)).toEqual([]);
  });
});
