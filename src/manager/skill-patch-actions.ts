/**
 * Phase 999.42 Plan 05 T-03 — skill-patch-actions module.
 *
 * Pure-IO handlers for the capability-C patch lifecycle (D5/D6):
 *   - applyPatch   — strip wrapper, conflict-guard against the live SKILL.md
 *                    base hash, version-validate the body, write the body,
 *                    archive the pre-patch file, remove the patch.
 *   - rejectPatch  — move the patch file to skills-rejected/ with a
 *                    `## Rejected: <reason>` header (preserving the
 *                    fingerprint12-bearing filename so D7's sticky-rejection
 *                    set covers patches too).
 *
 * D5 — a patch artifact is a wrapper YAML frontmatter block followed by the
 * literal full proposed SKILL.md (which itself begins with its own
 * frontmatter carrying the bumped `version`). Apply = strip wrapper, write
 * body verbatim.
 *
 * D6 — `baseHash` = SHA256 of the *whole* target SKILL.md file (frontmatter +
 * body), no normalization. On any mismatch applyPatch hard-refuses — the
 * operator's intervening edit always wins.
 *
 * Telemetry tag (grep-checkable): every handler emits exactly one
 * `phase999.42-skill-patch-action` structured log line.
 *
 * Zero new npm dependencies — node:crypto (SHA256), node:fs/promises,
 * `yaml` (existing).
 */
import {
  readFile as fsReadFile,
  readdir as fsReaddir,
  writeFile as fsWriteFile,
  mkdir as fsMkdir,
  unlink as fsUnlink,
} from "node:fs/promises";
import { join, basename } from "node:path";
import { createHash } from "node:crypto";
import { parse as parseYaml } from "yaml";
import type {
  DraftActionFs,
  DraftActionLogger,
} from "./skill-draft-actions.js";
import {
  bumpVersion,
  validateBumpedVersion,
  type PatchClass,
} from "./skill-patch-version.js";

/**
 * The 6 D5 wrapper frontmatter fields. `targetSlug` is kebab-validated by
 * `parsePatchFile` before any path join (anti path-traversal — T-999.42-05-04).
 */
export type PatchWrapperFrontmatter = {
  readonly targetSlug: string;
  readonly patchClass: PatchClass;
  readonly baseHash: string;
  readonly sourceFingerprint: string;
  readonly sourceSessionId: string;
  readonly draftedAt: string;
};

/**
 * A single pending patch surfaced by `listPatchesForSkill`. The wrapper
 * fields are read from the patch artifact's frontmatter (parsed via
 * `parsePatchFile`); `patchId` is the filename without the `.md` extension.
 */
export type PendingPatch = {
  readonly patchId: string;
  readonly targetSlug: string;
  readonly patchClass: PatchClass;
  readonly sourceFingerprint: string;
  readonly sourceSessionId: string;
  readonly draftedAt: string;
};

/** Result of `listPatchesForSkill` — typed list (never throws). */
export type ListPatchesResult = {
  readonly status: "listed";
  readonly slug: string;
  readonly patches: readonly PendingPatch[];
};

/** Discriminated result for both applyPatch and rejectPatch. */
export type PatchActionResult =
  | {
      readonly status: "applied";
      readonly finalPath: string;
      readonly newVersion: string;
    }
  | {
      readonly status: "conflict";
      readonly reason: string;
    }
  | {
      readonly status: "version-rejected";
      readonly reason: string;
      readonly expectedVersion: string;
      readonly declaredVersion: string;
    }
  | {
      readonly status: "rejected";
      readonly finalPath: string;
      readonly fingerprint12: string;
    }
  | {
      readonly status: "not-found";
      readonly reason: "patch-file-missing";
    };

/** Re-export so callers (Plan 06 IPC/slash) need a single import. */
export type { DraftActionFs, DraftActionLogger };

export type PatchActionDeps = {
  readonly log: DraftActionLogger;
  /** Returns absolute path to ~/.clawcode/agents/<agent>/. */
  readonly agentWorkspaceDir: (agent: string) => string;
  readonly fs?: DraftActionFs;
};

const KEBAB_CASE = /^[a-z][a-z0-9-]*$/;
const FINGERPRINT12_RE = /-([0-9a-f]{12})$/i;
const PATCH_CLASSES: readonly PatchClass[] = ["patch", "edit", "breaking"];

function unwrapFs(deps: PatchActionDeps): Required<DraftActionFs> {
  return {
    readFile: deps.fs?.readFile ?? fsReadFile,
    readdir: deps.fs?.readdir ?? fsReaddir,
    writeFile: deps.fs?.writeFile ?? fsWriteFile,
    mkdir: deps.fs?.mkdir ?? fsMkdir,
    unlink: deps.fs?.unlink ?? (async (p: string) => fsUnlink(p)),
  };
}

function extractFingerprint12(id: string): string {
  const m = id.match(FINGERPRINT12_RE);
  return m ? m[1]!.toLowerCase() : "";
}

/**
 * Read the `version:` field from a SKILL.md frontmatter block.
 *
 * Regex replicated from `src/skills/scanner.ts` `extractVersion` (not
 * exported there) — keep the two in sync.
 */
function extractVersion(content: string): string | null {
  const fm = content.match(/^---\n([\s\S]*?)\n---/);
  if (!fm) return null;
  const ver = fm[1]!.match(/^version:\s*(.+)$/m);
  return ver ? ver[1]!.trim() : null;
}

/** SHA256 hex of the whole-file bytes — D6, no normalization. */
function sha256(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

/**
 * Split a wrapped patch file into `{ wrapper, body }` and validate the
 * wrapper. The wrapper is the leading `---\n...\n---\n` block; the body is
 * everything after it (itself a literal SKILL.md beginning with its own
 * frontmatter). Non-greedy match on the FIRST `\n---\n` so the body's own
 * frontmatter is never swallowed.
 *
 * Returns `{ error }` (never throws) on a malformed wrapper, an unknown
 * `patchClass`, a missing field, or a non-kebab `targetSlug`.
 */
export function parsePatchFile(
  content: string,
): { readonly wrapper: PatchWrapperFrontmatter; readonly body: string } | {
  readonly error: string;
} {
  const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) {
    return { error: "no wrapper frontmatter block found" };
  }
  const [, rawWrapper, body] = match;
  let parsed: unknown;
  try {
    parsed = parseYaml(rawWrapper!);
  } catch (err) {
    return {
      error: `wrapper YAML parse failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }
  if (typeof parsed !== "object" || parsed === null) {
    return { error: "wrapper frontmatter is not a YAML mapping" };
  }
  const w = parsed as Record<string, unknown>;
  const required = [
    "targetSlug",
    "patchClass",
    "baseHash",
    "sourceFingerprint",
    "sourceSessionId",
    "draftedAt",
  ] as const;
  for (const field of required) {
    if (typeof w[field] !== "string" || (w[field] as string).length === 0) {
      return { error: `wrapper missing or non-string field: ${field}` };
    }
  }
  const targetSlug = w.targetSlug as string;
  // Anti path-traversal (T-999.42-05-04): targetSlug must be kebab-case —
  // no `/`, no `..` — BEFORE any join() in applyPatch.
  if (!KEBAB_CASE.test(targetSlug)) {
    return { error: `targetSlug is not kebab-case: ${targetSlug}` };
  }
  const patchClass = w.patchClass as string;
  if (!PATCH_CLASSES.includes(patchClass as PatchClass)) {
    return { error: `unknown patchClass: ${patchClass}` };
  }
  return {
    wrapper: {
      targetSlug,
      patchClass: patchClass as PatchClass,
      baseHash: w.baseHash as string,
      sourceFingerprint: w.sourceFingerprint as string,
      sourceSessionId: w.sourceSessionId as string,
      draftedAt: w.draftedAt as string,
    },
    body: body!,
  };
}

async function resolvePatchFile(
  fs: Required<DraftActionFs>,
  patchesDir: string,
  patchId: string,
): Promise<string | null> {
  const expected = `${patchId}.md`;
  try {
    const entries = await fs.readdir(patchesDir);
    return entries.includes(expected) ? join(patchesDir, expected) : null;
  } catch {
    return null;
  }
}

/** Filesystem-safe-ish timestamp for the applied-archive filename. */
function archiveTimestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

/**
 * Apply a reviewed patch to the live skill.
 *
 * Sequence (D5/D6): resolve patch → parse wrapper+body → read live SKILL.md →
 * SHA256 whole-file → compare to wrapper.baseHash (mismatch → conflict, zero
 * writes) → compute bumpVersion(currentVersion, patchClass) → compare to the
 * body's declared version (mismatch → version-rejected, zero writes) →
 * archive the pre-patch SKILL.md to skill-patches/applied/ → write the body
 * to skills/<slug>/SKILL.md → remove the patch file.
 *
 * Emits exactly one `phase999.42-skill-patch-action` log line.
 */
export async function applyPatch(
  opts: { readonly agent: string; readonly patchId: string },
  deps: PatchActionDeps,
): Promise<PatchActionResult> {
  const t0 = performance.now();
  const fs = unwrapFs(deps);
  const agentDir = deps.agentWorkspaceDir(opts.agent);
  const patchesDir = join(agentDir, "skill-patches");
  const patchPath = await resolvePatchFile(fs, patchesDir, opts.patchId);

  const failWarn = (reason: string): void => {
    deps.log.warn(
      {
        agent: opts.agent,
        patchId: opts.patchId,
        action: "apply",
        failed: true,
        reason,
        durationMs: Math.round(performance.now() - t0),
      },
      "phase999.42-skill-patch-action",
    );
  };

  if (!patchPath) {
    failWarn("patch-file-missing");
    return { status: "not-found", reason: "patch-file-missing" };
  }

  const rawPatch = String(await fs.readFile(patchPath, "utf8"));
  const parsed = parsePatchFile(rawPatch);
  if ("error" in parsed) {
    failWarn(`malformed-patch: ${parsed.error}`);
    return { status: "conflict", reason: `malformed patch: ${parsed.error}` };
  }
  const { wrapper, body } = parsed;

  // Read the live SKILL.md.
  const skillPath = join(agentDir, "skills", wrapper.targetSlug, "SKILL.md");
  let liveContent: string;
  try {
    liveContent = String(await fs.readFile(skillPath, "utf8"));
  } catch {
    failWarn("target-skill-missing");
    return {
      status: "conflict",
      reason: `target skill not found: ${wrapper.targetSlug}`,
    };
  }

  // D6 — whole-file SHA256 base-hash guard. Operator edit wins.
  const liveHash = sha256(liveContent);
  if (liveHash !== wrapper.baseHash) {
    failWarn("base-hash-mismatch");
    return {
      status: "conflict",
      reason:
        "skill changed since this patch was drafted — reject this patch and " +
        "re-draft against the current version",
    };
  }

  // D5 — version-validate: the body's declared version must equal the bump
  // computed at apply time from the live version + patchClass.
  const currentVersion = extractVersion(liveContent);
  const declaredVersion = extractVersion(body);
  if (!currentVersion || !declaredVersion) {
    failWarn("version-unreadable");
    return {
      status: "version-rejected",
      reason: "could not read version from the live skill or the patch body",
      expectedVersion: currentVersion ?? "(unreadable)",
      declaredVersion: declaredVersion ?? "(unreadable)",
    };
  }
  if (!validateBumpedVersion(currentVersion, declaredVersion, wrapper.patchClass)) {
    let expected: string;
    try {
      expected = bumpVersion(currentVersion, wrapper.patchClass);
    } catch {
      expected = "(non-semver current version)";
    }
    failWarn("version-mismatch");
    return {
      status: "version-rejected",
      reason: `patch body declares version ${declaredVersion} but ${wrapper.patchClass} of ${currentVersion} must be ${expected}`,
      expectedVersion: expected,
      declaredVersion,
    };
  }

  const newVersion = bumpVersion(currentVersion, wrapper.patchClass);

  // Archive the pre-patch SKILL.md BEFORE overwriting (D5 audit trail).
  const appliedDir = join(patchesDir, "applied");
  await fs.mkdir(appliedDir, { recursive: true });
  const archivePath = join(
    appliedDir,
    `${wrapper.targetSlug}-${newVersion}-${archiveTimestamp()}.md`,
  );
  await fs.writeFile(archivePath, liveContent, "utf8");

  // Write the proposed body verbatim, then remove the patch file.
  await fs.writeFile(skillPath, body, "utf8");
  await fs.unlink(patchPath);

  deps.log.info(
    {
      agent: opts.agent,
      patchId: opts.patchId,
      action: "apply",
      targetSlug: wrapper.targetSlug,
      finalPath: skillPath,
      archivePath,
      newVersion,
      durationMs: Math.round(performance.now() - t0),
    },
    "phase999.42-skill-patch-action",
  );
  return { status: "applied", finalPath: skillPath, newVersion };
}

/**
 * Reject a pending patch — move it to skills-rejected/ with a
 * `## Rejected: <reason>` header. The filename (with its trailing
 * fingerprint12) is preserved so D7's sticky-rejection set covers patches.
 *
 * Emits exactly one `phase999.42-skill-patch-action` log line.
 */
export async function rejectPatch(
  opts: {
    readonly agent: string;
    readonly patchId: string;
    readonly reason?: string;
  },
  deps: PatchActionDeps,
): Promise<PatchActionResult> {
  const t0 = performance.now();
  const fs = unwrapFs(deps);
  const agentDir = deps.agentWorkspaceDir(opts.agent);
  const patchesDir = join(agentDir, "skill-patches");
  const patchPath = await resolvePatchFile(fs, patchesDir, opts.patchId);

  if (!patchPath) {
    deps.log.warn(
      {
        agent: opts.agent,
        patchId: opts.patchId,
        action: "reject",
        reason: opts.reason,
        failed: true,
        durationMs: Math.round(performance.now() - t0),
      },
      "phase999.42-skill-patch-action",
    );
    return { status: "not-found", reason: "patch-file-missing" };
  }

  const content = String(await fs.readFile(patchPath, "utf8"));
  const fingerprint12 = extractFingerprint12(opts.patchId);
  const rejectedDir = join(agentDir, "skills-rejected");
  await fs.mkdir(rejectedDir, { recursive: true });
  // Preserve the filename (incl. fingerprint12) — D7's sticky-rejection scan
  // substring-matches on fingerprint12 across both drafts and patches.
  const finalPath = join(rejectedDir, basename(patchPath));
  const reasonText =
    opts.reason && opts.reason.trim().length > 0
      ? opts.reason
      : "no reason given";
  const body = `## Rejected: ${reasonText}\n\n${content}`;
  await fs.writeFile(finalPath, body, "utf8");
  await fs.unlink(patchPath);

  deps.log.info(
    {
      agent: opts.agent,
      patchId: opts.patchId,
      action: "reject",
      reason: opts.reason,
      finalPath,
      fingerprint12,
      durationMs: Math.round(performance.now() - t0),
    },
    "phase999.42-skill-patch-action",
  );
  return { status: "rejected", finalPath, fingerprint12 };
}

/**
 * List the pending patches in `skill-patches/` whose `targetSlug` wrapper
 * field matches `slug`. Backs the `/patch-skill <slug>` operator command.
 *
 * Scans the `skill-patches/` directory (NOT the `applied/` sub-directory —
 * `readdir` returns the sub-dir name but it is not a `.md` patch file so it
 * is skipped). Each candidate `.md` file is read + parsed with
 * `parsePatchFile`; malformed files and files whose `targetSlug` does not
 * match are silently skipped — a corrupt artifact must never break the
 * operator's review listing.
 *
 * Never throws — a missing `skill-patches/` directory yields an empty list.
 */
export async function listPatchesForSkill(
  opts: { readonly agent: string; readonly slug: string },
  deps: PatchActionDeps,
): Promise<ListPatchesResult> {
  const fs = unwrapFs(deps);
  const agentDir = deps.agentWorkspaceDir(opts.agent);
  const patchesDir = join(agentDir, "skill-patches");

  let entries: string[];
  try {
    entries = await fs.readdir(patchesDir);
  } catch {
    return { status: "listed", slug: opts.slug, patches: [] };
  }

  const patches: PendingPatch[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".md")) continue;
    let raw: string;
    try {
      raw = String(await fs.readFile(join(patchesDir, entry), "utf8"));
    } catch {
      continue; // unreadable artifact — skip, don't break the listing
    }
    const parsed = parsePatchFile(raw);
    if ("error" in parsed) continue; // malformed — skip
    if (parsed.wrapper.targetSlug !== opts.slug) continue;
    patches.push({
      patchId: basename(entry, ".md"),
      targetSlug: parsed.wrapper.targetSlug,
      patchClass: parsed.wrapper.patchClass,
      sourceFingerprint: parsed.wrapper.sourceFingerprint,
      sourceSessionId: parsed.wrapper.sourceSessionId,
      draftedAt: parsed.wrapper.draftedAt,
    });
  }

  deps.log.info(
    {
      agent: opts.agent,
      slug: opts.slug,
      action: "list",
      count: patches.length,
    },
    "phase999.42-skill-patch-action",
  );
  return { status: "listed", slug: opts.slug, patches };
}
