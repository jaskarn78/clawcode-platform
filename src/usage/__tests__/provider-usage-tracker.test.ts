/**
 * Phase 138 Plan 01 T-01 — `ProviderUsageTracker` behavior pinning.
 *
 * Proves the 6 cases from the PLAN `<action>` block:
 *   (1) Constructor creates the `provider_usage` table.
 *   (2) Single `recordTurn` inserts a row with correct cost.
 *   (3) Two `recordTurn` on same (date, provider, model) accumulates.
 *   (4) Two `recordTurn` on different providers same day → 2 distinct
 *       rows; `getDailyAggregate` returns both.
 *   (5) `recordTurn` with unknown model → cost_usd = 0 but turn_count
 *       + tokens still tracked.
 *   (6) `getDailyByProviderModel(date)` returns rows with all fields.
 *
 * Mirrors the in-memory better-sqlite3 pattern from
 * `src/usage/advisor-budget.test.ts` (CONTEXT D2 — the SQLite-test
 * template). A deterministic injected `clock` makes timestamps +
 * default-date resolution reproducible.
 *
 * See:
 *   - `src/usage/provider-usage-tracker.ts`
 *   - `.planning/phases/138-.../138-01-PLAN.md` T-01 <behavior>
 */

import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import {
  ProviderUsageTracker,
  DEFAULT_DAILY_CAP_USD,
} from "../provider-usage-tracker.js";

/**
 * Fixed wall clock — 2026-05-20T12:00:00Z. UTC date slice is
 * "2026-05-20". All `recordTurn` calls without an explicit `date`
 * resolve to this day.
 */
const FIXED_MILLIS = Date.parse("2026-05-20T12:00:00.000Z");
const FIXED_DATE = "2026-05-20";

describe("ProviderUsageTracker", () => {
  let db: InstanceType<typeof Database>;
  let tracker: ProviderUsageTracker;

  beforeEach(() => {
    db = new Database(":memory:");
    tracker = new ProviderUsageTracker(db, () => FIXED_MILLIS);
  });

  describe("constructor", () => {
    it("creates the provider_usage table", () => {
      const row = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='provider_usage'",
        )
        .get();
      expect(row).toBeDefined();
    });

    it("is idempotent — re-construction does not throw", () => {
      expect(() => new ProviderUsageTracker(db, () => FIXED_MILLIS)).not.toThrow();
    });

    it("exports DEFAULT_DAILY_CAP_USD = 6.67", () => {
      expect(DEFAULT_DAILY_CAP_USD).toBeCloseTo(6.67, 2);
    });
  });

  describe("recordTurn", () => {
    it("inserts a single row with the correct cost", () => {
      // Phase 999.114 — sonnet is $2 in / $10 out per million (Sonnet 5's real
      // rate; the previous $3/$15 was the pre-Sonnet-5 rate and over-reported
      // every sonnet turn by 50%).
      // 1_000_000 in + 1_000_000 out → 2.0 + 10.0 = 12.0 USD.
      const row = tracker.recordTurn({
        agent: "agent-a",
        provider: "anthropic",
        model: "sonnet",
        tokensIn: 1_000_000,
        tokensOut: 1_000_000,
      });
      expect(row.date).toBe(FIXED_DATE);
      expect(row.provider).toBe("anthropic");
      expect(row.model).toBe("sonnet");
      expect(row.tokens_in).toBe(1_000_000);
      expect(row.tokens_out).toBe(1_000_000);
      expect(row.cost_usd).toBeCloseTo(12.0, 6);
      expect(row.turn_count).toBe(1);
      expect(row.created_at).toBe(FIXED_MILLIS);
      expect(row.updated_at).toBe(FIXED_MILLIS);
    });

    it("accumulates on the same (date, provider, model) key", () => {
      tracker.recordTurn({
        agent: "agent-a",
        provider: "anthropic",
        model: "sonnet",
        tokensIn: 1_000_000,
        tokensOut: 1_000_000,
      });
      const second = tracker.recordTurn({
        agent: "agent-a",
        provider: "anthropic",
        model: "sonnet",
        tokensIn: 500_000,
        tokensOut: 200_000,
      });
      expect(second.turn_count).toBe(2);
      expect(second.tokens_in).toBe(1_500_000);
      expect(second.tokens_out).toBe(1_200_000);
      // 12.0 + (0.5 * 2.0 + 0.2 * 10.0) = 12.0 + 3.0 = 15.0
      expect(second.cost_usd).toBeCloseTo(15.0, 6);
    });

    it("inserts distinct rows for different providers the same day", () => {
      tracker.recordTurn({
        agent: "agent-a",
        provider: "anthropic",
        model: "sonnet",
        tokensIn: 100,
        tokensOut: 100,
      });
      tracker.recordTurn({
        agent: "agent-a",
        provider: "openai",
        model: "gpt-5-codex",
        tokensIn: 100,
        tokensOut: 100,
      });
      const rows = tracker.getDailyByProviderModel(FIXED_DATE);
      expect(rows.length).toBe(2);
      const providers = rows.map((r) => r.provider).sort();
      expect(providers).toEqual(["anthropic", "openai"]);
    });

    it("tracks tokens + turn_count for an unknown model with cost_usd = 0", () => {
      const row = tracker.recordTurn({
        agent: "agent-a",
        provider: "openai",
        model: "totally-unknown-model",
        tokensIn: 4_000,
        tokensOut: 2_000,
      });
      expect(row.cost_usd).toBe(0);
      expect(row.turn_count).toBe(1);
      expect(row.tokens_in).toBe(4_000);
      expect(row.tokens_out).toBe(2_000);
    });

    it("honours an explicit date override", () => {
      const row = tracker.recordTurn({
        agent: "agent-a",
        provider: "anthropic",
        model: "haiku",
        tokensIn: 10,
        tokensOut: 10,
        date: "2026-01-01",
      });
      expect(row.date).toBe("2026-01-01");
      expect(tracker.getDailyByProviderModel(FIXED_DATE).length).toBe(0);
      expect(tracker.getDailyByProviderModel("2026-01-01").length).toBe(1);
    });
  });

  describe("getDailyAggregate", () => {
    it("returns a per-provider rollup summed across models", () => {
      tracker.recordTurn({
        agent: "agent-a",
        provider: "anthropic",
        model: "sonnet",
        tokensIn: 1_000_000,
        tokensOut: 0,
      });
      tracker.recordTurn({
        agent: "agent-a",
        provider: "anthropic",
        model: "haiku",
        tokensIn: 1_000_000,
        tokensOut: 0,
      });
      tracker.recordTurn({
        agent: "agent-a",
        provider: "openai",
        model: "gpt-5-codex",
        tokensIn: 100,
        tokensOut: 100,
      });
      const agg = tracker.getDailyAggregate(FIXED_DATE);
      const anthropic = agg.get("anthropic");
      expect(anthropic).toBeDefined();
      expect(anthropic?.turn_count).toBe(2);
      expect(anthropic?.tokens_in).toBe(2_000_000);
      // Phase 999.114 — sonnet 1M-in (2.0) + haiku 1M-in (1.0) = 3.0.
      // haiku was $0.25 (the retired Haiku 3.5 rate); Haiku 4.5 is $1 in.
      expect(anthropic?.cost_usd).toBeCloseTo(3.0, 6);
      expect(agg.get("openai")?.turn_count).toBe(1);
    });

    it("returns an empty map for a date with no rows", () => {
      expect(tracker.getDailyAggregate("2020-01-01").size).toBe(0);
    });
  });

  describe("getDailyByProviderModel", () => {
    it("returns frozen rows with all fields in stable order", () => {
      tracker.recordTurn({
        agent: "agent-a",
        provider: "openai",
        model: "o3",
        tokensIn: 1,
        tokensOut: 1,
      });
      tracker.recordTurn({
        agent: "agent-a",
        provider: "anthropic",
        model: "opus",
        tokensIn: 1,
        tokensOut: 1,
      });
      const rows = tracker.getDailyByProviderModel(FIXED_DATE);
      expect(rows.length).toBe(2);
      // Stable order: provider ASC, model ASC.
      expect(rows[0]?.provider).toBe("anthropic");
      expect(rows[1]?.provider).toBe("openai");
      for (const row of rows) {
        expect(row).toHaveProperty("date");
        expect(row).toHaveProperty("provider");
        expect(row).toHaveProperty("model");
        expect(row).toHaveProperty("tokens_in");
        expect(row).toHaveProperty("tokens_out");
        expect(row).toHaveProperty("cost_usd");
        expect(row).toHaveProperty("turn_count");
        expect(row).toHaveProperty("created_at");
        expect(row).toHaveProperty("updated_at");
        expect(Object.isFrozen(row)).toBe(true);
      }
    });
  });
});
