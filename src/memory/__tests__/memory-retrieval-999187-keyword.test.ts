/**
 * Phase 999.187 — keyword recall through the hybrid path.
 *
 * A fixed-vector embedder makes vector search uninformative (every row at the
 * same distance), so any ordering below comes from the keyword rankers.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { MemoryStore } from "../store.js";
import { retrieveMemoryChunks } from "../memory-retrieval.js";

const vec = new Float32Array(384).fill(0.1);
const embed = async (_q: string) => vec;
let store: MemoryStore;
let sha = 0;

function chunk(heading: string, body: string) {
  store.insertMemoryChunk({
    path: `/ws/memory/2026-09-2${sha % 9}.md`,
    chunkIndex: 0,
    heading,
    body,
    tokenCount: 8,
    scoreWeight: 0,
    fileMtimeMs: Date.now(),
    fileSha256: `s${sha++}`,
    embedding: vec,
  });
}

beforeEach(() => {
  store = new MemoryStore(":memory:");
});
afterEach(() => store.close());

describe("retrieveMemoryChunks keyword recall (999.187)", () => {
  it("a natural question finds the chunk that shares its content words", async () => {
    chunk("Database decision", "We decided on sqlite-vec instead of faiss for the vector store.");
    chunk("Lunch", "Tacos on Tuesday.");
    chunk("Deploy", "Never redeploy without operator confirmation.");
    const out = await retrieveMemoryChunks({
      query: "What did we decide about the database and the vector store?",
      store,
      embed,
      topK: 1,
    });
    expect(out[0]?.heading).toBe("Database decision");
  });

  it("an exact token inside a saved memory is found by keyword alone", async () => {
    for (let i = 0; i < 5; i++) store.insert({ content: `filler memory ${i}`, source: "manual", skipDedup: true }, vec);
    const m = store.insert({ content: "Ticker BSXX is the leveraged one; BSX is the plain ETF.", source: "manual", skipDedup: true }, vec);
    const out = await retrieveMemoryChunks({ query: "which one is BSXX?", store, embed, topK: 1 });
    expect(out[0]?.chunkId).toBe(m.id);
    expect(out[0]?.source).toBe("memory");
  });
});
