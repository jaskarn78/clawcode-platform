/**
 * Phase 142 P4 — staging adapter tests (real temp FS + pure helpers).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ensureSkillFrontmatter,
  buildReviewSummary,
  stageOptimizerProposal,
} from "../optimizer-staging.js";
import type { OptimizationResult } from "../optimize-loop.js";
import type { OptimizerAction } from "../optimizer-actions.js";
import type { EvalScore } from "../types.js";

const SCORE = (o: number): EvalScore => ({ overall: o, perTask: [] });

function result(actions: OptimizerAction[], outcome: OptimizationResult["outcome"] = "improved"): OptimizationResult {
  return {
    outcome,
    baselineScore: 0.5,
    candidateScore: 0.8,
    margin: 0.1,
    actions,
    baseline: SCORE(0.5),
    candidate: SCORE(0.8),
  };
}

describe("Phase 142 — ensureSkillFrontmatter", () => {
  it("prepends frontmatter with the name when absent", () => {
    const out = ensureSkillFrontmatter("weather", "Use the weather API.");
    expect(out).toMatch(/^---\nname: weather\n/);
    expect(out).toContain("Use the weather API.");
  });
  it("leaves content whose frontmatter already has a name", () => {
    const md = "---\nname: weather\ndescription: d\n---\n\nbody";
    expect(ensureSkillFrontmatter("weather", md)).toBe(md);
  });
});

describe("Phase 142 — buildReviewSummary", () => {
  it("shows the outcome, score delta, and every action", () => {
    const s = buildReviewSummary(
      "research",
      result([
        { kind: "add", name: "cite-sources", skillMd: "x", rationale: "tasks failed citing" },
        { kind: "remove", name: "old", rationale: "unused" },
      ]),
    );
    expect(s).toContain("research");
    expect(s).toContain("IMPROVED");
    expect(s).toContain("50% → 80%");
    expect(s).toContain("ADD cite-sources");
    expect(s).toContain("REMOVE old");
    expect(s).toMatch(/remove actions are NOT auto-staged/i);
  });
});

describe("Phase 142 — stageOptimizerProposal", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "opt-stage-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const deps = () => ({ agentWorkspaceDir: (agent: string) => join(root, agent) });
  const SUFFIX = "2026-06-02-120000-abc123def456";

  it("stages add/revise as drafts in skills-staging, surfaces removes, returns a summary", async () => {
    const r = result([
      { kind: "add", name: "cite-sources", skillMd: "---\nname: cite-sources\n---\nAlways cite.", rationale: "r1" },
      { kind: "revise", name: "research", skillMd: "Better research instructions.", rationale: "r2" },
      { kind: "remove", name: "stale", rationale: "r3" },
    ]);
    const staged = await stageOptimizerProposal(deps(), { agent: "researcher", result: r, draftIdSuffix: SUFFIX });

    expect(staged.stagedDrafts.map((d) => d.name).sort()).toEqual(["cite-sources", "research"]);
    expect(staged.removes).toEqual([{ name: "stale", rationale: "r3" }]);

    const stagingDir = join(root, "researcher", "skills-staging");
    const files = (await readdir(stagingDir)).sort();
    expect(files).toEqual([
      `cite-sources-${SUFFIX}.md`,
      `research-${SUFFIX}.md`,
    ]);

    // add kept its own frontmatter; revise got frontmatter ensured.
    const cite = await readFile(join(stagingDir, `cite-sources-${SUFFIX}.md`), "utf8");
    expect(cite).toContain("Always cite.");
    const research = await readFile(join(stagingDir, `research-${SUFFIX}.md`), "utf8");
    expect(research).toMatch(/^---\nname: research\n/);

    // no .tmp left behind (atomic rename completed)
    expect(files.some((f) => f.endsWith(".tmp"))).toBe(false);
    expect(staged.summary).toContain("IMPROVED");
  });

  it("stages nothing (only removes) when the proposal is all removes", async () => {
    const r = result([{ kind: "remove", name: "x", rationale: "r" }]);
    const staged = await stageOptimizerProposal(deps(), { agent: "a", result: r, draftIdSuffix: SUFFIX });
    expect(staged.stagedDrafts).toEqual([]);
    expect(staged.removes).toHaveLength(1);
  });
});
