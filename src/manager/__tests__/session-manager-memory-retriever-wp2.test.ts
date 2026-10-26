/**
 * Memory overhaul WP2 (2026-10-25): the per-agent retriever closure built by
 * SessionManager.getMemoryRetrieverForAgent.
 *
 *   - the document-chunk cap default is 4 (was 2) when no retrieval config
 *     is wired;
 *   - an operator-configured cap still wins;
 *   - the Discord envelope is stripped before retrieval and before the
 *     owner-facts embedding.
 *
 * The agent is never started: an in-memory MemoryStore is placed in the
 * manager's per-agent map and the query embedding is stubbed, so no model
 * is loaded (the main session-manager suite needs a 60 s warmup for that).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMockAdapter } from "../session-adapter.js";
import { SessionManager } from "../session-manager.js";
import { MemoryStore } from "../../memory/store.js";

const VEC = new Float32Array(384).fill(0.1);
const WRAPPED =
  '<channel source="discord" chat_id="000000000000000001" message_id="1433000000000000000" user="jas" ts="2026-10-25 09:14 PDT">\n' +
  "what does the invoice say?\n" +
  "</channel>";

type Internals = {
  memory: { memoryStores: Map<string, MemoryStore> };
  configs: Map<string, unknown>;
};

describe("SessionManager.getMemoryRetrieverForAgent (WP2)", () => {
  let tmp: string;
  let manager: SessionManager;
  let store: MemoryStore;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "sm-wp2-"));
    manager = new SessionManager({
      adapter: createMockAdapter(),
      registryPath: join(tmp, "registry.json"),
      backoffConfig: { baseMs: 100, maxMs: 1000, maxRetries: 3, stableAfterMs: 500 },
    });
    store = new MemoryStore(":memory:");
    vi.spyOn(store, "embedQuery").mockImplementation(async () => VEC as never);
    const internals = manager as unknown as Internals;
    internals.memory.memoryStores.set("doc-agent", store);
    internals.configs.set("doc-agent", {
      name: "doc-agent",
      memoryRetrievalTopK: 10,
      memoryRetrievalTokenBudget: 8000,
      ingestionPriority: "medium",
    });
    for (let i = 0; i < 6; i++) {
      store.insertMemoryChunk({
        path: `document:invoice-${i}`,
        chunkIndex: 0,
        heading: null,
        body: `invoice ${i} total due`,
        tokenCount: 5,
        scoreWeight: 0.2,
        fileMtimeMs: Date.now(),
        fileSha256: `doc-${i}`,
        embedding: VEC,
      });
    }
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    try {
      await manager.stopAll();
    } catch {
      /* nothing was started */
    }
    store.close();
    await rm(tmp, { recursive: true, force: true });
  });

  it("caps document chunks at 4 by default (was 2)", async () => {
    const retriever = manager.getMemoryRetrieverForAgent("doc-agent")!;
    const out = await retriever("invoice total");
    expect(out.filter((r) => r.path.startsWith("document:"))).toHaveLength(4);
    expect(out.every((r) => r.sourceKind === "document")).toBe(true);
  });

  it("an operator-configured cap still wins", async () => {
    manager.setDocumentIngestRetrievalResolver(() => ({ recencyBoostDays: 2, maxChunksPerRetrieval: 1 }));
    const out = await manager.getMemoryRetrieverForAgent("doc-agent")!("invoice total");
    expect(out).toHaveLength(1);
  });

  it("strips the Discord envelope before retrieval and before the owner-facts embedding", async () => {
    const fts = vi.spyOn(store, "searchMemoryChunksFts");
    const internals = manager as unknown as Internals;
    internals.configs.set("doc-agent", { ...(internals.configs.get("doc-agent") as object), owner: "jas" });
    const search = vi.fn(() => []);
    manager.setSharedFactsStore({ search } as never);
    const ownerEmbed = vi.spyOn(manager.getEmbedder(), "embed").mockResolvedValue(VEC);

    await manager.getMemoryRetrieverForAgent("doc-agent")!(WRAPPED);

    expect(store.embedQuery).toHaveBeenCalledWith(expect.anything(), "what does the invoice say?");
    expect(fts.mock.calls[0]![0]).toBe("what does the invoice say?");
    expect(ownerEmbed).toHaveBeenCalledWith("what does the invoice say?");
    expect(search).toHaveBeenCalledWith("jas", VEC, expect.any(Number));
  });
});
