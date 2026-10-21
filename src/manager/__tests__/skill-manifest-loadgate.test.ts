/**
 * Regression test for `reelforge-cmd-not-registered`.
 *
 * The skill-slash-commands feature shipped as a production no-op: the daemon's
 * skill-manifest load gate admitted only `loaded` / `manifest-missing` skills
 * into `loadedSkills`, excluding `parse-error`. EVERY pre-Phase-130
 * hand-authored skill (no `version` / `owner` in its SKILL.md) is classified
 * `parse-error` — so a skill flagged `slashCommand: true` never reached
 * `buildSkillSlashCommands` and `/reelforge` never registered.
 *
 * The 35 prior skill-slash-command tests stubbed `loadedSkillsByAgent`
 * directly and never exercised this gate. This test drives the REAL chain —
 * scanner -> loadSkillManifest -> classifySkillForLoadGate ->
 * buildSkillSlashCommands — against an on-disk SKILL.md fixture.
 *
 * Revert-proof: if `classifySkillForLoadGate` is reverted to exclude
 * `parse-error` from the loaded set, BOTH layers below fail.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { scanSkillsDirectory } from "../../skills/scanner.js";
import {
  loadSkillManifest,
  classifySkillForLoadGate,
} from "../skill-loader.js";
import { buildSkillSlashCommands } from "../../discord/skill-slash-commands.js";
import type { SkillsCatalog } from "../../skills/types.js";

// Mirrors the real reelforge SKILL.md: name + slashCommand + description, and
// crucially NO `version` / `owner` — so loadSkillManifest classifies it
// `parse-error` (schema mismatch against Phase 130's SkillManifestSchema).
const REELFORGE_SKILL_MD = `---
name: reelforge
slashCommand: true
description: Test reel skill — mirrors the real reelforge frontmatter (no version/owner).
---

# reelforge

Body.
`;

describe("skill-manifest load gate — parse-error skills stay admitted (reelforge-cmd-not-registered)", () => {
  let skillsDir: string;
  let catalog: SkillsCatalog;

  beforeAll(async () => {
    skillsDir = await mkdtemp(join(tmpdir(), "loadgate-test-"));
    const reelDir = join(skillsDir, "reelforge");
    await mkdir(reelDir, { recursive: true });
    await writeFile(join(reelDir, "SKILL.md"), REELFORGE_SKILL_MD, "utf-8");
    catalog = await scanSkillsDirectory(skillsDir, pino({ level: "silent" }));
  });

  afterAll(async () => {
    await rm(skillsDir, { recursive: true, force: true });
  });

  it("Layer 1: a no-version/no-owner SKILL.md is parse-error, yet the load gate admits it", () => {
    const entry = catalog.get("reelforge");
    expect(entry).toBeDefined();
    // The scanner still parses the slashCommand flag onto the catalog entry.
    expect(entry?.slashCommand).toBe(true);

    const result = loadSkillManifest(entry!.path, []);
    // Phase 130's SkillManifestSchema requires version + owner — absent here.
    expect(result.status).toBe("parse-error");

    const decision = classifySkillForLoadGate("reelforge", result);
    // The fix: parse-error is ADMITTED (back-compat), not excluded.
    expect(decision.loaded).toBe(true);
    // ...but still surfaced to operators as an unloaded entry.
    expect(decision.unloadedEntry?.status).toBe("parse-error");
  });

  it("Layer 2: a parse-error slashCommand skill still produces a /reelforge command end-to-end", () => {
    const entry = catalog.get("reelforge")!;

    // Reproduce the daemon's per-agent load gate (daemon.ts skill-manifest loop).
    const loadedSkills = new Set<string>();
    const decision = classifySkillForLoadGate(
      "reelforge",
      loadSkillManifest(entry.path, []),
    );
    if (decision.loaded) loadedSkills.add("reelforge");

    const agentLoadedSkills = new Map<string, ReadonlySet<string>>([
      ["acme-content-creator", loadedSkills],
    ]);
    const built = buildSkillSlashCommands(
      agentLoadedSkills,
      catalog,
      new Set<string>(),
    );

    const cmd = built.commands.find((c) => c.name === "reelforge");
    expect(cmd, "/reelforge command must be registered").toBeDefined();
    expect(cmd?.skillDispatch?.skillName).toBe("reelforge");
  });
});
