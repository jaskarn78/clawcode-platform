/**
 * Phase 142 — LLM-judge tests. Focus: fail-closed on every uncertainty path.
 */
import { describe, it, expect, vi } from "vitest";
import { buildJudgePrompt, judgeResponse, makeJudge } from "../judge.js";
import type { EvalTask } from "../eval-set.js";

const task: EvalTask = {
  id: "t",
  prompt: "What's the weather in London?",
  successCriteria: "Reports a current temperature for London.",
  weight: 1,
};

describe("Phase 142 — buildJudgePrompt", () => {
  it("includes the success criterion and the response", () => {
    const { system, user } = buildJudgePrompt(task, "It's 12 degrees in London.");
    expect(system).toMatch(/STRICT/);
    expect(user).toContain("Reports a current temperature for London.");
    expect(user).toContain("It's 12 degrees in London.");
  });
});

describe("Phase 142 — judgeResponse (fail-closed)", () => {
  it("fails an empty response WITHOUT calling the LLM", async () => {
    const llm = vi.fn();
    const v = await judgeResponse(llm, task, "   ");
    expect(v.pass).toBe(false);
    expect(v.parsed).toBe(true);
    expect(llm).not.toHaveBeenCalled();
  });

  it("passes a valid {pass:true} verdict", async () => {
    const llm = vi.fn().mockResolvedValue('{"pass": true, "reasoning": "reports 12C"}');
    const v = await judgeResponse(llm, task, "It's 12C in London.");
    expect(v.pass).toBe(true);
    expect(v.parsed).toBe(true);
    expect(v.reasoning).toBe("reports 12C");
  });

  it("parses JSON wrapped in markdown fences / prose", async () => {
    const llm = vi.fn().mockResolvedValue('Sure!\n```json\n{"pass": false, "reasoning": "no temp"}\n```');
    const v = await judgeResponse(llm, task, "London is nice.");
    expect(v.pass).toBe(false);
    expect(v.parsed).toBe(true);
  });

  it("FAIL-CLOSED when the LLM call throws (does NOT default to pass)", async () => {
    const llm = vi.fn().mockRejectedValue(new Error("rate limit"));
    const v = await judgeResponse(llm, task, "It's 12C in London.");
    expect(v.pass).toBe(false);
    expect(v.parsed).toBe(false);
    expect(v.reasoning).toMatch(/failed/);
  });

  it("FAIL-CLOSED when the output is unparseable (does NOT default to pass)", async () => {
    const llm = vi.fn().mockResolvedValue("the response looks good to me, yes");
    const v = await judgeResponse(llm, task, "It's 12C in London.");
    expect(v.pass).toBe(false);
    expect(v.parsed).toBe(false);
  });

  it("FAIL-CLOSED when JSON is present but malformed (missing pass field)", async () => {
    const llm = vi.fn().mockResolvedValue('{"verdict": "good"}');
    const v = await judgeResponse(llm, task, "It's 12C in London.");
    expect(v.pass).toBe(false);
    expect(v.parsed).toBe(false);
  });

  it("makeJudge binds the LLM into a reusable grader", async () => {
    const judge = makeJudge(async () => '{"pass": true}');
    const v = await judge(task, "It's 12C in London.");
    expect(v.pass).toBe(true);
  });
});
