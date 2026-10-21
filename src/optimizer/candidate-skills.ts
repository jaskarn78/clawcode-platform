/**
 * Phase 142 — candidate skill-set staging.
 *
 * Materialises a candidate skill set into a throwaway workspace dir laid out as
 * `<workspace>/.claude/skills/<name>/SKILL.md`. A forked eval session points its
 * cwd at this workspace with `settingSources: ["project"]` so the SDK loads
 * ONLY these skills (see agent-runner.ts + the isolation spike).
 *
 * Used for BOTH:
 *   - baseline: copy the agent's CURRENT skills verbatim (no overrides), and
 *   - candidate: copy current + apply the optimizer's proposed write/remove
 *     overrides (P3).
 *
 * NOTE: whether a forked SDK session actually loads only this dir is the
 * load-bearing isolation assumption — verified by scripts/isolation-spike.ts,
 * NOT by this module's unit tests.
 */
import { mkdtemp, mkdir, writeFile, rm, cp, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** A proposed mutation to the skill set (P3 actions; baseline passes none). */
export type SkillOverride =
  | { readonly op: "write"; readonly name: string; readonly skillMd: string } // add OR revise
  | { readonly op: "remove"; readonly name: string };

export type StagedSkills = {
  /** Temp workspace dir; pass as the forked session's cwd (workspace). */
  readonly workspace: string;
  /** The skill names actually staged (after removes/adds). */
  readonly skillNames: string[];
  /** Remove the workspace. Always call (try/finally) to avoid tmp leaks. */
  readonly dispose: () => Promise<void>;
};

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Stage a candidate skill set into a fresh temp workspace.
 *
 * @param sourceSkillsRoot Directory holding installed skills (`<root>/<name>/`).
 * @param skillNames       The agent's current skill names to include.
 * @param overrides        Optional write/remove mutations (P3 candidate).
 */
export async function stageCandidateSkills(opts: {
  readonly sourceSkillsRoot: string;
  readonly skillNames: readonly string[];
  readonly overrides?: readonly SkillOverride[];
}): Promise<StagedSkills> {
  const workspace = await mkdtemp(join(tmpdir(), "optimizer-cand-"));
  const skillsRoot = join(workspace, ".claude", "skills");
  await mkdir(skillsRoot, { recursive: true });

  const overrides = opts.overrides ?? [];
  const removed = new Set(
    overrides.filter((o) => o.op === "remove").map((o) => o.name),
  );
  const writes = new Map(
    overrides
      .filter((o): o is Extract<SkillOverride, { op: "write" }> => o.op === "write")
      .map((o) => [o.name, o.skillMd]),
  );

  const staged: string[] = [];

  // 1. Copy the agent's current skills (minus removed, minus those a write will
  //    overwrite — written below so the candidate content wins).
  for (const name of opts.skillNames) {
    if (removed.has(name) || writes.has(name)) continue;
    const src = join(opts.sourceSkillsRoot, name);
    if (!(await exists(src))) continue; // not installed — best-effort skip
    await cp(src, join(skillsRoot, name), { recursive: true });
    staged.push(name);
  }

  // 2. Apply write overrides (add new OR revise existing — content wins).
  for (const [name, skillMd] of writes) {
    if (removed.has(name)) continue; // remove beats write
    const dir = join(skillsRoot, name);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "SKILL.md"), skillMd, "utf-8");
    staged.push(name);
  }

  return {
    workspace,
    skillNames: staged,
    dispose: () => rm(workspace, { recursive: true, force: true }),
  };
}
