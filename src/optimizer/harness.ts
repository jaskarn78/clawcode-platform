/**
 * Phase 142 — eval harness orchestration.
 *
 * Runs an eval set against ONE (agent, candidate-skill-set) by looping every
 * task `samplesPerTask` times through the injected `runAgentTurn` + `judge`,
 * then aggregating to a single 0..1 score. Pure orchestration over injected
 * seams — fully unit-testable with fakes. The real isolation (forked session +
 * candidate-skills cwd) lives behind `runAgentTurn` (see agent-runner.ts) and is
 * NOT exercised by these unit tests — it needs the live spike.
 *
 * Failure handling is fail-as-fail: a run that throws, an empty/substring-miss
 * response, or a judge error all count the sample as NOT passing (never as a
 * pass). The optimizer must not credit a change on the back of a broken eval.
 */
import type { EvalTask } from "./eval-set.js";
import type { AgentRunner, EvalScore, TaskScore } from "./types.js";
import type { Judge } from "./judge.js";
import { passesSubstrings, aggregateScore } from "./scoring.js";

export type RunEvalDeps = {
  /** Runs the agent once on a prompt (bound to the candidate skill set). */
  readonly runAgentTurn: AgentRunner;
  /** Grades a response against a task (LLM-judge, fail-closed). */
  readonly judge: Judge;
  /** Optional structured logger. */
  readonly log?: (obj: Record<string, unknown>, msg: string) => void;
};

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Max chars of a failing response captured for the proposer (keep prompts small). */
const FAILING_EXAMPLE_MAX = 500;

/**
 * Score `tasks` against the candidate skill set bound into `deps.runAgentTurn`.
 * Returns per-task pass-rates + the weighted overall score.
 */
export async function runEval(
  tasks: readonly EvalTask[],
  samplesPerTask: number,
  deps: RunEvalDeps,
): Promise<EvalScore> {
  const perTask: TaskScore[] = [];

  for (const task of tasks) {
    let passes = 0;
    let failingExample: string | undefined;

    for (let sample = 0; sample < samplesPerTask; sample++) {
      // 1. Run the agent. A thrown run = a failed sample (never a pass).
      let response: string;
      try {
        response = (await deps.runAgentTurn(task.prompt)).response;
      } catch (err) {
        deps.log?.(
          { taskId: task.id, sample, error: errMsg(err) },
          "optimizer: eval run threw — counting sample as fail",
        );
        continue;
      }

      // 2. Deterministic hard check.
      if (!passesSubstrings(task, response)) {
        failingExample ??= response.slice(0, FAILING_EXAMPLE_MAX);
        deps.log?.(
          { taskId: task.id, sample },
          "optimizer: sample failed substring hard-check",
        );
        continue;
      }

      // 3. LLM-judge (fail-closed). A judge throw = a failed sample.
      let pass = false;
      try {
        const verdict = await deps.judge(task, response);
        pass = verdict.pass;
        if (!verdict.parsed) {
          deps.log?.(
            { taskId: task.id, sample, reasoning: verdict.reasoning },
            "optimizer: judge fail-closed (no valid verdict)",
          );
        }
      } catch (err) {
        deps.log?.(
          { taskId: task.id, sample, error: errMsg(err) },
          "optimizer: judge threw — counting sample as fail",
        );
        continue;
      }
      if (pass) passes += 1;
      else failingExample ??= response.slice(0, FAILING_EXAMPLE_MAX);
    }

    const score = samplesPerTask > 0 ? passes / samplesPerTask : 0;
    perTask.push({
      taskId: task.id,
      weight: task.weight,
      samples: samplesPerTask,
      passes,
      score,
      ...(failingExample !== undefined ? { failingExample } : {}),
    });
    deps.log?.(
      { taskId: task.id, passes, samples: samplesPerTask, score },
      "optimizer: task scored",
    );
  }

  const overall = aggregateScore(perTask);
  deps.log?.({ overall, tasks: perTask.length }, "optimizer: eval run complete");
  return { overall, perTask };
}
