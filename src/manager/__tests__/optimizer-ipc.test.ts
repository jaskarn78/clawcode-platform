/**
 * Phase 142 P5b — run-agent-optimization IPC handler tests (pure, DI stubs).
 */
import { describe, it, expect, vi } from "vitest";
import {
  handleRunAgentOptimizationIpc,
  type RunAgentOptimizationIpcDeps,
} from "../optimizer-ipc.js";
import type { OptimizerConfig } from "../../config/schema.js";
import type { RunAgentOptimizationResult } from "../../optimizer/optimizer-run.js";
import type { EvalSet } from "../../optimizer/eval-set.js";

const cfg = (over: Partial<OptimizerConfig> = {}): OptimizerConfig => ({
  enabled: true,
  evalSet: "optimizer/eval.yaml",
  model: "opus",
  maxActionsPerRun: 3,
  samplesPerTask: 3,
  minImprovementMargin: 0.1,
  eligibleSkills: ["*"],
  evalMcpServers: [],
  cadence: "manual",
  ...over,
});

const EVAL_SET: EvalSet = { tasks: [{ id: "t1", prompt: "p", successCriteria: "c", weight: 1 }] };

const improvedResult: RunAgentOptimizationResult = {
  result: {
    outcome: "improved",
    baselineScore: 0.5,
    candidateScore: 0.8,
    margin: 0.1,
    actions: [{ kind: "add", name: "new", skillMd: "x", rationale: "r" }],
    baseline: { overall: 0.5, perTask: [] },
    candidate: { overall: 0.8, perTask: [] },
  },
  staged: {
    stagedDrafts: [{ name: "new", stagingPath: "/p/new.md" }],
    removes: [],
    summary: "Agent optimizer proposal — IMPROVED",
  },
};

function deps(over: Partial<RunAgentOptimizationIpcDeps> = {}): RunAgentOptimizationIpcDeps {
  return {
    knownAgents: () => ["researcher"],
    getOptimizerConfig: () => cfg(),
    loadEvalSetFor: async () => EVAL_SET,
    runOptimizationFor: async () => improvedResult,
    now: () => new Date("2026-06-02T00:00:00Z"),
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    ...over,
  };
}

describe("Phase 142 — handleRunAgentOptimizationIpc", () => {
  it("throws for an unknown agent", async () => {
    await expect(
      handleRunAgentOptimizationIpc({ agent: "ghost" }, deps()),
    ).rejects.toThrow(/agent not found/);
  });

  it("skips (no run) when the optimizer is not enabled", async () => {
    const run = vi.fn();
    const r = await handleRunAgentOptimizationIpc(
      { agent: "researcher" },
      deps({ getOptimizerConfig: () => cfg({ enabled: false }), runOptimizationFor: run }),
    );
    expect(r.status).toBe("skipped");
    expect(r.reason).toMatch(/not enabled/);
    expect(run).not.toHaveBeenCalled();
  });

  it("skips when enabled but no eval set (measured variant requires one)", async () => {
    const run = vi.fn();
    const r = await handleRunAgentOptimizationIpc(
      { agent: "researcher" },
      deps({ getOptimizerConfig: () => cfg({ evalSet: undefined }), runOptimizationFor: run }),
    );
    expect(r.status).toBe("skipped");
    expect(r.reason).toMatch(/no eval set/);
    expect(run).not.toHaveBeenCalled();
  });

  it("skips (does not run) when the eval set fails to load", async () => {
    const run = vi.fn();
    const r = await handleRunAgentOptimizationIpc(
      { agent: "researcher" },
      deps({
        loadEvalSetFor: async () => {
          throw new Error("bad yaml");
        },
        runOptimizationFor: run,
      }),
    );
    expect(r.status).toBe("skipped");
    expect(r.reason).toMatch(/eval set load failed/);
    expect(run).not.toHaveBeenCalled();
  });

  it("reports an improved run (scores + staged draft count + summary)", async () => {
    const r = await handleRunAgentOptimizationIpc({ agent: "researcher" }, deps());
    expect(r.status).toBe("completed");
    expect(r.outcome).toBe("improved");
    expect(r.baselineScore).toBe(0.5);
    expect(r.candidateScore).toBe(0.8);
    expect(r.stagedDraftCount).toBe(1);
    expect(r.removeCount).toBe(0);
    expect(r.summary).toMatch(/IMPROVED/);
  });

  it("reports a no-proposal run without staging", async () => {
    const noProp: RunAgentOptimizationResult = {
      result: {
        outcome: "no-proposal",
        baselineScore: 1,
        margin: 0.1,
        actions: [],
        baseline: { overall: 1, perTask: [] },
      },
    };
    const r = await handleRunAgentOptimizationIpc(
      { agent: "researcher" },
      deps({ runOptimizationFor: async () => noProp }),
    );
    expect(r.status).toBe("completed");
    expect(r.outcome).toBe("no-proposal");
    expect(r.stagedDraftCount).toBe(0);
    expect(r.summary).toBeUndefined();
  });
});
