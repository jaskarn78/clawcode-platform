/**
 * Phase 142 — LLM-judge grader.
 *
 * Binary pass/fail per sample (matches AutoGen's `is_satisfied`), graded against
 * the task's `successCriteria` rubric. FAIL-CLOSED on every uncertainty path:
 * empty/whitespace response, a judge LLM error, or unparseable judge output all
 * resolve to `pass: false`. This is deliberate — a vague or broken judge must
 * never silently default a change to "improved" (the failure class that bit the
 * voice work: structured output that intermittently fails to parse).
 *
 * The LLM call is injected (`JudgeLlm`) so the harness/loop wires the real model
 * (callHaikuDirect / advisor) while tests use a deterministic fake.
 */
import { z } from "zod";
import type { EvalTask } from "./eval-set.js";

export type JudgeVerdict = {
  readonly pass: boolean;
  readonly reasoning: string;
  /** false when we fail-closed without a valid judge verdict (error/unparseable). */
  readonly parsed: boolean;
};

/** Injected LLM seam: (systemPrompt, userPrompt) => raw model text. */
export type JudgeLlm = (systemPrompt: string, userPrompt: string) => Promise<string>;

/** A bound grader: (task, response) => verdict. */
export type Judge = (task: EvalTask, response: string) => Promise<JudgeVerdict>;

const JUDGE_SYSTEM = [
  "You are a STRICT evaluator of an AI agent's response.",
  "You are given a success criterion and the agent's response.",
  "Decide whether the response MEETS the criterion.",
  'Reply with ONLY a JSON object: {"pass": boolean, "reasoning": string}.',
  "Be strict: if the response is empty, refuses, is off-topic, or you are",
  "uncertain whether it meets the criterion, then pass MUST be false.",
].join(" ");

/** Build the (system, user) judge prompt for a task + response. */
export function buildJudgePrompt(
  task: EvalTask,
  response: string,
): { readonly system: string; readonly user: string } {
  const user = [
    `Success criterion:\n${task.successCriteria}`,
    "",
    `Agent response:\n${response}`,
    "",
    'Does the response meet the criterion? Reply with ONLY the JSON object {"pass": boolean, "reasoning": string}.',
  ].join("\n");
  return { system: JUDGE_SYSTEM, user };
}

const verdictSchema = z.object({
  pass: z.boolean(),
  reasoning: z.string().optional(),
});

/**
 * Extract + validate a verdict from raw model text. Tolerates prose/markdown
 * fences around the JSON by grabbing the first `{...}` block. Returns null on
 * any failure (caller fail-closes).
 */
function tryParseVerdict(raw: string): { pass: boolean; reasoning?: string } | null {
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(match[0]);
  } catch {
    return null;
  }
  const parsed = verdictSchema.safeParse(obj);
  return parsed.success ? parsed.data : null;
}

/**
 * Grade one response against one task. Fail-closed on every uncertainty path.
 */
export async function judgeResponse(
  llm: JudgeLlm,
  task: EvalTask,
  response: string,
): Promise<JudgeVerdict> {
  if (response.trim().length === 0) {
    return { pass: false, reasoning: "empty response", parsed: true };
  }
  const { system, user } = buildJudgePrompt(task, response);
  let raw: string;
  try {
    raw = await llm(system, user);
  } catch (err) {
    return {
      pass: false,
      reasoning: `judge LLM call failed: ${err instanceof Error ? err.message : String(err)}`,
      parsed: false,
    };
  }
  const verdict = tryParseVerdict(raw);
  if (!verdict) {
    return { pass: false, reasoning: "judge output unparseable — fail-closed", parsed: false };
  }
  return { pass: verdict.pass, reasoning: verdict.reasoning ?? "", parsed: true };
}

/** Bind an LLM into a reusable Judge. */
export function makeJudge(llm: JudgeLlm): Judge {
  return (task, response) => judgeResponse(llm, task, response);
}
