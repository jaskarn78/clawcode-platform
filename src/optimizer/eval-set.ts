/**
 * Phase 142 — Agent Optimizer eval-set schema + loader.
 *
 * The eval set is a per-agent dataset of tasks + success criteria the optimizer
 * scores the agent against (baseline vs candidate skill set). It is a SEPARATE
 * data file (NOT part of clawcode.yaml), living at
 * `<agentMemoryPath>/<optimizer.evalSet>` (YAML or JSON — `yaml.parse` accepts
 * both).
 *
 * MEASURED variant (Phase 142 decision 2026-06-02): no eval set ⇒ the optimizer
 * is disabled for that agent. This module is the single source of truth for the
 * eval-set shape; the eval harness (P2) and the optimize→measure→keep loop (P3)
 * consume the validated result.
 *
 * Logger-free by design (mirrors `stt.ts`): it returns or throws a contextual
 * error; the caller decides how to log + whether to disable the optimizer.
 */
import { readFile } from "node:fs/promises";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

/** One eval task: a prompt + how to judge the agent's response. */
export const evalTaskSchema = z.object({
  /** Stable id — used in logs + the staged-proposal score deltas. */
  id: z.string().min(1),
  /** The user message the agent is run against. */
  prompt: z.string().min(1),
  /**
   * Rubric the LLM-judge grades the response against, e.g. "Calls a weather
   * tool and reports a current temperature + condition." Required — the judge
   * needs a target; empty criteria make the score meaningless.
   */
  successCriteria: z.string().min(1),
  /** Optional HARD check: response must contain ALL of these (case-insensitive). */
  expectSubstrings: z.array(z.string().min(1)).optional(),
  // NOTE: a tool-usage hard check (expectToolUsed) is intentionally NOT in v1.
  // dispatchTurn returns only the response string; tool calls live in the
  // TraceCollector (tool_call.<name> spans) and would require threading a Turn
  // through + reading spans back off a throwaway fork's collector. Rather than
  // ship an inert config knob, it's omitted until tool-capture is wired (P3+).
  /** Relative weight in the aggregate score. Default 1. */
  weight: z.number().positive().default(1),
});

export type EvalTask = z.infer<typeof evalTaskSchema>;

/** A per-agent eval set: a non-empty list of tasks. */
export const evalSetSchema = z.object({
  tasks: z.array(evalTaskSchema).min(1),
});

export type EvalSet = z.infer<typeof evalSetSchema>;

/**
 * Load + validate an eval set from disk. `yaml.parse` accepts both YAML and
 * JSON. Throws a contextual error (with the path) on read / parse / validation
 * failure so the caller can disable the optimizer for that agent LOUDLY rather
 * than silently running against a broken or empty set.
 */
export async function loadEvalSet(absPath: string): Promise<EvalSet> {
  let raw: string;
  try {
    raw = await readFile(absPath, "utf-8");
  } catch (err) {
    throw new Error(
      `optimizer: failed to read eval set at ${absPath}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (err) {
    throw new Error(
      `optimizer: failed to parse eval set at ${absPath} (expected YAML/JSON): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  const result = evalSetSchema.safeParse(parsed);
  if (!result.success) {
    const detail = result.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    throw new Error(`optimizer: eval set at ${absPath} is invalid: ${detail}`);
  }
  return result.data;
}
