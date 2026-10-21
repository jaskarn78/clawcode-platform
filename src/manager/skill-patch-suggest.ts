/**
 * Phase 999.42 Plan 07 — skill-patch-suggest module.
 *
 * Capability C completion — the progressive-refinement loop. When a
 * recurring task trajectory matches a skill the distiller ALREADY created
 * (via the skill's `originatingFingerprint`), this module routes to a
 * PATCH-SUGGEST flow instead of producing a duplicate create-draft.
 *
 *   - findActiveSkillByFingerprint(agent, fp12, deps) — scans the agent's
 *     `skills/<slug>/SKILL.md` manifests for an `originatingFingerprint`
 *     equal to the trajectory fingerprint12; returns the matching
 *     {slug, skillMdPath, content, currentVersion} or null. Skills without
 *     `originatingFingerprint` (hand-authored / pre-999.42) never match —
 *     they do not participate in patch-suggest (CONTEXT D7).
 *   - suggestPatch(event, activeSkill, deps) — (a) sticky-rejection check
 *     against `skills-rejected/` (extends Phase 132 D-07 to patches);
 *     (b) runs the Haiku distiller in 'refine' mode with a distinct system
 *     prompt; (c) validates the refined manifest + version == the patch
 *     bump; (d) writes a wrapped D5 patch artifact to `skill-patches/`.
 *
 * D5 — a patch artifact is a wrapper YAML frontmatter block followed by the
 * literal full refined SKILL.md body. The wrapper carries the 6 fields
 * `skill-patch-actions.parsePatchFile` reads back: targetSlug, patchClass,
 * baseHash, sourceFingerprint, sourceSessionId, draftedAt.
 *
 * Telemetry (grep-checkable): `phase999.42-skill-patch-suggested` fires on
 * the suggested exit; `phase999.42-skill-patch-draft` is the per-artifact-
 * write tag (mirrors Phase 132's `phase132-skill-draft`).
 *
 * Zero new npm dependencies — reuses `callHaiku` (Phase 117 seam),
 * `node:crypto` (SHA256), `node:fs/promises`, `yaml` (existing).
 */
import { parse as parseYaml } from "yaml";
import type { Logger } from "pino";
import { join } from "node:path";
import {
  mkdir,
  readdir,
  readFile,
  writeFile,
  rename,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { SkillManifestSchema } from "../plugin-sdk/manifest-schema.js";
import type { TaskCompletedEvent } from "./skill-distiller-eligibility.js";
import type { CallHaikuFn } from "./skill-distiller.js";
import { isFingerprintPriorRejected } from "./skill-distiller.js";
import { trajectoryFingerprint } from "./skill-distiller-fingerprint.js";
import { bumpVersion } from "./skill-patch-version.js";
import type { SkillPatchRecord } from "../discord/skill-patch-embed.js";

/** A matched active skill — the patch-suggest target. */
export type ActiveSkillMatch = {
  readonly slug: string;
  readonly skillMdPath: string;
  /** The whole current SKILL.md (frontmatter + body) — used for baseHash. */
  readonly content: string;
  /** The `version:` field parsed from the current SKILL.md frontmatter. */
  readonly currentVersion: string;
};

/** DI shape for findActiveSkillByFingerprint (no Haiku / no write). */
export type FindActiveSkillDeps = {
  readonly log: Logger;
  /** Returns absolute path to ~/.clawcode/agents/<agent>/. */
  readonly agentWorkspaceDir: (agent: string) => string;
};

/** DI shape for suggestPatch — mirrors DistillSkillDraftDeps. */
export type SuggestPatchDeps = {
  readonly callHaiku: CallHaikuFn;
  readonly resolveModelId: (alias: string) => string;
  readonly log: Logger;
  /** Returns absolute path to ~/.clawcode/agents/<agent>/. */
  readonly agentWorkspaceDir: (agent: string) => string;
  readonly now: () => Date;
  /** Injected for test speed — production binds to a setTimeout wrapper. */
  readonly sleep: (ms: number) => Promise<void>;
};

/** Discriminated result for suggestPatch. */
export type SuggestPatchResult =
  | {
      readonly status: "suggested";
      readonly patchPath: string;
      /**
       * Everything the daemon needs to build + post the patch embed
       * (Plan 06 `buildSkillPatchEmbed`) without re-reading the artifact.
       */
      readonly record: SkillPatchRecord;
    }
  | { readonly status: "sticky-rejected"; readonly fingerprint: string }
  | {
      readonly status: "rejected-invalid";
      readonly reason: "manifest-invalid" | "version-mismatch";
      readonly detail: unknown;
    }
  | {
      readonly status: "errored";
      readonly reason: "haiku-call-failed";
      readonly cause: string;
    };

const HAIKU_MODEL_DEFAULT = "claude-haiku-4-5";
const BACKOFF_MS: ReadonlyArray<number> = [10000, 30000, 90000, 270000, 600000];

/**
 * The refine-mode system prompt — DISTINCT from `distillSkillDraft`'s
 * create prompt. Haiku is told it is REFINING an existing skill given a
 * new successful trajectory; the `version:` field MUST be exactly the
 * target version we compute (`bumpVersion(current,'patch')`) so the
 * apply-time version guard (Plan 05 `validateBumpedVersion`) passes.
 */
const REFINE_SYSTEM_PROMPT = [
  "You are a skill REFINER. You are given an EXISTING SKILL.md and a NEW",
  "successful task trajectory that repeats the workflow that skill already",
  "covers. Produce a REFINED full SKILL.md that improves the existing one",
  "in light of the new trajectory — clarify steps, add a missing step,",
  "tighten wording. Respond with EXACTLY a markdown file: YAML frontmatter",
  "then a numbered body of at least 3 steps. Preserve the skill's `name`",
  "and `owner` UNCHANGED. The `version:` field MUST be EXACTLY the target",
  "version given in the user message — do not invent a different number.",
  "Frontmatter MUST include: name (kebab-case), description (non-empty),",
  "version (the exact target), owner, capabilities (array), requiredTools",
  "(array), requiredMcpServers (array). Do not add commentary outside the",
  "markdown.",
].join(" ");

/** kebab-case slug guard — no `/`, no `..` (anti path-traversal). */
const KEBAB_CASE = /^[a-z][a-z0-9-]*$/;

function buildRefineUserPrompt(
  event: TaskCompletedEvent,
  existingSkillMd: string,
  targetVersion: string,
): string {
  const trajectoryJson = JSON.stringify(
    event.trajectory.map((t) => ({ tool: t.tool })),
  );
  return [
    `Target version (the refined SKILL.md version: MUST equal this): ${targetVersion}`,
    `Agent: ${event.agent}`,
    `New trajectory (tool names only): ${trajectoryJson}`,
    "",
    "EXISTING SKILL.md:",
    existingSkillMd,
  ].join("\n");
}

function isRetryableError(err: unknown): boolean {
  const status = (err as { status?: number } | null)?.status;
  if (typeof status === "number" && status >= 500) return true;
  const msg = err instanceof Error ? err.message : String(err);
  return /rate.?limit/i.test(msg);
}

async function callRefineWithRetry(
  deps: Pick<SuggestPatchDeps, "callHaiku" | "sleep">,
  model: string,
  user: string,
): Promise<{ text: string; costUsd?: number }> {
  let lastErr: unknown;
  for (let i = 0; i < BACKOFF_MS.length; i++) {
    await deps.sleep(BACKOFF_MS[i]!);
    try {
      return await deps.callHaiku(model, REFINE_SYSTEM_PROMPT, user, {});
    } catch (err) {
      lastErr = err;
      if (!isRetryableError(err)) throw err;
    }
  }
  throw lastErr ?? new Error("callHaiku refine failed after retries");
}

function splitFrontmatter(
  content: string,
): { frontmatter: string; body: string } | null {
  const match = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) return null;
  return { frontmatter: match[1]!, body: match[2] ?? "" };
}

/**
 * Read the `version:` field from a SKILL.md frontmatter block. Returns null
 * when there is no frontmatter or no version line. Replicates the regex in
 * `skill-patch-actions.extractVersion` (not exported there) — keep in sync.
 */
function extractVersion(content: string): string | null {
  const fm = content.match(/^---\n([\s\S]*?)\n---/);
  if (!fm) return null;
  const ver = fm[1]!.match(/^version:\s*(.+)$/m);
  return ver ? ver[1]!.trim() : null;
}

/** Read `originatingFingerprint:` from a SKILL.md frontmatter block. */
function extractOriginatingFingerprint(content: string): string | null {
  const fm = content.match(/^---\n([\s\S]*?)\n---/);
  if (!fm) return null;
  const m = fm[1]!.match(/^originatingFingerprint:\s*(.+)$/m);
  return m ? m[1]!.trim() : null;
}

/** SHA256 hex of the whole-file bytes — D6, no normalization. */
function sha256(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function formatTimestamp(d: Date): string {
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  const y = d.getUTCFullYear();
  const mo = pad(d.getUTCMonth() + 1);
  const da = pad(d.getUTCDate());
  const h = pad(d.getUTCHours());
  const mi = pad(d.getUTCMinutes());
  const s = pad(d.getUTCSeconds());
  return `${y}-${mo}-${da}-${h}${mi}${s}`;
}

/** Atomic temp+rename within the same filesystem (POSIX atomic). */
async function atomicWrite(finalPath: string, content: string): Promise<void> {
  const dir = finalPath.replace(/\/[^/]+$/, "");
  await mkdir(dir, { recursive: true });
  const tmpName = `.${finalPath.split("/").pop()}.tmp`;
  const tmpPath = join(dir, tmpName);
  await writeFile(tmpPath, content, "utf-8");
  await rename(tmpPath, finalPath);
}

/**
 * Scan the agent's `skills/<slug>/SKILL.md` manifests for one whose
 * `originatingFingerprint` equals `fingerprint12`. Returns the first match
 * or null. Skills without `originatingFingerprint` never match.
 *
 * Never throws — a missing `skills/` directory yields null.
 */
export async function findActiveSkillByFingerprint(
  agent: string,
  fingerprint12: string,
  deps: FindActiveSkillDeps,
): Promise<ActiveSkillMatch | null> {
  const skillsDir = join(deps.agentWorkspaceDir(agent), "skills");
  let entries: string[];
  try {
    entries = await readdir(skillsDir);
  } catch (err) {
    // ENOENT is non-fatal: an agent with no skills/ dir has no active skills.
    if ((err as { code?: string }).code === "ENOENT") return null;
    throw err;
  }

  for (const slug of entries) {
    const skillMdPath = join(skillsDir, slug, "SKILL.md");
    let content: string;
    try {
      content = await readFile(skillMdPath, "utf-8");
    } catch {
      // Not a skill dir (no SKILL.md) or unreadable — skip.
      continue;
    }
    const originating = extractOriginatingFingerprint(content);
    if (!originating || originating !== fingerprint12) continue;
    const currentVersion = extractVersion(content);
    if (!currentVersion) continue; // malformed — cannot bump; skip.
    deps.log.info(
      { agent, slug, fingerprint12, matched: true },
      "phase999.42-skill-patch-draft",
    );
    return { slug, skillMdPath, content, currentVersion };
  }
  return null;
}

/**
 * Suggest a patch for an active skill from a recurring trajectory.
 *
 * Sequence: (a) sticky-rejection scan of `skills-rejected/` — a rejected
 * patch/draft for this fingerprint12 blocks re-suggestion; (b) compute the
 * patch-bumped target version; (c) Haiku refine-mode call with the existing
 * SKILL.md + the new trajectory + the exact target version; (d) validate
 * the refined manifest AND that its `version:` equals the target; (e) write
 * the wrapped D5 patch artifact to `skill-patches/<slug>-<ts>-<fp12>.patch.md`.
 *
 * Emits `phase999.42-skill-patch-draft` at decision points and
 * `phase999.42-skill-patch-suggested` on the suggested exit.
 */
export async function suggestPatch(
  event: TaskCompletedEvent,
  activeSkill: ActiveSkillMatch,
  deps: SuggestPatchDeps,
): Promise<SuggestPatchResult> {
  const fingerprint = trajectoryFingerprint(event.trajectory);
  const fingerprint12 = fingerprint.slice(0, 12);
  const agentDir = deps.agentWorkspaceDir(event.agent);

  // Step a — sticky-rejection (extends Phase 132 D-07 to patches). Reuses
  // the SAME scan distillSkillDraft uses — rejected patches land in
  // skills-rejected/ via Plan 05 rejectPatch carrying the fingerprint12.
  const rejectedDir = join(agentDir, "skills-rejected");
  const priorRejected = await isFingerprintPriorRejected(
    rejectedDir,
    fingerprint12,
  );
  if (priorRejected) {
    deps.log.info(
      {
        agent: event.agent,
        sessionId: event.sessionId,
        slug: activeSkill.slug,
        fingerprint,
        skipped: true,
        reason: "fingerprint-rejected-prior",
      },
      "phase999.42-skill-patch-draft",
    );
    return { status: "sticky-rejected", fingerprint };
  }

  // Step b — compute the patch-bumped target version.
  let targetVersion: string;
  try {
    targetVersion = bumpVersion(activeSkill.currentVersion, "patch");
  } catch (err) {
    // Non-semver current version — cannot bump. Treat as invalid.
    deps.log.warn(
      {
        agent: event.agent,
        sessionId: event.sessionId,
        slug: activeSkill.slug,
        reason: "version-mismatch",
        detail: `current version not semver: ${activeSkill.currentVersion}`,
      },
      "phase999.42-skill-patch-draft",
    );
    return {
      status: "rejected-invalid",
      reason: "version-mismatch",
      detail: err instanceof Error ? err.message : String(err),
    };
  }

  // Step c — Haiku refine call (default model literal — D-02 parity).
  const model = HAIKU_MODEL_DEFAULT;
  let haiku: { text: string; costUsd?: number };
  try {
    haiku = await callRefineWithRetry(
      deps,
      model,
      buildRefineUserPrompt(event, activeSkill.content, targetVersion),
    );
  } catch (err) {
    const cause = err instanceof Error ? err.message : String(err);
    deps.log.error(
      {
        agent: event.agent,
        sessionId: event.sessionId,
        slug: activeSkill.slug,
        model,
        errored: true,
        reason: "haiku-call-failed",
        cause,
      },
      "phase999.42-skill-patch-draft",
    );
    return { status: "errored", reason: "haiku-call-failed", cause };
  }

  // Step d — validate the refined manifest + version-match.
  const split = splitFrontmatter(haiku.text);
  if (!split) {
    deps.log.warn(
      {
        agent: event.agent,
        sessionId: event.sessionId,
        slug: activeSkill.slug,
        reason: "manifest-invalid",
        detail: "no-frontmatter-fence",
      },
      "phase999.42-skill-patch-draft",
    );
    return {
      status: "rejected-invalid",
      reason: "manifest-invalid",
      detail: "no-frontmatter-fence",
    };
  }
  let parsedFrontmatter: unknown;
  try {
    parsedFrontmatter = parseYaml(split.frontmatter);
  } catch (err) {
    deps.log.warn(
      {
        agent: event.agent,
        sessionId: event.sessionId,
        slug: activeSkill.slug,
        reason: "manifest-invalid",
        detail: "yaml-parse-error",
      },
      "phase999.42-skill-patch-draft",
    );
    return {
      status: "rejected-invalid",
      reason: "manifest-invalid",
      detail: err instanceof Error ? err.message : String(err),
    };
  }
  const validation = SkillManifestSchema.safeParse(parsedFrontmatter);
  if (!validation.success) {
    deps.log.warn(
      {
        agent: event.agent,
        sessionId: event.sessionId,
        slug: activeSkill.slug,
        reason: "manifest-invalid",
        zodErrors: validation.error.format(),
      },
      "phase999.42-skill-patch-draft",
    );
    return {
      status: "rejected-invalid",
      reason: "manifest-invalid",
      detail: validation.error.format(),
    };
  }
  // The refined body's version MUST equal the target patch bump — the
  // apply-time guard (Plan 05 validateBumpedVersion) re-checks this; we
  // reject early so a hallucinated version never becomes an artifact.
  if (validation.data.version !== targetVersion) {
    deps.log.warn(
      {
        agent: event.agent,
        sessionId: event.sessionId,
        slug: activeSkill.slug,
        reason: "version-mismatch",
        expected: targetVersion,
        declared: validation.data.version,
      },
      "phase999.42-skill-patch-draft",
    );
    return {
      status: "rejected-invalid",
      reason: "version-mismatch",
      detail: `expected ${targetVersion}, refined body declared ${validation.data.version}`,
    };
  }

  // Step e — write the wrapped D5 patch artifact.
  const slug = activeSkill.slug;
  // Defensive: the slug came off a directory name — guard the join.
  if (!KEBAB_CASE.test(slug)) {
    deps.log.warn(
      {
        agent: event.agent,
        sessionId: event.sessionId,
        slug,
        reason: "manifest-invalid",
        detail: "skill slug is not kebab-case",
      },
      "phase999.42-skill-patch-draft",
    );
    return {
      status: "rejected-invalid",
      reason: "manifest-invalid",
      detail: "skill slug is not kebab-case",
    };
  }
  const draftedAt = deps.now();
  const timestamp = formatTimestamp(draftedAt);
  // Filename carries fingerprint12 LAST so Plan 05 rejectPatch (which
  // preserves the filename) keeps it in the D-07 sticky-rejection set.
  const filename = `${slug}-${timestamp}-${fingerprint12}.patch.md`;
  const patchPath = join(agentDir, "skill-patches", filename);
  const wrapper = [
    "---",
    `targetSlug: ${slug}`,
    "patchClass: patch",
    `baseHash: ${sha256(activeSkill.content)}`,
    `sourceFingerprint: ${fingerprint}`,
    `sourceSessionId: ${event.sessionId}`,
    `draftedAt: ${draftedAt.toISOString()}`,
    "---",
    "",
  ].join("\n");
  // D5 — wrapper frontmatter + the literal full refined SKILL.md body.
  const artifact = wrapper + haiku.text;
  await atomicWrite(patchPath, artifact);

  deps.log.info(
    {
      agent: event.agent,
      sessionId: event.sessionId,
      slug,
      patchPath,
      model,
      costUsd: haiku.costUsd,
      fingerprint,
      currentVersion: activeSkill.currentVersion,
      targetVersion,
      written: true,
    },
    "phase999.42-skill-patch-draft",
  );
  deps.log.info(
    {
      agent: event.agent,
      sessionId: event.sessionId,
      slug,
      patchPath,
      currentVersion: activeSkill.currentVersion,
      targetVersion,
      suggested: true,
    },
    "phase999.42-skill-patch-suggested",
  );

  const record: SkillPatchRecord = {
    patchId: filename.replace(/\.md$/, ""),
    slug,
    patchClass: "patch",
    currentVersion: activeSkill.currentVersion,
    bumpedVersion: targetVersion,
    sourceSessionId: event.sessionId,
    draftedAt: draftedAt.toISOString(),
  };
  return { status: "suggested", patchPath, record };
}

/**
 * Decide whether a distiller dispatch should route to PATCH-SUGGEST instead
 * of the Phase 132 create-draft path.
 *
 * Returns the matched `ActiveSkillMatch` when `suggestPatches` is true AND
 * the trajectory fingerprint matches an active skill's
 * `originatingFingerprint`. Returns null otherwise — the caller then runs
 * the existing `distillSkillDraft` create path.
 *
 * When `suggestPatches` is false (the default) this returns null WITHOUT
 * scanning `skills/` at all — the active-skill check is fully gated behind
 * the flag, so a flag-off agent's dispatch is byte-identical to Phase 132
 * (CONTEXT D7: zero fleet behavior change until an operator opts in).
 *
 * Never throws — a `findActiveSkillByFingerprint` failure (e.g. a transient
 * fs error) is swallowed and treated as "no match" so the out-of-band
 * dispatch (Phase 132 D-01) is never destabilized.
 */
export async function shouldRouteToPatch(
  event: TaskCompletedEvent,
  suggestPatches: boolean,
  deps: FindActiveSkillDeps,
): Promise<ActiveSkillMatch | null> {
  if (!suggestPatches) return null;
  const fingerprint12 = trajectoryFingerprint(event.trajectory).slice(0, 12);
  try {
    return await findActiveSkillByFingerprint(
      event.agent,
      fingerprint12,
      deps,
    );
  } catch (err) {
    deps.log.error(
      {
        agent: event.agent,
        sessionId: event.sessionId,
        reason: "active-skill-scan-failed",
        cause: err instanceof Error ? err.message : String(err),
      },
      "phase999.42-skill-patch-draft",
    );
    return null;
  }
}
