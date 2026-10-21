/**
 * 2026-07-31 — adaptive verify-budget decision core tests (pure).
 */
import { describe, it, expect } from "vitest";
import { decideVerifyBudget } from "../financial-verification-budget.js";

const KNOBS = {
  maxVerifyHops: 1,
  skipIfTurnMsOver: 120_000,
  shrinkIfTurnMsOver: 30_000,
};

describe("decideVerifyBudget", () => {
  it("maxVerifyHops 0 → skip with hops-disabled (regardless of cost)", () => {
    expect(
      decideVerifyBudget({ ...KNOBS, maxVerifyHops: 0, turnCostMs: 5 }),
    ).toEqual({ mode: "skip", skippedReason: "hops-disabled" });
  });

  it("cost at the skip threshold → skip with turn-cost", () => {
    expect(decideVerifyBudget({ ...KNOBS, turnCostMs: 120_000 })).toEqual({
      mode: "skip",
      skippedReason: "turn-cost",
    });
  });

  it("cost just under the skip threshold but at shrink → shrink", () => {
    expect(decideVerifyBudget({ ...KNOBS, turnCostMs: 119_999 })).toEqual({
      mode: "shrink",
    });
    expect(decideVerifyBudget({ ...KNOBS, turnCostMs: 30_000 })).toEqual({
      mode: "shrink",
    });
  });

  it("cost under the shrink threshold → full", () => {
    expect(decideVerifyBudget({ ...KNOBS, turnCostMs: 29_999 })).toEqual({
      mode: "full",
    });
  });

  it("unknown cost (null — no Turn wired) → full (fail-open)", () => {
    expect(decideVerifyBudget({ ...KNOBS, turnCostMs: null })).toEqual({
      mode: "full",
    });
  });
});
