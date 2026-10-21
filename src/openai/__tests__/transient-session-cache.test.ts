/**
 * Phase 74 Plan 01 — Transient-session cache unit tests.
 *
 * Pins the close-on-evict + LRU + TTL contract that the template driver
 * relies on to bound memory + shut down idle SDK subprocesses.
 */

import { describe, it, expect, vi } from "vitest";

import {
  TransientSessionCache,
  makeTransientCacheKey,
} from "../transient-session-cache.js";
import type { SessionHandle } from "../../manager/session-adapter.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/**
 * Build a SessionHandle-shaped mock. Only `close` and `sessionId` are touched
 * by the cache contract; the remaining fields satisfy the TypeScript surface.
 */
function makeHandle(sessionId = "sess-" + Math.random().toString(36).slice(2)): SessionHandle & {
  readonly closeMock: ReturnType<typeof vi.fn>;
} {
  const closeMock = vi.fn().mockResolvedValue(undefined);
  const h: SessionHandle & { closeMock: ReturnType<typeof vi.fn> } = {
    sessionId,
    send: vi.fn().mockResolvedValue(undefined),
    sendAndCollect: vi.fn().mockResolvedValue(""),
    sendAndStream: vi.fn().mockResolvedValue(""),
    close: closeMock as unknown as SessionHandle["close"],
    onError: vi.fn(),
    onEnd: vi.fn(),
    setEffort: vi.fn(),
    getEffort: vi.fn().mockReturnValue("low") as unknown as SessionHandle["getEffort"],
    // Phase 86 MODEL-03 — required by SessionHandle surface.
    setModel: vi.fn(),
    getModel: vi.fn().mockReturnValue(undefined) as unknown as SessionHandle["getModel"],
    // Phase 87 CMD-02 — required by SessionHandle surface.
    setPermissionMode: vi.fn(),
    getPermissionMode: vi.fn().mockReturnValue("default") as unknown as SessionHandle["getPermissionMode"],
    interrupt: vi.fn(),
    hasActiveTurn: vi.fn().mockReturnValue(false) as unknown as SessionHandle["hasActiveTurn"],
    // Phase 85 TOOL-01 — required by SessionHandle surface.
    getMcpState: vi.fn().mockReturnValue(new Map()) as unknown as SessionHandle["getMcpState"],
    setMcpState: vi.fn(),
    // Phase 96 D-CONTEXT — required by SessionHandle surface.
    getFsCapabilitySnapshot: vi.fn().mockReturnValue(new Map()) as unknown as SessionHandle["getFsCapabilitySnapshot"],
    setFsCapabilitySnapshot: vi.fn(),
    // Phase 103 OBS-04 — required by SessionHandle surface.
    getRateLimitTracker: vi.fn().mockReturnValue(undefined) as unknown as SessionHandle["getRateLimitTracker"],
    setRateLimitTracker: vi.fn(),
    // Phase 94 Plan 02 TOOL-03 — required by SessionHandle surface.
    getFlapHistory: vi.fn().mockReturnValue(new Map()) as unknown as SessionHandle["getFlapHistory"],
    // Phase 94 Plan 03 — required by SessionHandle surface.
    getRecoveryAttemptHistory: vi.fn().mockReturnValue(new Map()) as unknown as SessionHandle["getRecoveryAttemptHistory"],
    // Phase 87 CMD-01 — required by SessionHandle surface (empty default).
    getSupportedCommands: vi.fn().mockResolvedValue([]) as unknown as SessionHandle["getSupportedCommands"],
    getSupportedModels: vi.fn().mockResolvedValue([]) as unknown as SessionHandle["getSupportedModels"],
    closeMock,
  };
  return h;
}

/** Flush pending microtasks so fire-and-forget close() has a chance to run. */
async function flushMicrotasks(): Promise<void> {
  // Two awaits drain the default microtask queue + any then() chained close().
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

// ---------------------------------------------------------------------------
// makeTransientCacheKey
// ---------------------------------------------------------------------------

describe("makeTransientCacheKey", () => {
  it("2a: composes the four components in a fixed order with :: separator", () => {
    const k = makeTransientCacheKey({
      keyHash: "abc",
      callerSlug: "fin-test",
      soulFp: "deadbeef00000000",
      tier: "sonnet",
    });
    expect(k).toBe("abc::fin-test::deadbeef00000000::sonnet");
  });

  it("distinct tiers/slugs produce distinct keys", () => {
    const base = { keyHash: "k", callerSlug: "s", soulFp: "f", tier: "sonnet" };
    expect(makeTransientCacheKey(base)).not.toBe(
      makeTransientCacheKey({ ...base, tier: "opus" }),
    );
    expect(makeTransientCacheKey(base)).not.toBe(
      makeTransientCacheKey({ ...base, callerSlug: "other" }),
    );
    expect(makeTransientCacheKey(base)).not.toBe(
      makeTransientCacheKey({ ...base, keyHash: "other" }),
    );
    expect(makeTransientCacheKey(base)).not.toBe(
      makeTransientCacheKey({ ...base, soulFp: "other" }),
    );
  });
});

// ---------------------------------------------------------------------------
// Basic get/set
// ---------------------------------------------------------------------------

describe("TransientSessionCache — basic get/set", () => {
  it("2b: set then get returns the exact same handle instance", () => {
    const cache = new TransientSessionCache({ maxSize: 4, ttlMs: 60_000 });
    const h = makeHandle();
    cache.set("k1", h);
    expect(cache.get("k1")).toBe(h);
    expect(cache.size()).toBe(1);
  });

  it("2c: get(unknown) returns undefined", () => {
    const cache = new TransientSessionCache({ maxSize: 4, ttlMs: 60_000 });
    expect(cache.get("missing")).toBeUndefined();
  });

  it("set(k, h2) on existing k closes the old handle first", async () => {
    const cache = new TransientSessionCache({ maxSize: 4, ttlMs: 60_000 });
    const h1 = makeHandle("first");
    const h2 = makeHandle("second");
    cache.set("k1", h1);
    cache.set("k1", h2);
    await flushMicrotasks();
    expect(h1.closeMock).toHaveBeenCalledTimes(1);
    expect(h2.closeMock).not.toHaveBeenCalled();
    expect(cache.get("k1")).toBe(h2);
    expect(cache.size()).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// LRU
// ---------------------------------------------------------------------------

describe("TransientSessionCache — LRU", () => {
  it("2d: third distinct key on maxSize=2 evicts LRU and closes it", async () => {
    const cache = new TransientSessionCache({ maxSize: 2, ttlMs: 60_000 });
    const a = makeHandle("a");
    const b = makeHandle("b");
    const c = makeHandle("c");
    cache.set("a", a);
    cache.set("b", b);
    cache.set("c", c);
    await flushMicrotasks();
    expect(a.closeMock).toHaveBeenCalledTimes(1);
    expect(b.closeMock).not.toHaveBeenCalled();
    expect(c.closeMock).not.toHaveBeenCalled();
    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("b")).toBe(b);
    expect(cache.get("c")).toBe(c);
  });

  it("2e: get refreshes recency — k1 stays when k2 becomes LRU", async () => {
    const cache = new TransientSessionCache({ maxSize: 2, ttlMs: 60_000 });
    const k1 = makeHandle("k1");
    const k2 = makeHandle("k2");
    const k3 = makeHandle("k3");
    cache.set("k1", k1);
    cache.set("k2", k2);
    // Touch k1 to make k2 the LRU.
    expect(cache.get("k1")).toBe(k1);
    cache.set("k3", k3);
    await flushMicrotasks();
    expect(k2.closeMock).toHaveBeenCalledTimes(1);
    expect(k1.closeMock).not.toHaveBeenCalled();
    expect(cache.get("k1")).toBe(k1);
    expect(cache.get("k2")).toBeUndefined();
    expect(cache.get("k3")).toBe(k3);
  });

  it("maxSize=1 evicts immediately on second distinct set", async () => {
    const cache = new TransientSessionCache({ maxSize: 1, ttlMs: 60_000 });
    const a = makeHandle();
    const b = makeHandle();
    cache.set("a", a);
    cache.set("b", b);
    await flushMicrotasks();
    expect(a.closeMock).toHaveBeenCalledTimes(1);
    expect(cache.size()).toBe(1);
    expect(cache.get("b")).toBe(b);
  });
});

// ---------------------------------------------------------------------------
// TTL
// ---------------------------------------------------------------------------

describe("TransientSessionCache — TTL", () => {
  it("2f: ttlMs=100 — get after 150ms returns undefined AND closes once", async () => {
    let fakeNow = 1_000_000;
    const cache = new TransientSessionCache({
      maxSize: 4,
      ttlMs: 100,
      now: () => fakeNow,
    });
    const h = makeHandle();
    cache.set("k", h);
    fakeNow += 150;
    expect(cache.get("k")).toBeUndefined();
    await flushMicrotasks();
    expect(h.closeMock).toHaveBeenCalledTimes(1);
    expect(cache.size()).toBe(0);
  });

  it("2i: at ttlMs exactly, entry still live; 1ms past, reaped", async () => {
    let fakeNow = 0;
    const cache = new TransientSessionCache({
      maxSize: 4,
      ttlMs: 100,
      now: () => fakeNow,
    });
    const h = makeHandle();
    cache.set("k", h);
    fakeNow = 100; // exactly at TTL — NOT past the `>` threshold
    expect(cache.get("k")).toBe(h);
    // Now 1ms past — reaped.
    fakeNow = 202; // 202 - lastAccess(which was 100 after the touch) = 102 > 100
    expect(cache.get("k")).toBeUndefined();
    await flushMicrotasks();
    expect(h.closeMock).toHaveBeenCalledTimes(1);
  });

  it("ttlMs=0 disables TTL (LRU-only mode)", () => {
    let fakeNow = 0;
    const cache = new TransientSessionCache({
      maxSize: 4,
      ttlMs: 0,
      now: () => fakeNow,
    });
    const h = makeHandle();
    cache.set("k", h);
    fakeNow = 10 ** 9; // one billion ms in the future
    expect(cache.get("k")).toBe(h);
  });
});

// ---------------------------------------------------------------------------
// closeAll
// ---------------------------------------------------------------------------

describe("TransientSessionCache — closeAll", () => {
  it("2g: closeAll closes every handle exactly once", async () => {
    const cache = new TransientSessionCache({ maxSize: 4, ttlMs: 60_000 });
    const h1 = makeHandle();
    const h2 = makeHandle();
    const h3 = makeHandle();
    cache.set("a", h1);
    cache.set("b", h2);
    cache.set("c", h3);
    await cache.closeAll();
    expect(h1.closeMock).toHaveBeenCalledTimes(1);
    expect(h2.closeMock).toHaveBeenCalledTimes(1);
    expect(h3.closeMock).toHaveBeenCalledTimes(1);
    expect(cache.size()).toBe(0);
  });

  it("2g-bis: second closeAll is a no-op", async () => {
    const cache = new TransientSessionCache({ maxSize: 4, ttlMs: 60_000 });
    const h = makeHandle();
    cache.set("k", h);
    await cache.closeAll();
    await cache.closeAll();
    expect(h.closeMock).toHaveBeenCalledTimes(1);
  });

  it("after closeAll, get returns undefined and set closes inbound handle defensively", async () => {
    const cache = new TransientSessionCache({ maxSize: 4, ttlMs: 60_000 });
    await cache.closeAll();
    expect(cache.get("k")).toBeUndefined();
    const h = makeHandle();
    cache.set("k", h);
    await flushMicrotasks();
    expect(h.closeMock).toHaveBeenCalledTimes(1);
    expect(cache.size()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Error isolation
// ---------------------------------------------------------------------------

describe("TransientSessionCache — error isolation", () => {
  it("2h: handle.close() rejecting is caught; cache state still consistent", async () => {
    const warn = vi.fn();
    const cache = new TransientSessionCache({
      maxSize: 1,
      ttlMs: 60_000,
      log: { warn },
    });
    const bad = makeHandle();
    // Make close() reject — the cache must still drop the entry.
    (bad.close as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("boom"),
    );
    const good = makeHandle();
    cache.set("a", bad);
    cache.set("b", good); // triggers LRU eviction of "a"
    await flushMicrotasks();
    await flushMicrotasks();
    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("b")).toBe(good);
    expect(warn).toHaveBeenCalled(); // logged at least once
  });

  it("handle.close() throwing synchronously is caught + entry removed", async () => {
    const warn = vi.fn();
    const cache = new TransientSessionCache({
      maxSize: 1,
      ttlMs: 60_000,
      log: { warn },
    });
    const bad = makeHandle();
    // Make close() throw synchronously (not common but defensive).
    (bad.close as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error("sync-boom");
    });
    const good = makeHandle();
    cache.set("a", bad);
    cache.set("b", good);
    await flushMicrotasks();
    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("b")).toBe(good);
  });
});
