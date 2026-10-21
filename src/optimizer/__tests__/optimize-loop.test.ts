/**
 * Phase 142 P3 — keep-decision edges + loop orchestration tests.
 */
import { describe, it, expect, vi } from "vitest";
import { decideKeep, runOptimization } from "../optimize-loop.js";
import type { EvalScore } from "../types.js";
import type { OptimizerAction } from "../optimizer-actions.js";
import type { SkillOverride } from "../candidate-skills.js";

const score = (overall: number): EvalScore => ({ overall, perTask: [] });

describe("Phase 142 — decideKeep (degenerate-baseline guards)", () => {
  it("keeps when candidate beats baseline by >= margin", () => {
    expect(decideKeep(0.5, 0.7, 0.1)).toBe(true);
  });
  it("rejects when the gain is below the margin", () => {
    expect(decideKeep(0.5, 0.55, 0.1)).toBe(false);
  });
  it("rejects when candidate == baseline (margin 0 must not pass a no-op)", () => {
    expect(decideKeep(0.5, 0.5, 0)).toBe(false);
  });
  it("rejects when candidate is worse", () => {
    expect(decideKeep(0.5, 0.4, 0.1)).toBe(false);
  });
  it("never 'improves' a perfect baseline", () => {
    expect(decideKeep(1, 1, 0)).toBe(false);
    expect(decideKeep(1, 1, 0.1)).toBe(false);
  });
  it("rejects baseline 0 → candidate 0 (spurious no-op)", () => {
    expect(decideKeep(0, 0, 0.1)).toBe(false);
  });
  it("keeps a genuine lift off a 0 baseline", () => {
    expect(decideKeep(0, 0.5, 0.1)).toBe(true);
  });
});

describe("Phase 142 — runOptimization", () => {
  const action: OptimizerAction = { kind: "add", name: "new", skillMd: "# new", rationale: "r" };

  it("returns no-proposal (and only ONE eval) when the proposer yields nothing", async () => {
    const evalWith = vi.fn(async () => score(0.5));
    const r = await runOptimization(
      { margin: 0.1 },
      { evalWith, propose: async () => [] },
    );
    expect(r.outcome).toBe("no-proposal");
    expect(r.baselineScore).toBe(0.5);
    expect(r.candidateScore).toBeUndefined();
    expect(evalWith).toHaveBeenCalledTimes(1);
    expect(evalWith).toHaveBeenCalledWith([]); // baseline = current skills
  });

  it("returns 'improved' when the candidate beats baseline by the margin", async () => {
    const evalWith = vi.fn(async (overrides: readonly SkillOverride[]) =>
      score(overrides.length === 0 ? 0.5 : 0.8),
    );
    const r = await runOptimization(
      { margin: 0.1 },
      { evalWith, propose: async () => [action] },
    );
    expect(r.outcome).toBe("improved");
    expect(r.baselineScore).toBe(0.5);
    expect(r.candidateScore).toBe(0.8);
    expect(r.actions).toEqual([action]);
    expect(evalWith).toHaveBeenCalledTimes(2);
    // second call gets the candidate overrides derived from the action
    expect(evalWith.mock.calls[1][0]).toEqual([{ op: "write", name: "new", skillMd: "# new" }]);
  });

  it("returns 'rejected' when the candidate does not clear the margin", async () => {
    const evalWith = vi.fn(async (overrides: readonly SkillOverride[]) =>
      score(overrides.length === 0 ? 0.5 : 0.55),
    );
    const r = await runOptimization(
      { margin: 0.1 },
      { evalWith, propose: async () => [action] },
    );
    expect(r.outcome).toBe("rejected");
    expect(r.candidateScore).toBe(0.55);
  });
});
