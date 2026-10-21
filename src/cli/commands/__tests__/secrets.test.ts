/**
 * WS-5 (2026-08-28) — `clawcode secrets` pure formatters.
 */
import { describe, expect, it } from "vitest";
import {
  formatRefreshAll,
  formatRefreshOutcome,
  formatSecretsStatus,
} from "../secrets.js";

describe("clawcode secrets — formatters", () => {
  it("status block surfaces the read-budget pair (op reads spent vs LKG fresh-served)", () => {
    const out = formatSecretsStatus({
      ok: true,
      cacheSize: 32,
      hits: 120,
      misses: 2,
      retries: 0,
      rateLimitHits: 0,
      envFallbackServed: 0,
      staleServed: 0,
      breakerOpen: false,
      lkgFreshServed: 30,
      opReads: 2,
      lastRefreshedAt: "2026-08-28T12:00:00.000Z",
    });
    expect(out).toContain("Secrets cache (daemon)");
    expect(out).toMatch(/op reads\s+2 /);
    expect(out).toMatch(/LKG fresh-served\s+30 /);
    expect(out).toMatch(/breaker open\s+no/);
    expect(out).toMatch(/last failure\s+-/);
  });

  it("status block shouts when the breaker is open", () => {
    const out = formatSecretsStatus({
      ok: true,
      cacheSize: 0,
      hits: 0,
      misses: 3,
      retries: 3,
      rateLimitHits: 3,
      envFallbackServed: 0,
      staleServed: 0,
      breakerOpen: true,
      lkgFreshServed: 0,
      opReads: 6,
      lastFailureAt: "2026-08-28T12:00:00.000Z",
      lastFailureReason: "rate-limited at attempt 2",
    });
    expect(out).toContain("YES — op reads suppressed");
    expect(out).toContain("rate-limited at attempt 2");
  });

  it("refresh outcome lines: ok vs failed with reason", () => {
    expect(formatRefreshOutcome({ uri: "op://example-vault-33/i.invalid/f", ok: true })).toBe(
      "✓ op://example-vault-33/i.invalid/f refreshed (live read)",
    );
    expect(
      formatRefreshOutcome({ uri: "op://example-vault-33/i.invalid/f", ok: false, reason: "not authorized" }),
    ).toBe("✗ op://example-vault-33/i.invalid/f FAILED: not authorized");
  });

  it("refresh-all renders one line per URI plus a totals line; empty daemon says so", () => {
    const out = formatRefreshAll({
      ok: false,
      refreshed: "all",
      total: 2,
      failed: 1,
      results: [
        { uri: "op://example-vault-33/a.invalid/f", ok: true },
        { uri: "op://example-vault-33/b.invalid/f", ok: false, reason: "not authorized" },
      ],
    });
    expect(out.split("\n")[0]).toContain("✓ op://example-vault-33/a.invalid/f");
    expect(out.split("\n")[1]).toContain("✗ op://example-vault-33/b.invalid/f FAILED: not authorized");
    expect(out).toContain("refreshed 1/2 live (1 FAILED)");

    expect(
      formatRefreshAll({ ok: true, refreshed: "all", total: 0, failed: 0, results: [] }),
    ).toMatch(/nothing to refresh/);
  });
});
