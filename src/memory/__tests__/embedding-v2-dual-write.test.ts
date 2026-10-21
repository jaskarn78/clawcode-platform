import { describe, it, expect, vi } from "vitest";
import type { Logger } from "pino";

import { MemoryStore } from "../store.js";
import { EmbeddingV2Migrator } from "../migrations/embedding-v2.js";
import type { EmbeddingService } from "../embedder.js";
import {
  dualWriteMemoryV2,
  dualWriteChunkV2,
  shouldDualWriteV2,
  readMigrationPhase,
} from "../embedding-v2-dual-write.js";

const silent = {
  warn: () => undefined,
  info: () => undefined,
  error: () => undefined,
  debug: () => undefined,
} as unknown as Logger;

const v1 = () => new Float32Array(384);
const AGENT = "test-agent";

function fakeEmbedder(
  embedV2: () => Promise<Int8Array> = async () => new Int8Array(384),
): EmbeddingService {
  return { embedV2 } as unknown as EmbeddingService;
}

function freshStore(): MemoryStore {
  return new MemoryStore(":memory:");
}

function setPhase(
  store: MemoryStore,
  phase: "dual-write" | "re-embedding" | "re-embed-complete" | "cutover",
): void {
  const m = new EmbeddingV2Migrator(store.getDatabase(), AGENT);
  // Walk the legal transition path from idle to the target phase.
  const path: string[] = [];
  if (phase === "dual-write") path.push("dual-write");
  else if (phase === "re-embedding") path.push("dual-write", "re-embedding");
  else if (phase === "re-embed-complete")
    path.push("dual-write", "re-embedding", "re-embed-complete");
  else path.push("dual-write", "re-embedding", "re-embed-complete", "cutover");
  for (const p of path) m.transition(p as never);
}

function missingV2Ids(store: MemoryStore): string[] {
  return store.listMemoriesMissingV2Embedding(100, null).map((r) => r.id);
}

describe("MemoryStore embedding-v2 hook seam (Phase 141)", () => {
  it("fires the embedding-v2 hook on a NEW insert with (id, content)", () => {
    const store = freshStore();
    const hook = vi.fn();
    store.setEmbeddingV2Hook(hook);
    const entry = store.insert(
      { content: "remember the canary", source: "conversation" },
      v1(),
    );
    expect(hook).toHaveBeenCalledTimes(1);
    expect(hook).toHaveBeenCalledWith(entry.id, "remember the canary");
  });

  it("does NOT fire the hook when the caller already supplied a v2 embedding", () => {
    const store = freshStore();
    const hook = vi.fn();
    store.setEmbeddingV2Hook(hook);
    store.insert({ content: "x", source: "conversation" }, v1(), {
      embeddingV2: new Int8Array(384),
    });
    expect(hook).not.toHaveBeenCalled();
  });

  it("does NOT fire the hook on an idempotent origin_id skip", () => {
    const store = freshStore();
    const hook = vi.fn();
    store.setEmbeddingV2Hook(hook);
    store.insert({ content: "a", source: "conversation", origin_id: "o1" }, v1());
    hook.mockClear();
    // second insert with the same origin_id → INSERT OR IGNORE → not inserted
    store.insert({ content: "a", source: "conversation", origin_id: "o1" }, v1());
    expect(hook).not.toHaveBeenCalled();
  });

  it("fires the chunk hook on insertMemoryChunk with (chunkId, body)", () => {
    const store = freshStore();
    const hook = vi.fn();
    store.setChunkEmbeddingV2Hook(hook);
    const chunkId = store.insertMemoryChunk({
      path: "/m/notes.md",
      chunkIndex: 0,
      heading: "H",
      body: "chunk body text",
      tokenCount: 3,
      scoreWeight: 1,
      fileMtimeMs: 1,
      fileSha256: "sha",
      embedding: v1(),
    });
    expect(hook).toHaveBeenCalledWith(chunkId, "chunk body text");
  });
});

describe("embedding-v2 dual-write (Phase 141)", () => {
  it("shouldDualWriteV2 gates on the active migration phase", () => {
    const store = freshStore();
    expect(readMigrationPhase({ store, agent: AGENT })).toBe("idle");
    expect(shouldDualWriteV2({ store, agent: AGENT })).toBe(false); // idle
    setPhase(store, "dual-write");
    expect(shouldDualWriteV2({ store, agent: AGENT })).toBe(true);

    const store2 = freshStore();
    setPhase(store2, "re-embedding");
    expect(shouldDualWriteV2({ store: store2, agent: AGENT })).toBe(true);

    // Phase 999.119 v2 switch — a v2-reading agent keeps dual-writing so
    // its new memories are searchable the moment they land.
    const store3 = freshStore();
    setPhase(store3, "cutover");
    expect(shouldDualWriteV2({ store: store3, agent: AGENT })).toBe(true);

    const store4 = freshStore();
    new EmbeddingV2Migrator(store4.getDatabase(), AGENT).transition("rolled-back");
    expect(shouldDualWriteV2({ store: store4, agent: AGENT })).toBe(false);
  });

  it("writes the v2 vector for a new memory when the migration is active", async () => {
    const store = freshStore();
    setPhase(store, "dual-write");
    const entry = store.insert({ content: "hello", source: "conversation" }, v1());
    expect(missingV2Ids(store)).toContain(entry.id); // no v2 yet
    await dualWriteMemoryV2(
      { store, embedder: fakeEmbedder(), agent: AGENT, log: silent },
      entry.id,
      "hello",
    );
    expect(missingV2Ids(store)).not.toContain(entry.id); // v2 written
  });

  it("does NOT write v2 when the migration is idle", async () => {
    const store = freshStore();
    const entry = store.insert({ content: "hi", source: "conversation" }, v1());
    await dualWriteMemoryV2(
      { store, embedder: fakeEmbedder(), agent: AGENT, log: silent },
      entry.id,
      "hi",
    );
    expect(missingV2Ids(store)).toContain(entry.id); // still no v2 (idle)
  });

  it("is BEST-EFFORT — an embedV2 failure is swallowed and never throws", async () => {
    const store = freshStore();
    setPhase(store, "dual-write");
    const entry = store.insert({ content: "boom", source: "conversation" }, v1());
    const throwing = fakeEmbedder(async () => {
      throw new Error("model warmup failed");
    });
    await expect(
      dualWriteMemoryV2(
        { store, embedder: throwing, agent: AGENT, log: silent },
        entry.id,
        "boom",
      ),
    ).resolves.toBeUndefined();
    expect(missingV2Ids(store)).toContain(entry.id); // v1 intact, v2 absent
  });

  it("WIRED SEAM: store.insert → fire-and-forget hook → v2 row lands (as AgentMemoryManager wires it)", async () => {
    const store = freshStore();
    setPhase(store, "dual-write");
    // Wire EXACTLY as src/manager/session-memory.ts does (the production seam).
    const deps = { store, embedder: fakeEmbedder(), agent: AGENT, log: silent };
    store.setEmbeddingV2Hook((id, content) => {
      void dualWriteMemoryV2(deps, id, content);
    });
    const entry = store.insert(
      { content: "wired path", source: "conversation" },
      v1(),
    );
    // The hook is fire-and-forget (void async) — poll a few microtask ticks for
    // the v2 row to land. This is the actual end-to-end path prod runs.
    for (
      let i = 0;
      i < 25 && missingV2Ids(store).includes(entry.id);
      i++
    ) {
      await new Promise((r) => setImmediate(r));
    }
    expect(missingV2Ids(store)).not.toContain(entry.id);
  });

  it("dualWriteChunkV2 writes a chunk v2 when active (smoke)", async () => {
    const store = freshStore();
    setPhase(store, "dual-write");
    const chunkId = store.insertMemoryChunk({
      path: "/m/n.md",
      chunkIndex: 0,
      heading: null,
      body: "body",
      tokenCount: 1,
      scoreWeight: 1,
      fileMtimeMs: 1,
      fileSha256: "s",
      embedding: v1(),
    });
    await expect(
      dualWriteChunkV2(
        { store, embedder: fakeEmbedder(), agent: AGENT, log: silent },
        chunkId,
        "body",
      ),
    ).resolves.toBeUndefined();
  });
});

describe("embedding-v2 dual-write — use-after-close guard (db-not-open)", () => {
  it("isOpen() reflects the connection state", () => {
    const store = freshStore();
    expect(store.isOpen()).toBe(true);
    store.close();
    expect(store.isOpen()).toBe(false);
  });

  it("skips SILENTLY when a concurrent stop closed the store — no throw, no best-effort-failed log", async () => {
    const store = freshStore();
    setPhase(store, "dual-write"); // would otherwise dual-write
    const entry = store.insert(
      { content: "remember the canary", source: "conversation" },
      v1(),
    );
    const warn = vi.fn();
    const log = {
      warn,
      info: () => undefined,
      error: () => undefined,
      debug: () => undefined,
    } as unknown as Logger;
    // The embedder must NOT be reached once the store is closed (the guard
    // short-circuits before shouldDualWriteV2's query AND before embedV2).
    const embedV2 = vi.fn(async () => new Int8Array(384));
    const deps = {
      store,
      embedder: { embedV2 } as unknown as EmbeddingService,
      agent: AGENT,
      log,
    };

    store.close(); // concurrent stopAgent → cleanupMemory → store.close()

    await expect(dualWriteMemoryV2(deps, entry.id, "x")).resolves.toBeUndefined();
    await expect(dualWriteChunkV2(deps, "chunk-1", "y")).resolves.toBeUndefined();

    // Silent skip — NOT the "best-effort failed" catch path (which would mean
    // a raw "db not open" hit a prepared statement).
    expect(warn).not.toHaveBeenCalled();
    expect(embedV2).not.toHaveBeenCalled();
  });

  it("re-checks isOpen() AFTER the async embed (store can close during embedV2)", async () => {
    const store = freshStore();
    setPhase(store, "dual-write");
    const entry = store.insert(
      { content: "race the embed", source: "conversation" },
      v1(),
    );
    const warn = vi.fn();
    const log = {
      warn,
      info: () => undefined,
      error: () => undefined,
      debug: () => undefined,
    } as unknown as Logger;
    // embedV2 closes the store mid-await — modelling a stop landing during the
    // embed. The post-await isOpen() re-check must catch it (no insert → no throw).
    const embedV2 = vi.fn(async () => {
      store.close();
      return new Int8Array(384);
    });
    const deps = {
      store,
      embedder: { embedV2 } as unknown as EmbeddingService,
      agent: AGENT,
      log,
    };

    await expect(dualWriteMemoryV2(deps, entry.id, "x")).resolves.toBeUndefined();
    expect(embedV2).toHaveBeenCalledTimes(1); // it DID embed (store was open at entry)
    expect(warn).not.toHaveBeenCalled(); // but the post-await guard skipped the write
  });
});
