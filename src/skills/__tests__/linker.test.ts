/**
 * Skill linker unit tests.
 *
 * The `cliSkillsDir` half exists because of the 2026-09-10 client-a-personal
 * report: `Skill(shopping-research)` returned `Unknown skill` for a skill
 * that was assigned, on disk, symlinked into `<workspace>/skills/`, and
 * loaded successfully at boot. ClawCode's skill tree and the Claude Code
 * CLI's own `.claude/skills/` registry had simply never been connected, so
 * the native `Skill()` tool could not resolve any ClawCode-managed skill.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, rm, readlink, lstat, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { linkAgentSkills } from "../linker.js";
import type { SkillEntry, SkillsCatalog } from "../types.js";

let root: string;

const entry = (name: string, path: string): SkillEntry =>
  Object.freeze({ name, description: `${name} desc`, version: "1.0.0", path });

const catalogOf = (...names: readonly string[]): SkillsCatalog =>
  new Map(names.map((n) => [n, entry(n, join(root, "global", n))]));

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "linker-test-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const wsSkills = () => join(root, "ws", "skills");
const cliSkills = () => join(root, "ws", ".claude", "skills");

describe("linkAgentSkills", () => {
  it("links assigned skills into the workspace skills/ tree", async () => {
    await linkAgentSkills(wsSkills(), ["alpha", "beta"], catalogOf("alpha", "beta"));

    expect(await readlink(join(wsSkills(), "alpha"))).toBe(join(root, "global", "alpha"));
    expect(await readlink(join(wsSkills(), "beta"))).toBe(join(root, "global", "beta"));
  });

  it("skips a name that is not in the catalog", async () => {
    await linkAgentSkills(wsSkills(), ["alpha", "ghost"], catalogOf("alpha"));

    expect(await readlink(join(wsSkills(), "alpha"))).toBeTruthy();
    await expect(lstat(join(wsSkills(), "ghost"))).rejects.toThrow();
  });

  it("is idempotent — re-linking leaves a correct symlink alone", async () => {
    const cat = catalogOf("alpha");
    await linkAgentSkills(wsSkills(), ["alpha"], cat);
    await linkAgentSkills(wsSkills(), ["alpha"], cat);

    expect(await readlink(join(wsSkills(), "alpha"))).toBe(join(root, "global", "alpha"));
  });

  it("repoints a symlink whose target moved", async () => {
    await mkdir(wsSkills(), { recursive: true });
    await symlink(join(root, "stale", "alpha"), join(wsSkills(), "alpha"));

    await linkAgentSkills(wsSkills(), ["alpha"], catalogOf("alpha"));

    expect(await readlink(join(wsSkills(), "alpha"))).toBe(join(root, "global", "alpha"));
  });

  it("never clobbers a real directory sitting at the link path", async () => {
    await mkdir(join(wsSkills(), "alpha"), { recursive: true });
    await writeFile(join(wsSkills(), "alpha", "SKILL.md"), "hand-authored");

    await linkAgentSkills(wsSkills(), ["alpha"], catalogOf("alpha"));

    expect((await lstat(join(wsSkills(), "alpha"))).isDirectory()).toBe(true);
  });

  // --- 2026-09-10: native Skill() resolution -----------------------------
  describe("cliSkillsDir — native Skill() tool resolution", () => {
    it("links assigned skills into the CLI's .claude/skills/ root too", async () => {
      await linkAgentSkills(wsSkills(), ["alpha", "beta"], catalogOf("alpha", "beta"), undefined, {
        cliSkillsDir: cliSkills(),
      });

      // Both trees, same targets — the file-reading path and the native
      // Skill() path must resolve to the same skill.
      for (const name of ["alpha", "beta"]) {
        expect(await readlink(join(wsSkills(), name))).toBe(join(root, "global", name));
        expect(await readlink(join(cliSkills(), name))).toBe(join(root, "global", name));
      }
    });

    it("omitting cliSkillsDir leaves .claude/skills/ untouched (fleet stays byte-identical)", async () => {
      await linkAgentSkills(wsSkills(), ["alpha"], catalogOf("alpha"));

      await expect(lstat(cliSkills())).rejects.toThrow();
    });

    it("links ONLY assigned skills, never the whole catalog", async () => {
      const cat = catalogOf("alpha", "beta", "gamma");
      await linkAgentSkills(wsSkills(), ["alpha"], cat, undefined, { cliSkillsDir: cliSkills() });

      expect(await readlink(join(cliSkills(), "alpha"))).toBeTruthy();
      // beta/gamma exist in the catalog but are not this agent's — the CLI
      // must not surface them.
      await expect(lstat(join(cliSkills(), "beta"))).rejects.toThrow();
      await expect(lstat(join(cliSkills(), "gamma"))).rejects.toThrow();
    });

    it("leaves unmanaged skills in .claude/skills/ alone (no pruning)", async () => {
      // first-run-setup / set-goal live here and are not ClawCode's to remove.
      await mkdir(join(cliSkills(), "first-run-setup"), { recursive: true });
      await writeFile(join(cliSkills(), "first-run-setup", "SKILL.md"), "not ours");

      await linkAgentSkills(wsSkills(), ["alpha"], catalogOf("alpha"), undefined, {
        cliSkillsDir: cliSkills(),
      });

      expect((await lstat(join(cliSkills(), "first-run-setup"))).isDirectory()).toBe(true);
      expect(await readlink(join(cliSkills(), "alpha"))).toBeTruthy();
    });

    it("is idempotent across both trees", async () => {
      const cat = catalogOf("alpha");
      const opts = { cliSkillsDir: cliSkills() };
      await linkAgentSkills(wsSkills(), ["alpha"], cat, undefined, opts);
      await linkAgentSkills(wsSkills(), ["alpha"], cat, undefined, opts);

      expect(await readlink(join(cliSkills(), "alpha"))).toBe(join(root, "global", "alpha"));
    });

    it("no assigned skills → neither tree is created", async () => {
      await linkAgentSkills(wsSkills(), [], catalogOf("alpha"), undefined, {
        cliSkillsDir: cliSkills(),
      });

      await expect(lstat(wsSkills())).rejects.toThrow();
      await expect(lstat(cliSkills())).rejects.toThrow();
    });
  });
});
