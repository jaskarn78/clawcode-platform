/**
 * Phase 84 Plan 02 Task 1 — skills directory copier with hash-witness.
 *
 * Shape mirrors `workspace-copier.ts` (Phase 79) — filter predicate to
 * skip venv/VCS/build junk, `fs.cp` with `{recursive, verbatimSymlinks,
 * preserveTimestamps, force}`, then a post-copy sha256 witness to
 * verify each target file matches its source byte-for-byte.
 *
 * Extra vs workspace copier: the caller may supply a `transformSkillMd`
 * hook that rewrites `SKILL.md` after the bulk copy (used by the
 * migration apply path to prepend YAML frontmatter via
 * `normalizeSkillFrontmatter`). When the transform modifies the file,
 * that file's post-copy hash-witness is naturally inapplicable — we
 * compare the source sha against the transformed target sha, so the
 * check is selectively skipped for SKILL.md when a transform is
 * provided AND it actually changed the content.
 *
 * Contract:
 *   - Never writes under source paths (fs-guard enforces at a higher
 *     layer when installed).
 *   - On any hash mismatch: rm -rf the target, return
 *     `{pass: false, mismatches: [...]}`. Callers treat this as a hard
 *     refusal — no ledger row is written with `status: migrated`.
 *   - Filter skips node_modules, __pycache__, .git, *.pyc/pyo, .DS_Store,
 *     and SKILL.md.{backup,pre,pre-fix,pre-restore}-* markdown snapshots
 *     (OpenClaw's self-improving-agent + new-reel leave these lying
 *     around — they should NOT propagate to ~/.clawcode/skills/).
 *
 * Non-goals:
 *   - Partial / resumable copy — each call copies the full tree.
 *   - Verifying symlink targets — `verbatimSymlinks` preserves the
 *     symlink source as-is; a follow-up verifier can resolve.
 */
import { cp, readFile, readdir, rm, mkdir } from "node:fs/promises";
import { existsSync, lstatSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, relative, sep } from "node:path";

/**
 * Test-visible fs-dispatch holder — the ESM-safe monkey-patch pattern
 * used throughout `src/migration/`. Tests may replace `readFile` on
 * this object to simulate disk corruption between copy and witness.
 * Production code must not mutate these fields.
 */
export const copierSkillsFs: {
  cp: typeof cp;
  readFile: typeof readFile;
  readdir: typeof readdir;
  rm: typeof rm;
  mkdir: typeof mkdir;
} = { cp, readFile, readdir, rm, mkdir };

// -----------------------------------------------------------------------
// Filter — skip junk dirs + backup markdown.
// -----------------------------------------------------------------------

const SKIP_DIRS = new Set([
  "node_modules",
  "__pycache__",
  ".git",
  ".venv",
  "venv",
  "env",
  "dist",
  "build",
  ".next",
]);

const SKIP_FILES = new Set([".DS_Store"]);

const SKIP_EXTENSIONS: readonly string[] = [".pyc", ".pyo"];

// Backup markdown left behind by editor workflows on self-improving-agent
// + new-reel: SKILL.md.backup-2026-03-26, SKILL.md.pre-fix-..., etc.
// These must NOT migrate into ~/.clawcode/skills/ — they'd confuse
// scanner.ts and pollute search.
const BACKUP_MD_RE = /\.(backup|pre|pre-fix|pre-restore)-/;

/**
 * Synchronous filter for fs.cp. Returns `false` to SKIP the path, `true`
 * to include it. Matches `workspace-copier.ts` semantics — check each
 * path segment against the skip sets + extension list; additionally
 * filter backup-markdown filenames.
 */
export function defaultSkillsFilter(src: string): boolean {
  const segments = src.split(sep);
  for (const seg of segments) {
    if (SKIP_DIRS.has(seg)) return false;
    if (SKIP_FILES.has(seg)) return false;
    if (BACKUP_MD_RE.test(seg)) return false;
  }
  for (const ext of SKIP_EXTENSIONS) {
    if (src.endsWith(ext)) return false;
  }
  // Self-symlink detection (venv lateral `lib64 -> lib` pattern). Only
  // relevant when the path is an on-disk symlink whose realpath maps to
  // an ancestor/sibling directory. Best-effort — transient fs errors
  // fall through to "include".
  try {
    const lst = lstatSync(src);
    if (lst.isSymbolicLink()) {
      const real = realpathSync(src);
      // If the link resolves to a directory that itself contains the link
      // (parent-dir cycle), skip it. `verbatimSymlinks` in cp also
      // prevents infinite recursion, but skipping is defense-in-depth.
      if (real === src) return false;
      if (src.startsWith(real + sep)) return false;
    }
  } catch {
    // Missing paths / permission denied: fall through.
  }
  return true;
}

// -----------------------------------------------------------------------
// Hash helpers + directory walker
// -----------------------------------------------------------------------

async function sha256File(abs: string): Promise<string> {
  const buf = await copierSkillsFs.readFile(abs);
  return createHash("sha256").update(buf).digest("hex");
}

async function* walkRegularFiles(root: string): AsyncGenerator<string> {
  let entries;
  try {
    entries = await copierSkillsFs.readdir(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of entries) {
    const abs = join(root, ent.name);
    if (ent.isDirectory()) {
      yield* walkRegularFiles(abs);
      continue;
    }
    if (!ent.isFile()) continue;
    yield abs;
  }
}

// -----------------------------------------------------------------------
// Public types + entrypoint
// -----------------------------------------------------------------------

export type CopyMismatch = {
  readonly path: string;
  readonly srcSha: string;
  readonly tgtSha: string;
};

export type CopyResult = {
  readonly pass: boolean;
  readonly targetHash: string;
  readonly filesCopied: number;
  readonly filesSkipped: number;
  readonly mismatches?: readonly CopyMismatch[];
};

export type CopySkillOptions = {
  readonly transformSkillMd?: (content: string) => string;
};

/**
 * Copy a skill directory tree from `sourceDir` to `targetDir`, optionally
 * rewriting `SKILL.md` in the target via `opts.transformSkillMd`. Runs a
 * post-copy sha256 hash witness over every regular file in the target
 * tree; on mismatch, removes the target and returns `{ pass: false }`.
 *
 * Returns `{ pass: true, targetHash }` on success, where `targetHash` is
 * a deterministic sha256 over `sorted(${relpath}:${sha256}\n)` for every
 * file in the target. Callers use `targetHash` as the `target_hash` field
 * in a ledger row for downstream idempotency / auditing.
 */
export async function copySkillDirectory(
  sourceDir: string,
  targetDir: string,
  opts?: CopySkillOptions,
): Promise<CopyResult> {
  // 1. Ensure target parent exists.
  await copierSkillsFs.mkdir(dirname(targetDir), { recursive: true });

  // Phase 99 sub-scope L (2026-04-26) — destructive self-overwrite guard.
  // When `sourceDir === targetDir` (e.g., marketplace install where the
  // catalog scan path equals the install target path because the skill
  // is already in skillsTargetDir), the rm-then-cp pattern below destroys
  // the source. Detect and short-circuit: if same realpath, skip rm + cp
  // entirely and run the post-copy hash-witness directly over the existing
  // tree. The transform step is also a no-op (we'd be rewriting the same
  // file we're about to read).
  let isSelfCopy = false;
  try {
    const srcReal = realpathSync(sourceDir);
    const tgtReal = existsSync(targetDir) ? realpathSync(targetDir) : "";
    if (srcReal && tgtReal && srcReal === tgtReal) {
      isSelfCopy = true;
    }
  } catch {
    // realpath errors fall through to normal flow
  }

  // If a stale target exists from a prior failed run, clear it so
  // `cp` starts from a clean state. Defensive; `force: true` handles
  // individual file collisions but a stale file we no longer intend
  // to copy would survive otherwise.
  // SKIP when isSelfCopy — that would destroy the source.
  if (!isSelfCopy && existsSync(targetDir)) {
    await copierSkillsFs.rm(targetDir, { recursive: true, force: true });
  }

  // 2. Bulk copy. `verbatimSymlinks: true` is LOAD-BEARING — without
  // it, the copier follows venv-style self-symlinks and recurses
  // infinitely.
  // SKIP when isSelfCopy — cp(X, X) is a no-op at best, destructive at
  // worst (Phase 99-L). The hash-witness step below verifies whatever's
  // already at targetDir.
  if (!isSelfCopy) {
    await copierSkillsFs.cp(sourceDir, targetDir, {
      recursive: true,
      verbatimSymlinks: true,
      preserveTimestamps: true,
      errorOnExist: false,
      force: true,
      filter: defaultSkillsFilter,
    });
  }

  // 3. If a transform was supplied and target SKILL.md exists, apply it.
  let transformedSkillMd = false;
  if (opts?.transformSkillMd) {
    const targetSkill = join(targetDir, "SKILL.md");
    if (existsSync(targetSkill)) {
      // readFile with utf8 encoding always returns a string — cast is safe
      // because copierSkillsFs.readFile reflects the node:fs/promises shape.
      const raw = await copierSkillsFs.readFile(targetSkill, "utf8");
      const content =
        typeof raw === "string" ? raw : Buffer.from(raw).toString("utf8");
      const transformed = opts.transformSkillMd(content);
      if (transformed !== content) {
        const { writeFile } = await import("node:fs/promises");
        await writeFile(targetSkill, transformed, "utf8");
        transformedSkillMd = true;
      }
    }
  }

  // 4. Post-copy hash witness — walk TARGET, for each regular file
  //    compare sha256(source) vs sha256(target). Skip SKILL.md when
  //    the transform actually modified it (expected mismatch).
  const mismatches: CopyMismatch[] = [];
  const hashPairs: Array<{ relPath: string; sha: string }> = [];
  let filesCopied = 0;
  const filesSkipped = 0;

  for await (const tgtAbs of walkRegularFiles(targetDir)) {
    const relPath = relative(targetDir, tgtAbs);
    const srcAbs = join(sourceDir, relPath);
    const tgtSha = await sha256File(tgtAbs);
    hashPairs.push({ relPath, sha: tgtSha });
    filesCopied++;

    // If we rewrote SKILL.md, the source sha won't match the target sha —
    // that's expected. All other files are byte-identical witnesses.
    if (transformedSkillMd && relPath === "SKILL.md") continue;

    // If the source file doesn't exist (edge case — rare, but possible if
    // the filter diverges somehow), skip the witness for this path.
    if (!existsSync(srcAbs)) continue;

    let srcSha: string;
    try {
      srcSha = await sha256File(srcAbs);
    } catch {
      continue;
    }
    if (srcSha !== tgtSha) {
      mismatches.push({ path: relPath, srcSha, tgtSha });
    }
  }

  if (mismatches.length > 0) {
    await copierSkillsFs.rm(targetDir, { recursive: true, force: true });
    return {
      pass: false,
      targetHash: "",
      filesCopied: 0,
      filesSkipped: 0,
      mismatches,
    };
  }

  // 5. Aggregate target hash — deterministic sha256 over sorted
  //    relpath:sha lines.
  hashPairs.sort((a, b) => a.relPath.localeCompare(b.relPath));
  const master = createHash("sha256");
  for (const { relPath, sha } of hashPairs) {
    master.update(`${relPath}:${sha}\n`);
  }

  return {
    pass: true,
    targetHash: master.digest("hex"),
    filesCopied,
    filesSkipped,
  };
}
