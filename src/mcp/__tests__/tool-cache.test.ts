import { describe, it, expect } from "vitest";
import { ToolCache } from "../tool-cache.js";

/**
 * Phase 55 Plan 02 — ToolCache unit tests (Tests 1-7).
 *
 * Verifies the per-Turn idempotent tool-result cache behaves correctly:
 *   - stable key construction via canonicalStringify (arg-order-insensitive)
 *   - set / get round-trip
 *   - miss returns undefined
 *   - mutation safety (hits return frozen deep clones)
 *   - tool-name isolation (same args, different tool = different key)
 *   - hitCount telemetry (only increments on successful get)
 */

describe("ToolCache (Phase 55)", () => {
  it("Test 1: ToolCache.key formats as `${toolName}:${canonicalStringify(args)}`", () => {
    const key = ToolCache.key("memory_lookup", { q: "foo" });
    expect(key).toBe('memory_lookup:{"q":"foo"}');
  });

  it("Test 2: ToolCache.key is arg-order-insensitive via canonicalStringify", () => {
    const keyA = ToolCache.key("memory_lookup", { q: "x", limit: 5 });
    const keyB = ToolCache.key("memory_lookup", { limit: 5, q: "x" });
    expect(keyA).toBe(keyB);
  });

  it("Test 3: set/get round-trip returns the stored value", () => {
    const cache = new ToolCache();
    cache.set("memory_lookup", { q: "foo" }, { results: [1, 2, 3] });
    const hit = cache.get("memory_lookup", { q: "foo" }) as { results: number[] } | undefined;
    expect(hit).toBeDefined();
    expect(hit!.results).toEqual([1, 2, 3]);
  });

  it("Test 4: get on miss returns undefined", () => {
    const cache = new ToolCache();
    // Nothing set yet
    expect(cache.get("memory_lookup", { q: "bar" })).toBeUndefined();
    // Different args still miss
    cache.set("memory_lookup", { q: "foo" }, { results: [1] });
    expect(cache.get("memory_lookup", { q: "bar" })).toBeUndefined();
  });

  it("Test 5: mutation on a hit result does NOT poison subsequent hits (frozen deep clone)", () => {
    const cache = new ToolCache();
    cache.set("memory_lookup", { q: "foo" }, { results: [1, 2, 3], nested: { a: 1 } });

    const first = cache.get("memory_lookup", { q: "foo" }) as {
      results: number[];
      nested: { a: number };
    };
    expect(first.results).toEqual([1, 2, 3]);

    // Attempt mutation (must not poison the cached value). In strict mode,
    // modifying frozen objects throws — we catch so the test proves isolation,
    // not throw semantics.
    try {
      (first.results as unknown as number[]).push(99);
    } catch { /* frozen — expected */ }
    try {
      (first.nested as { a: number }).a = 999;
    } catch { /* frozen — expected */ }

    const second = cache.get("memory_lookup", { q: "foo" }) as {
      results: number[];
      nested: { a: number };
    };
    expect(second.results).toEqual([1, 2, 3]);
    expect(second.nested.a).toBe(1);
    // The returned value must be deeply frozen.
    expect(Object.isFrozen(second)).toBe(true);
    expect(Object.isFrozen(second.results)).toBe(true);
    expect(Object.isFrozen(second.nested)).toBe(true);
  });

  it("Test 6: tool-name isolation — same args, different tool = separate entries", () => {
    const cache = new ToolCache();
    cache.set("memory_lookup", { q: "foo" }, 1);
    cache.set("search_documents", { q: "foo" }, 2);
    expect(cache.get("memory_lookup", { q: "foo" })).toBe(1);
    expect(cache.get("search_documents", { q: "foo" })).toBe(2);
  });

  it("Test 7: hitCount starts at 0 and increments only on successful gets", () => {
    const cache = new ToolCache();
    expect(cache.hitCount()).toBe(0);
    // Miss does NOT increment
    cache.get("memory_lookup", { q: "foo" });
    expect(cache.hitCount()).toBe(0);
    cache.set("memory_lookup", { q: "foo" }, { ok: true });
    // Hit increments
    cache.get("memory_lookup", { q: "foo" });
    expect(cache.hitCount()).toBe(1);
    // Another hit increments again
    cache.get("memory_lookup", { q: "foo" });
    expect(cache.hitCount()).toBe(2);
    // Miss again — no change
    cache.get("memory_lookup", { q: "bar" });
    expect(cache.hitCount()).toBe(2);
  });

  it("set stores a deep clone (later mutation of stored reference does not leak)", () => {
    const cache = new ToolCache();
    const original = { results: [1, 2, 3], nested: { a: 1 } };
    cache.set("memory_lookup", { q: "foo" }, original);
    // Mutate the original AFTER set — cache must have kept its own frozen clone.
    original.results.push(99);
    original.nested.a = 999;
    const hit = cache.get("memory_lookup", { q: "foo" }) as {
      results: number[];
      nested: { a: number };
    };
    expect(hit.results).toEqual([1, 2, 3]);
    expect(hit.nested.a).toBe(1);
  });
});
