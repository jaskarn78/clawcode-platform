import { describe, it, expect } from "vitest";

import {
  CACHE_HIT_RATE_SLO,
  DEFAULT_SLOS,
  evaluateCacheHitRateStatus,
  evaluateSloStatus,
  getPerToolSlo,
  mergeSloOverrides,
  type SloEntry,
} from "../slos.js";
import { CANONICAL_SEGMENTS } from "../types.js";

describe("DEFAULT_SLOS", () => {
  it("contains exactly five entries (4 Phase 51 + typing_indicator Phase 54) matching CONTEXT decisions verbatim", () => {
    expect(DEFAULT_SLOS).toHaveLength(5);

    const bySegment = new Map<string, SloEntry>(
      DEFAULT_SLOS.map((e) => [e.segment, e]),
    );

    expect(bySegment.get("end_to_end")).toEqual({
      segment: "end_to_end",
      metric: "p95",
      thresholdMs: 6000,
    });
    expect(bySegment.get("first_token")).toEqual({
      segment: "first_token",
      metric: "p50",
      thresholdMs: 2000,
    });
    expect(bySegment.get("context_assemble")).toEqual({
      segment: "context_assemble",
      metric: "p95",
      thresholdMs: 300,
    });
    expect(bySegment.get("tool_call")).toEqual({
      segment: "tool_call",
      metric: "p95",
      thresholdMs: 1500,
    });
    // Phase 54 addition — observational initially (CONTEXT D-03).
    expect(bySegment.get("typing_indicator")).toEqual({
      segment: "typing_indicator",
      metric: "p95",
      thresholdMs: 500,
    });

    // Sanity: every canonical segment that has a default SLO is represented
    // (first_visible_token is canonical but intentionally has no default SLO —
    // it's the debug/support metric, not headline).
    const withSlo: ReadonlySet<string> = new Set([
      "end_to_end",
      "first_token",
      "context_assemble",
      "tool_call",
      "typing_indicator",
    ]);
    for (const seg of CANONICAL_SEGMENTS) {
      if (withSlo.has(seg)) {
        expect(bySegment.has(seg)).toBe(true);
      }
    }
  });

  it("is fully frozen: array AND every entry", () => {
    expect(Object.isFrozen(DEFAULT_SLOS)).toBe(true);
    for (const entry of DEFAULT_SLOS) {
      expect(Object.isFrozen(entry)).toBe(true);
    }
  });
});

describe("evaluateSloStatus", () => {
  it("returns no_data when row.count === 0", () => {
    const row = { p50: null, p95: null, p99: null, count: 0 };
    expect(evaluateSloStatus(row, 1000, "p95")).toBe("no_data");
  });

  it("returns no_data when the requested metric is null even with count > 0", () => {
    const row = { p50: 100, p95: null, p99: null, count: 5 };
    expect(evaluateSloStatus(row, 1000, "p95")).toBe("no_data");
  });

  it("returns healthy when row[metric] !== null AND row[metric] <= thresholdMs", () => {
    const row = { p50: 800, p95: 1500, p99: 2500, count: 50 };
    expect(evaluateSloStatus(row, 1500, "p95")).toBe("healthy");
    expect(evaluateSloStatus(row, 2000, "p95")).toBe("healthy");
    expect(evaluateSloStatus(row, 800, "p50")).toBe("healthy");
  });

  it("returns breach when row[metric] !== null AND row[metric] > thresholdMs", () => {
    const row = { p50: 1200, p95: 5800, p99: 9000, count: 50 };
    expect(evaluateSloStatus(row, 5000, "p95")).toBe("breach");
    expect(evaluateSloStatus(row, 1000, "p50")).toBe("breach");
    expect(evaluateSloStatus(row, 1199, "p50")).toBe("breach");
  });
});

describe("mergeSloOverrides", () => {
  it("replaces threshold for an entry matching segment + metric", () => {
    const merged = mergeSloOverrides(DEFAULT_SLOS, [
      { segment: "end_to_end", metric: "p95", thresholdMs: 4000 },
    ]);
    expect(merged).toHaveLength(5);

    const bySeg = new Map<string, SloEntry>(merged.map((e) => [e.segment, e]));
    expect(bySeg.get("end_to_end")).toEqual({
      segment: "end_to_end",
      metric: "p95",
      thresholdMs: 4000,
    });
    // Others unchanged
    expect(bySeg.get("first_token")?.thresholdMs).toBe(2000);
    expect(bySeg.get("context_assemble")?.thresholdMs).toBe(300);
    expect(bySeg.get("tool_call")?.thresholdMs).toBe(1500);

    expect(Object.isFrozen(merged)).toBe(true);
  });

  it("appends rather than replaces when an override targets the same segment with a different metric", () => {
    // first_token default is p50/2000. Adding a p95 override on first_token
    // should APPEND a new entry, not replace the existing p50.
    const merged = mergeSloOverrides(DEFAULT_SLOS, [
      { segment: "first_token", metric: "p95", thresholdMs: 4500 },
    ]);
    expect(merged).toHaveLength(6);

    const firstTokenEntries = merged.filter((e) => e.segment === "first_token");
    expect(firstTokenEntries).toHaveLength(2);
    expect(firstTokenEntries.find((e) => e.metric === "p50")?.thresholdMs).toBe(
      2000,
    );
    expect(firstTokenEntries.find((e) => e.metric === "p95")?.thresholdMs).toBe(
      4500,
    );
    expect(Object.isFrozen(merged)).toBe(true);
  });
});

describe("Phase 54: CANONICAL_SEGMENTS + typing_indicator SLO integration", () => {
  it("CANONICAL_SEGMENTS has 6 entries in exact canonical order", () => {
    expect(CANONICAL_SEGMENTS).toHaveLength(6);
    expect([...CANONICAL_SEGMENTS]).toEqual([
      "end_to_end",
      "first_token",
      "first_visible_token",
      "context_assemble",
      "tool_call",
      "typing_indicator",
    ]);
  });

  it("evaluateSloStatus works against a typing_indicator row (healthy when p95 <= 500, breach when > 500)", () => {
    const healthyRow = { p50: 120, p95: 400, p99: 480, count: 20 };
    const breachRow = { p50: 200, p95: 650, p99: 900, count: 20 };
    expect(evaluateSloStatus(healthyRow, 500, "p95")).toBe("healthy");
    expect(evaluateSloStatus(breachRow, 500, "p95")).toBe("breach");
  });

  it("mergeSloOverrides accepts a typing_indicator override and replaces the thresholdMs in-place", () => {
    const merged = mergeSloOverrides(DEFAULT_SLOS, [
      { segment: "typing_indicator", metric: "p95", thresholdMs: 300 },
    ]);
    // 5 defaults, override replaces (not appends) → still 5
    expect(merged).toHaveLength(5);
    const typing = merged.find(
      (e) => e.segment === "typing_indicator" && e.metric === "p95",
    );
    expect(typing?.thresholdMs).toBe(300);
  });
});

describe("getPerToolSlo (Phase 55)", () => {
  it("falls back to global tool_call SLO (1500ms p95) when perTools is undefined", () => {
    const result = getPerToolSlo("memory_lookup", undefined);
    expect(result).toEqual({ thresholdMs: 1500, metric: "p95" });
    expect(Object.isFrozen(result)).toBe(true);
  });

  it("returns the per-tool override with default metric p95 when metric omitted", () => {
    const result = getPerToolSlo("memory_lookup", {
      slos: { memory_lookup: { thresholdMs: 100 } },
    });
    expect(result).toEqual({ thresholdMs: 100, metric: "p95" });
    expect(Object.isFrozen(result)).toBe(true);
  });

  it("honors explicit metric on the override", () => {
    const result = getPerToolSlo("memory_lookup", {
      slos: { memory_lookup: { thresholdMs: 50, metric: "p50" } },
    });
    expect(result).toEqual({ thresholdMs: 50, metric: "p50" });
  });

  it("unknown tools still fall back to global tool_call SLO (1500ms p95)", () => {
    // An override map with entries for some tools but not 'unknown_tool' —
    // the lookup must miss and return the global fallback, not null / throw.
    const result = getPerToolSlo("unknown_tool", {
      slos: { memory_lookup: { thresholdMs: 100 } },
    });
    expect(result).toEqual({ thresholdMs: 1500, metric: "p95" });
  });

  it("returns the global fallback when perTools has no slos field at all", () => {
    const result = getPerToolSlo("any_tool", {});
    expect(result).toEqual({ thresholdMs: 1500, metric: "p95" });
  });
});

describe("CACHE_HIT_RATE_SLO (Phase 52)", () => {
  it("CACHE_HIT_RATE_SLO has healthy ≥ 0.60, breach < 0.30 per CONTEXT", () => {
    expect(CACHE_HIT_RATE_SLO).toEqual({
      healthyMin: 0.6,
      breachMax: 0.3,
    });
    expect(Object.isFrozen(CACHE_HIT_RATE_SLO)).toBe(true);
  });

  it("evaluateCacheHitRateStatus returns no_data when turns === 0", () => {
    expect(evaluateCacheHitRateStatus(0.5, 0)).toBe("no_data");
    expect(evaluateCacheHitRateStatus(0.9, 0)).toBe("no_data");
    expect(evaluateCacheHitRateStatus(0.0, 0)).toBe("no_data");
  });

  it("evaluateCacheHitRateStatus returns healthy when hitRate >= 0.60", () => {
    expect(evaluateCacheHitRateStatus(0.6, 5)).toBe("healthy");
    expect(evaluateCacheHitRateStatus(0.75, 50)).toBe("healthy");
    expect(evaluateCacheHitRateStatus(0.99, 100)).toBe("healthy");
    expect(evaluateCacheHitRateStatus(1.0, 1)).toBe("healthy");
  });

  it("evaluateCacheHitRateStatus returns breach when hitRate < 0.30", () => {
    expect(evaluateCacheHitRateStatus(0.29, 10)).toBe("breach");
    expect(evaluateCacheHitRateStatus(0.1, 50)).toBe("breach");
    expect(evaluateCacheHitRateStatus(0.0, 10)).toBe("breach");
  });

  it("evaluateCacheHitRateStatus returns no_data (neutral) in the 0.30-0.60 gray zone", () => {
    // Gray zone → warming up → neutral tint. Neither green nor red.
    expect(evaluateCacheHitRateStatus(0.45, 10)).toBe("no_data");
    expect(evaluateCacheHitRateStatus(0.3, 10)).toBe("no_data");
    expect(evaluateCacheHitRateStatus(0.59, 100)).toBe("no_data");
  });
});
