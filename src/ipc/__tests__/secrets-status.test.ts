/**
 * Phase 999.10 — SEC-06 IPC handler tests.
 *
 * Wave 3 plan 04 wires the `secrets-status` + `secrets-invalidate` IPC
 * methods into the daemon. These tests exercise the pure handler module
 * (`secrets-ipc-handler.ts`) directly — no IPC server boot required —
 * verifying the zod-validated response shape, single-URI invalidation,
 * full-cache flush, and zod request-shape rejection of non-op:// URIs.
 *
 * IPC-SECSTATUS-01 — counter snapshot returned, validates against zod
 * IPC-SECSTATUS-02 — invalidate clears one URI when uri param present
 * IPC-SECSTATUS-03 — invalidate clears entire cache when uri param omitted
 * IPC-SECSTATUS-04 — invalidate rejects non-op:// uri via zod (defense-in-depth)
 */

import { describe, it, expect, vi } from "vitest";
import pino from "pino";
import { Writable } from "node:stream";
import { SecretsResolver } from "../../manager/secrets-resolver.js";
import {
  handleSecretsStatus,
  handleSecretsInvalidate,
  handleSecretsRefresh,
} from "../../manager/secrets-ipc-handler.js";
import {
  SecretsStatusResponseSchema,
  SecretsRefreshResponseSchema,
} from "../protocol.js";

/** Silent pino logger — handler tests don't inspect log output. */
function makeSilentLog(): pino.Logger {
  const sink = new Writable({
    write(_chunk, _enc, cb) {
      cb();
    },
  });
  return pino({ level: "silent" }, sink);
}

describe("ipc method secrets-status", () => {
  it("IPC-SECSTATUS-01: returns zod-validated counter snapshot", async () => {
    const log = makeSilentLog();
    const opRead = vi.fn(async (uri: string) => `value-${uri}`);
    const r = new SecretsResolver({
      opRead,
      log,
      retryOptions: { retries: 0, minTimeout: 1, maxTimeout: 1, randomize: false },
    });
    // 1 miss + cache, then 1 hit on the same URI.
    await r.resolve("op://example-vault-6/B/C");
    await r.resolve("op://example-vault-6/B/C");

    const response = handleSecretsStatus(r);

    // The response MUST validate against the wire-level zod schema —
    // catches drift between SecretsResolver.snapshot() and the IPC
    // contract before it reaches a CLI consumer.
    const parsed = SecretsStatusResponseSchema.safeParse(response);
    expect(parsed.success, parsed.success ? "ok" : JSON.stringify(parsed.error)).toBe(true);

    expect(response.ok).toBe(true);
    expect(response.cacheSize).toBe(1);
    expect(response.hits).toBe(1);
    expect(response.misses).toBe(1);
    expect(response.retries).toBe(0);
    expect(response.rateLimitHits).toBe(0);
    // WS-5 — read-budget pair: one live op read, nothing fresh-served.
    expect(response.opReads).toBe(1);
    expect(response.lkgFreshServed).toBe(0);
    // lastRefreshedAt populated on the happy path.
    expect(response.lastRefreshedAt).toBeDefined();
    // No failures yet — failure fields stay undefined (omitted from response).
    expect(response.lastFailureAt).toBeUndefined();
    expect(response.lastFailureReason).toBeUndefined();
  });

  it("IPC-SECSTATUS-02: secrets-invalidate clears single URI when uri param present", async () => {
    const log = makeSilentLog();
    const opRead = vi.fn(async (uri: string) => `value-${uri}`);
    const r = new SecretsResolver({
      opRead,
      log,
      retryOptions: { retries: 0, minTimeout: 1, maxTimeout: 1, randomize: false },
    });
    await r.resolve("op://example-vault-6/B/C");
    await r.resolve("op://example-vault-8/E/F");
    expect(r.snapshot().cacheSize).toBe(2);

    const response = handleSecretsInvalidate(r, { uri: "op://example-vault-6/B/C" });

    expect(response).toEqual({ ok: true, invalidated: "op://example-vault-6/B/C" });
    // First URI flushed, second untouched.
    expect(r.getCached("op://example-vault-6/B/C")).toBeUndefined();
    expect(r.getCached("op://example-vault-8/E/F")).toBe("value-op://example-vault-8/E/F");
    expect(r.snapshot().cacheSize).toBe(1);
  });

  it("IPC-SECSTATUS-03: secrets-invalidate clears all when uri param omitted", async () => {
    const log = makeSilentLog();
    const opRead = vi.fn(async (uri: string) => `value-${uri}`);
    const r = new SecretsResolver({
      opRead,
      log,
      retryOptions: { retries: 0, minTimeout: 1, maxTimeout: 1, randomize: false },
    });
    await r.resolve("op://example-vault-6/B/C");
    await r.resolve("op://example-vault-8/E/F");
    expect(r.snapshot().cacheSize).toBe(2);

    // Omit uri — should flush everything.
    const response = handleSecretsInvalidate(r, {});

    expect(response).toEqual({ ok: true, invalidated: "all" });
    expect(r.snapshot().cacheSize).toBe(0);
    expect(r.getCached("op://example-vault-6/B/C")).toBeUndefined();
    expect(r.getCached("op://example-vault-8/E/F")).toBeUndefined();
  });

  it("IPC-SECSTATUS-04: secrets-invalidate rejects non-op:// uri via zod", () => {
    const log = makeSilentLog();
    // No opRead invocation — this test asserts the zod guard fires before
    // the resolver is touched. opRead is a never-called sentinel.
    const opRead = vi.fn(async () => {
      throw new Error("opRead should not be invoked when zod rejects params");
    });
    const r = new SecretsResolver({ opRead, log });

    const response = handleSecretsInvalidate(r, { uri: "not-an-op-ref" });

    expect(response.ok).toBe(false);
    if (response.ok === false) {
      expect(response.error).toMatch(/Invalid params/);
    }
    // Sanity: cache untouched, opRead never called.
    expect(opRead).not.toHaveBeenCalled();
    expect(r.snapshot().cacheSize).toBe(0);
  });
});

/**
 * WS-5 (2026-08-28) — `secrets-status` read-budget counters + the new
 * `secrets-refresh` method (forced live re-read; the rotation path under
 * `defaults.secrets.lkgFreshMs`).
 *
 * IPC-SECSTATUS-05 — status surfaces lkgFreshServed / opReads
 * IPC-SECREFRESH-01 — refresh with uri drops LKG + cache, reads live
 * IPC-SECREFRESH-02 — refresh without uri returns the outcome list
 * IPC-SECREFRESH-03 — refresh rejects non-op:// uri via zod
 */
describe("ipc method secrets-refresh (WS-5)", () => {
  const URI_A = "op://example-vault-23/a.invalid/credential";
  const URI_B = "op://example-vault-23/b.invalid/credential";
  const frag = (tag: string): string => [tag, "ipc", "ws5"].join("-");

  function makeStore(initial: Record<string, { value: string; savedAt: number }>) {
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

  it("IPC-SECSTATUS-05: secrets-status surfaces lkgFreshServed + opReads and still validates", async () => {
    const { store } = makeStore({ [URI_A]: { value: frag("lkg"), savedAt: 1_000 } });
    const opRead = vi.fn(async () => frag("live"));
    const r = new SecretsResolver({
      opRead,
      log: makeSilentLog(),
      persistentStore: store,
      lkgFreshMs: 43_200_000,
      now: () => 2_000,
    });
    await r.resolve(URI_A);

    const response = handleSecretsStatus(r);

    const parsed = SecretsStatusResponseSchema.safeParse(response);
    expect(parsed.success, parsed.success ? "ok" : JSON.stringify(parsed.error)).toBe(true);
    expect(response.lkgFreshServed).toBe(1);
    expect(response.opReads).toBe(0);
    expect(opRead).not.toHaveBeenCalled();
  });

  it("IPC-SECREFRESH-01: secrets-refresh with uri drops LKG + cache and reads live", async () => {
    const { store, saved } = makeStore({ [URI_A]: { value: frag("lkg"), savedAt: 1_000 } });
    const opRead = vi.fn(async () => frag("live"));
    const r = new SecretsResolver({
      opRead,
      log: makeSilentLog(),
      persistentStore: store,
      retryOptions: { retries: 0 },
      lkgFreshMs: 43_200_000,
      now: () => 2_000,
    });
    await r.resolve(URI_A);
    expect(opRead).not.toHaveBeenCalled();

    const response = await handleSecretsRefresh(r, { uri: URI_A });

    expect(response).toEqual({ uri: URI_A, ok: true });
    expect(SecretsRefreshResponseSchema.safeParse(response).success).toBe(true);
    expect(opRead).toHaveBeenCalledTimes(1);
    expect(r.getCached(URI_A)).toBe(frag("live"));
    expect(saved()[URI_A]).toEqual({ value: frag("live"), savedAt: 2_000 });
  });

  it("IPC-SECREFRESH-02: secrets-refresh without uri refreshes every held secret and returns the outcome list", async () => {
    const { store } = makeStore({
      [URI_A]: { value: frag("lkg-a"), savedAt: 1_000 },
      [URI_B]: { value: frag("lkg-b"), savedAt: 1_000 },
    });
    const opRead = vi.fn(async (uri: string) => {
      if (uri === URI_B) throw new Error("not authorized");
      return frag("live");
    });
    const r = new SecretsResolver({
      opRead,
      log: makeSilentLog(),
      persistentStore: store,
      retryOptions: { retries: 0 },
      lkgFreshMs: 43_200_000,
      now: () => 2_000,
    });

    const response = await handleSecretsRefresh(r, {});

    expect(SecretsRefreshResponseSchema.safeParse(response).success).toBe(true);
    expect(response.ok).toBe(false);
    if ("refreshed" in response) {
      expect(response.refreshed).toBe("all");
      expect(response.total).toBe(2);
      expect(response.failed).toBe(1);
      expect(response.results[0]).toEqual({ uri: URI_A, ok: true });
      expect(response.results[1]?.uri).toBe(URI_B);
      expect(response.results[1]?.ok).toBe(false);
      expect(response.results[1]?.reason).toMatch(/not authorized/);
    } else {
      expect.fail("expected the refresh-all response shape");
    }
    expect(opRead).toHaveBeenCalledTimes(2);
  });

  it("IPC-SECREFRESH-03: secrets-refresh rejects non-op:// uri via zod (op never invoked)", async () => {
    const opRead = vi.fn(async () => {
      throw new Error("opRead should not be invoked when zod rejects params");
    });
    const r = new SecretsResolver({ opRead, log: makeSilentLog() });

    const response = await handleSecretsRefresh(r, { uri: "not-an-op-ref" });

    expect(response.ok).toBe(false);
    if ("error" in response) {
      expect(response.error).toMatch(/Invalid params for secrets-refresh/);
    } else {
      expect.fail("expected the zod-rejection shape");
    }
    expect(opRead).not.toHaveBeenCalled();
  });
});
