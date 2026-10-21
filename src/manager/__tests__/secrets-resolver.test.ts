/**
 * Phase 999.10 Plan 01 — SecretsResolver behavior tests (RES-01..RES-09).
 *
 * Wave 1 replaces the Wave 0 `it.todo` scaffolds with real DI-pure tests
 * exercising:
 *   - cache hit (RES-01)
 *   - inflight dedup (RES-02)
 *   - retry success / rate-limit early-bail / empty-resolution (RES-03/04/05)
 *   - preResolveAll partial failure (RES-06)
 *   - counter lifecycle (RES-07)
 *   - SEC-07 no-leak guarantees: resolved value never in pino logs or thrown
 *     error messages (RES-08/09)
 *
 * All tests construct a fresh resolver per `it` — no module-level state.
 * Retry timings use minTimeout:1/maxTimeout:1 to keep wall-clock under the
 * 5s plan budget without resorting to fake timers (which p-retry's
 * setTimeout-based backoff fights).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Writable } from "node:stream";
import pino from "pino";
import {
  SecretsResolver,
  DEFAULT_LKG_MAX_AGE_MS,
  type OpReadFn,
} from "../secrets-resolver.js";

const SENTINEL_VALUE = "my-test-secret-9d8a2f";

function makeLogger(): { log: pino.Logger; captured: () => string } {
  const chunks: string[] = [];
  const sink = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(String(chunk));
      cb();
    },
  });
  const log = pino({ level: "debug" }, sink);
  return { log, captured: () => chunks.join("") };
}

/** Silent pino logger for tests that don't inspect log output. */
function silentLogger(): pino.Logger {
  const sink = new Writable({
    write(_chunk, _enc, cb) {
      cb();
    },
  });
  return pino({ level: "silent" }, sink);
}

describe("SecretsResolver", () => {
  beforeEach(() => {
    // No global state — each test constructs its own resolver. Real timers
    // are fine: p-retry's setTimeout uses minTimeout:1ms in retry tests.
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("RES-01: cache hit avoids opRead", async () => {
    const opRead: OpReadFn = vi.fn(async () => SENTINEL_VALUE);
    const r = new SecretsResolver({
      opRead,
      log: silentLogger(),
      retryOptions: { retries: 0 },
    });

    const v1 = await r.resolve("op://example-vault-6/B/C");
    const v2 = await r.resolve("op://example-vault-6/B/C");

    expect(v1).toBe(SENTINEL_VALUE);
    expect(v2).toBe(SENTINEL_VALUE);
    expect(opRead).toHaveBeenCalledTimes(1);

    const snap = r.snapshot();
    expect(snap.hits).toBe(1);
    expect(snap.misses).toBe(1);
    expect(snap.cacheSize).toBe(1);
  });

  it("RES-02: inflight dedup", async () => {
    // Slow opRead so all three concurrent callers find the inflight Promise.
    const opRead: OpReadFn = vi.fn(async () => {
      await new Promise((rs) => setTimeout(rs, 10));
      return SENTINEL_VALUE;
    });
    const r = new SecretsResolver({
      opRead,
      log: silentLogger(),
      retryOptions: { retries: 0 },
    });

    const [v1, v2, v3] = await Promise.all([
      r.resolve("op://example-vault-6"),
      r.resolve("op://example-vault-6"),
      r.resolve("op://example-vault-6"),
    ]);

    expect(v1).toBe(SENTINEL_VALUE);
    expect(v2).toBe(SENTINEL_VALUE);
    expect(v3).toBe(SENTINEL_VALUE);
    expect(opRead).toHaveBeenCalledTimes(1);
    expect(r.snapshot().cacheSize).toBe(1);
  });

  it("RES-03: retry succeeds before exhaustion", async () => {
    const opRead = vi
      .fn<OpReadFn>()
      .mockRejectedValueOnce(new Error("transient ECONNRESET"))
      .mockResolvedValueOnce(SENTINEL_VALUE);

    const r = new SecretsResolver({
      opRead,
      log: silentLogger(),
      retryOptions: { retries: 3, minTimeout: 1, maxTimeout: 1, randomize: false },
    });

    const v = await r.resolve("op://example-vault-6");

    expect(v).toBe(SENTINEL_VALUE);
    expect(opRead).toHaveBeenCalledTimes(2);
    expect(r.snapshot().retries).toBeGreaterThanOrEqual(1);
    expect(r.getCached("op://example-vault-6")).toBe(SENTINEL_VALUE);
  });

  it("RES-04: rate-limit bails early", async () => {
    const opRead: OpReadFn = vi.fn(async () => {
      throw new Error(
        "Too many requests. Your client has been rate-limited.",
      );
    });

    const r = new SecretsResolver({
      opRead,
      log: silentLogger(),
      retryOptions: { retries: 3, minTimeout: 1, maxTimeout: 1, randomize: false },
    });

    await expect(r.resolve("op://example-vault-6")).rejects.toThrow(/op:\/\/example-vault-6/);

    // Early-bail: attempt 1 fires (initial), attempt 2's onFailedAttempt
    // throws AbortError → no third invocation. Total opRead calls ≤ 2.
    expect((opRead as ReturnType<typeof vi.fn>).mock.calls.length).toBeLessThanOrEqual(2);
    expect(r.snapshot().rateLimitHits).toBeGreaterThanOrEqual(1);
    expect(r.snapshot().lastFailureReason).toMatch(/rate.?limit|too many requests/i);
  });

  it("RES-05: empty resolution throws AbortError", async () => {
    const opRead: OpReadFn = vi.fn(async () => "");
    const r = new SecretsResolver({
      opRead,
      log: silentLogger(),
      retryOptions: { retries: 3, minTimeout: 1, maxTimeout: 1, randomize: false },
    });

    await expect(r.resolve("op://example-vault-6")).rejects.toThrow(/empty string/);

    // Empty resolution is permanent (AbortError) — should not retry, and
    // must NOT be cached.
    expect((opRead as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
    expect(r.snapshot().cacheSize).toBe(0);
    expect(r.getCached("op://example-vault-6")).toBeUndefined();
  });

  it("RES-06: preResolveAll partial failure", async () => {
    const opRead: OpReadFn = vi.fn(async (uri: string) => {
      if (uri === "op://example-vault-7") throw new Error("not authorized");
      return SENTINEL_VALUE;
    });

    const r = new SecretsResolver({
      opRead,
      log: silentLogger(),
      retryOptions: { retries: 0 },
    });

    const results = await r.preResolveAll(["op://example-vault-6", "op://example-vault-7"]);

    expect(results).toHaveLength(2);
    const a = results.find((x) => x.uri === "op://example-vault-6");
    const b = results.find((x) => x.uri === "op://example-vault-7");
    expect(a?.ok).toBe(true);
    expect(b?.ok).toBe(false);
    expect(b?.reason).toMatch(/not authorized/);
    // preResolveAll itself does not throw.
  });

  // Phase 999.33 — bounded-concurrency boot-storm prevention.
  // Pre-fix: Promise.allSettled fanned out N op CLI subprocesses
  // simultaneously, saturating 1Password's rate-limit window when N > 4-5.
  // Post-fix: cap in-flight resolutions to 4. Verified by tracking max
  // concurrent inflight count across a 12-URI resolution wave.
  it("RES-08: preResolveAll caps concurrent in-flight at 4 (boot-storm fix)", async () => {
    let inflight = 0;
    let maxInflight = 0;
    const opRead: OpReadFn = vi.fn(async (uri: string) => {
      inflight++;
      maxInflight = Math.max(maxInflight, inflight);
      // Simulate a slow op CLI shell-out so concurrent calls overlap.
      await new Promise((r) => setTimeout(r, 25));
      inflight--;
      return `${SENTINEL_VALUE}-${uri}`;
    });

    const r = new SecretsResolver({
      opRead,
      log: silentLogger(),
      retryOptions: { retries: 0 },
    });

    const uris = Array.from({ length: 12 }, (_, i) => `op://example-vault-item-${i}/credential`);
    const results = await r.preResolveAll(uris);

    expect(results).toHaveLength(12);
    expect(results.every((x) => x.ok)).toBe(true);
    // All 12 resolved exactly once (no waste).
    expect(opRead).toHaveBeenCalledTimes(12);
    // Concurrency was bounded — must NEVER exceed the cap. Pre-fix this
    // would have been 12 (or close to N).
    expect(maxInflight).toBeLessThanOrEqual(4);
    expect(maxInflight).toBeGreaterThan(1); // sanity — actually went parallel
  });

  it("RES-09: preResolveAll preserves URI→outcome ordering (deterministic out array)", async () => {
    // The wave processor uses a shared cursor; each worker writes to
    // out[idx] for its assigned URI. The returned array must mirror
    // the input order even if workers complete out-of-order.
    const opRead: OpReadFn = vi.fn(async (uri: string) => {
      // Delay inversely to URI index — last URIs resolve first.
      const idx = parseInt(uri.replace(/\D/g, ""), 10) || 0;
      await new Promise((r) => setTimeout(r, (10 - idx) * 5));
      return `${SENTINEL_VALUE}-${uri}`;
    });

    const r = new SecretsResolver({
      opRead,
      log: silentLogger(),
      retryOptions: { retries: 0 },
    });

    const uris = Array.from({ length: 8 }, (_, i) => `op://example-vault-item-${i}/credential`);
    const results = await r.preResolveAll(uris);

    for (let i = 0; i < uris.length; i++) {
      expect(results[i]?.uri).toBe(uris[i]);
    }
  });

  it("RES-10: preResolveAll handles empty input without crashing", async () => {
    const opRead: OpReadFn = vi.fn(async () => SENTINEL_VALUE);
    const r = new SecretsResolver({
      opRead,
      log: silentLogger(),
      retryOptions: { retries: 0 },
    });
    const results = await r.preResolveAll([]);
    expect(results).toEqual([]);
    expect(opRead).not.toHaveBeenCalled();
  });

  it("RES-07: counters track lifecycle", async () => {
    const calls = {
      sentinelCount: 0,
      transientThrown: false,
    };
    const opRead: OpReadFn = vi.fn(async (uri: string) => {
      if (uri === "op://example-vault-25") return SENTINEL_VALUE;
      if (uri === "op://example-vault-30") {
        if (!calls.transientThrown) {
          calls.transientThrown = true;
          throw new Error("transient ECONNRESET");
        }
        return SENTINEL_VALUE;
      }
      if (uri === "op://example-vault-28") {
        throw new Error("Too many requests. Your client has been rate-limited.");
      }
      if (uri === "op://example-vault-22") return "";
      throw new Error(`unexpected uri ${uri}`);
    });

    const r = new SecretsResolver({
      opRead,
      log: silentLogger(),
      retryOptions: { retries: 3, minTimeout: 1, maxTimeout: 1, randomize: false },
    });

    // 1) miss + cache + hit
    await r.resolve("op://example-vault-25");
    await r.resolve("op://example-vault-25");
    // 2) retry-then-success
    await r.resolve("op://example-vault-30");
    // 3) rate-limit (rejects)
    await expect(r.resolve("op://example-vault-28")).rejects.toThrow();
    // 4) empty (rejects)
    await expect(r.resolve("op://example-vault-22")).rejects.toThrow();

    const snap = r.snapshot();
    expect(snap.hits).toBe(1);
    expect(snap.misses).toBeGreaterThanOrEqual(4); // hit, retry, ratelimit, empty
    expect(snap.retries).toBeGreaterThanOrEqual(1);
    expect(snap.rateLimitHits).toBeGreaterThanOrEqual(1);
    expect(snap.lastFailureAt).toBeDefined();
    // ISO 8601 sanity check
    expect(snap.lastFailureAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    expect(snap.lastFailureReason).toBeDefined();
    expect(snap.lastRefreshedAt).toBeDefined();
    expect(snap.cacheSize).toBe(2); // hit + retry resolved; ratelimit + empty did not cache
  });

  it("RES-08: resolved value never logged", async () => {
    const { log, captured } = makeLogger();

    let attempt = 0;
    const opRead: OpReadFn = vi.fn(async (uri: string) => {
      if (uri === "op://example-vault-31") {
        attempt++;
        if (attempt === 1) throw new Error("transient");
        return SENTINEL_VALUE;
      }
      if (uri === "op://example-vault-20") {
        throw new Error("permanent CLI failure");
      }
      return SENTINEL_VALUE;
    });

    const r = new SecretsResolver({
      opRead,
      log,
      retryOptions: { retries: 3, minTimeout: 1, maxTimeout: 1, randomize: false },
    });

    // Successful resolve
    await r.resolve("op://example-vault-24");
    // Retry-then-success
    await r.resolve("op://example-vault-31");
    // Permanent failure
    await expect(r.resolve("op://example-vault-20")).rejects.toThrow();
    // Cache invalidate (also logs)
    r.invalidate("op://example-vault-24");
    r.invalidateAll();

    const allLogs = captured();
    expect(allLogs.length).toBeGreaterThan(0); // sanity — sink received output
    expect(allLogs).not.toContain(SENTINEL_VALUE);
  });

  it("RES-09: error messages contain only URI", async () => {
    const opRead: OpReadFn = vi.fn(async () => {
      throw new Error("auth fail with token=abc123");
    });
    const r = new SecretsResolver({
      opRead,
      log: silentLogger(),
      retryOptions: { retries: 0 },
    });

    let caught: Error | undefined;
    try {
      await r.resolve("op://example-vault-16/Y/Z");
      expect.fail("expected throw");
    } catch (e) {
      caught = e as Error;
    }

    expect(caught).toBeDefined();
    expect(caught!.message).toContain("op://example-vault-16/Y/Z");
    expect(caught!.message).toContain("auth fail with token=abc123"); // operator-controlled CLI noise — fine
    // The resolved sentinel must never appear in the error (no resolution
    // happened, so this is enforced by construction — but we verify the
    // wrapping format does not echo any cached-value bleed-through).
    expect(caught!.message).not.toContain(SENTINEL_VALUE);
    expect(caught!.message).toMatch(/^Failed to resolve op:\/\/example-vault-16\/Y\/Z after retries: /);
  });
});

/**
 * INC-2026-07-27 — 1Password outage fallback.
 *
 * A rate-limited service account made a daemon restart resolve 0/17 refs and
 * two agents whose 1password MCP token is itself an op:// ref could not start.
 * These pin the three layers that keep the fleet alive through an outage:
 * operator env fallback, durable last-known-good, and the circuit breaker that
 * stops our own retries from sustaining the throttle.
 */
describe("SecretsResolver — outage fallback (INC-2026-07-27)", () => {
  const URI = "op://example-vault-21/Acme-Service-Token-1PW/credential";
  const LIVE = "live-value-aaa111";
  const LKG = "last-known-good-bbb222";
  const ENVV = "env-fallback-ccc333";

  const rateLimited = (): Promise<string> =>
    Promise.reject(new Error("Too many requests. Your client has been rate-limited."));

  function makeStore(initial: Record<string, { value: string; savedAt: number }> = {}) {
    let state = { ...initial };
    return {
      saved: () => state,
      store: {
        load: () => state,
        save: (e: Record<string, { value: string; savedAt: number }>) => {
          state = { ...e };
        },
      },
    };
  }

  it("persists a successful resolve to the durable store (so a restart can serve it)", async () => {
    const { store, saved } = makeStore();
    const r = new SecretsResolver({
      opRead: async () => LIVE,
      log: silentLogger(),
      persistentStore: store,
      now: () => 1_000,
    });
    expect(await r.resolve(URI)).toBe(LIVE);
    expect(saved()[URI]).toEqual({ value: LIVE, savedAt: 1_000 });
  });

  it("serves the LAST-KNOWN-GOOD value when op is rate-limited (the 07-27 restart scenario)", async () => {
    const { store } = makeStore({ [URI]: { value: LKG, savedAt: 500 } });
    const { log, captured } = makeLogger();
    const r = new SecretsResolver({
      opRead: rateLimited,
      log,
      persistentStore: store,
      retryOptions: { retries: 1, minTimeout: 1, maxTimeout: 1 },
      now: () => 3_600_500,
    });
    expect(await r.resolve(URI)).toBe(LKG);
    // Loud + honest: staleness surfaced, secret value never logged.
    expect(captured()).toContain("STALE");
    expect(captured()).not.toContain(LKG);
    expect(r.snapshot().staleServed).toBe(1);
  });

  it("prefers the operator ENV fallback over a stale cached value", async () => {
    const { store } = makeStore({ [URI]: { value: LKG, savedAt: 500 } });
    const r = new SecretsResolver({
      opRead: rateLimited,
      log: silentLogger(),
      persistentStore: store,
      envFallback: (u) => (u === URI ? ENVV : undefined),
      retryOptions: { retries: 1, minTimeout: 1, maxTimeout: 1 },
    });
    expect(await r.resolve(URI)).toBe(ENVV);
    expect(r.snapshot().envFallbackServed).toBe(1);
    expect(r.snapshot().staleServed).toBe(0);
  });

  it("still THROWS when a live read fails and no fallback exists (no silent empty secret)", async () => {
    const r = new SecretsResolver({
      opRead: rateLimited,
      log: silentLogger(),
      retryOptions: { retries: 1, minTimeout: 1, maxTimeout: 1 },
    });
    await expect(r.resolve(URI)).rejects.toThrow(/Failed to resolve/);
  });

  it("ignores an EMPTY env fallback and an empty persisted value (never serves a blank secret)", async () => {
    const { store } = makeStore({ [URI]: { value: "", savedAt: 1 } });
    const r = new SecretsResolver({
      opRead: rateLimited,
      log: silentLogger(),
      persistentStore: store,
      envFallback: () => "",
      retryOptions: { retries: 1, minTimeout: 1, maxTimeout: 1 },
    });
    await expect(r.resolve(URI)).rejects.toThrow(/Failed to resolve/);
  });

  it("opens the circuit breaker after N consecutive rate limits and STOPS calling op", async () => {
    let calls = 0;
    const { store } = makeStore({ [URI]: { value: LKG, savedAt: 1 } });
    const r = new SecretsResolver({
      opRead: async () => {
        calls++;
        return rateLimited();
      },
      log: silentLogger(),
      persistentStore: store,
      retryOptions: { retries: 1, minTimeout: 1, maxTimeout: 1 },
      breakerThreshold: 2,
      breakerCooldownMs: 60_000,
      now: () => 10_000,
    });
    // Distinct URIs so the in-memory cache never short-circuits the read.
    // These have no fallback, so they reject — that is the point: two
    // consecutive rate-limited failures must trip the breaker.
    await expect(r.resolve("op://example-vault-33/a/f")).rejects.toThrow();
    await expect(r.resolve("op://example-vault-33/b/f")).rejects.toThrow();
    expect(r.snapshot().breakerOpen).toBe(true);
    const callsWhenOpen = calls;
    // Breaker open → served from the durable store WITHOUT shelling out.
    expect(await r.resolve(URI)).toBe(LKG);
    expect(calls).toBe(callsWhenOpen);
  });

  it("closes the breaker and refreshes the durable store once 1Password recovers", async () => {
    let fail = true;
    const { store, saved } = makeStore({ [URI]: { value: LKG, savedAt: 1 } });
    let clock = 10_000;
    const r = new SecretsResolver({
      opRead: async () => (fail ? rateLimited() : LIVE),
      log: silentLogger(),
      persistentStore: store,
      retryOptions: { retries: 1, minTimeout: 1, maxTimeout: 1 },
      breakerThreshold: 1,
      breakerCooldownMs: 1_000,
      now: () => clock,
    });
    await expect(r.resolve("op://example-vault-33/x/f")).rejects.toThrow();
    expect(r.snapshot().breakerOpen).toBe(true);
    // Cooldown elapses and 1P is healthy again.
    fail = false;
    clock = 20_000;
    expect(await r.resolve(URI)).toBe(LIVE);
    expect(r.snapshot().breakerOpen).toBe(false);
    expect(saved()[URI]).toEqual({ value: LIVE, savedAt: 20_000 });
  });

  it("REGRESSION: a fallback-served value is visible to getCached() — the mcp-broker token map reads it SYNCHRONOUSLY (2026-07-27 fleet-down)", async () => {
    // The broker builds tokenHash -> rawToken from secretsResolver.getCached().
    // When the fallback served without populating the cache, the broker
    // collected NO literal for this token, a shim handshake resolved
    // rawToken="" and the daemon threw a fatal -> fleet down.
    const { store } = makeStore({ [URI]: { value: LKG, savedAt: 1 } });
    const r = new SecretsResolver({
      opRead: rateLimited,
      log: silentLogger(),
      persistentStore: store,
      retryOptions: { retries: 1, minTimeout: 1, maxTimeout: 1 },
      // Injected clock (matches the sibling breaker tests). Without it `now`
      // is the real wall clock and this entry (savedAt: 1) reads as ~56 years
      // old, so the lkgMaxAgeMs ceiling refuses it and the resolve throws —
      // this test asserts the CACHE-POPULATION contract, not staleness.
      now: () => 1_000,
    });
    expect(await r.resolve(URI)).toBe(LKG);
    expect(r.getCached(URI)).toBe(LKG);
  });

  it("REGRESSION: an ENV-fallback value is also visible to getCached()", async () => {
    const r = new SecretsResolver({
      opRead: rateLimited,
      log: silentLogger(),
      envFallback: (u) => (u === URI ? ENVV : undefined),
      retryOptions: { retries: 1, minTimeout: 1, maxTimeout: 1 },
    });
    expect(await r.resolve(URI)).toBe(ENVV);
    expect(r.getCached(URI)).toBe(ENVV);
  });

  it("serves ONE consistent value per URI for the process lifetime (broker map and MCP env cannot diverge)", async () => {
    let live: string | null = null;
    const r = new SecretsResolver({
      opRead: async () => (live === null ? rateLimited() : live),
      log: silentLogger(),
      envFallback: (u) => (u === URI ? ENVV : undefined),
      retryOptions: { retries: 1, minTimeout: 1, maxTimeout: 1 },
    });
    expect(await r.resolve(URI)).toBe(ENVV);
    // Even once 1P recovers mid-process, the cached fallback keeps serving —
    // a mid-flight switch would leave the broker map and the spawned MCP env
    // holding DIFFERENT tokens, which is exactly the auth break we hit.
    live = LIVE;
    expect(await r.resolve(URI)).toBe(ENVV);
    expect(r.getCached(URI)).toBe(ENVV);
  });

  it("serves an LKG value UNDER lkgMaxAgeMs (the normal outage path, unchanged)", async () => {
    const { store } = makeStore({ [URI]: { value: LKG, savedAt: 0 } });
    const { log, captured } = makeLogger();
    const r = new SecretsResolver({
      opRead: rateLimited,
      log,
      persistentStore: store,
      retryOptions: { retries: 1, minTimeout: 1, maxTimeout: 1 },
      lkgMaxAgeMs: 86_400_000,
      now: () => 86_399_000,
    });
    expect(await r.resolve(URI)).toBe(LKG);
    expect(r.snapshot().staleServed).toBe(1);
    expect(r.snapshot().staleRefused).toBe(0);
    // Broker contract unchanged: the served value is in the SYNC cache that
    // the daemon's tokenHash → rawToken map reads.
    expect(r.getCached(URI)).toBe(LKG);
    expect(captured()).toContain("STALE");
    expect(captured()).not.toContain(LKG);
  });

  it("REFUSES an LKG value OVER lkgMaxAgeMs and fails the resolve (dead-secret end state)", async () => {
    const { store } = makeStore({ [URI]: { value: LKG, savedAt: 0 } });
    const { log, captured } = makeLogger();
    const r = new SecretsResolver({
      opRead: rateLimited,
      log,
      persistentStore: store,
      retryOptions: { retries: 1, minTimeout: 1, maxTimeout: 1 },
      lkgMaxAgeMs: 86_400_000,
      now: () => 86_400_001,
    });
    // Falls through to the SAME "no fallback available" throw as before —
    // no new error type.
    await expect(r.resolve(URI)).rejects.toThrow(/Failed to resolve/);
    expect(r.snapshot().staleRefused).toBe(1);
    expect(r.snapshot().staleServed).toBe(0);
    // BROKER SAFETY: refusal yields ABSENCE, never a divergent literal. The
    // daemon token map and the spawned MCP env both read this cache, so a
    // missing entry degrades that one MCP — it can never make a shim hash a
    // token the daemon map lacks (the 2026-07-27 empty-rawToken fatal).
    expect(r.getCached(URI)).toBeUndefined();
    expect(captured()).toContain("REFUSED");
    expect(captured()).not.toContain(LKG);
  });

  it("treats ageMs === lkgMaxAgeMs as fresh (the ceiling is inclusive)", async () => {
    const { store } = makeStore({ [URI]: { value: LKG, savedAt: 0 } });
    const r = new SecretsResolver({
      opRead: rateLimited,
      log: silentLogger(),
      persistentStore: store,
      retryOptions: { retries: 1, minTimeout: 1, maxTimeout: 1 },
      lkgMaxAgeMs: 86_400_000,
      now: () => 86_400_000,
    });
    expect(await r.resolve(URI)).toBe(LKG);
    expect(r.snapshot().staleServed).toBe(1);
  });

  it("lkgMaxAgeMs: 0 disables the staleness check (parity with breakerThreshold: 0)", async () => {
    const { store } = makeStore({ [URI]: { value: LKG, savedAt: 0 } });
    const r = new SecretsResolver({
      opRead: rateLimited,
      log: silentLogger(),
      persistentStore: store,
      retryOptions: { retries: 1, minTimeout: 1, maxTimeout: 1 },
      lkgMaxAgeMs: 0,
      now: () => 10 * 365 * 24 * 3_600_000,
    });
    expect(await r.resolve(URI)).toBe(LKG);
    expect(r.snapshot().staleServed).toBe(1);
    expect(r.snapshot().staleRefused).toBe(0);
  });

  it("applies DEFAULT_LKG_MAX_AGE_MS when the knob is omitted (30d: serve at -1s, refuse at +1s)", async () => {
    const fresh = makeStore({ [URI]: { value: LKG, savedAt: 0 } });
    const rFresh = new SecretsResolver({
      opRead: rateLimited,
      log: silentLogger(),
      persistentStore: fresh.store,
      retryOptions: { retries: 1, minTimeout: 1, maxTimeout: 1 },
      now: () => DEFAULT_LKG_MAX_AGE_MS - 1_000,
    });
    expect(await rFresh.resolve(URI)).toBe(LKG);

    const stale = makeStore({ [URI]: { value: LKG, savedAt: 0 } });
    const rStale = new SecretsResolver({
      opRead: rateLimited,
      log: silentLogger(),
      persistentStore: stale.store,
      retryOptions: { retries: 1, minTimeout: 1, maxTimeout: 1 },
      now: () => DEFAULT_LKG_MAX_AGE_MS + 1_000,
    });
    await expect(rStale.resolve(URI)).rejects.toThrow(/Failed to resolve/);
    expect(rStale.snapshot().staleRefused).toBe(1);
  });

  it("still prefers the operator ENV fallback when the LKG entry is over-age (order preserved)", async () => {
    const { store } = makeStore({ [URI]: { value: LKG, savedAt: 0 } });
    const r = new SecretsResolver({
      opRead: rateLimited,
      log: silentLogger(),
      persistentStore: store,
      envFallback: (u) => (u === URI ? ENVV : undefined),
      retryOptions: { retries: 1, minTimeout: 1, maxTimeout: 1 },
      lkgMaxAgeMs: 1_000,
      now: () => 86_400_000,
    });
    expect(await r.resolve(URI)).toBe(ENVV);
    expect(r.snapshot().envFallbackServed).toBe(1);
    // The env branch returns first, so the age gate is never consulted.
    expect(r.snapshot().staleRefused).toBe(0);
  });

  it("breaker-open + over-age LKG throws the BREAKER message (existing throw sites unchanged)", async () => {
    const { store } = makeStore({ [URI]: { value: LKG, savedAt: 0 } });
    const r = new SecretsResolver({
      opRead: rateLimited,
      log: silentLogger(),
      persistentStore: store,
      retryOptions: { retries: 1, minTimeout: 1, maxTimeout: 1 },
      breakerThreshold: 1,
      breakerCooldownMs: 60_000,
      lkgMaxAgeMs: 1_000,
      now: () => 10_000,
    });
    await expect(r.resolve("op://example-vault-33/x/f")).rejects.toThrow();
    expect(r.snapshot().breakerOpen).toBe(true);
    await expect(r.resolve(URI)).rejects.toThrow(/circuit breaker open/);
    expect(r.snapshot().staleRefused).toBe(1);
  });

  it("survives a corrupt/unreadable durable store (boot must never fail on it)", () => {
    expect(
      () =>
        new SecretsResolver({
          opRead: async () => LIVE,
          log: silentLogger(),
          persistentStore: {
            load: () => {
              throw new Error("corrupt json");
            },
            save: () => undefined,
          },
        }),
    ).not.toThrow();
  });

  it("a failing save() never breaks a successful resolve", async () => {
    const r = new SecretsResolver({
      opRead: async () => LIVE,
      log: silentLogger(),
      persistentStore: {
        load: () => ({}),
        save: () => {
          throw new Error("ENOSPC");
        },
      },
    });
    expect(await r.resolve(URI)).toBe(LIVE);
  });
});

/**
 * WS-5 (2026-08-28) — last-known-good FRESH-SERVE (`lkgFreshMs`) + forced
 * refresh.
 *
 * Every daemon restart re-read all 32 prod op:// refs live (~30 reads of a
 * 1,000/24h cap SHARED across every service account). With `lkgFreshMs` > 0
 * an LKG entry younger than the window is served with NO `op` spawn; a
 * rotation goes through `refresh()`, which drops the entry and reads live.
 * `lkgFreshMs: 0` (the default) must keep the pre-WS-5 behaviour byte-for-byte
 * — every test above this block runs without the knob and is unchanged.
 *
 * Fixture values are assembled from fragments at runtime (no secret-shaped
 * literals in the tree — GitGuardian).
 */
describe("SecretsResolver — WS-5 lkgFreshMs fresh-serve + refresh (2026-08-28)", () => {
  const URI = "op://example-vault-23/example.invalid/credential";
  const URI_B = "op://example-vault-23/other.invalid/credential";
  const frag = (tag: string): string => [tag, "val", "ws5"].join("-");
  const LKG = frag("lkg");
  const LIVE = frag("live");
  const HOUR = 3_600_000;
  const TWELVE_H = 12 * HOUR;

  function makeStore(initial: Record<string, { value: string; savedAt: number }> = {}) {
    let state = { ...initial };
    const save = vi.fn((e: Record<string, { value: string; savedAt: number }>) => {
      state = { ...e };
    });
    return { saved: () => state, save, store: { load: () => state, save } };
  }

  it("serves a FRESH last-known-good entry without spawning op (counter 1, cache warm, savedAt untouched)", async () => {
    const { store, saved, save } = makeStore({ [URI]: { value: LKG, savedAt: 1_000 } });
    const opRead = vi.fn<OpReadFn>(async () => LIVE);
    const r = new SecretsResolver({
      opRead,
      log: silentLogger(),
      persistentStore: store,
      lkgFreshMs: TWELVE_H,
      now: () => 1_000 + HOUR,
    });

    expect(await r.resolve(URI)).toBe(LKG);

    expect(opRead).not.toHaveBeenCalled();
    const snap = r.snapshot();
    expect(snap.lkgFreshServed).toBe(1);
    expect(snap.opReads).toBe(0);
    expect(snap.misses).toBe(0);
    expect(snap.cacheSize).toBe(1);
    // Broker contract: the served value is visible to the SYNC accessor.
    expect(r.getCached(URI)).toBe(LKG);
    // savedAt only advances on a LIVE read — a fresh serve neither rewrites
    // the entry nor touches the durable store.
    expect(saved()[URI]).toEqual({ value: LKG, savedAt: 1_000 });
    expect(save).not.toHaveBeenCalled();

    // Second resolve is an ordinary in-memory hit — the fresh counter does
    // not keep climbing for the same URI.
    expect(await r.resolve(URI)).toBe(LKG);
    expect(r.snapshot().hits).toBe(1);
    expect(r.snapshot().lkgFreshServed).toBe(1);
  });

  it("an entry older than lkgFreshMs but within lkgMaxAgeMs still reads LIVE (counter 0)", async () => {
    const { store, saved } = makeStore({ [URI]: { value: LKG, savedAt: 0 } });
    const opRead = vi.fn<OpReadFn>(async () => LIVE);
    const r = new SecretsResolver({
      opRead,
      log: silentLogger(),
      persistentStore: store,
      lkgFreshMs: TWELVE_H,
      lkgMaxAgeMs: DEFAULT_LKG_MAX_AGE_MS,
      now: () => TWELVE_H + 1,
    });

    expect(await r.resolve(URI)).toBe(LIVE);

    expect(opRead).toHaveBeenCalledTimes(1);
    expect(r.snapshot().lkgFreshServed).toBe(0);
    expect(r.snapshot().opReads).toBe(1);
    // The live read refreshed the durable entry.
    expect(saved()[URI]).toEqual({ value: LIVE, savedAt: TWELVE_H + 1 });
  });

  it("treats ageMs === lkgFreshMs as fresh (inclusive, same convention as lkgMaxAgeMs)", async () => {
    const { store } = makeStore({ [URI]: { value: LKG, savedAt: 0 } });
    const opRead = vi.fn<OpReadFn>(async () => LIVE);
    const r = new SecretsResolver({
      opRead,
      log: silentLogger(),
      persistentStore: store,
      lkgFreshMs: TWELVE_H,
      now: () => TWELVE_H,
    });
    expect(await r.resolve(URI)).toBe(LKG);
    expect(opRead).not.toHaveBeenCalled();
  });

  it("lkgFreshMs: 0 (the default) keeps today's behaviour — a fresh entry is still read LIVE", async () => {
    for (const lkgFreshMs of [undefined, 0]) {
      const { store } = makeStore({ [URI]: { value: LKG, savedAt: 1_000 } });
      const opRead = vi.fn<OpReadFn>(async () => LIVE);
      const r = new SecretsResolver({
        opRead,
        log: silentLogger(),
        persistentStore: store,
        ...(lkgFreshMs === undefined ? {} : { lkgFreshMs }),
        now: () => 2_000,
      });
      expect(await r.resolve(URI)).toBe(LIVE);
      expect(opRead).toHaveBeenCalledTimes(1);
      expect(r.snapshot().lkgFreshServed).toBe(0);
    }
  });

  it("never fresh-serves an EMPTY persisted value (reads live instead)", async () => {
    const { store } = makeStore({ [URI]: { value: "", savedAt: 1_000 } });
    const opRead = vi.fn<OpReadFn>(async () => LIVE);
    const r = new SecretsResolver({
      opRead,
      log: silentLogger(),
      persistentStore: store,
      lkgFreshMs: TWELVE_H,
      now: () => 1_000,
    });
    expect(await r.resolve(URI)).toBe(LIVE);
    expect(opRead).toHaveBeenCalledTimes(1);
    expect(r.snapshot().lkgFreshServed).toBe(0);
  });

  it("clamps the fresh window to lkgMaxAgeMs — an entry the outage path would REFUSE is never 'fresh'", async () => {
    const { store } = makeStore({ [URI]: { value: LKG, savedAt: 0 } });
    const opRead = vi.fn<OpReadFn>(async () => LIVE);
    const r = new SecretsResolver({
      opRead,
      log: silentLogger(),
      persistentStore: store,
      lkgFreshMs: 10_000,
      lkgMaxAgeMs: 1_000,
      now: () => 5_000,
    });
    expect(await r.resolve(URI)).toBe(LIVE);
    expect(opRead).toHaveBeenCalledTimes(1);
    expect(r.snapshot().lkgFreshServed).toBe(0);
  });

  it("outage path unchanged: a live-read failure still serves a within-lkgMaxAgeMs entry as STALE when it is past the fresh window", async () => {
    const { store } = makeStore({ [URI]: { value: LKG, savedAt: 0 } });
    const opRead = vi.fn<OpReadFn>(async () => {
      throw new Error("Too many requests. Your client has been rate-limited.");
    });
    const r = new SecretsResolver({
      opRead,
      log: silentLogger(),
      persistentStore: store,
      retryOptions: { retries: 1, minTimeout: 1, maxTimeout: 1 },
      lkgFreshMs: 1_000,
      lkgMaxAgeMs: 24 * HOUR,
      now: () => HOUR,
    });
    expect(await r.resolve(URI)).toBe(LKG);
    expect(opRead).toHaveBeenCalled();
    expect(r.snapshot().staleServed).toBe(1);
    expect(r.snapshot().lkgFreshServed).toBe(0);
  });

  it("refresh(uri) drops cache + last-known-good and reads LIVE (savedAt advances, outcome ok)", async () => {
    const { store, saved, save } = makeStore({ [URI]: { value: LKG, savedAt: 1_000 } });
    const opRead = vi.fn<OpReadFn>(async () => LIVE);
    const r = new SecretsResolver({
      opRead,
      log: silentLogger(),
      persistentStore: store,
      lkgFreshMs: TWELVE_H,
      now: () => 1_000 + HOUR,
    });
    // Boot-time resolve fresh-serves — zero reads.
    expect(await r.resolve(URI)).toBe(LKG);
    expect(opRead).not.toHaveBeenCalled();

    // Rotation: force the live read.
    const outcome = await r.refresh(URI);

    expect(outcome).toEqual({ uri: URI, ok: true });
    expect(opRead).toHaveBeenCalledTimes(1);
    expect(r.getCached(URI)).toBe(LIVE);
    expect(saved()[URI]).toEqual({ value: LIVE, savedAt: 1_000 + HOUR });
    // The drop was persisted BEFORE the read (crash-safety), then the live
    // value was persisted — two saves.
    expect(save).toHaveBeenCalledTimes(2);
    expect(r.snapshot().lkgFreshServed).toBe(1);
    expect(r.snapshot().opReads).toBe(1);
    // A later resolve is an in-memory hit on the NEW value.
    expect(await r.resolve(URI)).toBe(LIVE);
  });

  it("refresh(uri) on a failing live read reports the reason and leaves NO stale value behind", async () => {
    const { store, saved } = makeStore({ [URI]: { value: LKG, savedAt: 1_000 } });
    const opRead = vi.fn<OpReadFn>(async () => {
      throw new Error("not authorized");
    });
    const r = new SecretsResolver({
      opRead,
      log: silentLogger(),
      persistentStore: store,
      retryOptions: { retries: 0 },
      lkgFreshMs: TWELVE_H,
      now: () => 1_000 + HOUR,
    });

    const outcome = await r.refresh(URI);

    expect(outcome.ok).toBe(false);
    expect(outcome.uri).toBe(URI);
    expect(outcome.reason).toMatch(/not authorized/);
    expect(outcome.reason).not.toContain(LKG);
    // The pre-rotation value is gone from BOTH stores — it must not be
    // fresh-served after the next boot.
    expect(r.getCached(URI)).toBeUndefined();
    expect(saved()[URI]).toBeUndefined();
  });

  it("refresh() rejects a non-op:// URI without touching op", async () => {
    const opRead = vi.fn<OpReadFn>(async () => LIVE);
    const r = new SecretsResolver({ opRead, log: silentLogger() });
    const outcome = await r.refresh("not-a-ref");
    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toMatch(/not an op:\/\/ URI/);
    expect(opRead).not.toHaveBeenCalled();
  });

  it("refreshAll() returns one outcome per held URI in order, reading each live once", async () => {
    const { store, saved } = makeStore({
      [URI]: { value: LKG, savedAt: 1_000 },
      [URI_B]: { value: frag("lkg-b"), savedAt: 1_000 },
    });
    const opRead = vi.fn<OpReadFn>(async (uri: string) => {
      if (uri === URI_B) throw new Error("not authorized");
      return LIVE;
    });
    const r = new SecretsResolver({
      opRead,
      log: silentLogger(),
      persistentStore: store,
      retryOptions: { retries: 0 },
      lkgFreshMs: TWELVE_H,
      now: () => 1_000 + HOUR,
    });

    const results = await r.refreshAll();

    expect(results).toHaveLength(2);
    expect(results[0]).toEqual({ uri: URI, ok: true });
    expect(results[1]?.uri).toBe(URI_B);
    expect(results[1]?.ok).toBe(false);
    expect(results[1]?.reason).toMatch(/not authorized/);
    expect(opRead).toHaveBeenCalledTimes(2);
    expect(saved()[URI]).toEqual({ value: LIVE, savedAt: 1_000 + HOUR });
    expect(saved()[URI_B]).toBeUndefined();
  });

  it("refreshAll() also covers cache-only entries (no durable store wired)", async () => {
    const opRead = vi.fn<OpReadFn>(async () => LIVE);
    const r = new SecretsResolver({ opRead, log: silentLogger(), retryOptions: { retries: 0 } });
    await r.resolve(URI);
    const results = await r.refreshAll();
    expect(results).toEqual([{ uri: URI, ok: true }]);
    expect(opRead).toHaveBeenCalledTimes(2);
  });

  it("refreshAll() caps concurrent in-flight reads at 4 (same boot-storm guard as preResolveAll)", async () => {
    let inflight = 0;
    let maxInflight = 0;
    const initial: Record<string, { value: string; savedAt: number }> = {};
    for (let i = 0; i < 12; i++) {
      initial[`op://example-vault-23/item-${i}.invalid/credential`] = { value: frag(`v${i}`), savedAt: 0 };
    }
    const { store } = makeStore(initial);
    const opRead = vi.fn<OpReadFn>(async (uri: string) => {
      inflight++;
      maxInflight = Math.max(maxInflight, inflight);
      await new Promise((rs) => setTimeout(rs, 20));
      inflight--;
      return `${LIVE}-${uri}`;
    });
    const r = new SecretsResolver({
      opRead,
      log: silentLogger(),
      persistentStore: store,
      retryOptions: { retries: 0 },
      now: () => 0,
    });
    const results = await r.refreshAll();
    expect(results).toHaveLength(12);
    expect(results.every((x) => x.ok)).toBe(true);
    expect(opRead).toHaveBeenCalledTimes(12);
    expect(maxInflight).toBeLessThanOrEqual(4);
    expect(maxInflight).toBeGreaterThan(1);
  });

  it("preResolveAll logs ONE summary line (served N of M) when the window is enabled — never per secret, never the value", async () => {
    const { store } = makeStore({
      [URI]: { value: LKG, savedAt: 1_000 },
      [URI_B]: { value: frag("lkg-b"), savedAt: 1_000 },
      "op://example-vault-23/third.invalid/credential": { value: frag("lkg-c"), savedAt: 1_000 },
    });
    const { log, captured } = makeLogger();
    const opRead = vi.fn<OpReadFn>(async () => LIVE);
    const r = new SecretsResolver({
      opRead,
      log,
      persistentStore: store,
      lkgFreshMs: TWELVE_H,
      now: () => 1_000 + HOUR,
    });

    const results = await r.preResolveAll([
      URI,
      URI_B,
      "op://example-vault-23/third.invalid/credential",
      "op://example-vault-23/uncached.invalid/credential",
    ]);

    expect(results.every((x) => x.ok)).toBe(true);
    // Only the un-persisted URI cost a read.
    expect(opRead).toHaveBeenCalledTimes(1);
    expect(r.snapshot().lkgFreshServed).toBe(3);
    expect(r.snapshot().opReads).toBe(1);

    const logs = captured();
    const summaryLines = logs
      .split("\n")
      .filter((l) => l.includes("served 3 of 4 secrets from last-known-good"));
    expect(summaryLines).toHaveLength(1);
    expect(summaryLines[0]).toContain('"lkgFreshServed":3');
    expect(summaryLines[0]).toContain('"liveReads":1');
    expect(summaryLines[0]).toContain('"total":4');
    expect(logs).not.toContain(LKG);
    expect(logs).not.toContain(LIVE);
  });

  it("preResolveAll logs NO fresh-serve summary when lkgFreshMs is 0 (log output unchanged)", async () => {
    const { store } = makeStore({ [URI]: { value: LKG, savedAt: 1_000 } });
    const { log, captured } = makeLogger();
    const r = new SecretsResolver({
      opRead: async () => LIVE,
      log,
      persistentStore: store,
      now: () => 2_000,
    });
    await r.preResolveAll([URI]);
    expect(captured()).not.toContain("from last-known-good (fresh");
  });
});
