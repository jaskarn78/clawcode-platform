/**
 * Phase 83 Plan 03 Task 2 (RED→GREEN) — SKILL.md `effort:` frontmatter parsing.
 *
 * EFFORT-05 native-format parity: SKILL.md files in the Claude Code
 * skill-file format can carry a top-level `effort:` YAML frontmatter field.
 * When the skill is invoked, the turn-dispatcher applies that level for the
 * duration of the turn, then reverts (turn-boundary revert).
 *
 * This test set covers the pure parser only (extractEffortFrontmatter) plus
 * one integration scenario through scanSkillsDirectory to confirm the field
 * flows onto SkillEntry.effort end-to-end.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { extractEffortFrontmatter, scanSkillsDirectory } from "../scanner.js";

describe("extractEffortFrontmatter", () => {
  it("returns the parsed level when frontmatter has a valid effort field", () => {
    const result = extractEffortFrontmatter(
      "---\nname: foo\neffort: max\n---\n# Foo\n",
    );
    expect(result).toBe("max");
  });

  it("returns null when frontmatter has no effort field", () => {
    const result = extractEffortFrontmatter(
      "---\nname: foo\n---\n# Foo\n",
    );
    expect(result).toBeNull();
  });

  it("returns null when content has no frontmatter", () => {
    const result = extractEffortFrontmatter("# Foo no frontmatter");
    expect(result).toBeNull();
  });

  it("returns null for an invalid effort level value (Zod guard)", () => {
    const result = extractEffortFrontmatter(
      "---\neffort: bogus\n---",
    );
    expect(result).toBeNull();
  });

  it("returns null for an empty effort value", () => {
    const result = extractEffortFrontmatter(
      "---\neffort:\n---",
    );
    expect(result).toBeNull();
  });

  it("accepts every valid v2.2 level", () => {
    const levels = ["low", "medium", "high", "xhigh", "max", "auto", "off"] as const;
    for (const level of levels) {
      const result = extractEffortFrontmatter(`---\neffort: ${level}\n---\n`);
      expect(result).toBe(level);
    }
  });

  // Quick 260715-j1j (D9) — a skill must never flip the native-Workflow
  // orchestration mode mid-turn. `ultracode` is a valid effortSchema member
  // since the enum widened, so the scanner REJECTS it explicitly BEFORE the
  // schema parse (treated exactly like an invalid level → null).
  it("rejects 'ultracode' frontmatter (orchestration mode is not skill-selectable)", () => {
    const result = extractEffortFrontmatter("---\neffort: ultracode\n---\n");
    expect(result).toBeNull();
  });

  it("rejects 'ultracode' with surrounding whitespace too", () => {
    const result = extractEffortFrontmatter("---\neffort:   ultracode  \n---\n");
    expect(result).toBeNull();
  });

  it("trims whitespace around the effort value", () => {
    const result = extractEffortFrontmatter(
      "---\neffort:    max   \n---\n",
    );
    expect(result).toBe("max");
  });
});

describe("scanSkillsDirectory — effort field integration", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "skills-scan-effort-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("populates SkillEntry.effort when SKILL.md has effort frontmatter", async () => {
    const skillDir = join(tempDir, "deep-thinker");
    mkdirSync(skillDir);
    writeFileSync(
      join(skillDir, "SKILL.md"),
      [
        "---",
        "version: 1.0.0",
        "effort: max",
        "---",
        "",
        "Forces max effort when invoked.",
      ].join("\n"),
    );

    const catalog = await scanSkillsDirectory(tempDir);
    const entry = catalog.get("deep-thinker");
    expect(entry).toBeDefined();
    expect(entry!.effort).toBe("max");
    // Other fields still parsed correctly.
    expect(entry!.version).toBe("1.0.0");
    expect(entry!.description).toBe("Forces max effort when invoked.");
  });

  it("leaves SkillEntry.effort undefined when SKILL.md has no effort frontmatter (back-compat)", async () => {
    const skillDir = join(tempDir, "normal-skill");
    mkdirSync(skillDir);
    writeFileSync(
      join(skillDir, "SKILL.md"),
      "---\nversion: 1.0.0\n---\n\nNo effort override.\n",
    );

    const catalog = await scanSkillsDirectory(tempDir);
    const entry = catalog.get("normal-skill");
    expect(entry).toBeDefined();
    expect(entry!.effort).toBeUndefined();
    expect(entry!.version).toBe("1.0.0");
  });

  it("ignores invalid effort values (does NOT populate effort, does NOT crash)", async () => {
    const skillDir = join(tempDir, "broken-effort");
    mkdirSync(skillDir);
    writeFileSync(
      join(skillDir, "SKILL.md"),
      "---\neffort: turbo-mode\n---\n\nInvalid level.\n",
    );

    const catalog = await scanSkillsDirectory(tempDir);
    const entry = catalog.get("broken-effort");
    expect(entry).toBeDefined();
    expect(entry!.effort).toBeUndefined();
  });

  it("mixed fleet: only skills with valid effort get the field populated", async () => {
    const a = join(tempDir, "a");
    const b = join(tempDir, "b");
    mkdirSync(a);
    mkdirSync(b);
    writeFileSync(
      join(a, "SKILL.md"),
      "---\neffort: high\n---\n\nHigh effort skill.\n",
    );
    writeFileSync(
      join(b, "SKILL.md"),
      "No frontmatter at all, just description.\n",
    );

    const catalog = await scanSkillsDirectory(tempDir);
    expect(catalog.get("a")!.effort).toBe("high");
    expect(catalog.get("b")!.effort).toBeUndefined();
  });
});
