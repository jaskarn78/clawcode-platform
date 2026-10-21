/**
 * Phase 142 — Agent Optimizer shared contracts.
 *
 * Cross-module seams kept tiny + injectable so the orchestration core
 * (harness) is unit-testable with fakes, while the production agent-spawn path
 * (agent-runner) sits behind the `AgentRunner` seam. The genuine
 * skill-isolation behavior of a forked SDK session is NOT verifiable by these
 * types/mocks — it requires a live spike (see scripts/isolation-spike.ts).
 */

/** The captured outcome of running the agent once on an eval prompt. */
export type AgentRunResult = {
  readonly response: string;
  // v1: tool-usage capture is intentionally absent (see eval-set.ts) — a tool
  // hard-check would need TraceCollector span readback from a throwaway fork.
};

/**
 * Runs the agent once on a prompt and returns its response. The candidate skill
 * set + isolation (forked session, candidate-skills cwd) are bound by the
 * implementation (see makeForkedAgentRunner); the harness only sees this seam.
 */
export type AgentRunner = (prompt: string) => Promise<AgentRunResult>;

/** Per-task aggregate over the task's samples. */
export type TaskScore = {
  readonly taskId: string;
  readonly weight: number;
  readonly samples: number;
  /** Number of samples that passed (hard checks AND judge). */
  readonly passes: number;
  /** passes / samples — 0..1. */
  readonly score: number;
  /**
   * Phase 142 P3 — one representative FAILING response for this task (truncated),
   * captured for the proposer so it can see WHY a task failed. Undefined when the
   * task fully passed or no sample produced a response. Additive/optional.
   */
  readonly failingExample?: string;
};

/** Overall eval result for one (agent, candidate-skill-set) run. */
export type EvalScore = {
  /** Weighted mean of per-task scores — 0..1. The number behind "did it help". */
  readonly overall: number;
  readonly perTask: readonly TaskScore[];
};
