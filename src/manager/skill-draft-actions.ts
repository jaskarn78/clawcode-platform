/**
 * Phase 132 Plan 03 T-01 — skill-draft-actions module.
 *
 * Pure-IO handlers for the three operator review actions:
 *   - approveDraft       (D-04: staging → skills/<slug>/SKILL.md, Phase 130 layout)
 *   - rejectDraft        (D-04: staging → skills-rejected/<id>.md;
 *                         D-07: filename preserves fingerprint12 for distiller dedup)
 *   - locateDraftForEdit (CONTEXT §Claude's Discretion — returns absolute
 *                         path so the operator can scp-edit then re-/approve)
 *
 * Telemetry tag (D-09 — grep-checkable): every handler emits exactly one
 * `phase132-skill-action` structured log line with {agent, draftId, action,
 * reason?, finalPath?|draftPath?}.
 *
 * Filename convention (must match Plan 02's distiller writer):
 *   <slug>-YYYY-MM-DD-HHMMSS-<fingerprint12>.md
 *
 *   skill-distiller.ts:328 — `${slug}-${timestamp}-${fingerprint12}.md`
 *   skill-distiller.ts:193 — `fingerprint12 = fingerprint.slice(0, 12)`
 *
 * The slug itself is kebab-case (may contain hyphens — manifest.name).
 * To peel the trailing fingerprint12 we take the LAST `-`-separated token
 * (12 hex chars). The slug for D-04's target path is derived from the
 * manifest's `name` field embedded in the YAML frontmatter — which is the
 * canonical authority — NOT from filename surgery. We read the staged file,
 * parse the frontmatter line `name: <slug>`, and use that for the target
 * directory. Filename surgery is reserved for the fingerprint12 peel only.
 */
import { readFile as fsReadFile, readdir as fsReaddir, writeFile as fsWriteFile, mkdir as fsMkdir, unlink as fsUnlink } from "node:fs/promises";
import { join, basename } from "node:path";

export type DraftActionLogger = {
  readonly info: (obj: Record<string, unknown>, msg: string) => void;
  readonly warn: (obj: Record<string, unknown>, msg: string) => void;
  readonly error: (obj: Record<string, unknown>, msg: string) => void;
};

export type DraftActionFs = {
  readonly readFile?: typeof fsReadFile;
  readonly readdir?: typeof fsReaddir;
  readonly writeFile?: typeof fsWriteFile;
  readonly mkdir?: typeof fsMkdir;
  readonly unlink?: (p: string) => Promise<void>;
};

export type DraftActionDeps = {
  readonly log: DraftActionLogger;
  /** Returns absolute path to ~/.clawcode/agents/<agent>/. */
  readonly agentWorkspaceDir: (agent: string) => string;
  readonly fs?: DraftActionFs;
};

export type DraftActionResult =
  | { readonly status: "approved"; readonly finalPath: string }
  | {
      readonly status: "rejected";
      readonly finalPath: string;
      readonly fingerprint12: string;
    }
  | { readonly status: "found"; readonly draftPath: string }
  | {
      readonly status: "not-found";
      readonly reason: "staging-file-missing";
    };

const FINGERPRINT12_RE = /-([0-9a-f]{12})$/i;
const NAME_FRONTMATTER_RE = /^name:\s*([A-Za-z0-9][A-Za-z0-9-]*)\s*$/m;

function unwrapFs(deps: DraftActionDeps): Required<DraftActionFs> {
  return {
    readFile: deps.fs?.readFile ?? fsReadFile,
    readdir: deps.fs?.readdir ?? fsReaddir,
    writeFile: deps.fs?.writeFile ?? fsWriteFile,
    mkdir: deps.fs?.mkdir ?? fsMkdir,
    unlink: deps.fs?.unlink ?? (async (p: string) => fsUnlink(p)),
  };
}

async function resolveStagingFile(
  fs: Required<DraftActionFs>,
  stagingDir: string,
  draftId: string,
): Promise<string | null> {
  const expected = `${draftId}.md`;
  try {
    const entries = await fs.readdir(stagingDir);
    return entries.includes(expected) ? join(stagingDir, expected) : null;
  } catch {
    return null;
  }
}

function extractFingerprint12(draftId: string): string {
  const m = draftId.match(FINGERPRINT12_RE);
  return m ? m[1]!.toLowerCase() : "";
}

function extractSlug(content: string, fallback: string): string {
  const m = content.match(NAME_FRONTMATTER_RE);
  return m ? m[1]! : fallback;
}

/** Frontmatter block — leading `---\n ... \n---`. */
const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---/;
/** A `version:` line inside the frontmatter block. */
const VERSION_LINE_RE = /^(version:[^\n]*)$/m;

/**
 * Phase 999.42 D7a — inject `originatingFingerprint: <fp12>` into the YAML
 * frontmatter of a staged skill's content. Byte-minimal: inserts a single
 * line, never re-serializes the YAML.
 *
 * No-ops (returns `content` unchanged) when:
 *  - `fp12` is empty (the draftId carried no parseable fingerprint12), or
 *  - the frontmatter already has an `originatingFingerprint:` line, or
 *  - there is no parseable frontmatter block at all.
 *
 * The line is inserted immediately after the `version:` line when one exists,
 * otherwise just before the closing `---` of the frontmatter block.
 */
function injectOriginatingFingerprint(content: string, fp12: string): string {
  if (!fp12) return content;
  const fmMatch = content.match(FRONTMATTER_RE);
  if (!fmMatch) return content;
  const block = fmMatch[1]!;
  // Already present — do not duplicate.
  if (/^originatingFingerprint:/m.test(block)) return content;
  const line = `originatingFingerprint: ${fp12}`;
  const verMatch = block.match(VERSION_LINE_RE);
  let newBlock: string;
  if (verMatch) {
    // Insert immediately after the `version:` line.
    newBlock = block.replace(VERSION_LINE_RE, `$1\n${line}`);
  } else {
    // No `version:` line — append at the end of the frontmatter block.
    newBlock = `${block}\n${line}`;
  }
  // Rebuild only the frontmatter block; body bytes are untouched.
  return content.replace(FRONTMATTER_RE, `---\n${newBlock}\n---`);
}

export async function approveDraft(
  opts: { readonly agent: string; readonly draftId: string },
  deps: DraftActionDeps,
): Promise<DraftActionResult> {
  // Phase 999.43-fu2 T06 — IPC-handler wall-clock duration. Captured at
  // entry; emitted on every log line below so each `phase132-skill-action`
  // event carries a measurable latency value (closes the latency-review
  // gap noted in latency-review-2026-05-17.md: "No durationMs field").
  const t0 = performance.now();
  const fs = unwrapFs(deps);
  const agentDir = deps.agentWorkspaceDir(opts.agent);
  const stagingDir = join(agentDir, "skills-staging");
  const stagingPath = await resolveStagingFile(fs, stagingDir, opts.draftId);
  if (!stagingPath) {
    deps.log.warn(
      {
        agent: opts.agent,
        draftId: opts.draftId,
        action: "approve",
        failed: true,
        reason: "staging-file-missing",
        durationMs: Math.round(performance.now() - t0),
      },
      "phase132-skill-action",
    );
    return { status: "not-found", reason: "staging-file-missing" };
  }
  const content = (await fs.readFile(stagingPath, "utf8")) as unknown;
  const contentStr =
    typeof content === "string" ? content : String(content);
  // Slug comes from the manifest frontmatter (authoritative — Phase 130
  // layout uses the manifest.name as the skill directory name). Fall back
  // to the filename's leading kebab segment only if frontmatter parsing
  // fails (Plan 02 already SkillManifestSchema.safeParse'd so this is
  // belt-and-suspenders).
  const slug = extractSlug(contentStr, opts.draftId.split("-")[0]!);
  const targetDir = join(agentDir, "skills", slug);
  const finalPath = join(targetDir, "SKILL.md");
  await fs.mkdir(targetDir, { recursive: true });
  // Phase 999.42 D7a — inject the trajectory fingerprint12 into the manifest
  // frontmatter on the staging→active move. The fp12 is the trailing segment
  // of the draftId. injectOriginatingFingerprint is a no-op when the draftId
  // has no fp12, when the field is already present, or when there is no
  // frontmatter — so a hand-authored draft passes through byte-stable.
  const fp12 = extractFingerprint12(opts.draftId);
  const finalContent = injectOriginatingFingerprint(contentStr, fp12);
  // Write-then-unlink (cross-filesystem safe; D-05 — only the additive
  // originatingFingerprint frontmatter line differs from the staged bytes).
  await fs.writeFile(finalPath, finalContent, "utf8");
  await fs.unlink(stagingPath);
  deps.log.info(
    {
      agent: opts.agent,
      draftId: opts.draftId,
      action: "approve",
      finalPath,
      durationMs: Math.round(performance.now() - t0),
    },
    "phase132-skill-action",
  );
  return { status: "approved", finalPath };
}

export async function rejectDraft(
  opts: {
    readonly agent: string;
    readonly draftId: string;
    readonly reason?: string;
  },
  deps: DraftActionDeps,
): Promise<DraftActionResult> {
  // Phase 999.43-fu2 T06 — IPC-handler wall-clock for distillation budget.
  const t0 = performance.now();
  const fs = unwrapFs(deps);
  const agentDir = deps.agentWorkspaceDir(opts.agent);
  const stagingDir = join(agentDir, "skills-staging");
  const stagingPath = await resolveStagingFile(fs, stagingDir, opts.draftId);
  if (!stagingPath) {
    deps.log.warn(
      {
        agent: opts.agent,
        draftId: opts.draftId,
        action: "reject",
        reason: opts.reason,
        failed: true,
        durationMs: Math.round(performance.now() - t0),
      },
      "phase132-skill-action",
    );
    return { status: "not-found", reason: "staging-file-missing" };
  }
  const content = (await fs.readFile(stagingPath, "utf8")) as unknown;
  const contentStr =
    typeof content === "string" ? content : String(content);
  const fingerprint12 = extractFingerprint12(opts.draftId);
  const rejectedDir = join(agentDir, "skills-rejected");
  await fs.mkdir(rejectedDir, { recursive: true });
  // Filename preserves the draftId (including fingerprint12) so Plan 02's
  // distiller can scan skills-rejected/ and substring-match on fingerprint12
  // to dedup sticky-rejected trajectories (D-07).
  const finalPath = join(rejectedDir, basename(stagingPath));
  const reasonText = opts.reason && opts.reason.trim().length > 0
    ? opts.reason
    : "no reason given";
  const body = `## Rejected: ${reasonText}\n\n${contentStr}`;
  await fs.writeFile(finalPath, body, "utf8");
  await fs.unlink(stagingPath);
  deps.log.info(
    {
      agent: opts.agent,
      draftId: opts.draftId,
      action: "reject",
      reason: opts.reason,
      finalPath,
      fingerprint12,
      durationMs: Math.round(performance.now() - t0),
    },
    "phase132-skill-action",
  );
  return { status: "rejected", finalPath, fingerprint12 };
}

export async function locateDraftForEdit(
  opts: { readonly agent: string; readonly draftId: string },
  deps: DraftActionDeps,
): Promise<DraftActionResult> {
  // Phase 999.43-fu2 T06 — IPC-handler wall-clock duration.
  const t0 = performance.now();
  const fs = unwrapFs(deps);
  const agentDir = deps.agentWorkspaceDir(opts.agent);
  const stagingDir = join(agentDir, "skills-staging");
  const stagingPath = await resolveStagingFile(fs, stagingDir, opts.draftId);
  if (!stagingPath) {
    deps.log.warn(
      {
        agent: opts.agent,
        draftId: opts.draftId,
        action: "edit",
        failed: true,
        durationMs: Math.round(performance.now() - t0),
      },
      "phase132-skill-action",
    );
    return { status: "not-found", reason: "staging-file-missing" };
  }
  deps.log.info(
    {
      agent: opts.agent,
      draftId: opts.draftId,
      action: "edit",
      draftPath: stagingPath,
      durationMs: Math.round(performance.now() - t0),
    },
    "phase132-skill-action",
  );
  return { status: "found", draftPath: stagingPath };
}
