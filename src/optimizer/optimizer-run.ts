/**
 * Phase 142 P5 — composition root: run one agent optimization end-to-end.
 *
 * Wires the pieces a daemon trigger calls:
 *   stage baseline (agent's current skills) → runEval → baseline score
 *   → propose ≤N actions → stage candidate (current + actions) → runEval
 *   → keep-iff-margin → on "improved", stage the proposal for operator review.
 *
 * Everything external is INJECTED (SessionManager, the optimizer LLM bound to the
 * configured model, the agent's skills source-root, the staging fs) so this is
 * decoupled + testable with fakes. The actual end-to-end run spawns real agent
 * forks + real LLM calls — that's the operator-gated PILOT (see 142-SUMMARY.md);
 * it has never executed here.
 */
import { stageCandidateSkills } from "./candidate-skills.js";
import { makeForkedAgentRunner, type EvalSessionManager } from "./agent-runner.js";
import { runEval } from "./harness.js";
import { makeJudge } from "./judge.js";
import { proposeActions } from "./optimizer-actions.js";
import { runOptimization, type OptimizationResult } from "./optimize-loop.js";
import { stageOptimizerProposal, type StagedOptimizerProposal } from "./optimizer-staging.js";
import type { EvalSet } from "./eval-set.js";
import type { ResolvedAgentConfig } from "../shared/types.js";

/** (systemPrompt, userPrompt) => raw text — bound by the daemon to the configured optimizer model. */
export type OptimizerLlm = (systemPrompt: string, userPrompt: string) => Promise<string>;

export type RunAgentOptimizationDeps = {
  readonly sessionManager: EvalSessionManager;
  /** The agent being optimized; `.skills` are its current skill names. */
  readonly parentConfig: ResolvedAgentConfig;
  /** One-shot LLM, already bound to the configured optimizer model (judge + proposer). */
  readonly llm: OptimizerLlm;
  /** Source root for the agent's current skills (`~/.clawcode/agents/<agent>/skills`). */
  readonly agentSkillsRoot: string;
  /** Absolute `~/.clawcode/agents/<agent>/` provider (for staging drafts). */
  readonly agentWorkspaceDir: (agent: string) => string;
  readonly evalSet: EvalSet;
  readonly config: {
    readonly samplesPerTask: number;
    readonly maxActionsPerRun: number;
    readonly minImprovementMargin: number;
    readonly eligibleSkills: readonly string[];
    /**
     * Phase 142 follow-up — fail-closed MCP server allowlist for the eval fork
     * (default/omitted = tool-free). Forwarded verbatim to the forked runner.
     */
    readonly evalMcpServers?: readonly string[];
  };
  /** Throwaway memory dir for the eval forks (isolated from the live agent). */
  readonly memoryPath: string;
  /**
   * Phase 142 fix — daemon-provided callbacks to register/unregister each eval
   * fork's LlmRuntime resolver around its session lifecycle (threaded into the
   * forked runner). The daemon edge wires them via `makeOptimizerForkResolver`.
   *
   * REQUIRED (not optional) by design: dropping this wiring is exactly the
   * silent failure that shipped the original 0%-score bug (every eval fork would
   * throw "No LlmRuntime resolver registered" → fail-closed 0%). Making it
   * type-required turns an accidental un-wire at the daemon edge into a COMPILE
   * error instead of a silent prod regression. (The lower-level
   * `ForkedRunnerDeps` keeps these optional for unit-test ergonomics — its tests
   * mock SessionManager and never hit a real registry.)
   */
  readonly registerLlmRuntime: (
    forkName: string,
    evalConfig: ResolvedAgentConfig,
    parentName: string,
  ) => void;
  readonly unregisterLlmRuntime: (forkName: string) => void;
  /** `<timestamp>-<fingerprint12>` staging-filename suffix (the approve/reject handlers peel it). */
  readonly draftIdSuffix: string;
  readonly log?: (obj: Record<string, unknown>, msg: string) => void;
};

export type RunAgentOptimizationResult = {
  readonly result: OptimizationResult;
  /** Present only when outcome === "improved" (a proposal was staged for review). */
  readonly staged?: StagedOptimizerProposal;
};

export async function runAgentOptimization(
  deps: RunAgentOptimizationDeps,
): Promise<RunAgentOptimizationResult> {
  const currentSkills = deps.parentConfig.skills ?? [];
  const judge = makeJudge(deps.llm);

  // One eval pass against a candidate skill set defined by `overrides` ([] = baseline).
  // BOTH baseline + candidate go through this same path + same eval set.
  const evalWith = async (overrides: Parameters<typeof stageCandidateSkills>[0]["overrides"]) => {
    const staged = await stageCandidateSkills({
      sourceSkillsRoot: deps.agentSkillsRoot,
      skillNames: currentSkills,
      overrides,
    });
    try {
      const runAgentTurn = makeForkedAgentRunner({
        sessionManager: deps.sessionManager,
        parentConfig: deps.parentConfig,
        workspace: staged.workspace,
        skillNames: staged.skillNames,
        memoryPath: deps.memoryPath,
        evalMcpServers: deps.config.evalMcpServers,
        registerLlmRuntime: deps.registerLlmRuntime,
        unregisterLlmRuntime: deps.unregisterLlmRuntime,
        log: deps.log,
      });
      return await runEval(deps.evalSet.tasks, deps.config.samplesPerTask, {
        runAgentTurn,
        judge,
        log: deps.log,
      });
    } finally {
      await staged.dispose();
    }
  };

  const result = await runOptimization(
    { margin: deps.config.minImprovementMargin },
    {
      evalWith,
      propose: (baseline) =>
        proposeActions(deps.llm, {
          currentSkills,
          evalScore: baseline,
          tasks: deps.evalSet.tasks,
          maxActions: deps.config.maxActionsPerRun,
          eligibleSkills: deps.config.eligibleSkills,
        }),
      log: deps.log,
    },
  );

  if (result.outcome !== "improved") {
    return { result };
  }

  const staged = await stageOptimizerProposal(
    { agentWorkspaceDir: deps.agentWorkspaceDir, log: deps.log },
    { agent: deps.parentConfig.name, result, draftIdSuffix: deps.draftIdSuffix },
  );
  return { result, staged };
}
