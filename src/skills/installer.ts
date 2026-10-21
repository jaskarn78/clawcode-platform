import { readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import type { Logger } from "pino";
import { logger } from "../shared/logger.js";

/**
 * Default global skills directory — where Claude Code looks for skills.
 */
export const GLOBAL_SKILLS_DIR = join(homedir(), ".claude", "skills");

/**
 * Install workspace-local skills to the global Claude Code skills directory.
 *
 * Copies each `<workspaceSkillsDir>/<skill-name>/SKILL.md` to
 * `<globalSkillsDir>/<skill-name>/SKILL.md`. Skips if content already matches.
 * Silently handles missing or empty source directory.
 *
 * @param workspaceSkillsDir - Path to the workspace's `skills/` directory
 * @param globalSkillsDir - Destination directory (defaults to ~/.claude/skills)
 * @param log - Logger instance
 */
export async function installWorkspaceSkills(
  workspaceSkillsDir: string,
  globalSkillsDir: string = GLOBAL_SKILLS_DIR,
  log: Logger = logger,
): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(workspaceSkillsDir);
  } catch {
    // Source dir missing or unreadable — nothing to install
    return;
  }

  for (const skillName of entries) {
    const srcFile = join(workspaceSkillsDir, skillName, "SKILL.md");
    const destDir = join(globalSkillsDir, skillName);
    const destFile = join(destDir, "SKILL.md");

    let srcContent: string;
    try {
      srcContent = await readFile(srcFile, "utf-8");
    } catch {
      // No SKILL.md in this dir — skip
      continue;
    }

    // Skip if destination already matches
    try {
      const existing = await readFile(destFile, "utf-8");
      if (existing === srcContent) {
        log.debug({ skill: skillName }, "skill already up-to-date");
        continue;
      }
    } catch {
      // Destination doesn't exist — proceed with copy
    }

    await mkdir(destDir, { recursive: true });
    await writeFile(destFile, srcContent, "utf-8");
    log.info({ skill: skillName, dest: destFile }, "installed skill");
  }
}
