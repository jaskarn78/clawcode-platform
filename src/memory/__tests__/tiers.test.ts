import { describe, it, expect } from "vitest";
import {
  shouldPromoteToHot,
  shouldDemoteToWarm,
  shouldArchiveToCold,
  DEFAULT_TIER_CONFIG,
} from "../tiers.js";
import type { TierConfig } from "../tiers.js";

describe("DEFAULT_TIER_CONFIG", () => {
  it("has correct default values", () => {
    expect(DEFAULT_TIER_CONFIG).toEqual({
      hotAccessThreshold: 3,
      hotAccessWindowDays: 7,
      hotDemotionDays: 7,
      coldRelevanceThreshold: 0.05,
      hotBudget: 20,
      centralityPromoteThreshold: 5,
    });
  });

  it("is frozen (immutable)", () => {
    expect(Object.isFrozen(DEFAULT_TIER_CONFIG)).toBe(true);
  });

  // TC-A5: Phase 100-fu — graph-centrality threshold default is 5.
  // Captures hub nodes in the wikilink graph (memories with >=5 inbound
  // wikilinks are structurally important even if rarely directly accessed).
  it("TC-A5: centralityPromoteThreshold default is 5", () => {
    expect(DEFAULT_TIER_CONFIG.centralityPromoteThreshold).toBe(5);
  });
});

describe("shouldPromoteToHot", () => {
  const now = new Date("2026-04-09T12:00:00Z");
  const config = DEFAULT_TIER_CONFIG;

  it("returns true when accessCount >= 3 and accessedAt within 7 days", () => {
    const accessedAt = new Date("2026-04-05T12:00:00Z").toISOString(); // 4 days ago
    expect(shouldPromoteToHot(3, accessedAt, now, config)).toBe(true);
  });

  it("returns true when accessCount exceeds threshold and accessedAt is today", () => {
    const accessedAt = now.toISOString();
    expect(shouldPromoteToHot(10, accessedAt, now, config)).toBe(true);
  });

  it("returns false when accessCount < 3", () => {
    const accessedAt = now.toISOString();
    expect(shouldPromoteToHot(2, accessedAt, now, config)).toBe(false);
  });

  it("returns false when accessCount is 0", () => {
    const accessedAt = now.toISOString();
    expect(shouldPromoteToHot(0, accessedAt, now, config)).toBe(false);
  });

  it("returns false when accessedAt older than 7 days even with high access count", () => {
    const accessedAt = new Date("2026-03-30T12:00:00Z").toISOString(); // 10 days ago
    expect(shouldPromoteToHot(100, accessedAt, now, config)).toBe(false);
  });

  it("returns true at exactly 7 days boundary (edge case)", () => {
    const accessedAt = new Date("2026-04-02T12:00:00Z").toISOString(); // exactly 7 days ago
    expect(shouldPromoteToHot(3, accessedAt, now, config)).toBe(true);
  });

  it("returns false at exactly 8 days (just past window)", () => {
    const accessedAt = new Date("2026-04-01T12:00:00Z").toISOString(); // 8 days ago
    expect(shouldPromoteToHot(3, accessedAt, now, config)).toBe(false);
  });

  it("respects custom config thresholds", () => {
    const customConfig: TierConfig = {
      ...config,
      hotAccessThreshold: 5,
      hotAccessWindowDays: 3,
    };
    const accessedAt = new Date("2026-04-07T12:00:00Z").toISOString(); // 2 days ago
    expect(shouldPromoteToHot(4, accessedAt, now, customConfig)).toBe(false); // below 5
    expect(shouldPromoteToHot(5, accessedAt, now, customConfig)).toBe(true);
  });

  // Phase 100-fu — graph-centrality promotion path. Heavy-backlink hubs
  // are structurally important (every backlink is a wikilink edge from
  // some other memory) and should be promoted to hot tier even when their
  // direct access_count is low. Production audit (fin-client agent):
  // 1,161 of 1,182 memories at access_count=0 despite 7,338 wikilink edges.

  // TC-A1: at-or-above the centrality threshold => promote.
  it("TC-A1: returns true when backlinkCount >= centralityPromoteThreshold (5)", () => {
    const accessedAt = new Date("2025-01-01T00:00:00Z").toISOString(); // very old
    // accessCount=0, ancient access — the access-based path returns false,
    // forcing the centrality path to be the reason for the true result.
    expect(shouldPromoteToHot(0, accessedAt, now, config, 5)).toBe(true);
  });

  // TC-A2: just below the threshold => no promotion. Confirms the
  // boundary is `>=` not `>`.
  it("TC-A2: returns false when backlinkCount < centralityPromoteThreshold", () => {
    const accessedAt = now.toISOString();
    expect(shouldPromoteToHot(0, accessedAt, now, config, 4)).toBe(false);
  });

  // TC-A3: back-compat — omitting the new param leaves all existing
  // call sites operating exactly as before this fix.
  it("TC-A3: backlinkCount=undefined behaves identically to pre-fix (only access path)", () => {
    const accessedAt = new Date("2026-04-05T12:00:00Z").toISOString(); // 4 days ago
    // Same inputs as the first happy-path test above — expect the same
    // result with the new param omitted.
    expect(shouldPromoteToHot(3, accessedAt, now, config)).toBe(true);

    // Below access threshold + undefined backlinkCount must be false
    // (no centrality fallback to rescue the row).
    expect(shouldPromoteToHot(2, accessedAt, now, config)).toBe(false);

    // Old access date + undefined backlinkCount must also be false.
    const oldAccess = new Date("2026-03-30T12:00:00Z").toISOString(); // 10 days
    expect(shouldPromoteToHot(100, oldAccess, now, config)).toBe(false);
  });

  // TC-A4: centrality wins over a stale + low-access record. This is the
  // exact production scenario: a hub node at access_count=0 with an old
  // accessed_at but heavy inbound links — must still promote.
  it("TC-A4: high backlinkCount overrides low access AND old accessedAt", () => {
    const ancient = new Date("2024-01-01T00:00:00Z").toISOString();
    // 6 backlinks (above the default-5 threshold), accessCount=0,
    // accessedAt 2+ years old — the access-based path returns false, and
    // the centrality path returns true.
    expect(shouldPromoteToHot(0, ancient, now, config, 6)).toBe(true);
  });

  // Custom centrality threshold is honored.
  it("respects custom centralityPromoteThreshold", () => {
    const customConfig: TierConfig = {
      ...config,
      centralityPromoteThreshold: 10,
    };
    const accessedAt = now.toISOString();
    expect(shouldPromoteToHot(0, accessedAt, now, customConfig, 9)).toBe(false);
    expect(shouldPromoteToHot(0, accessedAt, now, customConfig, 10)).toBe(true);
  });
});

describe("shouldDemoteToWarm", () => {
  const now = new Date("2026-04-09T12:00:00Z");
  const config = DEFAULT_TIER_CONFIG;

  it("returns true when accessedAt >= 7 days ago", () => {
    const accessedAt = new Date("2026-04-01T12:00:00Z").toISOString(); // 8 days ago
    expect(shouldDemoteToWarm(accessedAt, now, config)).toBe(true);
  });

  it("returns true when accessedAt is exactly 7 days ago", () => {
    const accessedAt = new Date("2026-04-02T12:00:00Z").toISOString(); // exactly 7 days
    expect(shouldDemoteToWarm(accessedAt, now, config)).toBe(true);
  });

  it("returns false when accessedAt < 7 days ago", () => {
    const accessedAt = new Date("2026-04-05T12:00:00Z").toISOString(); // 4 days ago
    expect(shouldDemoteToWarm(accessedAt, now, config)).toBe(false);
  });

  it("returns false when accessedAt is today", () => {
    const accessedAt = now.toISOString();
    expect(shouldDemoteToWarm(accessedAt, now, config)).toBe(false);
  });

  it("returns true for very old access date", () => {
    const accessedAt = new Date("2025-01-01T00:00:00Z").toISOString();
    expect(shouldDemoteToWarm(accessedAt, now, config)).toBe(true);
  });

  it("respects custom hotDemotionDays config", () => {
    const customConfig: TierConfig = { ...config, hotDemotionDays: 14 };
    const accessedAt = new Date("2026-04-01T12:00:00Z").toISOString(); // 8 days ago
    expect(shouldDemoteToWarm(accessedAt, now, customConfig)).toBe(false); // < 14 days
  });
});

describe("shouldArchiveToCold", () => {
  const now = new Date("2026-04-09T12:00:00Z");
  const config = DEFAULT_TIER_CONFIG;

  it("returns true when relevance score drops below 0.05", () => {
    // importance=0.5, accessedAt 365 days ago with halfLife=30 days
    // relevance = 0.5 * 0.5^(365/30) = 0.5 * 0.5^12.17 ~= 0.5 * 0.000217 ~= 0.000109
    const accessedAt = new Date("2025-04-09T12:00:00Z").toISOString();
    expect(shouldArchiveToCold(0.5, accessedAt, now, config)).toBe(true);
  });

  it("returns false when relevance score is above threshold", () => {
    // importance=0.8, accessedAt today => relevance = 0.8
    const accessedAt = now.toISOString();
    expect(shouldArchiveToCold(0.8, accessedAt, now, config)).toBe(false);
  });

  it("returns false for high-importance recent memory", () => {
    const accessedAt = new Date("2026-04-08T12:00:00Z").toISOString(); // 1 day ago
    expect(shouldArchiveToCold(1.0, accessedAt, now, config)).toBe(false);
  });

  it("returns true for low-importance old memory", () => {
    // importance=0.1, 100 days ago => 0.1 * 0.5^(100/30) = 0.1 * 0.5^3.33 ~= 0.1 * 0.099 ~= 0.0099
    const accessedAt = new Date("2025-12-31T12:00:00Z").toISOString();
    expect(shouldArchiveToCold(0.1, accessedAt, now, config)).toBe(true);
  });

  it("respects custom coldRelevanceThreshold", () => {
    const customConfig: TierConfig = { ...config, coldRelevanceThreshold: 0.5 };
    // importance=0.8, accessedAt=today => relevance ~0.8, above 0.5
    const accessedAt = now.toISOString();
    expect(shouldArchiveToCold(0.8, accessedAt, now, customConfig)).toBe(false);

    // importance=0.3, 60 days ago => 0.3 * 0.5^(60/30) = 0.3 * 0.25 = 0.075, below 0.5
    const oldAccess = new Date("2026-02-08T12:00:00Z").toISOString();
    expect(shouldArchiveToCold(0.3, oldAccess, now, customConfig)).toBe(true);
  });
});
