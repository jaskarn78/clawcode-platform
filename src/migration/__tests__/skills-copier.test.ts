/**
 * Phase 84 Plan 02 Task 1 — skills-copier integration tests.
 *
 * Exercises `copySkillDirectory` against real `~/.openclaw/skills/` subdirs
 * with a tmpdir target. Covers:
 *   (a) tuya-ac + transform → target SKILL.md has normalized frontmatter
 *   (b) frontend-design + transform → target SKILL.md byte-identical
 *   (c) self-improving-agent → preserves hooks/ + scripts/ + .learnings/,
 *       filters SKILL.md.backup-* noise
 *   (d) re-run → same targetHash (idempotent by content)
 *   (e) synthetic hash-witness mismatch → target is removed
 *   (f) no-follow of self-symlinks (verbatimSymlinks)
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import {
  readFile,
  readdir,
  writeFile,
  symlink,
  mkdir,
} from "node:fs/promises";
const realReadFile = readFile;
import { existsSync, lstatSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { copySkillDirectory, copierSkillsFs } from "../skills-copier.js";
import { normalizeSkillFrontmatter } from "../skills-transformer.js";

const OPENCLAW_SKILLS = join(homedir(), ".openclaw", "skills");

describe("skills-copier", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "skills-copier-"));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
    // Restore any test monkey-patches on the fs-dispatch holder.
    copierSkillsFs.readFile = realReadFile;
  });

  it("(a) tuya-ac + transformSkillMd=normalizeSkillFrontmatter → target SKILL.md has frontmatter", async () => {
    const source = join(OPENCLAW_SKILLS, "tuya-ac");
    const target = join(tmp, "tuya-ac");
    const result = await copySkillDirectory(source, target, {
      transformSkillMd: (c) => normalizeSkillFrontmatter(c, "tuya-ac"),
    });
    expect(result.pass).toBe(true);
    expect(result.targetHash).toMatch(/^[0-9a-f]{64}$/);
    const targetSkill = await readFile(join(target, "SKILL.md"), "utf8");
    expect(targetSkill.startsWith("---\nname: tuya-ac\ndescription: ")).toBe(
      true,
    );
  });

  it("(b) frontend-design + transform → target SKILL.md === source SKILL.md", async () => {
    const source = join(OPENCLAW_SKILLS, "frontend-design");
    const target = join(tmp, "frontend-design");
    const result = await copySkillDirectory(source, target, {
      transformSkillMd: (c) => normalizeSkillFrontmatter(c, "frontend-design"),
    });
    expect(result.pass).toBe(true);
    const sourceSkill = await readFile(join(source, "SKILL.md"), "utf8");
    const targetSkill = await readFile(join(target, "SKILL.md"), "utf8");
    expect(targetSkill).toBe(sourceSkill);
  });

  it("(c) self-improving-agent → preserves hooks/, scripts/, .learnings/; drops SKILL.md.backup-* (filter)", async () => {
    // Use new-reel as the "has backup files" canary — it has SKILL.md.backup-*
    // and SKILL.md.pre-* files we want to filter.
    const sourceNewReel = join(OPENCLAW_SKILLS, "new-reel");
    const targetNewReel = join(tmp, "new-reel");
    const nrResult = await copySkillDirectory(sourceNewReel, targetNewReel);
    expect(nrResult.pass).toBe(true);
    const nrEntries = await readdir(targetNewReel);
    // SKILL.md copied
    expect(nrEntries).toContain("SKILL.md");
    // Backup files filtered
    expect(nrEntries.every((e) => !e.startsWith("SKILL.md.backup-"))).toBe(
      true,
    );
    expect(nrEntries.every((e) => !e.startsWith("SKILL.md.pre-"))).toBe(true);
    // scripts/ + reference/ dirs preserved
    expect(nrEntries).toContain("scripts");
    expect(nrEntries).toContain("reference");

    // self-improving-agent — hooks/ + scripts/ + .learnings/ subdirs preserved
    const source = join(OPENCLAW_SKILLS, "self-improving-agent");
    const target = join(tmp, "self-improving-agent");
    const result = await copySkillDirectory(source, target);
    expect(result.pass).toBe(true);
    const entries = await readdir(target);
    expect(entries).toContain("SKILL.md");
    expect(entries).toContain("hooks");
    expect(entries).toContain("scripts");
    expect(entries).toContain(".learnings");
    // .git filtered out (it's transient VCS metadata; not useful in target)
    expect(entries).not.toContain(".git");
  });

  it("(d) re-run copy → same targetHash (content-hash idempotent)", async () => {
    const source = join(OPENCLAW_SKILLS, "frontend-design");
    const target = join(tmp, "fd-repeat");
    const first = await copySkillDirectory(source, target);
    expect(first.pass).toBe(true);
    const second = await copySkillDirectory(source, target);
    expect(second.pass).toBe(true);
    expect(second.targetHash).toBe(first.targetHash);
  });

  it("(e) hash-witness fails synthetically → pass=false, target tree removed", async () => {
    const source = join(OPENCLAW_SKILLS, "tuya-ac");
    const target = join(tmp, "tuya-ac-corrupt");

    // Monkey-patch the copier's readFile so that on TARGET reads it returns
    // corrupted content — mimics a disk-write corruption scenario. Pattern:
    // calls against TARGET paths return "corrupted", calls against SOURCE
    // paths return real content.
    const origReadFile = copierSkillsFs.readFile;
    copierSkillsFs.readFile = (async (path: string, ...rest: unknown[]) => {
      const s = String(path);
      if (s.startsWith(target)) {
        return Buffer.from("corrupted!!!", "utf8");
      }
      // Delegate to the real readFile for source + any other paths.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (origReadFile as any)(path, ...rest);
    }) as typeof origReadFile;

    const result = await copySkillDirectory(source, target);
    expect(result.pass).toBe(false);
    expect((result.mismatches ?? []).length).toBeGreaterThan(0);
    // Target tree must be removed on failure.
    expect(existsSync(target)).toBe(false);

    // Restore before afterEach runs.
    copierSkillsFs.readFile = origReadFile;
  });

  it("(f) verbatimSymlinks: an ordinary file-to-file symlink is preserved as a symlink in target", async () => {
    // Build a synthetic source with a plain file-to-file symlink. Self-
    // referential symlinks (loopback -> .) are filtered by defaultSkillsFilter
    // to prevent recursion — so we use a non-recursive link here.
    const synthSource = join(tmp, "_synth_src");
    await mkdir(synthSource, { recursive: true });
    await writeFile(join(synthSource, "SKILL.md"), "# synth\n\nbody");
    await writeFile(join(synthSource, "real.md"), "# real\n");
    // `alias.md -> real.md` — verbatimSymlinks should preserve this as a
    // symlink in the target tree (NOT resolve + duplicate the content).
    await symlink("real.md", join(synthSource, "alias.md"));

    const synthTarget = join(tmp, "_synth_tgt");
    const result = await copySkillDirectory(synthSource, synthTarget);
    expect(result.pass).toBe(true);

    const aliasStat = lstatSync(join(synthTarget, "alias.md"), {
      throwIfNoEntry: false,
    });
    expect(aliasStat).toBeDefined();
    expect(aliasStat!.isSymbolicLink()).toBe(true);
  });
});
