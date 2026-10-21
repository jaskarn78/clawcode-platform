/**
 * Phase 142 P3 — proposer parse / validate / fail-safe tests.
 */
import { describe, it, expect, vi } from "vitest";
import {
  parseActions,
  validateActions,
  isEligible,
  actionsToOverrides,
  proposeActions,
  buildProposalPrompt,
  type OptimizerAction,
} from "../optimizer-actions.js";
import type { EvalScore } from "../types.js";
import type { EvalTask } from "../eval-set.js";

describe("Phase 142 — parseActions (shape, fail-safe)", () => {
  it("parses a valid JSON array of actions", () => {
    const a = parseActions('[{"kind":"add","name":"weather","skillMd":"# weather","rationale":"need it"}]');
    expect(a).toEqual([{ kind: "add", name: "weather", skillMd: "# weather", rationale: "need it" }]);
  });
  it("tolerates prose/fences around the array", () => {
    const a = parseActions('Here:\n```json\n[{"kind":"remove","name":"x","rationale":"unused"}]\n```');
    expect(a).toEqual([{ kind: "remove", name: "x", rationale: "unused" }]);
  });
  it("defaults missing skillMd to '' (validation drops it later)", () => {
    const a = parseActions('[{"kind":"add","name":"y","rationale":"r"}]');
    expect(a[0]).toEqual({ kind: "add", name: "y", skillMd: "", rationale: "r" });
  });
  it("returns [] on non-JSON / no array", () => {
    expect(parseActions("I think you should add a weather skill.")).toEqual([]);
  });
  it("returns [] on malformed array (wrong shape)", () => {
    expect(parseActions('[{"foo":"bar"}]')).toEqual([]);
  });
});

describe("Phase 142 — validateActions (drop invalid, dedup, cap)", () => {
  const opts = { currentSkills: ["alpha", "beta"], eligibleSkills: ["*"], maxActions: 3 };
  const add = (name: string, skillMd = "x"): OptimizerAction => ({ kind: "add", name, skillMd, rationale: "" });
  const revise = (name: string, skillMd = "x"): OptimizerAction => ({ kind: "revise", name, skillMd, rationale: "" });
  const remove = (name: string): OptimizerAction => ({ kind: "remove", name, rationale: "" });

  it("keeps a valid add of a NEW skill", () => {
    expect(validateActions([add("gamma")], opts)).toHaveLength(1);
  });
  it("drops an add of an EXISTING skill", () => {
    expect(validateActions([add("alpha")], opts)).toEqual([]);
  });
  it("drops an add/revise with empty content", () => {
    expect(validateActions([add("gamma", "   ")], opts)).toEqual([]);
    expect(validateActions([revise("alpha", "")], opts)).toEqual([]);
  });
  it("keeps a revise of an existing eligible skill", () => {
    expect(validateActions([revise("alpha")], opts)).toHaveLength(1);
  });
  it("drops a revise/remove of an UNKNOWN skill", () => {
    expect(validateActions([revise("ghost")], opts)).toEqual([]);
    expect(validateActions([remove("ghost")], opts)).toEqual([]);
  });
  it("enforces eligibleSkills for revise/remove", () => {
    const restricted = { currentSkills: ["alpha", "beta"], eligibleSkills: ["alpha"], maxActions: 3 };
    expect(validateActions([revise("beta")], restricted)).toEqual([]);
    expect(validateActions([remove("beta")], restricted)).toEqual([]);
    expect(validateActions([revise("alpha")], restricted)).toHaveLength(1);
  });
  it("dedups multiple actions on the same skill (first wins)", () => {
    const r = validateActions([revise("alpha", "v2"), remove("alpha")], opts);
    expect(r).toHaveLength(1);
    expect(r[0].kind).toBe("revise");
  });
  it("truncates to maxActions (does not trust the model's count)", () => {
    const many = [add("s1"), add("s2"), add("s3"), add("s4"), add("s5")];
    expect(validateActions(many, { ...opts, maxActions: 2 })).toHaveLength(2);
  });
});

describe("Phase 142 — isEligible / actionsToOverrides", () => {
  it("'*' allows any skill", () => {
    expect(isEligible("anything", ["*"])).toBe(true);
  });
  it("otherwise requires the name to be listed", () => {
    expect(isEligible("a", ["a", "b"])).toBe(true);
    expect(isEligible("c", ["a", "b"])).toBe(false);
  });
  it("maps actions to candidate-skills overrides", () => {
    const overrides = actionsToOverrides([
      { kind: "add", name: "a", skillMd: "A", rationale: "" },
      { kind: "revise", name: "b", skillMd: "B", rationale: "" },
      { kind: "remove", name: "c", rationale: "" },
    ]);
    expect(overrides).toEqual([
      { op: "write", name: "a", skillMd: "A" },
      { op: "write", name: "b", skillMd: "B" },
      { op: "remove", name: "c" },
    ]);
  });
});

describe("Phase 142 — buildProposalPrompt", () => {
  it("includes current skills + failed-task criteria + the failing example", () => {
    const tasks: EvalTask[] = [
      { id: "t1", prompt: "p", successCriteria: "must cite a source", weight: 1 },
    ];
    const evalScore: EvalScore = {
      overall: 0,
      perTask: [{ taskId: "t1", weight: 1, samples: 2, passes: 0, score: 0, failingExample: "no source given" }],
    };
    const { user } = buildProposalPrompt({ currentSkills: ["alpha"], evalScore, tasks, maxActions: 3 });
    expect(user).toContain("alpha");
    expect(user).toContain("must cite a source");
    expect(user).toContain("no source given");
    expect(user).toContain("at most 3");
  });
});

describe("Phase 142 — proposeActions (fail-safe end-to-end)", () => {
  const baseArgs = {
    currentSkills: ["alpha"] as string[],
    evalScore: { overall: 0, perTask: [{ taskId: "t1", weight: 1, samples: 1, passes: 0, score: 0 }] } as EvalScore,
    tasks: [{ id: "t1", prompt: "p", successCriteria: "c", weight: 1 }] as EvalTask[],
    maxActions: 3,
    eligibleSkills: ["*"] as string[],
  };

  it("returns validated actions from a good LLM reply", async () => {
    const llm = vi.fn().mockResolvedValue('[{"kind":"add","name":"new-skill","skillMd":"# new","rationale":"fixes t1"}]');
    const r = await proposeActions(llm, baseArgs);
    expect(r).toEqual([{ kind: "add", name: "new-skill", skillMd: "# new", rationale: "fixes t1" }]);
  });
  it("FAIL-SAFE: returns [] when the LLM throws", async () => {
    const llm = vi.fn().mockRejectedValue(new Error("rate limit"));
    expect(await proposeActions(llm, baseArgs)).toEqual([]);
  });
  it("FAIL-SAFE: returns [] on unparseable output", async () => {
    const llm = vi.fn().mockResolvedValue("add a weather skill please");
    expect(await proposeActions(llm, baseArgs)).toEqual([]);
  });
  it("drops a hallucinated revise of a non-existent skill", async () => {
    const llm = vi.fn().mockResolvedValue('[{"kind":"revise","name":"ghost","skillMd":"x","rationale":"r"}]');
    expect(await proposeActions(llm, baseArgs)).toEqual([]);
  });
});
