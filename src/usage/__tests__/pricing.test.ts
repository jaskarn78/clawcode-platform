/**
 * Phase 138 Plan 01 T-02 — pricing extension regression suite.
 *
 * Pins the 6 cases from the PLAN `<action>` block:
 *   (a) `lookupPricing("gpt-5-codex")` returns the gpt-5-codex entry.
 *   (b) `lookupPricing("o3")` returns the o3 entry (NOT o3-mini).
 *   (c) `lookupPricing("o3-mini")` returns the o3-mini entry
 *       (collision regression — must NOT fall through to o3).
 *   (d) `lookupPricing("haiku")` still returns haiku (no Anthropic
 *       regression from the OpenAI additions).
 *   (e) `estimateCost("gpt-5-codex", 1M, 1M)` = input + output rate.
 *   (f) `estimateCost("unknown-model", 100, 100)` = 0.
 *
 * See:
 *   - `src/usage/pricing.ts`
 *   - `.planning/phases/138-.../138-01-PLAN.md` T-02 <behavior>
 */

import { describe, it, expect } from "vitest";
import {
  MODEL_PRICING,
  estimateCost,
  lookupPricing,
} from "../pricing.js";

describe("pricing — OpenAI extension", () => {
  it("(a) lookupPricing('gpt-5-codex') returns the gpt-5-codex entry", () => {
    const pricing = lookupPricing("gpt-5-codex");
    expect(pricing).toBe(MODEL_PRICING["gpt-5-codex"]);
    expect(pricing).toBeDefined();
  });

  it("(b) lookupPricing('o3') returns the o3 entry, NOT o3-mini", () => {
    const pricing = lookupPricing("o3");
    expect(pricing).toBe(MODEL_PRICING["o3"]);
    expect(pricing).not.toBe(MODEL_PRICING["o3-mini"]);
  });

  it("(c) lookupPricing('o3-mini') returns o3-mini, NOT o3 (collision regression)", () => {
    const pricing = lookupPricing("o3-mini");
    expect(pricing).toBe(MODEL_PRICING["o3-mini"]);
    expect(pricing).not.toBe(MODEL_PRICING["o3"]);
  });

  it("(c2) substring lookup of an o3-mini-bearing model string does not collide with o3", () => {
    // A model string like "openai/o3-mini-2026" must resolve to the
    // o3-mini entry — the length-descending substring scan ensures the
    // longer key wins before the shorter "o3" key is tried.
    const pricing = lookupPricing("openai/o3-mini-2026");
    expect(pricing).toBe(MODEL_PRICING["o3-mini"]);
  });

  it("(d) lookupPricing('haiku') still returns the haiku entry", () => {
    expect(lookupPricing("haiku")).toBe(MODEL_PRICING["haiku"]);
  });

  it("(d2) Anthropic sonnet/opus unaffected by the OpenAI additions", () => {
    expect(lookupPricing("sonnet")).toBe(MODEL_PRICING["sonnet"]);
    expect(lookupPricing("opus")).toBe(MODEL_PRICING["opus"]);
  });

  it("(e) estimateCost('gpt-5-codex', 1M, 1M) = inputPerMillion + outputPerMillion", () => {
    const entry = MODEL_PRICING["gpt-5-codex"];
    expect(entry).toBeDefined();
    const expected = entry!.inputPerMillion + entry!.outputPerMillion;
    expect(estimateCost("gpt-5-codex", 1_000_000, 1_000_000)).toBeCloseTo(
      expected,
      9,
    );
  });

  it("(f) estimateCost('unknown-model', 100, 100) = 0 (existing behavior preserved)", () => {
    expect(estimateCost("unknown-model", 100, 100)).toBe(0);
  });
});
