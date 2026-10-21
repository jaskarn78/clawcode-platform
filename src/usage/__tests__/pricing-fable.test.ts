/**
 * Phase 999.98 Plan 01 Task 3 — Fable pricing matcher unit pins.
 *
 * Asserts the length-sorted substring matcher maps `claude-fable-5` → `fable`
 * ($10 in / $50 out per MTok) AND that adding the new key does NOT mis-collide
 * with the existing Anthropic / OpenAI keys (the length-sort invariant from the
 * Phase 138 o3/o3-mini collision fix must survive the new entry).
 */

import { describe, it, expect } from "vitest";
import { lookupPricing } from "../pricing.js";

describe("pricing — Fable entry (Phase 999.98 D5)", () => {
  it("lookupPricing('claude-fable-5') resolves to the fable bucket ($10/$50)", () => {
    expect(lookupPricing("claude-fable-5")).toEqual({
      inputPerMillion: 10,
      outputPerMillion: 50,
    });
  });

  it("the bare 'fable' key resolves exactly", () => {
    expect(lookupPricing("fable")).toEqual({
      inputPerMillion: 10,
      outputPerMillion: 50,
    });
  });

  it("adding 'fable' does not mis-collide — existing Claude keys still resolve", () => {
    expect(lookupPricing("claude-sonnet-4-6")).toEqual({
      inputPerMillion: 3.0,
      outputPerMillion: 15.0,
    });
    expect(lookupPricing("claude-opus-4-8")).toEqual({
      // Opus family corrected to the real $5/$25 tier (was a stale $15/$75).
      inputPerMillion: 5.0,
      outputPerMillion: 25.0,
    });
    // Phase 999.114 — CORRECTED: $0.25/$1.25 was the RETIRED Haiku 3.5 rate and
    // under-reported every Haiku 4.5 turn 4x. Haiku 4.5 is $1 in / $5 out.
    expect(lookupPricing("claude-haiku-4-5")).toEqual({
      inputPerMillion: 1.0,
      outputPerMillion: 5.0,
    });
  });

  it("the length-sort invariant survives — o3-mini still wins over o3", () => {
    expect(lookupPricing("openai/o3-mini-2026")).toEqual({
      inputPerMillion: 1.1,
      outputPerMillion: 4.4,
    });
  });

  it("an unknown model returns undefined (no false fable match)", () => {
    expect(lookupPricing("some-unknown-model")).toBeUndefined();
  });
});
