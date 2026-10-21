import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
import { installWorkspaceSkills } from "../installer.js";

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "skill-installer-test-"));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe("installWorkspaceSkills", () => {
  it("copies SKILL.md from source to dest when dest does not exist", async () => {
    const src = join(tempDir, "src");
    const dest = join(tempDir, "dest");
    await mkdir(join(src, "my-skill"), { recursive: true });
    await writeFile(join(src, "my-skill", "SKILL.md"), "# My Skill", "utf-8");

    await installWorkspaceSkills(src, dest);

    const content = await readFile(join(dest, "my-skill", "SKILL.md"), "utf-8");
    expect(content).toBe("# My Skill");
  });

  it("skips copy when content matches (idempotent)", async () => {
    const src = join(tempDir, "src");
    const dest = join(tempDir, "dest");
    await mkdir(join(src, "my-skill"), { recursive: true });
    await mkdir(join(dest, "my-skill"), { recursive: true });
    const content = "# My Skill\nversion: 1.0";
    await writeFile(join(src, "my-skill", "SKILL.md"), content, "utf-8");
    await writeFile(join(dest, "my-skill", "SKILL.md"), content, "utf-8");

    // Should not throw and should not change file
    await installWorkspaceSkills(src, dest);

    const existing = await readFile(join(dest, "my-skill", "SKILL.md"), "utf-8");
    expect(existing).toBe(content);
  });

  it("overwrites dest when content differs", async () => {
    const src = join(tempDir, "src");
    const dest = join(tempDir, "dest");
    await mkdir(join(src, "my-skill"), { recursive: true });
    await mkdir(join(dest, "my-skill"), { recursive: true });
    await writeFile(join(src, "my-skill", "SKILL.md"), "# New Content", "utf-8");
    await writeFile(join(dest, "my-skill", "SKILL.md"), "# Old Content", "utf-8");

    await installWorkspaceSkills(src, dest);

    const result = await readFile(join(dest, "my-skill", "SKILL.md"), "utf-8");
    expect(result).toBe("# New Content");
  });

  it("handles empty source dir without error", async () => {
    const src = join(tempDir, "src");
    const dest = join(tempDir, "dest");
    await mkdir(src, { recursive: true });

    await expect(installWorkspaceSkills(src, dest)).resolves.not.toThrow();
  });

  it("handles missing source dir without error", async () => {
    const src = join(tempDir, "nonexistent");
    const dest = join(tempDir, "dest");

    await expect(installWorkspaceSkills(src, dest)).resolves.not.toThrow();
  });

  it("skips skill dirs without SKILL.md", async () => {
    const src = join(tempDir, "src");
    const dest = join(tempDir, "dest");
    await mkdir(join(src, "no-skill-md"), { recursive: true });
    await writeFile(join(src, "no-skill-md", "other.md"), "other", "utf-8");

    await installWorkspaceSkills(src, dest);

    // dest/no-skill-md should not exist
    await expect(readFile(join(dest, "no-skill-md", "SKILL.md"), "utf-8")).rejects.toThrow();
  });
});
