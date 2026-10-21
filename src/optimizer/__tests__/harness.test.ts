/**
 * Phase 142 — eval harness orchestration tests (injected runner + judge).
 *
 * These prove the orchestration/aggregation logic. They do NOT exercise the
 * real forked-session isolation — that is the live spike (scripts/isolation-spike.ts).
 */
import { describe, it, expect, vi } from "vitest";
import { runEval } from "../harness.js";
import type { EvalTask } from "../eval-set.js";
import type { JudgeVerdict } from "../judge.js";

const task = (over: Partial<EvalTask> = {}): EvalTask => ({
  id: "t",
  prompt: "p",
  successCriteria: "c",
  weight: 1,
  ...over,
});
const PASS: JudgeVerdict = { pass: true, reasoning: "", parsed: true };
const FAIL: JudgeVerdict = { pass: false, reasoning: "", parsed: true };

describe("Phase 142 — runEval", () => {
  it("scores 1.0 when every sample passes", async () => {
    const r = await runEval([task()], 3, {
      runAgentTurn: async () => ({ response: "ok" }),
      judge: async () => PASS,
    });
    expect(r.overall).toBe(1);
    expect(r.perTask[0].passes).toBe(3);
    expect(r.perTask[0].samples).toBe(3);
  });

  it("counts a substring-miss as a fail and does NOT consult the judge", async () => {
    const judge = vi.fn(async () => PASS);
    const r = await runEval([task({ expectSubstrings: ["london"] })], 2, {
      runAgentTurn: async () => ({ response: "no city here" }),
      judge,
    });
    expect(r.overall).toBe(0);
    expect(judge).not.toHaveBeenCalled();
  });

  it("counts judge-fail samples as fails", async () => {
    const r = await runEval([task()], 4, {
      runAgentTurn: async () => ({ response: "ok" }),
      judge: async () => FAIL,
    });
    expect(r.overall).toBe(0);
  });

  it("aggregates a partial pass-rate across samples", async () => {
    let i = 0;
    const r = await runEval([task()], 3, {
      runAgentTurn: async () => ({ response: "ok" }),
      judge: async () => (i++ % 2 === 0 ? PASS : FAIL), // pass, fail, pass => 2/3
    });
    expect(r.perTask[0].passes).toBe(2);
    expect(r.overall).toBeCloseTo(2 / 3);
  });

  it("counts a thrown agent run as a failed sample", async () => {
    const r = await runEval([task()], 2, {
      runAgentTurn: async () => {
        throw new Error("spawn failed");
      },
      judge: async () => PASS,
    });
    expect(r.overall).toBe(0);
  });

  it("counts a thrown judge as a failed sample (fail-closed)", async () => {
    const r = await runEval([task()], 2, {
      runAgentTurn: async () => ({ response: "ok" }),
      judge: async () => {
        throw new Error("judge boom");
      },
    });
    expect(r.overall).toBe(0);
  });

  it("weights tasks in the overall score", async () => {
    // task A (weight 1) all-pass; task B (weight 3) all-fail => (1*1 + 3*0)/4
    const r = await runEval([task({ id: "a", weight: 1 }), task({ id: "b", weight: 3 })], 1, {
      runAgentTurn: async () => ({ response: "ok" }),
      judge: async (t) => (t.id === "a" ? PASS : FAIL),
    });
    expect(r.overall).toBeCloseTo(0.25);
  });
});
