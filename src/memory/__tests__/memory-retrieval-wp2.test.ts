/**
 * Memory overhaul WP2 (2026-10-25): retrieval ranking, query hygiene and
 * provenance.
 *
 * Most tests drive retrieveMemoryChunks with a fake store whose rankers
 * return ids in a fixed order, so every assertion is about the scoring
 * rules and not about embedding geometry:
 *   (b) path weights multiply the fused score, clamped to +-0.2;
 *   (c) RETRIEVAL_FETCH_K per ranker, excludeTags before fusion (plus one
 *       wider refetch), soft recency factor on the rank scale, opt-in hard
 *       window;
 *   (e) an embedder or vector-search failure keeps the keyword rankers;
 *   (f) the budget loop skips an oversize candidate and keeps filling;
 *   (g) results carry sourceKind and a date;
 *   query hygiene: the Discord envelope never reaches a ranker.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { MemoryStore } from "../store.js";
import {
  MAX_PATH_SCORE_WEIGHT,
  RETRIEVAL_FETCH_K,
  RRF_K,
  SOFT_WINDOW_FLOOR,
  _resetVectorFallbackLogForTests,
  clampScoreWeight,
  recencyDemotedRrf,
  retrievalResultDate,
  retrievalSourceKind,
  retrieveMemoryChunks,
  softRecencyFactor,
} from "../memory-retrieval.js";
import { summarizeRecall, recallFooterLine } from "../../manager/recall-footer.js";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 26, 12, 0, 0);
const QVEC = new Float32Array(384).fill(0.1);

type ChunkRow = {
  chunk_id: string;
  path: string;
  heading: string | null;
  body: string;
  file_mtime_ms: number;
  score_weight: number;
};
type MemRow = { memory_id: string; content: string; tags: string[]; created_at: string };

/**
 * A store double whose four rankers return ids in the given order. `k` is
 * honored (a ranker returns at most k rows), so over-fetch and refetch
 * behavior is observable.
 */
function fakeStore(opts: {
  chunks?: ChunkRow[];
  memories?: MemRow[];
  chunkVec?: string[];
  chunkFts?: string[];
  memVec?: string[];
  memFts?: string[];
}) {
  const chunks = new Map((opts.chunks ?? []).map((c) => [c.chunk_id, c]));
  const memories = new Map((opts.memories ?? []).map((m) => [m.memory_id, m]));
  const calls = {
    chunkVecK: [] as number[],
    chunkFts: [] as { query: string; k: number }[],
    memVecK: [] as number[],
    memFts: [] as { query: string; k: number }[],
  };
  const store = {
    searchMemoryChunksVec: (_q: unknown, k: number) => {
      calls.chunkVecK.push(k);
      return (opts.chunkVec ?? []).slice(0, k).map((chunk_id, i) => ({ chunk_id, distance: 0.1 + i * 0.001 }));
    },
    searchMemoryChunksFts: (query: string, k: number) => {
      calls.chunkFts.push({ query, k });
      return (opts.chunkFts ?? []).slice(0, k).map((chunk_id, i) => ({ chunk_id, rank: -10 + i * 0.01 }));
    },
    searchMemoriesVec: (_q: unknown, k: number) => {
      calls.memVecK.push(k);
      return (opts.memVec ?? []).slice(0, k).map((memory_id, i) => ({
        memory_id,
        distance: 0.1 + i * 0.001,
        importance: 0.5,
        accessed_at: new Date(NOW).toISOString(),
        tier: "warm",
      }));
    },
    searchMemoriesFts: (query: string, k: number) => {
      calls.memFts.push({ query, k });
      return (opts.memFts ?? []).slice(0, k).map((memory_id, i) => ({ memory_id, rank: -10 + i * 0.01 }));
    },
    getMemoryChunk: (id: string) => chunks.get(id) ?? null,
    getMemoryForRetrieval: (id: string) => {
      const m = memories.get(id);
      return m ? { memory_id: m.memory_id, content: m.content, tags: m.tags, importance: 0.5, created_at: m.created_at } : null;
    },
  };
  return { store: store as unknown as MemoryStore, calls };
}

const chunk = (id: string, path: string, over: Partial<ChunkRow> = {}): ChunkRow => ({
  chunk_id: id,
  path,
  heading: id,
  body: `body of ${id}`,
  file_mtime_ms: NOW - DAY,
  score_weight: 0,
  ...over,
});

const mem = (id: string, over: Partial<MemRow> = {}): MemRow => ({
  memory_id: id,
  content: `memory ${id}`,
  tags: [],
  created_at: "2026-10-20T09:00:00.000Z",
  ...over,
});

const fillers = (prefix: string, n: number) =>
  Array.from({ length: n }, (_, i) => chunk(`${prefix}${i}`, `/ws/memory/2026-10-25-${prefix}${i}.md`, { file_mtime_ms: NOW }));

beforeEach(() => _resetVectorFallbackLogForTests());
afterEach(() => vi.restoreAllMocks());

describe("WP2 helpers", () => {
  it("clampScoreWeight keeps weights in [-0.2, 0.2]", () => {
    expect(MAX_PATH_SCORE_WEIGHT).toBe(0.2);
    expect(clampScoreWeight(0.1)).toBe(0.1);
    expect(clampScoreWeight(5)).toBe(0.2);
    expect(clampScoreWeight(-3)).toBe(-0.2);
    expect(clampScoreWeight(Number.NaN)).toBe(0);
  });

  it("softRecencyFactor = max(0.35, 0.5 ** (ageDays / windowDays))", () => {
    expect(SOFT_WINDOW_FLOOR).toBe(0.35);
    expect(softRecencyFactor(0, 14)).toBe(1);
    expect(softRecencyFactor(14, 14)).toBeCloseTo(0.5, 10);
    expect(softRecencyFactor(7, 14)).toBeCloseTo(Math.SQRT1_2, 10);
    expect(softRecencyFactor(28, 14)).toBe(0.35); // 0.25 floored
    expect(softRecencyFactor(400, 14)).toBe(0.35);
    expect(softRecencyFactor(-2, 14)).toBe(1); // future mtime is "fresh"
    expect(softRecencyFactor(Number.NaN, 14)).toBe(0.35);
    expect(softRecencyFactor(30, 0)).toBe(1); // window disabled
  });

  it("recencyDemotedRrf: factor 1 is plain RRF; a lower factor demotes each rank", () => {
    expect(recencyDemotedRrf([0, 4], 1)).toBeCloseTo(1 / (RRF_K + 1) + 1 / (RRF_K + 5), 12);
    expect(recencyDemotedRrf([0], 0.5)).toBeCloseTo(1 / (RRF_K + 2), 12);
    expect(recencyDemotedRrf([], 0.5)).toBe(0);
    // The floor costs a best match about 3 percent, a rank-20 match about a third.
    expect(recencyDemotedRrf([0], 0.35) / (1 / (RRF_K + 1))).toBeGreaterThan(0.96);
    expect(recencyDemotedRrf([19], 0.35) / (1 / (RRF_K + 20))).toBeLessThan(0.7);
  });

  it("retrievalSourceKind and retrievalResultDate", () => {
    expect(retrievalSourceKind({ source: "memory", path: "memory:x" })).toBe("memory");
    expect(retrievalSourceKind({ source: "chunk", path: "document:inv" })).toBe("document");
    expect(retrievalSourceKind({ source: "chunk", path: "shared-facts", chunkId: "shared:1" })).toBe("shared");
    expect(retrievalSourceKind({ source: "chunk", path: "/ws/memory/a.md" })).toBe("chunk");
    expect(retrievalSourceKind({ source: "chunk", path: "document:x", sourceKind: "chunk" })).toBe("chunk");
    expect(retrievalResultDate({ createdAt: "2026-10-01T10:00:00Z" })).toBe("2026-10-01T10:00:00.000Z");
    expect(retrievalResultDate({ fileMtimeMs: Date.UTC(2026, 8, 3) })).toBe("2026-09-03T00:00:00.000Z");
    expect(retrievalResultDate({ createdAt: "garbage", fileMtimeMs: 0 })).toBeUndefined();
  });
});

describe("WP2 (b): path weights are multiplicative and bounded", () => {
  it("a rank-1 dated chunk outranks a rank-20 vault chunk (additive +0.2 put the vault first)", async () => {
    const dated = chunk("dated", "/ws/memory/2026-10-25.md", { file_mtime_ms: NOW });
    const vault = chunk("vault", "/ws/memory/vault/rules.md", { score_weight: 0.2 });
    const filler = fillers("f", 18);
    const { store } = fakeStore({
      chunks: [dated, vault, ...filler],
      chunkVec: ["dated", ...filler.map((c) => c.chunk_id), "vault"],
    });
    const out = await retrieveMemoryChunks({ query: "q", store, embed: async () => QVEC, topK: 20, tokenBudget: 8000, now: NOW });
    const ids = out.map((r) => r.chunkId);
    expect(ids[0]).toBe("dated");
    expect(ids.indexOf("vault")).toBeGreaterThan(0);
    const v = out.find((r) => r.chunkId === "vault")!;
    expect(v.fusedScore).toBeCloseTo((1 / (RRF_K + 20)) * 1.2, 12);
  });

  it("a memory found by both rankers outranks a vault chunk found first by one", async () => {
    const vault = chunk("vault", "/ws/memory/vault/rules.md", { score_weight: 0.2 });
    const { store } = fakeStore({
      chunks: [vault],
      memories: [mem("m1")],
      chunkVec: ["vault"],
      memVec: ["m1"],
      memFts: ["m1"],
    });
    const out = await retrieveMemoryChunks({ query: "q", store, embed: async () => QVEC, topK: 5, now: NOW });
    expect(out.map((r) => r.chunkId)).toEqual(["m1", "vault"]);
  });

  it("an out-of-range stored weight is clamped (scoreWeight reports the clamped value)", async () => {
    const odd = chunk("odd", "/ws/memory/vault/x.md", { score_weight: 3 });
    const { store } = fakeStore({ chunks: [odd], chunkVec: ["odd"] });
    const [r] = await retrieveMemoryChunks({ query: "q", store, embed: async () => QVEC, now: NOW });
    expect(r!.scoreWeight).toBe(0.2);
    expect(r!.fusedScore).toBeCloseTo((1 / (RRF_K + 1)) * 1.2, 12);
  });

  it("archive weight lowers but does not zero a chunk", async () => {
    const arch = chunk("arch", "/ws/memory/archive/2025-01-01.md", { score_weight: -0.2, file_mtime_ms: NOW });
    const { store } = fakeStore({ chunks: [arch], chunkVec: ["arch"] });
    const [r] = await retrieveMemoryChunks({ query: "q", store, embed: async () => QVEC, now: NOW, timeWindowDays: 0 });
    expect(r!.fusedScore).toBeCloseTo((1 / (RRF_K + 1)) * 0.8, 12);
  });
});

describe("WP2 (c): over-fetch, tag exclusion before fusion, soft window", () => {
  it(`fetches ${RETRIEVAL_FETCH_K} candidates from every ranker`, async () => {
    expect(RETRIEVAL_FETCH_K).toBe(60);
    const { store, calls } = fakeStore({});
    await retrieveMemoryChunks({ query: "hello there", store, embed: async () => QVEC, now: NOW });
    expect(calls.chunkVecK).toEqual([60]);
    expect(calls.chunkFts.map((c) => c.k)).toEqual([60]);
    expect(calls.memVecK).toEqual([60]);
    expect(calls.memFts.map((c) => c.k)).toEqual([60]);
  });

  it("excluded rows do not occupy fused rank positions", async () => {
    const flood = Array.from({ length: 5 }, (_, i) => mem(`flood${i}`, { tags: ["mid-session"] }));
    const { store } = fakeStore({
      memories: [...flood, mem("good")],
      memVec: [...flood.map((m) => m.memory_id), "good"],
    });
    const out = await retrieveMemoryChunks({
      query: "q",
      store,
      embed: async () => QVEC,
      excludeTags: ["mid-session"],
      now: NOW,
    });
    expect(out.map((r) => r.chunkId)).toEqual(["good"]);
    // rank 1 after exclusion (1/61), not rank 6 (1/66)
    expect(out[0]!.fusedScore).toBeCloseTo(1 / (RRF_K + 1), 12);
  });

  it("a full fetch eaten by excluded rows triggers one wider refetch", async () => {
    const flood = Array.from({ length: 120 }, (_, i) => mem(`flood${i}`, { tags: ["mid-session"] }));
    const { store, calls } = fakeStore({
      memories: [...flood, mem("good")],
      memVec: [...flood.map((m) => m.memory_id), "good"],
      memFts: [...flood.map((m) => m.memory_id), "good"],
    });
    const out = await retrieveMemoryChunks({
      query: "q",
      store,
      embed: async () => QVEC,
      excludeTags: ["mid-session"],
      now: NOW,
    });
    expect(out.map((r) => r.chunkId)).toEqual(["good"]);
    expect(calls.memVecK).toEqual([60, 600]);
    expect(calls.memFts.map((c) => c.k)).toEqual([60, 600]);
  });

  it("no refetch when the filter leaves enough candidates", async () => {
    const rows = Array.from({ length: 60 }, (_, i) => mem(`m${i}`, { tags: i % 2 === 0 ? ["mid-session"] : [] }));
    const { store, calls } = fakeStore({ memories: rows, memVec: rows.map((m) => m.memory_id) });
    await retrieveMemoryChunks({ query: "q", store, embed: async () => QVEC, excludeTags: ["mid-session"], now: NOW });
    expect(calls.memVecK).toEqual([60]);
  });

  it("soft window (default): an old dated chunk is kept, its ranks demoted by the recency factor", async () => {
    const old = chunk("old", "/ws/memory/2026-08-01.md", { file_mtime_ms: NOW - 60 * DAY });
    const fresh = chunk("fresh", "/ws/memory/2026-10-25.md", { file_mtime_ms: NOW });
    const { store } = fakeStore({ chunks: [old, fresh], chunkVec: ["old", "fresh"], chunkFts: ["old"] });
    const out = await retrieveMemoryChunks({ query: "q", store, embed: async () => QVEC, timeWindowDays: 14, now: NOW });
    const o = out.find((r) => r.chunkId === "old")!;
    // 60 days at a 14-day half-life sits at the 0.35 floor: rank 1 counts as 1/0.35.
    expect(o.fusedScore).toBeCloseTo(2 / (RRF_K + 1 / 0.35), 12);
    // Found first by both rankers, the old note still beats a fresh one found second by one.
    expect(out.map((r) => r.chunkId)).toEqual(["old", "fresh"]);
  });

  it("soft window: equal ranks, the fresher dated chunk wins (recency breaks the tie)", async () => {
    const a = chunk("a", "/ws/memory/2026-09-01.md", { file_mtime_ms: NOW - 40 * DAY });
    const b = chunk("b", "/ws/memory/2026-10-24.md", { file_mtime_ms: NOW - 2 * DAY });
    const { store } = fakeStore({ chunks: [a, b], chunkVec: ["a", "b"], chunkFts: ["b", "a"] });
    const out = await retrieveMemoryChunks({ query: "q", store, embed: async () => QVEC, now: NOW });
    expect(out.map((r) => r.chunkId)).toEqual(["b", "a"]);
  });

  it("soft window leaves standing paths and memories at their plain score", async () => {
    const vault = chunk("vault", "/ws/memory/vault/rules.md", { file_mtime_ms: NOW - 400 * DAY, score_weight: 0 });
    const doc = chunk("doc", "document:inv-1", { file_mtime_ms: NOW - 400 * DAY, score_weight: 0 });
    const cue = chunk("cue", "/ws/memory/2025-01-01-remember-Ab9.md", { file_mtime_ms: NOW - 400 * DAY });
    const { store } = fakeStore({ chunks: [vault, doc, cue], chunkVec: ["vault", "doc", "cue"] });
    const out = await retrieveMemoryChunks({ query: "q", store, embed: async () => QVEC, now: NOW });
    expect(out.find((r) => r.chunkId === "vault")!.fusedScore).toBeCloseTo(1 / (RRF_K + 1), 12);
    expect(out.find((r) => r.chunkId === "doc")!.fusedScore).toBeCloseTo(1 / (RRF_K + 2), 12);
    expect(out.find((r) => r.chunkId === "cue")!.fusedScore).toBeCloseTo(1 / (RRF_K + 3), 12);
  });

  it('timeWindowMode "hard" drops dated chunks older than the window (applyTimeWindowFilter)', async () => {
    const old = chunk("old", "/ws/memory/2026-08-01.md", { file_mtime_ms: NOW - 60 * DAY });
    const vault = chunk("vault", "/ws/memory/vault/rules.md", { file_mtime_ms: NOW - 60 * DAY });
    const { store } = fakeStore({ chunks: [old, vault], chunkVec: ["old", "vault"] });
    const out = await retrieveMemoryChunks({
      query: "q",
      store,
      embed: async () => QVEC,
      timeWindowDays: 14,
      timeWindowMode: "hard",
      now: NOW,
    });
    expect(out.map((r) => r.chunkId)).toEqual(["vault"]);
  });
});

describe("WP2 (e): a vector-side failure keeps keyword recall", () => {
  it("embed throws: FTS results are still returned and the failure is logged once", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const c = chunk("kw", "/ws/memory/2026-10-25.md", { file_mtime_ms: NOW });
    const { store, calls } = fakeStore({ chunks: [c], memories: [mem("m1")], chunkFts: ["kw"], memFts: ["m1"], chunkVec: ["kw"] });
    const debug = vi.fn();
    const embed = async () => {
      throw new Error("onnx session crashed");
    };
    const first = await retrieveMemoryChunks({ query: "ticker SGOV", store, embed, now: NOW, log: { debug }, agent: "a" });
    const second = await retrieveMemoryChunks({ query: "ticker SGOV", store, embed, now: NOW, log: { debug }, agent: "a" });
    expect(first.map((r) => r.chunkId).sort()).toEqual(["kw", "m1"]);
    expect(second).toHaveLength(2);
    expect(calls.chunkVecK).toEqual([]); // no vector search without a query vector
    expect(calls.memVecK).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![1])).toContain("onnx session crashed");
    expect(debug).toHaveBeenCalledTimes(2);
  });

  it("a vec table error is treated the same way", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const c = chunk("kw", "/ws/memory/2026-10-25.md", { file_mtime_ms: NOW });
    const { store } = fakeStore({ chunks: [c], chunkFts: ["kw"] });
    (store as unknown as { searchMemoryChunksVec: () => never }).searchMemoryChunksVec = () => {
      throw new Error("Dimension mismatch for query vector");
    };
    const out = await retrieveMemoryChunks({ query: "kw", store, embed: async () => QVEC, now: NOW });
    expect(out.map((r) => r.chunkId)).toEqual(["kw"]);
  });
});

describe("WP2 (f): the budget loop skips an oversize candidate and keeps filling", () => {
  it("a large second candidate is skipped, smaller ones behind it are kept", async () => {
    const rows = [
      chunk("a", "/ws/memory/a.md", { body: "a".repeat(1000), file_mtime_ms: NOW }),
      chunk("big", "/ws/memory/big.md", { body: "b".repeat(5900), file_mtime_ms: NOW }),
      chunk("c", "/ws/memory/c.md", { body: "c".repeat(1000), file_mtime_ms: NOW }),
      chunk("d", "/ws/memory/d.md", { body: "d".repeat(1000), file_mtime_ms: NOW }),
    ];
    const { store } = fakeStore({ chunks: rows, chunkVec: rows.map((r) => r.chunk_id) });
    const out = await retrieveMemoryChunks({ query: "q", store, embed: async () => QVEC, topK: 5, tokenBudget: 1500, now: NOW });
    expect(out.map((r) => r.chunkId)).toEqual(["a", "c", "d"]);
  });

  it("the first candidate is always emitted, even when it alone is over budget", async () => {
    const rows = [
      chunk("big", "/ws/memory/big.md", { body: "b".repeat(9000), file_mtime_ms: NOW }),
      chunk("small", "/ws/memory/small.md", { body: "s".repeat(100), file_mtime_ms: NOW }),
    ];
    const { store } = fakeStore({ chunks: rows, chunkVec: ["big", "small"] });
    const out = await retrieveMemoryChunks({ query: "q", store, embed: async () => QVEC, tokenBudget: 1500, now: NOW });
    expect(out.map((r) => r.chunkId)).toEqual(["big"]);
  });

  it("topK still bounds the result when everything fits", async () => {
    const rows = fillers("t", 10);
    const { store } = fakeStore({ chunks: rows, chunkVec: rows.map((r) => r.chunk_id) });
    const out = await retrieveMemoryChunks({ query: "q", store, embed: async () => QVEC, topK: 3, now: NOW });
    expect(out).toHaveLength(3);
  });
});

describe("WP2 (g): provenance on every result", () => {
  it("memories carry createdAt, chunks carry fileMtimeMs, and every result a sourceKind", async () => {
    const note = chunk("note", "/ws/memory/2026-10-21.md", { file_mtime_ms: Date.UTC(2026, 9, 21, 8) });
    const doc = chunk("doc", "document:invoice-7", { file_mtime_ms: Date.UTC(2026, 9, 2, 8), heading: null });
    const { store } = fakeStore({
      chunks: [note, doc],
      memories: [mem("m1", { created_at: "2026-06-12T17:00:00.000Z" })],
      chunkVec: ["note", "doc"],
      memVec: ["m1"],
    });
    const out = await retrieveMemoryChunks({ query: "q", store, embed: async () => QVEC, now: NOW });
    const byId = new Map(out.map((r) => [r.chunkId, r]));
    expect(byId.get("m1")).toMatchObject({ source: "memory", sourceKind: "memory", createdAt: "2026-06-12T17:00:00.000Z" });
    expect(byId.get("m1")!.fileMtimeMs).toBeUndefined();
    expect(byId.get("note")).toMatchObject({ source: "chunk", sourceKind: "chunk", fileMtimeMs: Date.UTC(2026, 9, 21, 8) });
    expect(byId.get("doc")).toMatchObject({ source: "chunk", sourceKind: "document", fileMtimeMs: Date.UTC(2026, 9, 2, 8) });
    expect(byId.get("note")!.createdAt).toBeUndefined();
  });

  it("real retrieval output gives the recall footer a date range", async () => {
    const note = chunk("note", "/ws/memory/2026-08-30.md", { file_mtime_ms: Date.UTC(2026, 7, 30, 17) });
    const { store } = fakeStore({
      chunks: [note],
      memories: [mem("m1", { created_at: "2026-06-12T17:00:00.000Z" })],
      chunkVec: ["note"],
      memVec: ["m1"],
    });
    const out = await retrieveMemoryChunks({ query: "q", store, embed: async () => QVEC, now: NOW, timeWindowDays: 0 });
    const footer = recallFooterLine(summarizeRecall(out, NOW), NOW);
    expect(footer).toContain("recalled 1 memory (Jun 12), 1 note (Aug 30)*");
  });
});

describe("WP2 query hygiene: the Discord envelope never reaches a ranker", () => {
  it("strips <channel ...> before embedding and keyword search", async () => {
    const seen: string[] = [];
    const { store, calls } = fakeStore({});
    const wrapped =
      '<channel source="discord" chat_id="000000000000000001" message_id="1433000000000000000" user="jas" ts="2026-10-25 09:14 PDT">\n' +
      "is it safe to run the migration on staging?\n" +
      "</channel>";
    await retrieveMemoryChunks({
      query: wrapped,
      store,
      embed: async (t) => {
        seen.push(t);
        return QVEC;
      },
      now: NOW,
    });
    expect(seen).toEqual(["is it safe to run the migration on staging?"]);
    expect(calls.chunkFts[0]!.query).toBe("is it safe to run the migration on staging?");
    expect(calls.memFts[0]!.query).toBe("is it safe to run the migration on staging?");
  });

  it("an envelope with no words is an empty query", async () => {
    const { store, calls } = fakeStore({});
    const out = await retrieveMemoryChunks({
      query: '<channel source="discord" user="jas" ts="t">\n</channel>',
      store,
      embed: async () => QVEC,
      now: NOW,
    });
    expect(out).toEqual([]);
    expect(calls.chunkFts).toEqual([]);
  });
});
