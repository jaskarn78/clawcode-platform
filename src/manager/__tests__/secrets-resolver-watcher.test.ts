/**
 * Phase 999.10 Plan 03 — ConfigWatcher invalidation hook (SEC-05).
 *
 * The production daemon.ts wires its `ConfigWatcher.onChange` callback to
 * `applySecretsDiff(diff, secretsResolver, log)` (the bridge factored out of
 * the daemon to stay testable). These tests pin the bridge's two
 * observable behaviors:
 *
 *   WATCH-01: an op:// URI swap (oldValue=op://example-vault-16, newValue=op://example-vault-17) invalidates
 *             the OLD URI in the cache AND warm-resolves the NEW URI so the
 *             next agent spawn hits a hot cache.
 *
 *   WATCH-02: a brand-new op:// URI (oldValue=undefined, newValue=op://example-vault-18)
 *             does NOT call invalidate (no old URI to drop) and DOES warm-
 *             resolve the new URI.
 */
import { describe, it, expect, vi } from "vitest";
import pino from "pino";
import { Writable } from "node:stream";
import { SecretsResolver } from "../secrets-resolver.js";
import { applySecretsDiff } from "../secrets-watcher-bridge.js";
import type { ConfigDiff } from "../../config/types.js";

function makeNoopLog(): pino.Logger {
  return pino(
    { level: "silent" },
    new Writable({
      write(_chunk, _enc, cb) {
        cb();
      },
    }),
  );
}

function makeResolver(opRead: (uri: string) => Promise<string>): SecretsResolver {
  return new SecretsResolver({
    opRead,
    log: makeNoopLog(),
    // Drop retry-loop wall-time for the test path (tests don't exercise
    // failure modes; SecretsResolver's RES-* tests already cover those).
    retryOptions: { retries: 0, minTimeout: 1, maxTimeout: 1, randomize: false },
  });
}

describe("SecretsResolver × ConfigWatcher", () => {
  it("WATCH-01: changed URI invalidates old cache entry AND warm-resolves new URI", async () => {
    const opRead = vi.fn(async (uri: string) => `value-for-${uri}`);
    const resolver = makeResolver(opRead);
    const log = makeNoopLog();

    // Pre-warm the cache for the OLD URI so we can observe the invalidation.
    await resolver.resolve("op://example-vault-12/X/Y");
    expect(resolver.getCached("op://example-vault-12/X/Y")).toBe("value-for-op://example-vault-12/X/Y");
    expect(opRead).toHaveBeenCalledTimes(1);

    const invalidateSpy = vi.spyOn(resolver, "invalidate");

    const diff: ConfigDiff = {
      changes: [
        {
          fieldPath: "discord.botToken",
          oldValue: "op://example-vault-12/X/Y",
          newValue: "op://example-vault-11/X/Y",
          reloadable: false,
        },
      ],
      hasReloadableChanges: false,
      hasNonReloadableChanges: true,
    };
    await applySecretsDiff(diff, resolver, log);

    // Old URI got invalidated.
    expect(invalidateSpy).toHaveBeenCalledWith("op://example-vault-12/X/Y");
    expect(resolver.getCached("op://example-vault-12/X/Y")).toBeUndefined();

    // New URI got warm-resolved.
    expect(opRead).toHaveBeenCalledWith("op://example-vault-11/X/Y");
    expect(resolver.getCached("op://example-vault-11/X/Y")).toBe("value-for-op://example-vault-11/X/Y");
  });

  it("WATCH-02: newly added op:// URI is pre-resolved without invalidating anything", async () => {
    const opRead = vi.fn(async (uri: string) => `value-for-${uri}`);
    const resolver = makeResolver(opRead);
    const log = makeNoopLog();
    const invalidateSpy = vi.spyOn(resolver, "invalidate");

    const diff: ConfigDiff = {
      changes: [
        {
          fieldPath: "mcpServers.foo.env.KEY",
          oldValue: undefined,
          newValue: "op://example-vault-11/X/Y",
          reloadable: false,
        },
      ],
      hasReloadableChanges: false,
      hasNonReloadableChanges: true,
    };
    await applySecretsDiff(diff, resolver, log);

    // Nothing to invalidate — there was no prior URI.
    expect(invalidateSpy).not.toHaveBeenCalled();

    // New URI got warm-resolved exactly once.
    expect(opRead).toHaveBeenCalledTimes(1);
    expect(opRead).toHaveBeenCalledWith("op://example-vault-11/X/Y");
    expect(resolver.getCached("op://example-vault-11/X/Y")).toBe("value-for-op://example-vault-11/X/Y");
  });

  it("WATCH-03: op:// → literal swap invalidates the old URI and does NOT warm-resolve", async () => {
    const opRead = vi.fn(async (uri: string) => `value-for-${uri}`);
    const resolver = makeResolver(opRead);
    const log = makeNoopLog();

    await resolver.resolve("op://example-vault-12/X/Y");
    opRead.mockClear();
    const invalidateSpy = vi.spyOn(resolver, "invalidate");

    const diff: ConfigDiff = {
      changes: [
        {
          fieldPath: "discord.botToken",
          oldValue: "op://example-vault-12/X/Y",
          newValue: "literal-token-no-resolution-needed",
          reloadable: false,
        },
      ],
      hasReloadableChanges: false,
      hasNonReloadableChanges: true,
    };
    await applySecretsDiff(diff, resolver, log);

    expect(invalidateSpy).toHaveBeenCalledWith("op://example-vault-12/X/Y");
    expect(opRead).not.toHaveBeenCalled();
  });

  it("WATCH-04: non-secret diff entries are ignored (no invalidate, no resolve)", async () => {
    const opRead = vi.fn(async (uri: string) => `value-for-${uri}`);
    const resolver = makeResolver(opRead);
    const log = makeNoopLog();
    const invalidateSpy = vi.spyOn(resolver, "invalidate");

    const diff: ConfigDiff = {
      changes: [
        {
          fieldPath: "defaults.basePath",
          oldValue: "/old/path",
          newValue: "/new/path",
          reloadable: false,
        },
      ],
      hasReloadableChanges: false,
      hasNonReloadableChanges: true,
    };
    await applySecretsDiff(diff, resolver, log);

    expect(invalidateSpy).not.toHaveBeenCalled();
    expect(opRead).not.toHaveBeenCalled();
  });

  it("WATCH-05: warm-resolve failure is swallowed (callback does not throw)", async () => {
    const opRead = vi.fn(async (_uri: string) => {
      throw new Error("op CLI not authenticated");
    });
    const resolver = makeResolver(opRead);
    const log = makeNoopLog();

    const diff: ConfigDiff = {
      changes: [
        {
          fieldPath: "mcpServers.foo.env.KEY",
          oldValue: undefined,
          newValue: "op://example-vault-11/BROKEN/Y",
          reloadable: false,
        },
      ],
      hasReloadableChanges: false,
      hasNonReloadableChanges: true,
    };
    // Must not throw — the existing configReloader.applyChanges path still
    // needs to run regardless of secret warm-resolve failures.
    await expect(applySecretsDiff(diff, resolver, log)).resolves.toBeUndefined();
  });
});
