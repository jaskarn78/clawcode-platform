/**
 * Skill-slash-commands — SKILL.md `slashCommand:` frontmatter parsing.
 *
 * Covers the pure parser (extractSlashCommandFrontmatter) plus an integration
 * scenario through scanSkillsDirectory that confirms the flag flows onto
 * SkillEntry.slashCommand end-to-end.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  extractSlashCommandFrontmatter,
  scanSkillsDirectory,
} from "../scanner.js";

describe("extractSlashCommandFrontmatter", () => {
  it("returns true when frontmatter sets slashCommand: true", () => {
    expect(
      extractSlashCommandFrontmatter("---\nname: foo\nslashCommand: true\n---\n"),
    ).toBe(true);
  });

  it("is case-insensitive for the literal true", () => {
    expect(
      extractSlashCommandFrontmatter("---\nslashCommand: True\n---\n"),
    ).toBe(true);
    expect(
      extractSlashCommandFrontmatter("---\nslashCommand: TRUE\n---\n"),
    ).toBe(true);
  });

  it("returns false for slashCommand: false", () => {
    expect(
      extractSlashCommandFrontmatter("---\nslashCommand: false\n---\n"),
    ).toBe(false);
  });

  it("returns false when the slashCommand field is absent", () => {
    expect(extractSlashCommandFrontmatter("---\nname: foo\n---\n")).toBe(false);
  });

  it("returns false when there is no frontmatter", () => {
    expect(extractSlashCommandFrontmatter("# Foo no frontmatter")).toBe(false);
  });

  it("returns false for an empty slashCommand value", () => {
    expect(extractSlashCommandFrontmatter("---\nslashCommand:\n---\n")).toBe(
      false,
    );
  });

  it("trims whitespace around the value", () => {
    expect(
      extractSlashCommandFrontmatter("---\nslashCommand:   true   \n---\n"),
    ).toBe(true);
  });
});

describe("scanSkillsDirectory — slashCommand field integration", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "skills-scan-slash-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("populates SkillEntry.slashCommand when SKILL.md opts in", async () => {
    const skillDir = join(tempDir, "reelforge");
    mkdirSync(skillDir);
    writeFileSync(
      join(skillDir, "SKILL.md"),
      [
        "---",
        "version: 2.0.0",
        "slashCommand: true",
        "---",
        "",
        "Build a Acme reel.",
      ].join("\n"),
    );

    const catalog = await scanSkillsDirectory(tempDir);
    const entry = catalog.get("reelforge");
    expect(entry).toBeDefined();
    expect(entry!.slashCommand).toBe(true);
  });

  it("leaves SkillEntry.slashCommand undefined when the flag is absent (back-compat)", async () => {
    const skillDir = join(tempDir, "market-research");
    mkdirSync(skillDir);
    writeFileSync(
      join(skillDir, "SKILL.md"),
      "---\nversion: 1.0.0\n---\n\nDo market research.\n",
    );

    const catalog = await scanSkillsDirectory(tempDir);
    const entry = catalog.get("market-research");
    expect(entry).toBeDefined();
    expect(entry!.slashCommand).toBeUndefined();
  });

  it("leaves slashCommand undefined when set to false", async () => {
    const skillDir = join(tempDir, "no-cmd");
    mkdirSync(skillDir);
    writeFileSync(
      join(skillDir, "SKILL.md"),
      "---\nslashCommand: false\n---\n\nNo command.\n",
    );

    const catalog = await scanSkillsDirectory(tempDir);
    expect(catalog.get("no-cmd")!.slashCommand).toBeUndefined();
  });
});
