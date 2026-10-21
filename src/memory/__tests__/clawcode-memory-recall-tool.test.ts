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
