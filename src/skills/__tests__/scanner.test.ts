import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { scanSkillsDirectory } from "../scanner.js";

describe("scanSkillsDirectory", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "skills-scan-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("returns empty catalog for empty directory", async () => {
    const catalog = await scanSkillsDirectory(tempDir);

    expect(catalog.size).toBe(0);
  });

  it("returns empty catalog for non-existent directory", async () => {
    const catalog = await scanSkillsDirectory(join(tempDir, "nonexistent"));

    expect(catalog.size).toBe(0);
  });

  it("parses skill with SKILL.md containing YAML frontmatter", async () => {
    const skillDir = join(tempDir, "my-skill");
    mkdirSync(skillDir);
    writeFileSync(
      join(skillDir, "SKILL.md"),
      [
        "---",
        "version: 1.2.0",
        "---",
        "",
        "This skill does amazing things.",
        "",
        "## Details",
        "More info here.",
      ].join("\n"),
    );

    const catalog = await scanSkillsDirectory(tempDir);

    expect(catalog.size).toBe(1);
    const entry = catalog.get("my-skill");
    expect(entry).toBeDefined();
    expect(entry!.name).toBe("my-skill");
    expect(entry!.version).toBe("1.2.0");
    expect(entry!.description).toBe("This skill does amazing things.");
    expect(entry!.path).toBe(skillDir);
  });

  it("returns version as null when SKILL.md has no frontmatter", async () => {
    const skillDir = join(tempDir, "no-version");
    mkdirSync(skillDir);
    writeFileSync(
      join(skillDir, "SKILL.md"),
      "A simple skill with no frontmatter.\n\nMore details.\n",
    );

    const catalog = await scanSkillsDirectory(tempDir);

    expect(catalog.size).toBe(1);
    const entry = catalog.get("no-version");
    expect(entry).toBeDefined();
    expect(entry!.version).toBeNull();
    expect(entry!.description).toBe("A simple skill with no frontmatter.");
  });

  it("skips subdirectories without SKILL.md", async () => {
    const validDir = join(tempDir, "valid-skill");
    mkdirSync(validDir);
    writeFileSync(join(validDir, "SKILL.md"), "Valid skill description.\n");

    const invalidDir = join(tempDir, "no-skill-md");
    mkdirSync(invalidDir);
    writeFileSync(join(invalidDir, "README.md"), "Not a skill.\n");

    const catalog = await scanSkillsDirectory(tempDir);

    expect(catalog.size).toBe(1);
    expect(catalog.has("valid-skill")).toBe(true);
    expect(catalog.has("no-skill-md")).toBe(false);
  });

  it("skips regular files in the skills directory", async () => {
    writeFileSync(join(tempDir, "not-a-dir.txt"), "just a file");

    const skillDir = join(tempDir, "real-skill");
    mkdirSync(skillDir);
    writeFileSync(join(skillDir, "SKILL.md"), "Real skill.\n");

    const catalog = await scanSkillsDirectory(tempDir);

    expect(catalog.size).toBe(1);
    expect(catalog.has("real-skill")).toBe(true);
  });

  it("handles SKILL.md with frontmatter but no version field", async () => {
    const skillDir = join(tempDir, "no-version-field");
    mkdirSync(skillDir);
    writeFileSync(
      join(skillDir, "SKILL.md"),
      ["---", "author: someone", "---", "", "Skill without version."].join(
        "\n",
      ),
    );

    const catalog = await scanSkillsDirectory(tempDir);

    const entry = catalog.get("no-version-field");
    expect(entry).toBeDefined();
    expect(entry!.version).toBeNull();
    expect(entry!.description).toBe("Skill without version.");
  });

  it("handles multiple skills in one directory", async () => {
    for (const name of ["alpha", "beta", "gamma"]) {
      const dir = join(tempDir, name);
      mkdirSync(dir);
      writeFileSync(
        join(dir, "SKILL.md"),
        `---\nversion: 1.0.0\n---\n\n${name} skill description.\n`,
      );
    }

    const catalog = await scanSkillsDirectory(tempDir);

    expect(catalog.size).toBe(3);
    expect(catalog.get("alpha")!.description).toBe("alpha skill description.");
    expect(catalog.get("beta")!.description).toBe("beta skill description.");
    expect(catalog.get("gamma")!.description).toBe("gamma skill description.");
  });
});
