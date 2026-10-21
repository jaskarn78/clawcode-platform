/**
 * Phase 142 — eval scoring (pure).
 *
 * A sample passes iff BOTH the deterministic substring hard-check AND the
 * LLM-judge pass. Per-task score = passes / samples (noise control via
 * samplesPerTask). Overall = weighted mean of per-task scores. All pure +
 * unit-tested; the harness composes these with the injected runner + judge.
 */
import type { EvalTask } from "./eval-set.js";
import type { TaskScore } from "./types.js";

/**
 * Hard check: the response contains ALL `expectSubstrings` (case-insensitive).
 * A task with no `expectSubstrings` trivially passes this gate (judge-only).
 */
export function passesSubstrings(task: EvalTask, response: string): boolean {
  if (!task.expectSubstrings || task.expectSubstrings.length === 0) return true;
  const hay = response.toLowerCase();
  return task.expectSubstrings.every((s) => hay.includes(s.toLowerCase()));
}

/**
 * Weighted mean of per-task scores. Empty list or total weight 0 ⇒ 0 (a run
 * with no measurable tasks scores zero rather than dividing by zero).
 */
export function aggregateScore(perTask: readonly TaskScore[]): number {
  const totalWeight = perTask.reduce((acc, t) => acc + t.weight, 0);
  if (totalWeight <= 0) return 0;
  const weighted = perTask.reduce((acc, t) => acc + t.weight * t.score, 0);
  return weighted / totalWeight;
}
