/**
 * Phase 84 Plan 01 — OpenClaw skill discovery.
 *
 * Walks `~/.openclaw/skills/`, classifies each subdirectory against the
 * locked P1/P2/DEPRECATE verdict table (encoded below as SKILL_CLASSIFICATIONS),
 * computes a deterministic per-skill content hash for idempotency, and
 * returns a sorted deterministic array.
 *
 * This is the read-only discovery layer. The CLI action (migrate-skills.ts)
 * consumes the DiscoveredSkill[] and routes each skill through the secret-
 * scan + ledger idempotency check.
 *
 * Load-bearing: this module NEVER writes to the source tree. All reads go
 * through fs/promises; no fs-guard carve-out needed.
 */
import { readdir, stat, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";

/**
 * Classification verdict per the v2.2 research table (84-CONTEXT + FEATURES.md).
 * Immutable public constant — Plan 02's transformer reads it; the CLI uses it
 * to bucket skills by verdict.
 */
export type SkillClassification = "p1" | "p2" | "deprecate" | "unknown";

/**
 * Locked classification table. Order matches the 84-01-PLAN interfaces block
 * so grep-verifiable (`grep -c` returns ≥12). If OpenClaw ships a new skill,
 * its name will default to "unknown" (caller decides whether to include via
 * --include-unknown flag).
 */
export const SKILL_CLASSIFICATIONS: ReadonlyMap<string, SkillClassification> =
  new Map<string, SkillClassification>([
    ["cognitive-memory", "deprecate"],
    ["acme-content-creator.retired", "deprecate"],
    ["acme-crm", "p1"],
    ["frontend-design", "p1"],
    ["new-reel", "p1"],
    ["openclaw-config", "deprecate"],
    ["power-apps-builder", "p2"],
    ["remotion", "p2"],
    ["self-improving-agent", "p1"],
    ["test", "p2"],
    ["tuya-ac", "p1"],
    ["workspace-janitor", "p2"],
  ]);

/**
 * Operator-facing deprecation reasons — displayed in the CLI `skipped
 * (deprecated)` section. Plan 02 reuses when emitting the skills report.
 */
export const SKILL_DEPRECATION_REASONS: ReadonlyMap<string, string> = new Map([
  ["cognitive-memory", "superseded by ClawCode v1.1/v1.5/v1.9 memory stack"],
  [
    "acme-content-creator.retired",
    ".retired suffix; replaced by new-reel",
  ],
  ["openclaw-config", "references dead OpenClaw gateway"],
]);

export type DiscoveredSkill = {
  readonly name: string;
  readonly path: string;
  readonly classification: SkillClassification;
  readonly sourceHash: string;
};

/**
 * Compute a deterministic hash of a skill directory's content. Hash covers
 * every regular file's relative path + sha256(content). Stable across calls
 * (sort order is alphabetical). Used for idempotency: if a subsequent
 * --dry-run finds the same hash already `migrated` in the ledger, the skill
 * is bucketed as `skipped (idempotent)`.
 *
 * Phase 88 Plan 01 Task 2 — promoted to an exported function
 * (`computeSkillContentHash`) so the Phase 88 marketplace installer can
 * compute a skill's current source hash for the ledger idempotency gate
 * without re-walking the whole discovery tree. Old `computeSkillHash` is
 * preserved as a local alias for the readability of in-module callers.
 */
export async function computeSkillContentHash(
  skillDir: string,
): Promise<string> {
  const master = createHash("sha256");
  // Collect every file's (relpath, content) pair, sort by relpath, feed to
  // master hasher. Symlinks are dereferenced by readFile; broken symlinks
  // throw and are silently skipped (migrator isn't a verifier — Plan 02's
  // per-agent linker does that).
  const files: Array<{ relPath: string; content: Buffer }> = [];

  async function walk(dir: string, relBase: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      const relPath = relBase ? `${relBase}/${ent.name}` : ent.name;
      const absPath = join(dir, ent.name);
      if (ent.isDirectory()) {
        // Skip well-known transient dirs so hash is stable across dev-machine
        // state (node_modules populated vs not, .git staged vs not).
        if (
          ent.name === "node_modules" ||
          ent.name === ".git" ||
          ent.name === "dist" ||
          ent.name === "build"
        ) {
          continue;
        }
        await walk(absPath, relPath);
        continue;
      }
      if (!ent.isFile()) continue;
      try {
        const content = await readFile(absPath);
        files.push({ relPath, content });
      } catch {
        // Broken symlink or permissions — silently skip (hash stays stable
        // across transient fs issues instead of throwing mid-plan).
      }
    }
  }

  await walk(skillDir, "");
  files.sort((a, b) => a.relPath.localeCompare(b.relPath));
  for (const { relPath, content } of files) {
    const fileHash = createHash("sha256").update(content).digest("hex");
    master.update(relPath);
    master.update("\0");
    master.update(fileHash);
    master.update("\n");
  }
  return master.digest("hex");
}

/**
 * Discover every subdir under `sourceRoot` as a potential skill. Non-existent
 * sourceRoot returns []. Each subdir is classified via SKILL_CLASSIFICATIONS;
 * unknown names default to "unknown" (caller decides whether to include).
 *
 * Result is sorted alphabetically by name for deterministic CLI output.
 */
export async function discoverOpenclawSkills(
  sourceRoot: string,
): Promise<readonly DiscoveredSkill[]> {
  if (!existsSync(sourceRoot)) return [];

  let entries;
  try {
    entries = await readdir(sourceRoot, { withFileTypes: true });
  } catch {
    return [];
  }

  const discovered: DiscoveredSkill[] = [];
  for (const ent of entries) {
    // Only subdirectories count as skills. `.` / `..` are excluded by readdir.
    // Stat-follow: withFileTypes gives us dirent.isDirectory; trust it.
    if (!ent.isDirectory()) {
      // Some OpenClaw skills install via symlinks — stat-follow check.
      try {
        const st = await stat(join(sourceRoot, ent.name));
        if (!st.isDirectory()) continue;
      } catch {
        continue;
      }
    }
    const skillPath = join(sourceRoot, ent.name);
    const classification: SkillClassification =
      SKILL_CLASSIFICATIONS.get(ent.name) ?? "unknown";
    const sourceHash = await computeSkillContentHash(skillPath);
    discovered.push({
      name: ent.name,
      path: skillPath,
      classification,
      sourceHash,
    });
  }

  discovered.sort((a, b) => a.name.localeCompare(b.name));
  return discovered;
}
