/**
 * Phase 142 — candidate-skills staging tests (real temp FS).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm, readFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stageCandidateSkills } from "../candidate-skills.js";

describe("Phase 142 — stageCandidateSkills", () => {
  let src: string;
  beforeEach(async () => {
    src = await mkdtemp(join(tmpdir(), "src-skills-"));
    await mkdir(join(src, "alpha"), { recursive: true });
    await writeFile(join(src, "alpha", "SKILL.md"), "alpha v1");
    await mkdir(join(src, "beta"), { recursive: true });
    await writeFile(join(src, "beta", "SKILL.md"), "beta v1");
  });
  afterEach(async () => {
    await rm(src, { recursive: true, force: true });
  });

  it("copies the agent's current skills into <workspace>/.claude/skills", async () => {
    const staged = await stageCandidateSkills({ sourceSkillsRoot: src, skillNames: ["alpha", "beta"] });
    try {
      expect(staged.skillNames.sort()).toEqual(["alpha", "beta"]);
      const a = await readFile(join(staged.workspace, ".claude/skills/alpha/SKILL.md"), "utf-8");
      expect(a).toBe("alpha v1");
    } finally {
      await staged.dispose();
    }
  });

  it("a write override ADDS a new skill", async () => {
    const staged = await stageCandidateSkills({
      sourceSkillsRoot: src,
      skillNames: ["alpha"],
      overrides: [{ op: "write", name: "gamma", skillMd: "gamma new" }],
    });
    try {
      expect(staged.skillNames.sort()).toEqual(["alpha", "gamma"]);
      const g = await readFile(join(staged.workspace, ".claude/skills/gamma/SKILL.md"), "utf-8");
      expect(g).toBe("gamma new");
    } finally {
      await staged.dispose();
    }
  });

  it("a write override REVISES an existing skill (candidate content wins over the copy)", async () => {
    const staged = await stageCandidateSkills({
      sourceSkillsRoot: src,
      skillNames: ["alpha"],
      overrides: [{ op: "write", name: "alpha", skillMd: "alpha v2" }],
    });
    try {
      const a = await readFile(join(staged.workspace, ".claude/skills/alpha/SKILL.md"), "utf-8");
      expect(a).toBe("alpha v2");
    } finally {
      await staged.dispose();
    }
  });

  it("a remove override excludes a skill", async () => {
    const staged = await stageCandidateSkills({
      sourceSkillsRoot: src,
      skillNames: ["alpha", "beta"],
      overrides: [{ op: "remove", name: "beta" }],
    });
    try {
      expect(staged.skillNames).toEqual(["alpha"]);
      await expect(access(join(staged.workspace, ".claude/skills/beta"))).rejects.toThrow();
    } finally {
      await staged.dispose();
    }
  });

  it("remove beats write for the same skill name", async () => {
    const staged = await stageCandidateSkills({
      sourceSkillsRoot: src,
      skillNames: ["alpha"],
      overrides: [
        { op: "write", name: "beta", skillMd: "beta candidate" },
        { op: "remove", name: "beta" },
      ],
    });
    try {
      expect(staged.skillNames).toEqual(["alpha"]);
    } finally {
      await staged.dispose();
    }
  });

  it("skips a skillName whose source dir is missing (best-effort)", async () => {
    const staged = await stageCandidateSkills({ sourceSkillsRoot: src, skillNames: ["alpha", "ghost"] });
    try {
      expect(staged.skillNames).toEqual(["alpha"]);
    } finally {
      await staged.dispose();
    }
  });

  it("dispose removes the workspace", async () => {
    const staged = await stageCandidateSkills({ sourceSkillsRoot: src, skillNames: ["alpha"] });
    const ws = staged.workspace;
    await staged.dispose();
    await expect(access(ws)).rejects.toThrow();
  });
});
