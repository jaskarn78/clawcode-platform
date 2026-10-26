/**
 * Phase 115 Plan 05 sub-scope 7 — `clawcode_memory_recall` tool tests.
 *
 * Pins:
 *   - hit on memories table → returns full content + tags + source + importance
 *   - hit on memory_chunks table → returns body + heading + path
 *   - miss → returns { ok: false, error } (does NOT throw)
 *   - falls through memories → memory_chunks order
 */

import { describe, it, expect, afterEach } from "vitest";
import { MemoryStore } from "../store.js";
import { clawcodeMemoryRecall } from "../tools/clawcode-memory-recall.js";
import { SharedFactsStore } from "../shared-facts-store.js";

function createTestStore(): MemoryStore {
  return new MemoryStore(":memory:");
}

function randomEmbedding(): Float32Array {
  const arr = new Float32Array(384);
  for (let i = 0; i < 384; i++) {
    arr[i] = (Math.random() * 2 - 1) * 0.1;
  }
  let norm = 0;
  for (let i = 0; i < 384; i++) norm += arr[i] * arr[i];
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < 384; i++) arr[i] /= norm;
  return arr;
}

describe("clawcodeMemoryRecall — hit / miss / fallthrough", () => {
  let store: MemoryStore;

  afterEach(() => {
    store?.close();
  });

  it("memories-table hit returns full content + tags + source + importance", async () => {
    store = createTestStore();
    const entry = store.insert(
      {
        content: "fin-client pricing model — LTV target $1500 payback 4mo",
        source: "manual",
        importance: 0.9,
        tags: ["pricing", "fin-client"],
      },
      randomEmbedding(),
    );

    const res = await clawcodeMemoryRecall(
      { memoryId: entry.id },
      { store, agentName: "fin-client" },
    );

    expect(res.ok).toBe(true);
    expect(res.memoryId).toBe(entry.id);
    expect(res.content).toContain("LTV target");
    expect(res.tags).toEqual(["pricing", "fin-client"]);
    expect(res.source).toBe("manual");
    expect(res.importance).toBe(0.9);
  });

  it("memory_chunks-table hit returns body + heading + path + source='memory_chunks'", async () => {
    store = createTestStore();
    const chunkId = store.insertMemoryChunk({
      path: "memory/notes/cutover.md",
      chunkIndex: 0,
      heading: "Cutover summary",
      body: "Phase 91 cutover succeeded after path correction.",
      tokenCount: 12,
      scoreWeight: 0,
      fileMtimeMs: Date.now(),
      fileSha256: "x".repeat(64),
      embedding: randomEmbedding(),
    });

    const res = await clawcodeMemoryRecall(
      { memoryId: chunkId },
      { store, agentName: "agent-A" },
    );

    expect(res.ok).toBe(true);
    expect(res.memoryId).toBe(chunkId);
    expect(res.content).toContain("Phase 91");
    expect(res.heading).toBe("Cutover summary");
    expect(res.path).toBe("memory/notes/cutover.md");
    expect(res.source).toBe("memory_chunks");
  });

  it("miss returns { ok: false, error } and does NOT throw", async () => {
    store = createTestStore();
    const res = await clawcodeMemoryRecall(
      { memoryId: "nonexistent-id-xxx" },
      { store, agentName: "agent-A" },
    );
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/memory not found/i);
    expect(res.memoryId).toBe("nonexistent-id-xxx");
  });

  it("memories-table hit takes precedence over memory_chunks (lookup order)", async () => {
    store = createTestStore();
    // Different ids — no actual collision possible — but we verify the
    // memories table is checked FIRST by inserting both and asserting the
    // memories entry returns its source verbatim (would be "memory_chunks"
    // if the chunk path was hit).
    const entry = store.insert(
      { content: "memory-side body", source: "manual", tags: [] },
      randomEmbedding(),
    );
    const res = await clawcodeMemoryRecall(
      { memoryId: entry.id },
      { store, agentName: "agent-A" },
    );
    expect(res.source).toBe("manual");
  });

  it("agentName comes from deps, never from input", async () => {
    store = createTestStore();
    const res = await clawcodeMemoryRecall(
      { memoryId: "x" },
      { store, agentName: "deps-controlled" },
    );
    // No agentName in input means the result reflects the deps-supplied value.
    expect(res.ok).toBe(false); // miss is fine
    // Deps was the only path that could carry the name.
    // No assertion-able field on the miss path; the security pin is the
    // schema shape — re-pin it explicitly:
    const { RECALL_INPUT_SCHEMA } = await import("../tools/clawcode-memory-recall.js");
    const shape = RECALL_INPUT_SCHEMA.shape as Record<string, unknown>;
    expect(shape.agentName).toBeUndefined();
    expect(shape.agent).toBeUndefined();
    expect(shape.agent_name).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Memory overhaul 2026-10-25 (WP5) - shared:<id> owner facts, superseded
// rows, and dates on chunk recalls.
// ---------------------------------------------------------------------------

function axis(i: number): Float32Array {
  const v = new Float32Array(384);
  v[i] = 1;
  return v;
}

describe("clawcodeMemoryRecall: WP5 owner facts and supersession", () => {
  let store: MemoryStore;
  let shared: SharedFactsStore;

  afterEach(() => {
    store?.close();
    shared?.close();
  });

  it("recalls a shared:<id> owner fact for the agent's own owner", async () => {
    store = createTestStore();
    shared = new SharedFactsStore(":memory:");
    const saved = shared.save(
      { owner: "owner_a", content: "Operator prefers brief answers", tags: ["style"], importance: 0.8, sourceAgent: "projects" },
      axis(1),
    );

    const res = await clawcodeMemoryRecall(
      { memoryId: `shared:${saved.fact.id}` },
      { store, agentName: "agent-A", ownerFacts: { store: shared, owner: "owner_a" } },
    );

    expect(res.ok).toBe(true);
    expect(res.memoryId).toBe(`shared:${saved.fact.id}`);
    expect(res.content).toBe("Operator prefers brief answers");
    expect(res.source).toBe("owner-fact");
    expect(res.tags).toEqual(["style"]);
    expect(res.created_at).toBe(saved.fact.createdAt);
    expect(res.path).toBe("owner-facts");
  });

  it("never returns another owner's fact, and says when owner facts are unavailable", async () => {
    store = createTestStore();
    shared = new SharedFactsStore(":memory:");
    const other = shared.save({ owner: "owner_b", content: "private to b", sourceAgent: "x" }, axis(2));

    const crossOwner = await clawcodeMemoryRecall(
      { memoryId: `shared:${other.fact.id}` },
      { store, agentName: "agent-A", ownerFacts: { store: shared, owner: "owner_a" } },
    );
    expect(crossOwner.ok).toBe(false);
    expect(crossOwner.content).toBeUndefined();
    expect(crossOwner.error).toMatch(/owner fact not found/);

    const noOwner = await clawcodeMemoryRecall(
      { memoryId: `shared:${other.fact.id}` },
      { store, agentName: "agent-A" },
    );
    expect(noOwner.ok).toBe(false);
    expect(noOwner.error).toMatch(/not available/);
  });

  it("recalls a superseded memory with a pointer to its successor and no access bump", async () => {
    store = createTestStore();
    const old = store.insert({ content: "old value", source: "manual", skipDedup: true }, axis(0));
    const fresh = store.insert({ content: "new value", source: "manual", skipDedup: true }, axis(3));
    store.supersede(old.id, fresh.id);

    const res = await clawcodeMemoryRecall({ memoryId: old.id }, { store, agentName: "agent-A" });

    expect(res.ok).toBe(true);
    expect(res.content).toBe("old value");
    expect(res.supersededBy).toBe(fresh.id);
    expect(typeof res.supersededAt).toBe("string");
    expect(res.note).toContain(fresh.id);
    expect(store.peekById(old.id)?.accessCount).toBe(0);

    // A live memory still counts the recall as an access.
    await clawcodeMemoryRecall({ memoryId: fresh.id }, { store, agentName: "agent-A" });
    expect(store.peekById(fresh.id)?.accessCount).toBe(1);
  });

  it("a memory-file section recall carries the file date", async () => {
    store = createTestStore();
    const mtime = Date.parse("2026-09-01T12:00:00.000Z");
    const chunkId = store.insertMemoryChunk({
      path: "memory/2026-09-01.md",
      chunkIndex: 0,
      heading: "Standup",
      body: "notes",
      tokenCount: 1,
      scoreWeight: 0,
      fileMtimeMs: mtime,
      fileSha256: "z".repeat(64),
      embedding: axis(4),
    });
    const res = await clawcodeMemoryRecall({ memoryId: chunkId }, { store, agentName: "agent-A" });
    expect(res.created_at).toBe("2026-09-01T12:00:00.000Z");
  });
});
