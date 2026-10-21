/**
 * Skill-slash-commands — unit tests for the pure command builder.
 *
 * Covers: opt-in filtering (`slashCommand: true` required), the agent union
 * (one command, multiple holders), collision skip (reserved + skill-vs-skill),
 * name normalisation, the dispatch-template shape, and description truncation.
 */

import { describe, it, expect } from "vitest";
import { buildSkillSlashCommands } from "../skill-slash-commands.js";
import type { SkillEntry, SkillsCatalog } from "../../skills/types.js";

function makeCatalog(
  entries: ReadonlyArray<Partial<SkillEntry> & { name: string }>,
): SkillsCatalog {
  const map = new Map<string, SkillEntry>();
  for (const e of entries) {
    map.set(e.name, {
      name: e.name,
      description: e.description ?? `desc for ${e.name}`,
      version: e.version ?? null,
      path: e.path ?? `/skills/${e.name}`,
      ...(e.effort ? { effort: e.effort } : {}),
      ...(e.slashCommand ? { slashCommand: true } : {}),
    });
  }
  return map;
}

describe("buildSkillSlashCommands", () => {
  it("registers ONLY skills flagged slashCommand: true (opt-in)", () => {
    const catalog = makeCatalog([
      { name: "reelforge", slashCommand: true },
      { name: "market-research" }, // no flag → excluded
    ]);
    const agentSkills = new Map<string, ReadonlySet<string>>([
      ["agent-a", new Set(["reelforge", "market-research"])],
    ]);

    const result = buildSkillSlashCommands(agentSkills, catalog, new Set());

    expect(result.commands.map((c) => c.name)).toEqual(["reelforge"]);
  });

  it("excludes a skill not present in the catalog", () => {
    const catalog = makeCatalog([{ name: "reelforge", slashCommand: true }]);
    const agentSkills = new Map<string, ReadonlySet<string>>([
      ["agent-a", new Set(["reelforge", "ghost-skill"])],
    ]);

    const result = buildSkillSlashCommands(agentSkills, catalog, new Set());
    expect(result.commands.map((c) => c.name)).toEqual(["reelforge"]);
  });

  it("registers a shared skill ONCE and lists every holding agent", () => {
    const catalog = makeCatalog([{ name: "reelforge", slashCommand: true }]);
    const agentSkills = new Map<string, ReadonlySet<string>>([
      ["agent-b", new Set(["reelforge"])],
      ["agent-a", new Set(["reelforge"])],
    ]);

    const result = buildSkillSlashCommands(agentSkills, catalog, new Set());

    expect(result.commands).toHaveLength(1);
    // agentsByCommand is sorted for determinism.
    expect(result.agentsByCommand.get("reelforge")).toEqual([
      "agent-a",
      "agent-b",
    ]);
  });

  it("skips a skill that normalises onto a reserved command name", () => {
    const catalog = makeCatalog([
      { name: "clawcode-memory", slashCommand: true },
      { name: "reelforge", slashCommand: true },
    ]);
    const agentSkills = new Map<string, ReadonlySet<string>>([
      ["agent-a", new Set(["clawcode-memory", "reelforge"])],
    ]);

    const result = buildSkillSlashCommands(
      agentSkills,
      catalog,
      new Set(["clawcode-memory"]),
    );

    expect(result.commands.map((c) => c.name)).toEqual(["reelforge"]);
    expect(result.skipped).toEqual([
      {
        skillName: "clawcode-memory",
        commandName: "clawcode-memory",
        reason: "reserved-collision",
      },
    ]);
  });

  it("first-wins when two distinct skills normalise to the same name", () => {
    // "discord:access" → "discord-access"; a literal "discord-access" skill
    // also normalises to "discord-access" → genuine collision.
    const catalog = makeCatalog([
      { name: "discord:access", slashCommand: true },
      { name: "discord-access", slashCommand: true },
    ]);
    const agentSkills = new Map<string, ReadonlySet<string>>([
      ["agent-a", new Set(["discord:access", "discord-access"])],
    ]);

    const result = buildSkillSlashCommands(agentSkills, catalog, new Set());

    // Sorted within-agent: "discord-access" < "discord:access", so the
    // literal skill wins; the colon-form is skipped.
    expect(result.commands).toHaveLength(1);
    expect(result.commands[0].name).toBe("discord-access");
    expect(result.commands[0].skillDispatch?.skillName).toBe("discord-access");
    expect(result.skipped).toEqual([
      {
        skillName: "discord:access",
        commandName: "discord-access",
        reason: "skill-collision",
      },
    ]);
  });

  it("builds a natural-language dispatch template with an optional args option", () => {
    const catalog = makeCatalog([{ name: "reelforge", slashCommand: true }]);
    const agentSkills = new Map<string, ReadonlySet<string>>([
      ["agent-a", new Set(["reelforge"])],
    ]);

    const result = buildSkillSlashCommands(agentSkills, catalog, new Set());
    const cmd = result.commands[0];

    expect(cmd.claudeCommand).toBe(
      "Read the skill instructions at skills/reelforge/SKILL.md (in your workspace) and follow them to complete this request. {args}",
    );
    expect(cmd.options).toHaveLength(1);
    expect(cmd.options[0]).toMatchObject({
      name: "args",
      type: 3,
      required: false,
    });
    expect(cmd.skillDispatch).toEqual({ skillName: "reelforge" });
  });

  it("truncates a long description to Discord's 100-char cap", () => {
    const longDesc = "x".repeat(250);
    const catalog = makeCatalog([
      { name: "reelforge", slashCommand: true, description: longDesc },
    ]);
    const agentSkills = new Map<string, ReadonlySet<string>>([
      ["agent-a", new Set(["reelforge"])],
    ]);

    const result = buildSkillSlashCommands(agentSkills, catalog, new Set());
    expect(result.commands[0].description.length).toBeLessThanOrEqual(100);
  });

  it("normalises a colon-namespaced skill name into a legal command name", () => {
    const catalog = makeCatalog([
      { name: "discord:configure", slashCommand: true },
    ]);
    const agentSkills = new Map<string, ReadonlySet<string>>([
      ["agent-a", new Set(["discord:configure"])],
    ]);

    const result = buildSkillSlashCommands(agentSkills, catalog, new Set());
    expect(result.commands[0].name).toBe("discord-configure");
    // skillDispatch keeps the ORIGINAL (un-normalised) skill name.
    expect(result.commands[0].skillDispatch?.skillName).toBe(
      "discord:configure",
    );
  });

  it("produces no commands when no agent has an opted-in skill", () => {
    const catalog = makeCatalog([{ name: "reelforge" }]); // no flag
    const agentSkills = new Map<string, ReadonlySet<string>>([
      ["agent-a", new Set(["reelforge"])],
    ]);
    const result = buildSkillSlashCommands(agentSkills, catalog, new Set());
    expect(result.commands).toEqual([]);
  });
});
