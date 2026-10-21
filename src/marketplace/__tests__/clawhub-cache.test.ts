/**
 * Phase 90 Plan 04 Task 1 — clawhub-cache.ts TTL cache tests.
 *
 * Pins behavior per 90-04-PLAN (HUB-CACHE-1..3):
 *   HUB-CACHE-1  get/set/expire: set → get returns value; after ttlMs → miss.
 *   HUB-CACHE-2  setNegative: sentinel kind="rate-limited" with retryAfterMs
 *                until negative window expires.
 *   HUB-CACHE-3  key derivation: {endpoint, query, cursor} produces stable
 *                distinct keys (different cursor → different key).
 */
import { describe, it, expect } from "vitest";
import { createClawhubCache } from "../clawhub-cache.js";

describe("createClawhubCache — Phase 90 Plan 04 (HUB-CACHE-1..3)", () => {
  it("HUB-CACHE-1: set → hit within ttl; after ttl elapses → miss", () => {
    let now = 1_000;
    const cache = createClawhubCache<{ items: number[] }>(10_000, () => now);

    const key = { endpoint: "skills", query: "foo" };
    expect(cache.get(key).kind).toBe("miss");

    cache.set(key, { items: [1, 2, 3] });
    const hit = cache.get(key);
    expect(hit.kind).toBe("hit");
    if (hit.kind === "hit") expect(hit.value.items).toEqual([1, 2, 3]);

    // Still within ttl at now + 9999
    now += 9999;
    expect(cache.get(key).kind).toBe("hit");

    // After ttl elapses
    now += 2;
    expect(cache.get(key).kind).toBe("miss");
  });

  it("HUB-CACHE-2: setNegative → rate-limited sentinel with retryAfterMs until elapsed", () => {
    let now = 0;
    const cache = createClawhubCache<{ items: number[] }>(60_000, () => now);

    const key = { endpoint: "skills" };
    cache.setNegative(key, 60_000);

    const neg1 = cache.get(key);
    expect(neg1.kind).toBe("rate-limited");
    if (neg1.kind === "rate-limited") {
      expect(neg1.retryAfterMs).toBe(60_000);
    }

    now += 30_000;
    const neg2 = cache.get(key);
    expect(neg2.kind).toBe("rate-limited");
    if (neg2.kind === "rate-limited") {
      // Remaining window shrinks as time advances.
      expect(neg2.retryAfterMs).toBe(30_000);
    }

    now += 30_001;
    expect(cache.get(key).kind).toBe("miss");
  });

  it("HUB-CACHE-3: distinct cursors produce distinct keys; same shape produces same key", () => {
    let now = 0;
    const cache = createClawhubCache<string>(100_000, () => now);

    cache.set({ endpoint: "skills", query: "foo", cursor: undefined }, "no-cursor");
    cache.set({ endpoint: "skills", query: "foo", cursor: "x" }, "cursor-x");

    const h1 = cache.get({ endpoint: "skills", query: "foo" });
    const h2 = cache.get({ endpoint: "skills", query: "foo", cursor: "x" });

    expect(h1.kind).toBe("hit");
    expect(h2.kind).toBe("hit");
    if (h1.kind === "hit" && h2.kind === "hit") {
      expect(h1.value).toBe("no-cursor");
      expect(h2.value).toBe("cursor-x");
    }

    // Different endpoint → miss
    expect(cache.get({ endpoint: "plugins", query: "foo" }).kind).toBe("miss");
  });
});
