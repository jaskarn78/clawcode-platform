/**
 * Phase 115 sub-scope 3 — verify `retrieveMemoryChunks` honors the
 * `tokenBudget` argument and the new 1500 default.
 *
 * Locked invariants:
 *   - Default tokenBudget is 1500 (was 2000 pre-115).
 *   - Cumulative body chars never exceed `tokenBudget * 4` after the first
 *     emitted chunk (the "always emit at least the first chunk" guard from
 *     memory-retrieval.ts is preserved — single oversized chunk still passes).
 *   - Higher tokenBudget admits more chunks; lower tokenBudget admits fewer.
 *
 * Strategy: build an in-memory MemoryStore, insert a small set of chunks
 * via insertMemoryChunk, and exercise retrieveMemoryChunks with various
 * tokenBudget values. The chunks-side path is the lever (the memories-side
 * fan-out is irrelevant to the budget contract — chars accumulate equally).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { MemoryStore } from "../store.js";
import { retrieveMemoryChunks } from "../memory-retrieval.js";

let store: MemoryStore;

// Deterministic 384-dim embedder — every chunk and the query share the
// SAME embedding so vec-search returns them all at uniform distance. FTS
// then orders them in insert order, but for budget testing we don't care
// about rank precision — we need many candidate chunks to exercise the
// cumulative-chars cap at varying budgets.
const FIXED_VEC = new Float32Array(384).fill(0.1);
const embed = async (_text: string): Promise<Float32Array> => FIXED_VEC;

beforeEach(() => {
  store = new MemoryStore(":memory:");
});

afterEach(() => {
  store.close();
});

/** Insert N chunks, each with `bodySize` chars of body content. */
function seedChunks(n: number, bodySize: number) {
  const body = "x".repeat(bodySize);
  for (let i = 0; i < n; i++) {
    store.insertMemoryChunk({
      path: `/ws/memory/chunk-${i}.md`,
      chunkIndex: 0,
      heading: `Heading ${i}`,
      body,
      tokenCount: Math.ceil(bodySize / 4),
      scoreWeight: 0,
      fileMtimeMs: Date.now(),
      fileSha256: `sha-${i}`,
      embedding: FIXED_VEC,
    });
  }
}

describe("Phase 115 sub-scope 3 — retrieveMemoryChunks tokenBudget", () => {
  it("default tokenBudget is 1500 (down from pre-115 2000)", async () => {
    // 8 chunks × 1000 chars each. With tokenBudget unset (default 1500 →
    // cap 6000 chars) the loop should admit at most 6 (it stops AT the cap,
    // not over). Pre-115 default 2000 → cap 8000 chars → admitted 8.
    seedChunks(8, 1000);
    const out = await retrieveMemoryChunks({
      query: "anything",
      store,
      embed,
      topK: 8,
      timeWindowDays: 14,
      // tokenBudget intentionally OMITTED — verify the new 1500 default fires.
    });
    const totalChars = out.reduce((sum, h) => sum + h.body.length, 0);
    // The first-chunk-always-passes guard means total can be slightly OVER
    // budget*4 if the first chunk alone exceeds it. Here each is 1000 chars,
    // so the cap fires cleanly — never over 6000.
    expect(totalChars).toBeLessThanOrEqual(1500 * 4);
    // 1500*4 = 6000; with 1000-char chunks → at most 6 chunks fit.
    expect(out.length).toBeLessThanOrEqual(6);
    expect(out.length).toBeGreaterThan(0);
  });

  it("tokenBudget=500 caps cumulative body length to 500*4 = 2000 chars", async () => {
    // 5 chunks × 600 chars: first passes (always-emit guard); second adds
    // 600 → 1200 (under 2000); third adds 600 → 1800 (still under); fourth
    // would push to 2400 OVER 2000 → STOP. So 3 chunks expected.
    seedChunks(5, 600);
    const out = await retrieveMemoryChunks({
      query: "anything",
      store,
      embed,
      topK: 5,
      timeWindowDays: 14,
      tokenBudget: 500,
    });
    const totalChars = out.reduce((sum, h) => sum + h.body.length, 0);
    expect(out.length).toBe(3);
    expect(totalChars).toBe(1800);
    expect(totalChars).toBeLessThanOrEqual(500 * 4);
  });

  it("tokenBudget=4000 admits more chunks than tokenBudget=500", async () => {
    seedChunks(10, 800);
    const lo = await retrieveMemoryChunks({
      query: "anything",
      store,
      embed,
      topK: 10,
      timeWindowDays: 14,
      tokenBudget: 500,
    });
    const hi = await retrieveMemoryChunks({
      query: "anything",
      store,
      embed,
      topK: 10,
      timeWindowDays: 14,
      tokenBudget: 4000,
    });
    expect(hi.length).toBeGreaterThan(lo.length);
  });

  it("always-emit-first-chunk guard fires for single oversized chunk (Pain Point #16)", async () => {
    // Single chunk of 5000 chars. tokenBudget=500 → cap 2000 chars. The
    // first-chunk-always-passes guard MUST emit it anyway so the caller
    // never gets an empty <memory-context> just because the top result
    // happens to be large.
    seedChunks(1, 5000);
    const out = await retrieveMemoryChunks({
      query: "anything",
      store,
      embed,
      topK: 5,
      timeWindowDays: 14,
      tokenBudget: 500,
    });
    expect(out.length).toBe(1);
    expect(out[0].body.length).toBe(5000);
  });

  it("tokenBudget=0 emits exactly one chunk (the always-emit guard)", async () => {
    // Edge case: tokenBudget=0 means cap=0 chars. The always-emit guard
    // must still emit the FIRST chunk; subsequent chunks are skipped.
    seedChunks(3, 100);
    const out = await retrieveMemoryChunks({
      query: "anything",
      store,
      embed,
      topK: 3,
      timeWindowDays: 14,
      tokenBudget: 0,
    });
    expect(out.length).toBe(1);
  });

  it("explicit tokenBudget overrides the 1500 default", async () => {
    // Pre-115 behavior recovery: operator can opt back into 2000-token
    // budget by passing it explicitly. Verify the value reaches the cap.
    seedChunks(8, 1000);
    const out = await retrieveMemoryChunks({
      query: "anything",
      store,
      embed,
      topK: 8,
      timeWindowDays: 14,
      tokenBudget: 2000, // pre-115 value
    });
    // 2000 * 4 = 8000 chars cap; 8 × 1000 = 8000 → all 8 chunks fit
    // exactly (the loop stops AT the cap, not over).
    expect(out.length).toBe(8);
    expect(out.reduce((s, h) => s + h.body.length, 0)).toBe(8000);
  });
});
