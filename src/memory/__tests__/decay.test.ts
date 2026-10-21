import { describe, it, expect } from "vitest";
import { calculateRelevanceScore } from "../decay.js";
import { decayConfigSchema, dedupConfigSchema, memoryConfigSchema } from "../schema.js";

describe("calculateRelevanceScore", () => {
  const now = new Date("2026-04-09T00:00:00Z");

  it("returns importance when accessed just now (no decay)", () => {
    const result = calculateRelevanceScore(0.8, now.toISOString(), now, { halfLifeDays: 30 });
    expect(result).toBeCloseTo(0.8, 5);
  });

  it("returns ~half importance at exactly one half-life (30 days)", () => {
    const thirtyDaysAgo = new Date("2026-03-10T00:00:00Z");
    const result = calculateRelevanceScore(0.8, thirtyDaysAgo.toISOString(), now, { halfLifeDays: 30 });
    expect(result).toBeCloseTo(0.4, 1);
  });

  it("returns ~quarter importance at two half-lives (60 days)", () => {
    const sixtyDaysAgo = new Date("2026-02-08T00:00:00Z");
    const result = calculateRelevanceScore(0.8, sixtyDaysAgo.toISOString(), now, { halfLifeDays: 30 });
    expect(result).toBeCloseTo(0.2, 1);
  });

  it("returns 1.0 for max importance accessed now", () => {
    const result = calculateRelevanceScore(1.0, now.toISOString(), now, { halfLifeDays: 30 });
    expect(result).toBe(1.0);
  });

  it("returns importance unchanged for future accessedAt (no negative decay)", () => {
    const futureDate = new Date("2026-05-01T00:00:00Z");
    const result = calculateRelevanceScore(0.8, futureDate.toISOString(), now, { halfLifeDays: 30 });
    expect(result).toBeCloseTo(0.8, 5);
  });

  it("clamps result to [0, 1] range", () => {
    // importance > 1 should clamp
    const result = calculateRelevanceScore(1.5, now.toISOString(), now, { halfLifeDays: 30 });
    expect(result).toBeLessThanOrEqual(1.0);

    // Very old memory should be >= 0
    const veryOld = new Date("2020-01-01T00:00:00Z");
    const resultOld = calculateRelevanceScore(0.5, veryOld.toISOString(), now, { halfLifeDays: 30 });
    expect(resultOld).toBeGreaterThanOrEqual(0);
  });
});

describe("decayConfigSchema", () => {
  it("provides sensible defaults", () => {
    const parsed = decayConfigSchema.parse({});
    expect(parsed.halfLifeDays).toBe(30);
    expect(parsed.semanticWeight).toBe(0.7);
    expect(parsed.decayWeight).toBe(0.3);
  });

  it("rejects halfLifeDays less than 1", () => {
    expect(() => decayConfigSchema.parse({ halfLifeDays: 0 })).toThrow();
  });

  it("rejects semanticWeight outside 0-1", () => {
    expect(() => decayConfigSchema.parse({ semanticWeight: 1.5 })).toThrow();
    expect(() => decayConfigSchema.parse({ semanticWeight: -0.1 })).toThrow();
  });

  it("rejects decayWeight outside 0-1", () => {
    expect(() => decayConfigSchema.parse({ decayWeight: 1.5 })).toThrow();
    expect(() => decayConfigSchema.parse({ decayWeight: -0.1 })).toThrow();
  });
});

describe("dedupConfigSchema", () => {
  it("provides sensible defaults", () => {
    const parsed = dedupConfigSchema.parse({});
    expect(parsed.enabled).toBe(true);
    expect(parsed.similarityThreshold).toBe(0.85);
  });

  it("rejects similarityThreshold outside 0-1", () => {
    expect(() => dedupConfigSchema.parse({ similarityThreshold: 1.5 })).toThrow();
    expect(() => dedupConfigSchema.parse({ similarityThreshold: -0.1 })).toThrow();
  });
});

describe("memoryConfigSchema includes decay and deduplication", () => {
  it("includes decay config with defaults", () => {
    const parsed = memoryConfigSchema.parse({});
    expect(parsed.decay).toBeDefined();
    expect(parsed.decay.halfLifeDays).toBe(30);
  });

  it("includes deduplication config with defaults", () => {
    const parsed = memoryConfigSchema.parse({});
    expect(parsed.deduplication).toBeDefined();
    expect(parsed.deduplication.enabled).toBe(true);
  });
});
