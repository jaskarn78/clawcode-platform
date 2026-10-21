import type { EffortLevel } from "../config/schema.js";

/**
 * A single skill entry parsed from a SKILL.md file in a skills directory.
 */
export type SkillEntry = {
  readonly name: string;
  readonly description: string;
  readonly version: string | null;
  readonly path: string;
  /**
   * Phase 83 EFFORT-05 — per-skill effort override.
   *
   * When set, turns that explicitly invoke this skill run at this
   * effort level, then revert at turn boundary. Parsed from SKILL.md
   * YAML frontmatter `effort:` field via extractEffortFrontmatter.
   * Undefined when the skill's SKILL.md omits the field, has no
   * frontmatter, or sets an invalid level (silently ignored).
   */
  readonly effort?: EffortLevel;
  /**
   * Skill-slash-commands — opt-in Discord slash-command flag.
   *
   * When the SKILL.md YAML frontmatter sets `slashCommand: true`, the skill
   * is registered as a guild-wide Discord slash command (`/<skill-name>`)
   * at daemon boot. Skills without the flag get no command — this opt-in
   * model keeps the registered set well under Discord's 90-per-guild cap.
   *
   * Parsed from SKILL.md frontmatter via extractSlashCommandFrontmatter.
   * Undefined when the field is omitted, has no frontmatter, or is set to
   * any value other than the literal `true`.
   */
  readonly slashCommand?: boolean;
};

/**
 * A catalog of discovered skills, keyed by skill name (directory name).
 */
export type SkillsCatalog = ReadonlyMap<string, SkillEntry>;
