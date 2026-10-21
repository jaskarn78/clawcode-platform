import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { Logger } from "pino";
import { effortSchema, type EffortLevel } from "../config/schema.js";
import type { SkillEntry, SkillsCatalog } from "./types.js";

/**
 * Parse YAML frontmatter from a SKILL.md file content.
 * Extracts `version` field if present. Returns null if no frontmatter or no version.
 */
function extractVersion(content: string): string | null {
  const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (!frontmatterMatch) {
    return null;
  }

  const versionMatch = frontmatterMatch[1].match(/^version:\s*(.+)$/m);
  return versionMatch ? versionMatch[1].trim() : null;
}

/**
 * Phase 83 EFFORT-05 — extract `effort:` YAML frontmatter from SKILL.md.
 *
 * Returns:
 *   - The parsed EffortLevel when the value is one of the v2.2 levels
 *     (low|medium|high|xhigh|max|auto|off) validated by effortSchema.
 *   - null when there's no frontmatter, no `effort:` field, an empty
 *     value, or an invalid level (Zod rejects → null, silently ignored).
 *
 * Mirrors the shape of extractVersion — regex frontmatter extraction +
 * single-line key match. Whitespace around the value is trimmed. Invalid
 * values are silently dropped (not thrown) so a broken SKILL.md cannot
 * crash the daemon at startup; the skill is simply treated as if it has
 * no override.
 */
export function extractEffortFrontmatter(content: string): EffortLevel | null {
  const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (!frontmatterMatch) return null;
  const effortMatch = frontmatterMatch[1].match(/^effort:\s*(.+)$/m);
  if (!effortMatch) return null;
  const raw = effortMatch[1].trim();
  if (raw.length === 0) return null;
  // Quick 260715-j1j (D9) — explicit ultracode rejection BEFORE the schema
  // parse (which accepts it since the enum widened): a skill must never flip
  // the native-Workflow orchestration mode mid-turn. Treated exactly like an
  // invalid level (null, silently ignored — this function is pure/loggerless;
  // the scanner-effort-frontmatter test pins the intent). Layer 2 of the
  // defense is the turn-dispatcher applySkillEffort clamp.
  if (raw === "ultracode") return null;
  const parsed = effortSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/**
 * Skill-slash-commands — extract the `slashCommand:` YAML frontmatter flag
 * from SKILL.md.
 *
 * Returns true ONLY when the value is the literal `true` (case-insensitive,
 * whitespace-trimmed). Any other value — `false`, an empty value, a missing
 * field, or no frontmatter at all — returns false. Mirrors the regex
 * frontmatter extraction shape of extractVersion / extractEffortFrontmatter.
 *
 * Opt-in by design: only skills that explicitly set `slashCommand: true`
 * become Discord slash commands.
 */
export function extractSlashCommandFrontmatter(content: string): boolean {
  const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (!frontmatterMatch) return false;
  const flagMatch = frontmatterMatch[1].match(/^slashCommand:\s*(.+)$/m);
  if (!flagMatch) return false;
  return flagMatch[1].trim().toLowerCase() === "true";
}

/**
 * Extract the first paragraph (description) from SKILL.md content.
 * Skips YAML frontmatter and leading blank lines.
 * First paragraph = first non-empty lines before a blank line.
 */
function extractDescription(content: string): string {
  // Strip frontmatter if present
  const withoutFrontmatter = content.replace(/^---\n[\s\S]*?\n---\n*/, "");

  const lines = withoutFrontmatter.split("\n");
  const paragraphLines: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === "" && paragraphLines.length > 0) {
      break;
    }
    if (trimmed !== "") {
      paragraphLines.push(trimmed);
    }
  }

  return paragraphLines.join(" ");
}

/**
 * Scan a directory of skill folders and return a catalog of discovered skills.
 *
 * Each subdirectory must contain a SKILL.md file to be recognized as a skill.
 * Directories without SKILL.md are skipped with a warning log.
 * Non-existent or empty directories return an empty catalog.
 *
 * @param skillsPath - Absolute path to the skills directory
 * @param log - Optional pino logger for warnings
 * @returns A SkillsCatalog (ReadonlyMap) keyed by skill directory name
 */
export async function scanSkillsDirectory(
  skillsPath: string,
  log?: Logger,
): Promise<SkillsCatalog> {
  const catalog = new Map<string, SkillEntry>();

  let entries: string[];
  try {
    entries = await readdir(skillsPath);
  } catch {
    log?.warn({ skillsPath }, "Skills directory does not exist, returning empty catalog");
    return catalog;
  }

  for (const entry of entries) {
    const entryPath = join(skillsPath, entry);

    // Skip non-directories
    const entryStat = await stat(entryPath);
    if (!entryStat.isDirectory()) {
      continue;
    }

    const skillMdPath = join(entryPath, "SKILL.md");
    let content: string;
    try {
      content = await readFile(skillMdPath, "utf-8");
    } catch {
      log?.warn({ skill: entry }, "Skipping directory without SKILL.md");
      continue;
    }

    const version = extractVersion(content);
    const description = extractDescription(content);
    // Phase 83 EFFORT-05 — conditional spread: omit the field when null so
    // SkillEntry.effort stays undefined (readonly optional). Readers then
    // use `entry.effort` as a truthy/undefined guard.
    const effort = extractEffortFrontmatter(content);
    // Skill-slash-commands — conditional spread: omit the field unless the
    // SKILL.md opts in with `slashCommand: true`, so SkillEntry.slashCommand
    // stays undefined for the common case (back-compat for every reader).
    const slashCommand = extractSlashCommandFrontmatter(content);

    catalog.set(entry, {
      name: entry,
      description,
      version,
      path: entryPath,
      ...(effort ? { effort } : {}),
      ...(slashCommand ? { slashCommand: true } : {}),
    });
  }

  return catalog;
}
