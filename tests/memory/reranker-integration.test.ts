/**
 * Phase 101 Plan 04 Task 2 (U9, SC-10) — integration tests for
 * `rerankTop` over the Phase 90 RRF output and the `reranker.enabled`
 * off-switch in `retrieveMemoryChunks`.
 *
 * These tests use the `rerankFn` DI hook so they do NOT load the real
 * Xenova/bge-reranker-base model — Wave-0 smoke covers the real-model
 * load gate. Here we exercise the orchestration logic: sort order on
 * happy path, timeout fallback, error fallback, off-switch bypass,
 * and end-to-end integration through `retrieveMemoryChunks`.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  rerankTop,
  _resetRerankerForTests,
  applyRerankerEnvOverride,
  type RerankFn,
} from "../../src/memory/reranker.js";
import { retrieveMemoryChunks } from "../../src/memory/memory-retrieval.js";
import { MemoryStore } from "../../src/memory/store.js";

beforeEach(() => {
  _resetRerankerForTests();
});

// ---------------------------------------------------------------------------
// Unit tests for rerankTop (5 named cases per plan T02 acceptance criteria)
// ---------------------------------------------------------------------------

describe("rerankTop — Phase 101 Plan 04 U9", () => {
  it("U9-T01: empty candidates → returns empty array (no rerank invocation)", async () => {
    const fn = vi.fn() as unknown as RerankFn;
    const out = await rerankTop("any", [], { topK: 5, rerankFn: fn });
    expect(out).toHaveLength(0);
    expect(fn).not.toHaveBeenCalled();
  });

  it("U9-T02: happy path — reorders 20 candidates into top-5 by synthetic score", async () => {
    // Build 20 candidates whose original order is rank-0..19 by RRF (i.e.,
    // numbered).  The synthetic reranker inverts that: candidate index 19
    // gets the highest score, index 0 the lowest. After rerank top-5 the
    // returned ids should be [c19, c18, c17, c16, c15] in that order.
    const candidates = Array.from({ length: 20 }, (_, i) => ({
      id: `c${i}`,
      body: `passage ${i}`,
    }));
    const rerankFn: RerankFn = async (pairs) =>
      pairs.map((p) => ({ score: parseInt(p.text_pair.split(" ")[1], 10) }));
    const out = await rerankTop("q", candidates, { topK: 5, rerankFn });
    expect(out.map((c) => c.id)).toEqual(["c19", "c18", "c17", "c16", "c15"]);
  });

  it("U9-T03: timeout path — falls back to original RRF order + warn log", async () => {
    const warn = vi.fn();
    const candidates = [
      { id: "a", body: "alpha" },
      { id: "b", body: "beta" },
      { id: "c", body: "gamma" },
    ];
    // Reranker hangs > timeoutMs.
    const rerankFn: RerankFn = () =>
      new Promise((resolve) => {
        setTimeout(() => resolve([{ score: 1 }, { score: 2 }, { score: 3 }]), 1000);
      });
    const out = await rerankTop("q", candidates, {
      topK: 2,
      timeoutMs: 50,
      rerankFn,
      logger: { warn },
    });
    // Fallback returns the first `topK` candidates in their original order.
    expect(out.map((c) => c.id)).toEqual(["a", "b"]);
    expect(warn).toHaveBeenCalledOnce();
    const [payload] = warn.mock.calls[0];
    expect(payload).toMatchObject({
      phase: "phase101-ingest",
      event: "reranker-fallback",
      reason: "reranker-timeout",
    });
  });

  it("U9-T04: error path — fallback to original RRF order + warn log", async () => {
    const warn = vi.fn();
    const candidates = [
      { id: "a", body: "alpha" },
      { id: "b", body: "beta" },
    ];
    const rerankFn: RerankFn = async () => {
      throw new Error("onnx-runtime-died");
    };
    const out = await rerankTop("q", candidates, {
      topK: 5,
      timeoutMs: 500,
      rerankFn,
      logger: { warn },
    });
    expect(out.map((c) => c.id)).toEqual(["a", "b"]);
    expect(warn).toHaveBeenCalledOnce();
    const [payload] = warn.mock.calls[0];
    expect(payload).toMatchObject({
      phase: "phase101-ingest",
      event: "reranker-fallback",
      reason: "onnx-runtime-died",
    });
  });

  it("U9-T05: applied log emitted on success with score-distribution metadata only (no query/passage)", async () => {
    const info = vi.fn();
    const candidates = [
      { id: "a", body: "alpha" },
      { id: "b", body: "beta" },
    ];
    const rerankFn: RerankFn = async () => [{ score: 0.9 }, { score: 0.2 }];
    await rerankTop("a secret query that must NOT appear in logs", candidates, {
      topK: 2,
      rerankFn,
      logger: { info },
    });
    expect(info).toHaveBeenCalledOnce();
    const [payload] = info.mock.calls[0];
    expect(payload).toMatchObject({
      phase: "phase101-ingest",
      event: "reranker-applied",
      n: 2,
      kept: 2,
    });
    // T-101-14 mitigation — log MUST NOT carry query or passage content.
    expect(JSON.stringify(payload)).not.toContain("secret query");
    expect(JSON.stringify(payload)).not.toContain("alpha");
    expect(JSON.stringify(payload)).not.toContain("beta");
  });
});

// ---------------------------------------------------------------------------
// Integration test — retrieveMemoryChunks config off-switch + wiring
// ---------------------------------------------------------------------------

function deterministicEmbedding(seed: number): Float32Array {
  const arr = new Float32Array(384);
  for (let i = 0; i < 384; i++) {
    arr[i] = Math.sin(seed * 0.1 + i * 0.01);
  }
  let norm = 0;
  for (let i = 0; i < 384; i++) norm += arr[i] * arr[i];
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < 384; i++) arr[i] = arr[i] / norm;
  return arr;
}

async function testEmbed(text: string): Promise<Float32Array> {
  let h = 0;
  for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) | 0;
  return deterministicEmbedding(Math.abs(h));
}

describe("retrieveMemoryChunks — Phase 101 Plan 04 reranker integration (SC-10)", () => {
  let store: MemoryStore;

  beforeEach(() => {
    store = new MemoryStore(":memory:");
  });

  it("U9-T06: rerank disabled (enabled:false) → skips rerankFn entirely (off-switch)", async () => {
    // Seed two chunks. With the rerankFn NOT called, the test verifies the
    // off-switch path doesn't even touch the reranker dependency.
    const path1 = "document:doc-a";
    const path2 = "document:doc-b";
    store.insertMemoryChunk({
      path: path1,
      chunkIndex: 0,
      heading: null,
      body: "alpha content about Schedule C profit",
      tokenCount: 8,
      scoreWeight: 0,
      fileMtimeMs: Date.now(),
      fileSha256: "sha-a",
      embedding: await testEmbed("alpha"),
    });
    store.insertMemoryChunk({
      path: path2,
      chunkIndex: 0,
      heading: null,
      body: "beta content about wages",
      tokenCount: 4,
      scoreWeight: 0,
      fileMtimeMs: Date.now(),
      fileSha256: "sha-b",
      embedding: await testEmbed("beta"),
    });
    const rerankFn = vi.fn() as unknown as RerankFn;
    const out = await retrieveMemoryChunks({
      query: "alpha",
      store,
      embed: testEmbed,
      topK: 5,
      reranker: {
        enabled: false,
        topNToRerank: 20,
        finalTopK: 5,
        timeoutMs: 500,
        rerankFn,
      },
    });
    expect(rerankFn).not.toHaveBeenCalled();
    expect(out.length).toBeGreaterThan(0);
  });

  it("U9-T07: rerank enabled → rerankFn invoked with (query, passage) pairs; reordering applied", async () => {
    // Seed three chunks. Synthetic rerank inverts the RRF order so the LAST
    // chunk (originally rank-2) ends up first in the returned list.
    const now = Date.now();
    for (let i = 0; i < 3; i++) {
      store.insertMemoryChunk({
        path: `document:doc-${i}`,
        chunkIndex: 0,
        heading: null,
        body: `passage ${i}`,
        tokenCount: 2,
        scoreWeight: 0,
        fileMtimeMs: now,
        fileSha256: `sha-${i}`,
        embedding: await testEmbed(`passage ${i}`),
      });
    }
    const rerankFn: RerankFn = async (pairs) =>
      // Score = position in passage text; later passages score higher.
      pairs.map((p) => ({ score: parseInt(p.text_pair.split(" ")[1], 10) }));
    const out = await retrieveMemoryChunks({
      query: "passage 0",
      store,
      embed: testEmbed,
      topK: 3,
      reranker: {
        enabled: true,
        topNToRerank: 20,
        finalTopK: 3,
        timeoutMs: 500,
        rerankFn,
      },
    });
    // After rerank the highest-numbered passage leads.
    expect(out.length).toBe(3);
    expect(out[0].body).toBe("passage 2");
    expect(out[1].body).toBe("passage 1");
    expect(out[2].body).toBe("passage 0");
  });

  it("U9-T09: CLAWCODE_RERANKER_ENABLED=false env override forces disabled on a YAML-enabled cfg (emergency knob)", () => {
    const cfg = { enabled: true, topNToRerank: 20, finalTopK: 5, timeoutMs: 500 };
    // Operator emergency knob — overrides YAML.
    const overridden = applyRerankerEnvOverride(cfg, {
      CLAWCODE_RERANKER_ENABLED: "false",
    } as NodeJS.ProcessEnv);
    expect(overridden).toEqual({
      enabled: false,
      topNToRerank: 20,
      finalTopK: 5,
      timeoutMs: 500,
    });
    // Env unset → cfg passes through unchanged.
    expect(applyRerankerEnvOverride(cfg, {} as NodeJS.ProcessEnv)).toEqual(cfg);
    // Env "true" (any non-"false" value) → cfg passes through unchanged.
    expect(
      applyRerankerEnvOverride(cfg, {
        CLAWCODE_RERANKER_ENABLED: "true",
      } as NodeJS.ProcessEnv),
    ).toEqual(cfg);
    // Env "false" + cfg undefined → undefined (back-compat).
    expect(
      applyRerankerEnvOverride(undefined, {
        CLAWCODE_RERANKER_ENABLED: "false",
      } as NodeJS.ProcessEnv),
    ).toBeUndefined();
  });

  it("U9-T10: env override path integrates end-to-end — disabled cfg from override → rerankFn NOT invoked", async () => {
    const store = new MemoryStore(":memory:");
    store.insertMemoryChunk({
      path: "document:doc-y",
      chunkIndex: 0,
      heading: null,
      body: "y content for env-override test",
      tokenCount: 4,
      scoreWeight: 0,
      fileMtimeMs: Date.now(),
      fileSha256: "sha-y",
      embedding: await testEmbed("y"),
    });
    const rerankFn = vi.fn() as unknown as RerankFn;
    // Simulate daemon resolver path: YAML says enabled:true, env forces false.
    const yamlCfg = {
      enabled: true,
      topNToRerank: 20,
      finalTopK: 5,
      timeoutMs: 500,
    };
    const effective = applyRerankerEnvOverride(yamlCfg, {
      CLAWCODE_RERANKER_ENABLED: "false",
    } as NodeJS.ProcessEnv);
    expect(effective?.enabled).toBe(false);
    const out = await retrieveMemoryChunks({
      query: "y",
      store,
      embed: testEmbed,
      topK: 5,
      reranker: effective ? { ...effective, rerankFn } : undefined,
    });
    expect(rerankFn).not.toHaveBeenCalled();
    expect(out.length).toBeGreaterThan(0);
  });

  it("U9-T08: rerank with timeout → graceful fallback preserves RRF order", async () => {
    const now = Date.now();
    store.insertMemoryChunk({
      path: "document:doc-x",
      chunkIndex: 0,
      heading: null,
      body: "x content",
      tokenCount: 2,
      scoreWeight: 0,
      fileMtimeMs: now,
      fileSha256: "sha-x",
      embedding: await testEmbed("x"),
    });
    const rerankFn: RerankFn = () =>
      new Promise((resolve) => {
        setTimeout(() => resolve([{ score: 0 }]), 1000);
      });
    const out = await retrieveMemoryChunks({
      query: "x",
      store,
      embed: testEmbed,
      topK: 1,
      reranker: {
        enabled: true,
        topNToRerank: 20,
        finalTopK: 1,
        timeoutMs: 25,
        rerankFn,
      },
    });
    expect(out.length).toBe(1);
    expect(out[0].body).toBe("x content");
  });
});
