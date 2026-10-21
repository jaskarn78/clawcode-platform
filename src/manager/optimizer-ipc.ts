/**
 * Phase 142 P5b — run-agent-optimization IPC handler (pure, testable).
 *
 * Mirrors handleRunDreamPassIpc: a pure orchestrator over injected DI deps so it
 * unit-tests without the daemon. The daemon edge (daemon.ts IPC dispatch) builds
 * the real deps — `runOptimizationFor` wraps `runAgentOptimization` with the live
 * SessionManager + optimizer LLM + the agent's skill source-root — and dispatches
 * the `run-agent-optimization` IPC method here. Backs the `/clawcode-optimize
 * <agent>` slash command.
 *
 * MEASURED variant: optimizer disabled OR no eval set ⇒ a clean "skipped"
 * response (never a fabricated result). A kept ("improved") result has already
 * been STAGED for operator review by runAgentOptimization — this handler only
 * reports; it never auto-applies.
 */
import { ManagerError } from "../shared/errors.js";
import type { OptimizerConfig } from "../config/schema.js";
import type { EvalSet } from "../optimizer/eval-set.js";
import type { RunAgentOptimizationResult } from "../optimizer/optimizer-run.js";

export interface RunAgentOptimizationRequest {
  readonly agent: string;
}

export interface RunAgentOptimizationResponse {
  readonly agent: string;
  readonly status: "completed" | "skipped";
  /** Present when skipped (not enabled / no eval set / load failed). */
  readonly reason?: string;
  readonly outcome?: RunAgentOptimizationResult["result"]["outcome"];
  readonly baselineScore?: number;
  readonly candidateScore?: number;
  /** add/revise drafts staged for operator review (improved only). */
  readonly stagedDraftCount?: number;
  /** remove actions surfaced for manual review (improved only). */
  readonly removeCount?: number;
  readonly summary?: string;
  readonly startedAt: string;
}

export interface RunAgentOptimizationIpcDeps {
  readonly knownAgents: () => readonly string[];
  /** Resolved optimizer config for the agent (agent.optimizer ?? defaults.optimizer), or null. */
  readonly getOptimizerConfig: (agent: string) => OptimizerConfig | null;
  /** Load + validate the agent's eval set from `config.evalSet` (relative to its memoryPath). */
  readonly loadEvalSetFor: (agent: string, evalSetPath: string) => Promise<EvalSet>;
  /** Run the full optimization (baseline→propose→candidate→keep→stage) with live deps. */
  readonly runOptimizationFor: (
    agent: string,
    evalSet: EvalSet,
    config: OptimizerConfig,
  ) => Promise<RunAgentOptimizationResult>;
  readonly now: () => Date;
  readonly log: {
    info: (m: string) => void;
    warn: (m: string) => void;
    error: (m: string) => void;
  };
}

export async function handleRunAgentOptimizationIpc(
  req: RunAgentOptimizationRequest,
  deps: RunAgentOptimizationIpcDeps,
): Promise<RunAgentOptimizationResponse> {
  if (!deps.knownAgents().includes(req.agent)) {
    throw new ManagerError(`agent not found: ${req.agent}`, { code: -32602 });
  }
  const startedAt = deps.now().toISOString();

  const config = deps.getOptimizerConfig(req.agent);
  if (!config || !config.enabled) {
    deps.log.info(`[run-agent-optimization] ${req.agent}: skipped — optimizer.enabled=false`);
    return { agent: req.agent, status: "skipped", reason: "optimizer not enabled", startedAt };
  }
  // MEASURED variant: no eval set ⇒ no measurement ⇒ disabled (would just be the
  // Phase 132 skill-distiller). Skip loudly rather than guess.
  if (!config.evalSet) {
    deps.log.warn(
      `[run-agent-optimization] ${req.agent}: skipped — no evalSet (measured optimizer requires one)`,
    );
    return { agent: req.agent, status: "skipped", reason: "no eval set configured", startedAt };
  }

  let evalSet: EvalSet;
  try {
    evalSet = await deps.loadEvalSetFor(req.agent, config.evalSet);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    deps.log.error(`[run-agent-optimization] ${req.agent}: eval set load failed — ${msg}`);
    return { agent: req.agent, status: "skipped", reason: `eval set load failed: ${msg}`, startedAt };
  }

  const { result, staged } = await deps.runOptimizationFor(req.agent, evalSet, config);
  deps.log.info(
    `[run-agent-optimization] ${req.agent}: outcome=${result.outcome} ` +
      `baseline=${result.baselineScore} candidate=${result.candidateScore ?? "n/a"} ` +
      `staged=${staged?.stagedDrafts.length ?? 0}`,
  );

  return {
    agent: req.agent,
    status: "completed",
    outcome: result.outcome,
    baselineScore: result.baselineScore,
    candidateScore: result.candidateScore,
    stagedDraftCount: staged?.stagedDrafts.length ?? 0,
    removeCount: staged?.removes.length ?? 0,
    summary: staged?.summary,
    startedAt,
  };
}
