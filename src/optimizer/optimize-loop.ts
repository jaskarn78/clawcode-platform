/**
 * Phase 142 P3 — the optimize→measure→keep loop.
 *
 * baseline eval (current skills) → propose ≤N actions → candidate eval
 * (current + actions) → KEEP iff the candidate beats baseline by the margin.
 * Pure orchestration over two injected seams (`evalWith`, `propose`); the real
 * wiring (staged candidate-skills + forked runner + LLM judge/proposer) is
 * composed at P5. A "improved" result is handed to operator-review staging (P4)
 * — NEVER auto-applied. Both eval passes MUST use the same eval set (the injected
 * `evalWith` closes over it) or the delta is noise.
 */
import type { EvalScore } from "./types.js";
import { actionsToOverrides, type OptimizerAction } from "./optimizer-actions.js";
import type { SkillOverride } from "./candidate-skills.js";

export type OptimizationOutcome = "improved" | "rejected" | "no-proposal";

export type OptimizationResult = {
  readonly outcome: OptimizationOutcome;
  readonly baselineScore: number;
  readonly candidateScore?: number;
  readonly margin: number;
  readonly actions: readonly OptimizerAction[];
  readonly baseline: EvalScore;
  readonly candidate?: EvalScore;
};

export type OptimizeDeps = {
  /** Run the eval against a candidate skill set; `[]` overrides = baseline (current skills). */
  readonly evalWith: (overrides: readonly SkillOverride[]) => Promise<EvalScore>;
  /** Propose validated, capped actions from the baseline eval result. */
  readonly propose: (baseline: EvalScore) => Promise<readonly OptimizerAction[]>;
  readonly log?: (obj: Record<string, unknown>, msg: string) => void;
};

/**
 * Keep iff the candidate STRICTLY beats baseline by at least the margin. Guards:
 *   - baseline already perfect (>= 1) → never "improved" (nothing to gain).
 *   - candidate == baseline (or worse) → never kept (margin 0 must not pass a no-op).
 */
export function decideKeep(baseline: number, candidate: number, margin: number): boolean {
  if (baseline >= 1) return false;
  return candidate > baseline && candidate - baseline >= margin;
}

export async function runOptimization(
  args: { readonly margin: number },
  deps: OptimizeDeps,
): Promise<OptimizationResult> {
  const baseline = await deps.evalWith([]);
  deps.log?.({ baseline: baseline.overall }, "optimizer: baseline scored");

  const actions = await deps.propose(baseline);
  if (actions.length === 0) {
    deps.log?.({ baseline: baseline.overall }, "optimizer: no proposal — nothing to stage");
    return {
      outcome: "no-proposal",
      baselineScore: baseline.overall,
      margin: args.margin,
      actions: [],
      baseline,
    };
  }

  const candidate = await deps.evalWith(actionsToOverrides(actions));
  const keep = decideKeep(baseline.overall, candidate.overall, args.margin);
  deps.log?.(
    {
      baseline: baseline.overall,
      candidate: candidate.overall,
      margin: args.margin,
      keep,
      actions: actions.length,
    },
    "optimizer: candidate scored",
  );

  return {
    outcome: keep ? "improved" : "rejected",
    baselineScore: baseline.overall,
    candidateScore: candidate.overall,
    margin: args.margin,
    actions,
    baseline,
    candidate,
  };
}
