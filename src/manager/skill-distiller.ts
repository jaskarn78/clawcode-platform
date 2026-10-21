/**
 * Phase 132 Plan 02 T-02 — out-of-band Haiku skill distiller.
 *
 * Decisions: D-01 (out-of-band — invoked via fire-and-forget dispatcher),
 * D-02 (default model literal "claude-haiku-4-5"; sonnet override via
 * resolveModelId), D-04 (draft path = <agentWorkspaceDir>/skills-staging/
 * <slug>-<YYYY-MM-DD-HHMMSS>-<fingerprint12>.md, atomic temp+rename),
 * D-05 (SkillManifestSchema.safeParse before disk write), D-07
 * (fingerprint dedup against skills-rejected/ filenames), D-09 (every
 * exit branch logs phase132-skill-draft). API resilience: retry on 5xx
 * or rate-limit with backoff [10000, 30000, 90000, 270000, 600000] ms.
 * §specifics: drafts with fewer than 3 numbered body steps reject.
 */
import { parse as parseYaml } from "yaml";
import type { Logger } from "pino";
import { join } from "node:path";
import { mkdir, readdir, writeFile, rename } from "node:fs/promises";
import {
  SkillManifestSchema,
  type SkillManifest,
} from "../plugin-sdk/manifest-schema.js";
import type {
  SkillDistillerConfig,
  TaskCompletedEvent,
} from "./skill-distiller-eligibility.js";
import { trajectoryFingerprint } from "./skill-distiller-fingerprint.js";

/**
 * Production callHaiku signature. NOT identical to callHaikuDirect (which
 * hardcodes resolveModelId("haiku") internally); model parameterized here
 * so D-02 Haiku-default + Sonnet-escalation flow through one DI seam.
 */
export type CallHaikuFn = (
  model: string,
  systemPrompt: string,
  userPrompt: string,
  opts: { readonly signal?: AbortSignal; readonly maxTokens?: number },
) => Promise<{ readonly text: string; readonly costUsd?: number }>;

export type DistillSkillDraftDeps = {
  readonly callHaiku: CallHaikuFn;
  readonly resolveModelId: (alias: string) => string;
  readonly log: Logger;
  /** Returns absolute path to ~/.clawcode/agents/<agent>/. */
  readonly agentWorkspaceDir: (agent: string) => string;
  readonly now: () => Date;
  /** Injected for test speed — production binds to a setTimeout wrapper. */
  readonly sleep: (ms: number) => Promise<void>;
};

export type DistillSkillDraftResult =
  | {
      readonly status: "staged";
      readonly draftPath: string;
      readonly manifest: SkillManifest;
      readonly fingerprint: string;
      // Phase 132 Plan 03 T-03 — additive: exposed so the daemon-side
      // embed builder (skill-draft-embed.buildSkillDraftEmbed) has the
      // step count without re-reading the staged file.
      readonly stepCount: number;
    }
  | {
      readonly status: "rejected";
      readonly reason: "manifest-invalid";
      readonly errors: unknown;
    }
  | {
      readonly status: "rejected";
      readonly reason: "trivial-trajectory";
      readonly stepCount: number;
    }
  | {
      readonly status: "skipped";
      readonly reason: "fingerprint-rejected-prior";
      readonly fingerprint: string;
    }
  | {
      readonly status: "errored";
      readonly reason: "haiku-call-failed";
      readonly cause: string;
    };

const HAIKU_MODEL_DEFAULT = "claude-haiku-4-5";
const BACKOFF_MS: ReadonlyArray<number> = [10000, 30000, 90000, 270000, 600000];

const SYSTEM_PROMPT = [
  "You are a skill distiller. Given a tool-call trajectory and outcome from",
  "an agent's task, produce a candidate SKILL.md describing the reusable",
  "workflow. Respond with EXACTLY a markdown file: YAML frontmatter then a",
  "numbered body of at least 3 steps. Frontmatter MUST include: name",
  "(kebab-case), description (non-empty), version (M.m.p semver), owner",
  "(kebab-case agent name or *), capabilities (array of capability enum),",
  "requiredTools (array of strings), requiredMcpServers (array of strings).",
  "Do not add any commentary outside the markdown.",
].join(" ");

function buildUserPrompt(event: TaskCompletedEvent): string {
  const trajectoryJson = JSON.stringify(
    event.trajectory.map((t) => ({ tool: t.tool })),
  );
  return [
    `Agent: ${event.agent}`,
    `Outcome: ${event.outcome}`,
    `Duration (ms): ${event.durationMs}`,
    `Tool call count: ${event.toolCallCount}`,
    `Trajectory (tool names only): ${trajectoryJson}`,
  ].join("\n");
}

function isRetryableError(err: unknown): boolean {
  const status = (err as { status?: number } | null)?.status;
  if (typeof status === "number" && status >= 500) return true;
  const msg = err instanceof Error ? err.message : String(err);
  return /rate.?limit/i.test(msg);
}

async function callWithRetry(
  deps: Pick<DistillSkillDraftDeps, "callHaiku" | "sleep" | "log">,
  model: string,
  user: string,
): Promise<{ text: string; costUsd?: number }> {
  let lastErr: unknown;
  // 5 attempts; sleep BEFORE each (operator API resilience directive
  // covers all attempts including the first — flakiness is not just
  // retry-after-success).
  for (let i = 0; i < BACKOFF_MS.length; i++) {
    await deps.sleep(BACKOFF_MS[i]!);
    try {
      const result = await deps.callHaiku(model, SYSTEM_PROMPT, user, {});
      return result;
    } catch (err) {
      lastErr = err;
      if (!isRetryableError(err)) {
        throw err;
      }
    }
  }
  throw lastErr ?? new Error("callHaiku failed after retries");
}

function splitFrontmatter(
  content: string,
): { frontmatter: string; body: string } | null {
  const match = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) return null;
  return { frontmatter: match[1]!, body: match[2] ?? "" };
}

function countNumberedSteps(body: string): number {
  const matches = body.match(/^[ \t]*\d+\.[ \t]+/gm);
  return matches ? matches.length : 0;
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

/**
 * D-07 sticky-rejection scan. Returns true iff any filename in
 * `rejectedDir` contains `fingerprint12` as a substring.
 *
 * Phase 999.42 Plan 07 — EXPORTED so `skill-patch-suggest.ts` reuses the
 * SAME scan before writing a patch artifact (rejected patches land in
 * `skills-rejected/` via Plan 05 `rejectPatch`, carrying the fingerprint12
 * in the preserved filename). Single source of truth — no second scan.
 */
export async function isFingerprintPriorRejected(
  rejectedDir: string,
  fingerprint12: string,
): Promise<boolean> {
  try {
    const entries = await readdir(rejectedDir);
    return entries.some((name) => name.includes(fingerprint12));
  } catch (err) {
    // ENOENT is non-fatal: empty rejected dir is the common case.
    if ((err as { code?: string }).code === "ENOENT") return false;
    throw err;
  }
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

/** Distill a candidate SKILL.md draft from a task.completed event. */
export async function distillSkillDraft(
  event: TaskCompletedEvent,
  config: SkillDistillerConfig,
  deps: DistillSkillDraftDeps,
): Promise<DistillSkillDraftResult> {
  // Step 1 — fingerprint.
  const fingerprint = trajectoryFingerprint(event.trajectory);
  const fingerprint12 = fingerprint.slice(0, 12);

  // Step 2 — dedup against prior rejections.
  const agentDir = deps.agentWorkspaceDir(event.agent);
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
        fingerprint,
        skipped: true,
        reason: "fingerprint-rejected-prior",
      },
      "phase132-skill-draft",
    );
    return {
      status: "skipped",
      reason: "fingerprint-rejected-prior",
      fingerprint,
    };
  }

  // Step 3 — resolve model. Default uses LITERAL "claude-haiku-4-5" so
  // static grep verifies D-02 verbatim. Sonnet via resolveModelId.
  const model =
    config.distillerModel === "sonnet"
      ? deps.resolveModelId("sonnet")
      : HAIKU_MODEL_DEFAULT;

  // Step 4-5 — Haiku call with retry.
  let haiku: { text: string; costUsd?: number };
  try {
    haiku = await callWithRetry(deps, model, buildUserPrompt(event));
  } catch (err) {
    const cause = err instanceof Error ? err.message : String(err);
    deps.log.error(
      {
        agent: event.agent,
        sessionId: event.sessionId,
        model,
        errored: true,
        reason: "haiku-call-failed",
        cause,
      },
      "phase132-skill-draft",
    );
    return { status: "errored", reason: "haiku-call-failed", cause };
  }

  // Step 6 — split.
  const split = splitFrontmatter(haiku.text);
  if (!split) {
    deps.log.warn(
      {
        agent: event.agent,
        sessionId: event.sessionId,
        manifestValid: false,
        reason: "manifest-invalid",
        detail: "no-frontmatter-fence",
      },
      "phase132-skill-draft",
    );
    return {
      status: "rejected",
      reason: "manifest-invalid",
      errors: { detail: "no-frontmatter-fence" },
    };
  }

  // Step 7 — manifest validation (D-05).
  let parsedFrontmatter: unknown;
  try {
    parsedFrontmatter = parseYaml(split.frontmatter);
  } catch (err) {
    deps.log.warn(
      {
        agent: event.agent,
        sessionId: event.sessionId,
        manifestValid: false,
        reason: "manifest-invalid",
        detail: "yaml-parse-error",
        cause: err instanceof Error ? err.message : String(err),
      },
      "phase132-skill-draft",
    );
    return {
      status: "rejected",
      reason: "manifest-invalid",
      errors: { detail: "yaml-parse-error" },
    };
  }
  const validation = SkillManifestSchema.safeParse(parsedFrontmatter);
  if (!validation.success) {
    deps.log.warn(
      {
        agent: event.agent,
        sessionId: event.sessionId,
        manifestValid: false,
        reason: "manifest-invalid",
        zodErrors: validation.error.format(),
      },
      "phase132-skill-draft",
    );
    return {
      status: "rejected",
      reason: "manifest-invalid",
      errors: validation.error.format(),
    };
  }
  const manifest = validation.data;

  // Step 8 — numbered-step count (§specifics: no drafts under length 3).
  const stepCount = countNumberedSteps(split.body);
  if (stepCount < 3) {
    deps.log.info(
      {
        agent: event.agent,
        sessionId: event.sessionId,
        manifestValid: true,
        reason: "trivial-trajectory",
        stepCount,
      },
      "phase132-skill-draft",
    );
    return { status: "rejected", reason: "trivial-trajectory", stepCount };
  }

  // Step 9 — derive filename (D-04 path convention).
  const slug = manifest.name;
  const timestamp = formatTimestamp(deps.now());
  const filename = `${slug}-${timestamp}-${fingerprint12}.md`;
  const stagingDir = join(agentDir, "skills-staging");
  const draftPath = join(stagingDir, filename);

  // Step 10 — atomic write.
  await atomicWrite(draftPath, haiku.text);

  // Step 11 — staged log + return.
  deps.log.info(
    {
      agent: event.agent,
      sessionId: event.sessionId,
      manifestValid: true,
      slug,
      draftPath,
      model,
      costUsd: haiku.costUsd,
      fingerprint,
      stepCount,
      staged: true,
    },
    "phase132-skill-draft",
  );

  return { status: "staged", draftPath, manifest, fingerprint, stepCount };
}
