import { lstat, readlink, symlink, unlink, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Logger } from "pino";
import type { SkillEntry, SkillsCatalog } from "./types.js";

/**
 * Link one skill into one directory. Idempotent: a correct symlink is left
 * alone, a wrong one is repointed, and a real file/dir at the path is never
 * clobbered.
 */
async function linkOne(
  targetDir: string,
  skillName: string,
  entry: SkillEntry,
  log?: Logger,
): Promise<void> {
  const linkPath = join(targetDir, skillName);

  // Check existing symlink state
  try {
    const stats = await lstat(linkPath);
    if (stats.isSymbolicLink()) {
      const currentTarget = await readlink(linkPath);
      if (currentTarget === entry.path) {
        // Already correct, skip
        return;
      }
      // Wrong target, remove and recreate
      await unlink(linkPath);
    } else {
      // Non-symlink file/dir exists at this path, skip with warning
      log?.warn({ skill: skillName, linkPath }, "Non-symlink exists at skill link path, skipping");
      return;
    }
  } catch {
    // Path doesn't exist, which is fine -- we'll create it
  }

  await symlink(entry.path, linkPath);
  log?.debug({ skill: skillName, target: entry.path }, "Skill symlink created");
}

/**
 * Create symlinks in an agent's workspace skills/ directory for each assigned skill.
 *
 * For each skill name in assignedSkillNames:
 * - Look up the SkillEntry in catalog
 * - If found, create a symlink at {agentSkillsDir}/{skillName} -> entry.path
 * - If symlink already exists and points to correct target, skip
 * - If symlink points to wrong target, remove and recreate
 * - If skill name not found in catalog, log warning and skip
 *
 * @param agentSkillsDir - Absolute path to the agent's workspace skills/ directory
 * @param assignedSkillNames - Skill names assigned to this agent
 * @param catalog - The full skills catalog from scanning
 * @param log - Optional pino logger
 * @param opts.cliSkillsDir - See below.
 *
 * ## `cliSkillsDir` — making the native `Skill()` tool resolve these
 *
 * 2026-09-10 (client-a-personal): `Skill(shopping-research)` returned
 * `Unknown skill: shopping-research` for a skill that was assigned, present
 * on disk, correctly symlinked into `<workspace>/skills/`, and logged
 * `phase130-skill-load-success` at boot. Same for `adaptive-coaching`.
 * Nothing was broken — the two systems simply never met:
 *
 *   - ClawCode lists assigned skills in the system prompt and symlinks them
 *     into `<workspace>/skills/`, expecting the agent to READ `SKILL.md`
 *     (see the header text at session-config.ts:786).
 *   - The Claude Code CLI has its OWN skill registry, populated from
 *     `.claude/skills/` under its setting sources. It never saw ClawCode's
 *     tree, so the native `Skill()` tool did not know these names.
 *
 * An agent handed a catalog of skill names and a `Skill` tool will call
 * `Skill(name)` — that is the correct instinct, and it was failing on absent
 * plumbing rather than agent error. So we ALSO link into the CLI's project
 * discovery root, which makes the native tool resolve assigned skills while
 * the file-reading path keeps working unchanged.
 *
 * Verified on the prod pin (claude 2.1.257): a `SKILL.md` under
 * `<cwd>/.claude/skills/<name>/` IS discovered with
 * `--setting-sources=project`. Callers must therefore pass the directory
 * matching the session's cwd — `gsd.projectDir ?? workspace` (mirroring
 * `ensureSessionCwd` in session-adapter.ts) — not blindly the workspace.
 *
 * Only ASSIGNED skills are linked, never the whole catalog: the CLI would
 * otherwise surface every fleet skill to every agent. Stale links are NOT
 * pruned — `.claude/skills/` also holds skills ClawCode does not manage
 * (first-run-setup, set-goal), and blowing those away is not this
 * function's business.
 */
export async function linkAgentSkills(
  agentSkillsDir: string,
  assignedSkillNames: readonly string[],
  catalog: SkillsCatalog,
  log?: Logger,
  opts?: { readonly cliSkillsDir?: string },
): Promise<void> {
  if (assignedSkillNames.length === 0) {
    return;
  }

  const targetDirs = [
    agentSkillsDir,
    ...(opts?.cliSkillsDir !== undefined ? [opts.cliSkillsDir] : []),
  ];

  // Ensure the skills directories exist
  for (const dir of targetDirs) {
    await mkdir(dir, { recursive: true });
  }

  for (const skillName of assignedSkillNames) {
    const entry: SkillEntry | undefined = catalog.get(skillName);
    if (!entry) {
      log?.warn({ skill: skillName }, "Assigned skill not found in catalog, skipping");
      continue;
    }

    for (const dir of targetDirs) {
      await linkOne(dir, skillName, entry, log);
    }
  }
}
