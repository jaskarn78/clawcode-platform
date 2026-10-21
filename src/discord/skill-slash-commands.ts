/**
 * Skill-slash-commands — pure builder for opt-in per-skill Discord commands.
 *
 * Each agent skill whose SKILL.md frontmatter sets `slashCommand: true`
 * becomes a guild-wide Discord slash command (`/<skill-name>`). Discord
 * commands are app/guild-scoped (not per-channel), so a skill is registered
 * ONCE as the union across every agent that has it; the handler gates each
 * invocation by the channel→agent binding.
 *
 * This module is pure (no I/O, no logging) so the union / dedupe / collision
 * logic is unit-testable in isolation. The caller (slash-commands.ts
 * `register()`) supplies the catalog, the per-agent loaded-skill sets, and
 * the reserved-name set; it owns the actual Discord REST registration and
 * any logging of skipped commands.
 */

import type { SkillsCatalog } from "../skills/types.js";
import type { SlashCommandDef } from "./slash-types.js";
import { skillNameToCommandName } from "./skill-command-names.js";

/**
 * Discord caps a command description at 100 characters. Skill descriptions
 * (first paragraph of SKILL.md) routinely exceed that — truncate with an
 * ellipsis so the REST registration body is always accepted.
 */
const DISCORD_DESCRIPTION_MAX = 100;

/** A skill command that was skipped during the build, with the reason. */
export type SkippedSkillCommand = {
  readonly skillName: string;
  readonly commandName: string;
  readonly reason: "reserved-collision" | "skill-collision";
};

/** Result of building the per-skill command set. */
export type SkillCommandBuildResult = {
  /** The SlashCommandDef per unique skill command, ready to register. */
  readonly commands: readonly SlashCommandDef[];
  /**
   * Map from normalised command name → the agent names whose active skill
   * set includes the source skill. Used by the handler to name the
   * holding agent(s) in a wrong-channel ephemeral reject.
   */
  readonly agentsByCommand: ReadonlyMap<string, readonly string[]>;
  /** Skills dropped because of a collision (caller logs these). */
  readonly skipped: readonly SkippedSkillCommand[];
};

/**
 * Truncate a skill description to Discord's 100-char command-description cap.
 * Empty / whitespace-only descriptions fall back to a generic label so the
 * REST body always has a non-empty description (Discord rejects empty ones).
 */
function buildDescription(skillName: string, raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return `Run the ${skillName} skill`.slice(0, DISCORD_DESCRIPTION_MAX);
  }
  return trimmed.length > DISCORD_DESCRIPTION_MAX
    ? `${trimmed.slice(0, DISCORD_DESCRIPTION_MAX - 1)}…`
    : trimmed;
}

/**
 * Build the union of opt-in skill commands across all agents.
 *
 * @param agentLoadedSkills - per-agent active (manifest-survived) skill name
 *   sets. Manifest-refused skills must already be excluded by the caller.
 * @param skillsCatalog - the boot-time skills catalog (carries the
 *   `slashCommand` frontmatter flag).
 * @param reservedNames - command names that already exist (static
 *   `/clawcode-*`, `/gsd-*`, `CONTROL_COMMANDS`, native-CC, etc.). A skill
 *   normalising onto any of these is skipped — the static set is never
 *   regressed. `gsd-`-prefixed names should be included wholesale by the
 *   caller because the register loop re-homes any bare `gsd-` name under
 *   `/get-shit-done`.
 *
 * Rules:
 *   - Only skills flagged `slashCommand: true` in the catalog are included.
 *   - Names are normalised via skillNameToCommandName; an un-normalisable
 *     name is silently dropped.
 *   - Two agents sharing a skill → ONE command, both agents listed in
 *     agentsByCommand (the intended union).
 *   - Two DIFFERENT skills normalising to the same command name → first
 *     wins, the loser is reported in `skipped` (skill-collision).
 *   - A skill normalising onto a reserved name → skipped
 *     (reserved-collision).
 */
export function buildSkillSlashCommands(
  agentLoadedSkills: ReadonlyMap<string, ReadonlySet<string>>,
  skillsCatalog: SkillsCatalog,
  reservedNames: ReadonlySet<string>,
): SkillCommandBuildResult {
  const commands: SlashCommandDef[] = [];
  const skipped: SkippedSkillCommand[] = [];
  // commandName → { skillName, agents }
  const byCommand = new Map<
    string,
    { readonly skillName: string; readonly agents: Set<string> }
  >();

  // Deterministic iteration: sort agent names so collision "first wins" is
  // stable across boots regardless of Map insertion order.
  const agentNames = [...agentLoadedSkills.keys()].sort();

  for (const agentName of agentNames) {
    const skills = agentLoadedSkills.get(agentName);
    if (!skills) continue;
    // Sort skill names too so a within-agent skill→command collision
    // resolves deterministically.
    for (const skillName of [...skills].sort()) {
      const entry = skillsCatalog.get(skillName);
      if (!entry || entry.slashCommand !== true) continue;

      const commandName = skillNameToCommandName(skillName);
      if (commandName === null) continue;

      // Reserved-name collision — never override a static command.
      if (reservedNames.has(commandName)) {
        // Record once per (skill,command) pair.
        const already = skipped.some(
          (s) => s.skillName === skillName && s.commandName === commandName,
        );
        if (!already) {
          skipped.push({ skillName, commandName, reason: "reserved-collision" });
        }
        continue;
      }

      const existing = byCommand.get(commandName);
      if (existing) {
        if (existing.skillName === skillName) {
          // Same skill on another agent — the intended union. Add the agent.
          existing.agents.add(agentName);
        } else {
          // Two distinct skills → same command name. First wins.
          const already = skipped.some(
            (s) => s.skillName === skillName && s.commandName === commandName,
          );
          if (!already) {
            skipped.push({
              skillName,
              commandName,
              reason: "skill-collision",
            });
          }
        }
        continue;
      }

      byCommand.set(commandName, {
        skillName,
        agents: new Set([agentName]),
      });
    }
  }

  const agentsByCommand = new Map<string, readonly string[]>();
  for (const [commandName, { skillName, agents }] of byCommand) {
    const entry = skillsCatalog.get(skillName);
    commands.push({
      name: commandName,
      description: buildDescription(skillName, entry?.description ?? ""),
      // ClawCode skills are NOT native Claude Code skills — they are
      // symlinked into <workspace>/skills/<name>/ and the agent reads
      // SKILL.md directly (there is no native Skill-tool registration).
      // The dispatch therefore points the agent STRAIGHT at the SKILL.md
      // file. Saying "use the <skill> skill" made the agent fumble its
      // native skill invoker, find nothing, then fall back anyway — see the
      // reelforge-cmd-not-registered debug session.
      claudeCommand: `Read the skill instructions at skills/${skillName}/SKILL.md (in your workspace) and follow them to complete this request. {args}`,
      options: [
        {
          name: "args",
          type: 3, // STRING
          description: "Optional instructions or input for the skill",
          required: false,
        },
      ],
      skillDispatch: { skillName },
    });
    agentsByCommand.set(commandName, [...agents].sort());
  }

  return { commands, agentsByCommand, skipped };
}
