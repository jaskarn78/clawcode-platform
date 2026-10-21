/**
 * Phase 142 P4 — stage a KEPT optimization proposal for operator review.
 *
 * Reuses the Phase 132 skill-draft pipeline: each add/revise action is written
 * as a staged draft into `<agentDir>/skills-staging/` in the distiller's filename
 * convention (`<slug>-<suffix>.md`, suffix ends with a 12-hex fingerprint), so the
 * EXISTING `approveDraft` (skill-draft-actions.ts) applies it to
 * `<agentDir>/skills/<slug>/SKILL.md` on operator approval — and `rejectDraft`
 * discards it. NOTHING is auto-applied here; staging + the operator gate are the
 * whole point.
 *
 * `remove` actions have no existing apply handler and are the highest-blast-radius
 * action, so v1 does NOT auto-stage them — they're surfaced in the review summary
 * for the operator to action manually. (A future plan can add a remove handler.)
 */
import { join } from "node:path";
import {
  mkdir as fsMkdir,
  writeFile as fsWriteFile,
  rename as fsRename,
} from "node:fs/promises";
import type { OptimizationResult } from "./optimize-loop.js";
import type { OptimizerAction } from "./optimizer-actions.js";

export type StagingFs = {
  readonly mkdir: typeof fsMkdir;
  readonly writeFile: typeof fsWriteFile;
  readonly rename: typeof fsRename;
};

export type StagingDeps = {
  /** Absolute path to `~/.clawcode/agents/<agent>/` (same source as skill-draft-actions). */
  readonly agentWorkspaceDir: (agent: string) => string;
  readonly fs?: StagingFs;
  readonly log?: (obj: Record<string, unknown>, msg: string) => void;
};

export type StagedOptimizerProposal = {
  readonly stagedDrafts: ReadonlyArray<{ readonly name: string; readonly stagingPath: string }>;
  /** remove actions — NOT auto-staged; for the operator to action manually. */
  readonly removes: ReadonlyArray<{ readonly name: string; readonly rationale: string }>;
  readonly summary: string;
};

/**
 * Ensure the SKILL.md has YAML frontmatter whose `name:` matches `name` so
 * approveDraft derives the correct target slug. If frontmatter is absent (or has
 * no name), prepend a minimal block; otherwise leave the content as-is.
 */
export function ensureSkillFrontmatter(name: string, skillMd: string): string {
  const trimmed = skillMd.trimStart();
  if (trimmed.startsWith("---")) {
    const end = trimmed.indexOf("\n---", 3);
    const fm = end === -1 ? trimmed : trimmed.slice(0, end);
    if (/(^|\n)name:\s*\S/.test(fm)) return skillMd; // already has a name
  }
  return `---\nname: ${name}\ndescription: Proposed by the agent optimizer (Phase 142).\n---\n\n${skillMd.trimStart()}`;
}

/** Human-readable review summary: outcome, score delta, and every action. */
export function buildReviewSummary(agent: string, result: OptimizationResult): string {
  const pct = (n: number | undefined): string =>
    n === undefined ? "n/a" : `${Math.round(n * 100)}%`;
  const lines: string[] = [
    `Agent optimizer proposal for "${agent}" — ${result.outcome.toUpperCase()}`,
    `Score: ${pct(result.baselineScore)} → ${pct(result.candidateScore)} (margin ${pct(result.margin)})`,
    "Actions:",
  ];
  for (const a of result.actions) {
    lines.push(`  - ${a.kind.toUpperCase()} ${a.name}: ${a.rationale || "(no rationale)"}`);
  }
  const removes = result.actions.filter((a) => a.kind === "remove");
  if (removes.length > 0) {
    lines.push("NOTE: remove actions are NOT auto-staged — review + apply them manually.");
  }
  return lines.join("\n");
}

/**
 * Stage the add/revise drafts of a proposal into the agent's skills-staging dir
 * (atomic tmp+rename), and return the staged paths + removes + a review summary.
 *
 * @param draftIdSuffix `<timestamp>-<fingerprint12>` — the distiller filename
 *   suffix the approve/reject handlers peel. Injected so tests are deterministic;
 *   the real wiring builds it from a timestamp + a content hash.
 */
export async function stageOptimizerProposal(
  deps: StagingDeps,
  args: {
    readonly agent: string;
    readonly result: OptimizationResult;
    readonly draftIdSuffix: string;
  },
): Promise<StagedOptimizerProposal> {
  const fs: StagingFs = deps.fs ?? { mkdir: fsMkdir, writeFile: fsWriteFile, rename: fsRename };
  const stagingDir = join(deps.agentWorkspaceDir(args.agent), "skills-staging");
  await fs.mkdir(stagingDir, { recursive: true });

  const stagedDrafts: Array<{ name: string; stagingPath: string }> = [];
  const removes: Array<{ name: string; rationale: string }> = [];

  for (const action of args.result.actions) {
    if (action.kind === "remove") {
      removes.push({ name: action.name, rationale: action.rationale });
      continue;
    }
    const content = ensureSkillFrontmatter(action.name, (action as Extract<OptimizerAction, { skillMd: string }>).skillMd);
    const fileName = `${action.name}-${args.draftIdSuffix}.md`;
    const finalPath = join(stagingDir, fileName);
    const tmpPath = `${finalPath}.tmp`;
    await fs.writeFile(tmpPath, content, "utf8");
    await fs.rename(tmpPath, finalPath); // atomic publish (mirrors the distiller writer)
    stagedDrafts.push({ name: action.name, stagingPath: finalPath });
  }

  deps.log?.(
    { agent: args.agent, staged: stagedDrafts.length, removes: removes.length, outcome: args.result.outcome },
    "optimizer: proposal staged for operator review",
  );

  return { stagedDrafts, removes, summary: buildReviewSummary(args.agent, args.result) };
}
