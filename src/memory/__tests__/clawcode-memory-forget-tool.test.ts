/**
 * Memory overhaul 2026-10-25 (WP5) - `clawcode_memory_forget` tool tests.
 *
 * Pins:
 *   - a live saved memory is marked superseded_by = "forgotten" with a
 *     timestamp, keeps its row, and disappears from search paths
 *   - a second forget reports "already-superseded" (no re-stamp)
 *   - shared:<id>, memory-file chunk ids and unknown ids are refused
 *   - the reason is logged with the agent name from deps
 *   - schema requires both id and reason
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import { MemoryStore } from "../store.js";
import { clawcodeMemoryForget, FORGET_INPUT_SCHEMA } from "../tools/clawcode-memory-forget.js";
import { FORGOTTEN_MARKER } from "../types.js";

function unit(axis: number): Float32Array {
  const v = new Float32Array(384);
  v[axis] = 1;
  return v;
}

describe("clawcodeMemoryForget", () => {
  let store: MemoryStore;

  afterEach(() => {
    store?.close();
  });

  it("schema requires a non-empty id and reason", () => {
    expect(FORGET_INPUT_SCHEMA.safeParse({ id: "x" }).success).toBe(false);
    expect(FORGET_INPUT_SCHEMA.safeParse({ id: "", reason: "r" }).success).toBe(false);
    expect(FORGET_INPUT_SCHEMA.safeParse({ id: "x", reason: "r" }).success).toBe(true);
  });

  it("retires a live memory without deleting it and hides it from search", async () => {
    store = new MemoryStore(":memory:");
    const m = store.insert({ content: "office moved to Denver", source: "manual" }, unit(0));
    const info = vi.fn();

    const res = await clawcodeMemoryForget(
      { id: m.id, reason: "the move was cancelled" },
      { store, agentName: "agent-A", log: { info } },
    );

    expect(res.ok).toBe(true);
    expect(res.status).toBe("forgotten");
    expect(res.supersededBy).toBe(FORGOTTEN_MARKER);
    expect(typeof res.supersededAt).toBe("string");
    const row = store.peekById(m.id);
    expect(row?.content).toBe("office moved to Denver");
    expect(row?.supersededBy).toBe(FORGOTTEN_MARKER);
    expect(row?.supersededAt).toBe(res.supersededAt);
    expect(store.listRecent(10)).toEqual([]);
    expect(store.searchMemoriesVec(unit(0), 5)).toEqual([]);
    expect(store.searchMemoriesFts("Denver", 5)).toEqual([]);
    expect(info).toHaveBeenCalledWith(
      expect.objectContaining({ agent: "agent-A", memoryId: m.id, reason: "the move was cancelled" }),
      expect.any(String),
    );
  });

  it("a second forget reports already-superseded and keeps the first timestamp", async () => {
    store = new MemoryStore(":memory:");
    const m = store.insert({ content: "temp", source: "manual" }, unit(0));
    const first = await clawcodeMemoryForget({ id: m.id, reason: "r1" }, { store, agentName: "a" });
    const second = await clawcodeMemoryForget({ id: m.id, reason: "r2" }, { store, agentName: "a" });
    expect(second.ok).toBe(true);
    expect(second.status).toBe("already-superseded");
    expect(second.supersededBy).toBe(FORGOTTEN_MARKER);
    expect(second.supersededAt).toBe(first.supersededAt);
  });

  it("refuses owner facts, memory-file sections and unknown ids", async () => {
    store = new MemoryStore(":memory:");
    const chunkId = store.insertMemoryChunk({
      path: "memory/2026-10-20.md",
      chunkIndex: 0,
      heading: "Notes",
      body: "a daily note",
      tokenCount: 3,
      scoreWeight: 0,
      fileMtimeMs: Date.now(),
      fileSha256: "x".repeat(64),
      embedding: unit(1),
    });

    const shared = await clawcodeMemoryForget({ id: "shared:abc", reason: "r" }, { store, agentName: "a" });
    expect(shared.ok).toBe(false);
    expect(shared.error).toMatch(/owner facts/);

    const chunk = await clawcodeMemoryForget({ id: chunkId, reason: "r" }, { store, agentName: "a" });
    expect(chunk.ok).toBe(false);
    expect(chunk.error).toMatch(/memory file section/);

    const missing = await clawcodeMemoryForget({ id: "nope", reason: "r" }, { store, agentName: "a" });
    expect(missing.ok).toBe(false);
    expect(missing.error).toMatch(/not found/);
  });
});
