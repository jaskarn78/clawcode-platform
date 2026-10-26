/**
 * Memory overhaul 2026-10-25 (WP5) - `clawcode_memory_update` tool tests.
 *
 * Pins:
 *   - the correction is a NEW row; the old row is marked superseded by it
 *     and keeps its text; search and listing show only the correction
 *   - source, importance, tags and turn lineage carry over; tags can be
 *     replaced
 *   - the dedup probe is skipped (a near-identical third memory neither
 *     swallows the correction nor gets retired)
 *   - an already superseded / forgotten row, owner facts, memory-file
 *     sections, unknown ids and no-op updates are refused without writing
 *   - a row retired while the embedder was running is not double-superseded
 */

import { describe, it, expect, afterEach } from "vitest";
import { MemoryStore } from "../store.js";
import { clawcodeMemoryUpdate } from "../tools/clawcode-memory-update.js";

function unit(axis: number): Float32Array {
  const v = new Float32Array(384);
  v[axis] = 1;
  return v;
}

describe("clawcodeMemoryUpdate", () => {
  let store: MemoryStore;

  afterEach(() => {
    store?.close();
  });

  it("inserts the correction and marks the old row superseded by it", async () => {
    store = new MemoryStore(":memory:");
    const old = store.insert(
      {
        content: "quarterly review is on 2026-11-03",
        source: "conversation",
        importance: 0.8,
        tags: ["schedule"],
        sourceTurnIds: ["turn-1"],
      },
      unit(0),
    );

    const res = await clawcodeMemoryUpdate(
      { id: old.id, content: "quarterly review moved to 2026-11-10" },
      { store, agentName: "agent-A", embed: async () => unit(0) },
    );

    expect(res.ok).toBe(true);
    expect(res.supersedes).toBe(old.id);
    expect(res.id).toBeDefined();
    expect(res.id).not.toBe(old.id);

    const fresh = store.peekById(res.id!);
    expect(fresh?.content).toBe("quarterly review moved to 2026-11-10");
    expect(fresh?.source).toBe("conversation");
    expect(fresh?.importance).toBe(0.8);
    expect([...(fresh?.tags ?? [])]).toEqual(["schedule"]);
    expect(fresh?.sourceTurnIds).toEqual(["turn-1"]);
    expect(fresh?.createdAt).toBe(res.createdAt);

    const retired = store.peekById(old.id);
    expect(retired?.content).toBe("quarterly review is on 2026-11-03");
    expect(retired?.supersededBy).toBe(res.id);

    expect(store.listRecent(10).map((m) => m.id)).toEqual([res.id]);
    expect(store.searchMemoriesVec(unit(0), 5).map((r) => r.memory_id)).toEqual([res.id]);
  });

  it("replaces tags when given and skips the dedup probe", async () => {
    store = new MemoryStore(":memory:");
    const old = store.insert({ content: "wrong", source: "manual", tags: ["a"] }, unit(0));
    // A live bystander identical to the correction's vector.
    const bystander = store.insert({ content: "bystander", source: "manual", skipDedup: true }, unit(4));

    const res = await clawcodeMemoryUpdate(
      { id: old.id, content: "right", tags: ["b"] },
      { store, agentName: "a", embed: async () => unit(4) },
    );

    expect(res.ok).toBe(true);
    expect([...(store.peekById(res.id!)?.tags ?? [])]).toEqual(["b"]);
    expect(store.peekById(bystander.id)?.supersededBy).toBeUndefined();
    expect(store.peekById(old.id)?.supersededBy).toBe(res.id);
  });

  it("refuses an already superseded or forgotten row and points at the successor", async () => {
    store = new MemoryStore(":memory:");
    const v1 = store.insert({ content: "v1", source: "manual" }, unit(0));
    const first = await clawcodeMemoryUpdate(
      { id: v1.id, content: "v2" },
      { store, agentName: "a", embed: async () => unit(1) },
    );
    const again = await clawcodeMemoryUpdate(
      { id: v1.id, content: "v3" },
      { store, agentName: "a", embed: async () => unit(2) },
    );
    expect(again.ok).toBe(false);
    expect(again.error).toContain(first.id!);

    const gone = store.insert({ content: "gone", source: "manual" }, unit(5));
    store.forget(gone.id);
    const forgotten = await clawcodeMemoryUpdate(
      { id: gone.id, content: "back" },
      { store, agentName: "a", embed: async () => unit(6) },
    );
    expect(forgotten.ok).toBe(false);
    expect(forgotten.error).toMatch(/forgotten/);
    expect(store.listRecent(10).map((m) => m.content)).toEqual(["v2"]);
  });

  it("does not write when the row is retired while the embedder runs", async () => {
    store = new MemoryStore(":memory:");
    const m = store.insert({ content: "racy", source: "manual" }, unit(0));
    const res = await clawcodeMemoryUpdate(
      { id: m.id, content: "corrected" },
      {
        store,
        agentName: "a",
        embed: async () => {
          store.forget(m.id);
          return unit(1);
        },
      },
    );
    expect(res.ok).toBe(false);
    expect(store.listRecent(10, { includeSuperseded: true }).map((r) => r.content)).toEqual(["racy"]);
  });

  it("refuses owner facts, file sections, unknown ids and identical content", async () => {
    store = new MemoryStore(":memory:");
    const m = store.insert({ content: "same", source: "manual" }, unit(0));
    const chunkId = store.insertMemoryChunk({
      path: "memory/notes.md",
      chunkIndex: 0,
      heading: null,
      body: "file body",
      tokenCount: 2,
      scoreWeight: 0,
      fileMtimeMs: Date.now(),
      fileSha256: "y".repeat(64),
      embedding: unit(3),
    });
    const deps = { store, agentName: "a", embed: async () => unit(9) };

    expect((await clawcodeMemoryUpdate({ id: "shared:f1", content: "x" }, deps)).error).toMatch(/owner facts/);
    expect((await clawcodeMemoryUpdate({ id: chunkId, content: "x" }, deps)).error).toMatch(/memory file section/);
    expect((await clawcodeMemoryUpdate({ id: "missing", content: "x" }, deps)).error).toMatch(/not found/);
    expect((await clawcodeMemoryUpdate({ id: m.id, content: "same" }, deps)).error).toMatch(/identical/);
    expect(store.listRecent(10)).toHaveLength(1);
  });
});
