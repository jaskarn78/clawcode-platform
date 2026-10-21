/**
 * Phase 52 Plan 03 — `clawcode cache` CLI formatter tests.
 *
 * Exercises the pure-function formatters (no IPC, no daemon):
 *   - formatCacheTable: headers + column order, percent rendering, empty window
 *   - formatFleetCache: blank-line separators, empty fleet fallback
 *   - Cache-effect footer: suppressed null, shown delta
 */

import { describe, it, expect } from "vitest";
import {
  formatCacheTable,
  formatFleetCache,
  type AugmentedCacheReport,
} from "../cache.js";

function makeReport(
  overrides: Partial<AugmentedCacheReport> = {},
): AugmentedCacheReport {
  return Object.freeze({
    agent: "atlas",
    since: "2026-04-12T00:00:00.000Z",
    totalTurns: 50,
    avgHitRate: 0.72,
    p50HitRate: 0.75,
    p95HitRate: 0.50,
    totalCacheReads: 5000,
    totalCacheWrites: 1000,
    totalInputTokens: 1000,
    trendByDay: Object.freeze([]),
    status: "healthy" as const,
    cache_effect_ms: -700 as number | null,
    ...overrides,
  });
}

describe("formatCacheTable", () => {
  it("renders all 5 column headers: Hit Rate / Cache Reads / Cache Writes / Input Tokens / Turns", () => {
    const out = formatCacheTable(makeReport());
    expect(out).toContain("Hit Rate");
    expect(out).toContain("Cache Reads");
    expect(out).toContain("Cache Writes");
    expect(out).toContain("Input Tokens");
    expect(out).toContain("Turns");
  });

  it("renders hit rate as a percentage with one decimal (72.3% not 72.333%)", () => {
    const out = formatCacheTable(makeReport({ avgHitRate: 0.7234 }));
    expect(out).toContain("72.3%");
    expect(out).not.toContain("72.333");
    expect(out).not.toContain("72.0%");
  });

  it("renders counts with locale thousand separators", () => {
    const out = formatCacheTable(
      makeReport({
        totalCacheReads: 12345,
        totalCacheWrites: 2345,
        totalInputTokens: 3456,
        totalTurns: 100,
      }),
    );
    expect(out).toContain("12,345");
    expect(out).toContain("2,345");
    expect(out).toContain("3,456");
    expect(out).toContain("100");
  });

  it("renders status line with p50 and p95 hit rates", () => {
    const out = formatCacheTable(makeReport());
    expect(out).toContain("Status: healthy");
    expect(out).toContain("p50: 75.0%");
    expect(out).toContain("p95: 50.0%");
  });

  it("renders 'No cache data' when totalTurns === 0", () => {
    const out = formatCacheTable(makeReport({ totalTurns: 0 }));
    expect(out).toContain("No cache data for atlas");
    expect(out).not.toContain("Hit Rate");
  });

  it("includes cache effect footer with ms delta when non-null", () => {
    const out = formatCacheTable(makeReport({ cache_effect_ms: -650 }));
    expect(out).toContain("Cache effect: -650 ms");
    expect(out).toContain("negative = cache helps");
  });

  it("renders positive cache effect with '+' sign prefix", () => {
    const out = formatCacheTable(makeReport({ cache_effect_ms: 200 }));
    expect(out).toContain("Cache effect: +200 ms");
  });

  it("renders 'insufficient data' when cache_effect_ms is null (< 20 eligible turns)", () => {
    const out = formatCacheTable(makeReport({ cache_effect_ms: null }));
    expect(out).toContain("Cache effect: insufficient data");
    expect(out).toContain("< 20 eligible turns");
  });

  it("renders breach status when SLO tripped", () => {
    const out = formatCacheTable(
      makeReport({ avgHitRate: 0.15, status: "breach" }),
    );
    expect(out).toContain("Status: breach");
    expect(out).toContain("15.0%");
  });

  it("renders the agent name and 'since' window in the header", () => {
    const out = formatCacheTable(
      makeReport({ agent: "beacon", since: "2026-04-12T00:00:00.000Z" }),
    );
    expect(out).toContain("Cache for beacon");
    expect(out).toContain("2026-04-12T00:00:00.000Z");
  });
});

describe("formatFleetCache", () => {
  it("renders one block per report separated by blank lines", () => {
    const out = formatFleetCache([
      makeReport({ agent: "atlas" }),
      makeReport({ agent: "beacon", avgHitRate: 0.5, status: "healthy" }),
    ]);
    expect(out).toContain("Cache for atlas");
    expect(out).toContain("Cache for beacon");
    // Two blocks → at least one blank line between them.
    expect(out.split("\n\n").length).toBeGreaterThanOrEqual(2);
  });

  it("renders fallback when reports array is empty", () => {
    const out = formatFleetCache([]);
    expect(out).toBe("No cache data for any agent.");
  });

  it("handles a single-element fleet (edge case — --all with one running agent)", () => {
    const out = formatFleetCache([makeReport()]);
    expect(out).toContain("Cache for atlas");
    expect(out).toContain("Status: healthy");
  });
});
