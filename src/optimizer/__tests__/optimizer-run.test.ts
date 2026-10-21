/**
 * Phase 142 P5 — composition smoke test.
 *
 * Exercises the REAL wiring (stageCandidateSkills → forked runner → runEval →
 * proposer → optimize loop → staging) with fakes ONLY at the two external
 * boundaries: SessionManager and the optimizer LLM. This proves the pieces
 * compose; it does NOT exercise a real agent process (that's the operator pilot).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAgentOptimization } from "../optimizer-run.js";
import type { EvalSessionManager } from "../agent-runner.js";
import type { EvalSet } from "../eval-set.js";
import type { ResolvedAgentConfig } from "../../shared/types.js";

describe("Phase 142 — runAgentOptimization (composition)", () => {
  let skillsRoot: string;
  let agentsRoot: string;
  let memoryPath: string;
  beforeEach(async () => {
    skillsRoot = await mkdtemp(join(tmpdir(), "opt-run-skills-"));
    agentsRoot = await mkdtemp(join(tmpdir(), "opt-run-agents-"));
    memoryPath = await mkdtemp(join(tmpdir(), "opt-run-mem-"));
    // one current skill "alpha"
    await mkdir(join(skillsRoot, "alpha"), { recursive: true });
    await writeFile(join(skillsRoot, "alpha", "SKILL.md"), "---\nname: alpha\n---\nalpha");
  });
  afterEach(async () => {
    for (const d of [skillsRoot, agentsRoot, memoryPath]) await rm(d, { recursive: true, force: true });
  });

  it("baseline-fails → proposes → candidate-passes → 'improved' → stages the draft", async () => {
    const sm: EvalSessionManager = {
      startAgent: vi.fn(async () => {}),
      dispatchTurn: vi.fn(async () => "an answer"),
      stopAgent: vi.fn(async () => {}),
    };

    // Stateful fake LLM: proposer (system mentions "optimizer") returns an add
    // action and flips the flag; the judge fails BEFORE a proposal and passes
    // AFTER — i.e. baseline 0, candidate 1.
    let proposed = false;
    const llm = vi.fn(async (system: string) => {
      if (/optimizer/i.test(system)) {
        proposed = true;
        return '[{"kind":"add","name":"new-skill","skillMd":"help with citing","rationale":"fixes t1"}]';
      }
      return proposed ? '{"pass": true}' : '{"pass": false}';
    });

    const evalSet: EvalSet = {
      tasks: [{ id: "t1", prompt: "do the thing", successCriteria: "does the thing", weight: 1 }],
    };
    const parentConfig = {
      name: "researcher",
      skills: ["alpha"],
      soul: "you are researcher",
      model: "opus",
      effort: "high",
    } as unknown as ResolvedAgentConfig;

    const out = await runAgentOptimization({
      sessionManager: sm,
      parentConfig,
      llm,
      agentSkillsRoot: skillsRoot,
      agentWorkspaceDir: (agent) => join(agentsRoot, agent),
      evalSet,
      config: { samplesPerTask: 1, maxActionsPerRun: 1, minImprovementMargin: 0.1, eligibleSkills: ["*"] },
      memoryPath,
      registerLlmRuntime: () => {},
      unregisterLlmRuntime: () => {},
      draftIdSuffix: "2026-06-02-000000-abc123def456",
    });

    expect(out.result.outcome).toBe("improved");
    expect(out.result.baselineScore).toBe(0);
    expect(out.result.candidateScore).toBe(1);
    expect(out.staged?.stagedDrafts.map((d) => d.name)).toEqual(["new-skill"]);

    // the draft really landed in the agent's skills-staging dir
    const stagingFiles = await readdir(join(agentsRoot, "researcher", "skills-staging"));
    expect(stagingFiles).toContain("new-skill-2026-06-02-000000-abc123def456.md");

    // two eval passes (baseline + candidate) → two forked sessions, both torn down
    expect((sm.startAgent as ReturnType<typeof vi.fn>).mock.calls.length).toBe(2);
    expect((sm.stopAgent as ReturnType<typeof vi.fn>).mock.calls.length).toBe(2);
  });

  it("no-proposal → returns rejected/no-proposal without staging", async () => {
    const sm: EvalSessionManager = {
      startAgent: vi.fn(async () => {}),
      dispatchTurn: vi.fn(async () => "an answer"),
      stopAgent: vi.fn(async () => {}),
    };
    // judge always passes (baseline 1.0) + proposer returns nothing useful
    const llm = vi.fn(async (system: string) => (/optimizer/i.test(system) ? "[]" : '{"pass": true}'));
    const out = await runAgentOptimization({
      sessionManager: sm,
      parentConfig: { name: "a", skills: ["alpha"], soul: "s", model: "opus", effort: "high" } as unknown as ResolvedAgentConfig,
      llm,
      agentSkillsRoot: skillsRoot,
      agentWorkspaceDir: (agent) => join(agentsRoot, agent),
      evalSet: { tasks: [{ id: "t1", prompt: "p", successCriteria: "c", weight: 1 }] },
      config: { samplesPerTask: 1, maxActionsPerRun: 1, minImprovementMargin: 0.1, eligibleSkills: ["*"] },
      memoryPath,
      registerLlmRuntime: () => {},
      unregisterLlmRuntime: () => {},
      draftIdSuffix: "s",
    });
    expect(out.result.outcome).toBe("no-proposal");
    expect(out.staged).toBeUndefined();
  });
});
