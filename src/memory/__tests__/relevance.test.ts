import { describe, it, expect } from "vitest";
import { distanceToSimilarity, scoreAndRank, type ScoringConfig } from "../relevance.js";
import type { SearchResult } from "../types.js";

/** Helper to create a mock SearchResult. */
function makeResult(overrides: Partial<SearchResult> & { distance: number }): SearchResult {
  return {
    id: "mem-1",
    content: "test memory",
    source: "conversation",
    importance: 0.5,
    accessCount: 1,
    tags: Object.freeze([] as string[]),
    embedding: null,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    accessedAt: "2026-04-09T00:00:00Z",
    tier: "warm" as const,
    sourceTurnIds: null,
    ...overrides,
  };
}

describe("distanceToSimilarity", () => {
  it("returns 1.0 for distance 0 (identical)", () => {
    expect(distanceToSimilarity(0)).toBe(1.0);
  });

  it("returns 0.0 for distance 1 (orthogonal)", () => {
    expect(distanceToSimilarity(1)).toBe(0.0);
  });

  it("returns 0.0 for distance 2 (opposite, clamped)", () => {
    expect(distanceToSimilarity(2)).toBe(0.0);
  });

  it("returns 0.7 for distance 0.3", () => {
    expect(distanceToSimilarity(0.3)).toBeCloseTo(0.7, 5);
  });

  it("clamps negative distances to max 1.0", () => {
    expect(distanceToSimilarity(-0.5)).toBeLessThanOrEqual(1.0);
  });
});

describe("scoreAndRank", () => {
  const now = new Date("2026-04-09T00:00:00Z");
  const defaultConfig: ScoringConfig = {
    semanticWeight: 0.7,
    decayWeight: 0.3,
    halfLifeDays: 30,
  };

  it("ranks recently accessed memories higher than stale ones (same distance)", () => {
    const recent = makeResult({
      id: "recent",
      distance: 0.2,
      importance: 0.8,
      accessedAt: "2026-04-08T00:00:00Z", // yesterday
    });
    const stale = makeResult({
      id: "stale",
      distance: 0.2,
      importance: 0.8,
      accessedAt: "2026-02-08T00:00:00Z", // ~60 days ago
    });

    const ranked = scoreAndRank([stale, recent], defaultConfig, now);

    expect(ranked[0].id).toBe("recent");
    expect(ranked[1].id).toBe("stale");
    expect(ranked[0].combinedScore).toBeGreaterThan(ranked[1].combinedScore);
  });

  it("produces expected combined scores with default weights", () => {
    const result = makeResult({
      distance: 0.2,
      importance: 0.8,
      accessedAt: now.toISOString(), // no decay
    });

    const ranked = scoreAndRank([result], defaultConfig, now);

    // similarity = 1 - 0.2 = 0.8
    // relevance = 0.8 (no decay)
    // combined = 0.8 * 0.7 + 0.8 * 0.3 = 0.56 + 0.24 = 0.8
    expect(ranked[0].combinedScore).toBeCloseTo(0.8, 2);
    expect(ranked[0].relevanceScore).toBeCloseTo(0.8, 2);
  });

  it("returns frozen array of frozen objects", () => {
    const result = makeResult({ distance: 0.3, importance: 0.5 });
    const ranked = scoreAndRank([result], defaultConfig, now);

    expect(Object.isFrozen(ranked)).toBe(true);
    expect(Object.isFrozen(ranked[0])).toBe(true);
  });

  it("returns empty frozen array for empty input", () => {
    const ranked = scoreAndRank([], defaultConfig, now);

    expect(ranked).toEqual([]);
    expect(Object.isFrozen(ranked)).toBe(true);
  });

  it("supports custom weights", () => {
    const customConfig: ScoringConfig = {
      semanticWeight: 0.5,
      decayWeight: 0.5,
      halfLifeDays: 30,
    };

    const result = makeResult({
      distance: 0.2,
      importance: 0.8,
      accessedAt: now.toISOString(),
    });

    const ranked = scoreAndRank([result], customConfig, now);

    // similarity = 0.8, relevance = 0.8
    // combined = 0.8 * 0.5 + 0.8 * 0.5 = 0.8
    expect(ranked[0].combinedScore).toBeCloseTo(0.8, 2);
  });

  it("includes relevanceScore and combinedScore fields", () => {
    const result = makeResult({ distance: 0.1, importance: 0.9 });
    const ranked = scoreAndRank([result], defaultConfig, now);

    expect(ranked[0]).toHaveProperty("relevanceScore");
    expect(ranked[0]).toHaveProperty("combinedScore");
    expect(typeof ranked[0].relevanceScore).toBe("number");
    expect(typeof ranked[0].combinedScore).toBe("number");
  });
});
