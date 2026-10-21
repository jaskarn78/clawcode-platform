/**
 * Deterministic workflow-completion summary.
 *
 * WHY (INC-2026-08-10). A fin-client workflow (`wf_HSegp2`, 4/4 steps)
 * finished and `finalizeWorkflow` posted `header + body`, where `body` was every
 * worker's FULL result concatenated — 90,103 characters. `splitMessage` cut that
 * into ~51 sequential Discord messages. The operator's verdict: "Nobody is going
 * to read that much output."
 *
 * (The per-worker results were never individually posted — that part of the
 * pipeline was always fine. The aggregation at finalize was the whole problem.)
 *
 * This module builds the ALWAYS-AVAILABLE summary: composed purely from
 * `state.workers`, so it needs no LLM turn, no browser, and no attachments. It
 * is the floor that every richer path degrades to — if the synthesis worker
 * fails, if the PDF render fails, if Discord rejects a file, this still posts
 * and the operator still learns what happened and where the detail lives.
 *
 * Two hard invariants, both tested:
 *  1. **≤ MAX_SUMMARY_LENGTH.** The attachment `content` path does NOT go
 *     through `splitMessage`; anything over Discord's 2000 throws a form-body
 *     error and the ENTIRE delivery fails. Truncation here is deterministic.
 *  2. **`formatOutboundText` fixed point.** The daemon re-applies that transform
 *     on the way out, so the text must survive it byte-identically. In practice
 *     that means NO em dashes and no padded en dashes (`stripEmDashes` rewrites
 *     both to " - "), and no bare markdown tables (they get code-fenced).
 */

/**
 * Well under Discord's 2000 hard cap, leaving room for the caller's framing.
 * Deliberately BELOW `FINALIZE_CHUNK_MAX_LENGTH` (1900) so the consolidated
 * post can never be split into two messages by the chunker downstream - the
 * gap is asserted in the tests, because the two constants live apart.
 */
export const MAX_SUMMARY_LENGTH = 1800;

/** Shortest prefix that still reads as a sentence rather than a fragment. */
const MIN_SENTENCE_GIST = 30;

export interface SummaryWorker {
  readonly stepId: string;
  readonly status: string;
  readonly result?: string;
  readonly error?: string;
}

export interface SummaryInput {
  readonly workflowId: string;
  readonly workers: readonly SummaryWorker[];
  /** Relative workspace dir holding per-step .md + summary.json, when persisted. */
  readonly artifactDir?: string;
  /** Basenames of any successfully rendered attachments. */
  readonly attachments?: readonly string[];
  /**
   * The synthesized bottom line, when the report's editorial pass produced one.
   * Carried into the channel post deliberately: the operator should get the
   * answer in Discord, not only inside an attachment they have to open.
   */
  readonly bluf?: string;
  /**
   * Phase 999.120 — the report's key findings and next steps, posted with
   * the PDF so the findings land in the channel, not only inside a file.
   * When present, the per-step gist list collapses to one line (the PDF
   * carries the detail) so the post stays readable on a phone.
   */
  readonly keyFindings?: readonly string[];
  readonly nextSteps?: readonly string[];
  /**
   * Phase 999.129 — recurring (template) runs: what changed since the
   * previous run, posted ABOVE the key findings because the delta is the
   * point of a recurring report. `previousRunAt` is that run's epoch ms.
   */
  readonly changes?: readonly string[];
  readonly previousRunAt?: number;
  /**
   * Phase 999.123 — the fact-check step's outcome: one line of counts and
   * the flagged figures, posted under the findings so an unverified figure
   * is visible in the channel, not only inside the PDF's appendix.
   */
  readonly verification?: {
    readonly line: string;
    readonly flagged: readonly string[];
  };
  readonly elapsedMs?: number;
}

/** Max findings / next steps carried into the post. */
const MAX_POST_FINDINGS = 6;
const MAX_POST_NEXT_STEPS = 4;
/** Max flagged figures carried into the post. */
const MAX_POST_FLAGGED = 4;
/** Max delta lines carried into the post. */
const MAX_POST_CHANGES = 4;

/**
 * House + fixed-point rule in one: em dashes and padded en dashes become
 * " - " (what `stripEmDashes` would do outbound), emphasis is dropped.
 */
function plainLine(text: string, max: number): string {
  return firstMeaningfulLine(
    text.replace(/\s*—\s*/g, " - ").replace(/\s+–\s+/g, " - "),
    max,
  ).replace(/\*+/g, "");
}

function humanDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return s % 60 === 0 ? `${m} min` : `${m} min ${s % 60}s`;
}

/**
 * First meaningful line of a worker result, for a one-line-per-step digest.
 * Skips markdown headings/bullets/fences so the gist survives rather than "###".
 */
export function firstMeaningfulLine(text: string, max = 110): string {
  const clip = (s: string): string => {
    if (s.length <= max) return s;
    // Prefer a sentence boundary near the limit - a gist that stops on a period
    // reads as a statement; one that stops mid-clause reads as damage.
    const head = s.slice(0, max - 1);
    const stop = Math.max(head.lastIndexOf(". "), head.lastIndexOf("? "), head.lastIndexOf("! "));
    // An absolute floor, not a fraction of `max`: 30-odd characters is already
    // a real sentence, and a proportional threshold rejects a perfectly good
    // short opener just because the budget happens to be large.
    if (stop >= MIN_SENTENCE_GIST) return head.slice(0, stop + 1);
    return `${head.trimEnd()}…`;
  };

  let inFence = false;
  // A heading is a usable gist ("Revenue quality"), but real prose is better.
  // Keep the first heading as a fallback and keep looking for a sentence.
  let headingFallback = "";

  for (const raw of text.split("\n")) {
    const trimmed = raw.trim();
    // Track fence STATE, not just the marker: skipping only the ``` lines
    // would happily return the first line of code inside the block.
    if (trimmed.startsWith("```")) {
      inFence = !inFence;
      continue;
    }
    if (inFence || trimmed.startsWith("|")) continue;

    const isHeading = /^#{1,6}(\s|$)/.test(trimmed);
    const line = trimmed
      .replace(/^#{1,6}\s*/, "")
      // `\s+|$` so a BARE marker ("-", "*") is stripped too. Without the `$`
      // an empty bullet survives as the literal "-" and becomes the gist.
      .replace(/^[-*+](\s+|$)/, "")
      .replace(/^\d+[.)](\s+|$)/, "")
      .replace(/^>\s*/, "")
      .replace(/\*\*/g, "")
      .trim();
    // Require real content: a residue of punctuation or list markers is not a gist.
    if (!/[\p{L}\p{N}]/u.test(line)) continue;

    if (isHeading) {
      if (!headingFallback) headingFallback = line;
      continue;
    }
    return clip(line);
  }
  return headingFallback ? clip(headingFallback) : "";
}

/**
 * Build the completion post.
 *
 * Deliberately self-sufficient: it never points ONLY at an attachment. The
 * workspace path is always named, so the message still tells the operator where
 * the detail is even when every attachment failed to render or send.
 */
export function buildDeterministicSummary(input: SummaryInput): string {
  const done = input.workers.filter((w) => w.status === "done");
  const failed = input.workers.filter((w) => w.status !== "done");

  const lines: string[] = [];
  // NOTE: " - ", never " — ". stripEmDashes would rewrite an em dash and break
  // the fixed-point property this string is asserted to have.
  lines.push(
    `🧩 **Workflow \`${input.workflowId}\` complete** - ${done.length}/${input.workers.length} step(s) succeeded` +
      (failed.length > 0 ? `, ${failed.length} failed` : ""),
  );
  if (input.elapsedMs !== undefined) {
    lines.push(`Elapsed: ${humanDuration(input.elapsedMs)}`);
  }

  const bluf = input.bluf?.trim();
  if (bluf) {
    lines.push("");
    // Strip markdown emphasis: the brief renders it, but here it competes with
    // the bold step labels below and the post reads busier for no gain.
    lines.push(`> ${plainLine(bluf, 320)}`);
  }

  // Phase 999.120 — findings + next steps next to the PDF.
  const findings = (input.keyFindings ?? [])
    .map((f) => plainLine(f, 220))
    .filter((f) => f.length > 0)
    .slice(0, MAX_POST_FINDINGS);
  const nextSteps = (input.nextSteps ?? [])
    .map((s) => plainLine(s, 160))
    .filter((s) => s.length > 0)
    .slice(0, MAX_POST_NEXT_STEPS);
  // Phase 999.129 — deltas first on a recurring run.
  const changes = (input.changes ?? [])
    .map((c) => plainLine(c, 220))
    .filter((c) => c.length > 0)
    .slice(0, MAX_POST_CHANGES);
  if (changes.length > 0) {
    lines.push("");
    const since =
      input.previousRunAt !== undefined
        ? ` (since ${new Date(input.previousRunAt).toISOString().slice(0, 10)})`
        : "";
    lines.push(`**Since last run${since}**`);
    for (const c of changes) lines.push(`• ${c}`);
  }
  if (findings.length > 0) {
    lines.push("");
    lines.push("**Key findings**");
    findings.forEach((f, i) => lines.push(`${i + 1}. ${f}`));
  }
  if (nextSteps.length > 0) {
    lines.push("");
    lines.push("**Next**");
    for (const s of nextSteps) lines.push(`• ${s}`);
  }
  // Phase 999.123 — verification status next to the findings.
  if (input.verification) {
    lines.push("");
    lines.push(`**Verification** ${plainLine(input.verification.line, 200)}`);
    for (const f of input.verification.flagged.slice(0, MAX_POST_FLAGGED)) {
      const line = plainLine(f, 160);
      if (line) lines.push(`• ⚠️ ${line}`);
    }
  }

  if (done.length > 0) {
    lines.push("");
    if (findings.length > 0) {
      // The findings are the digest; the steps become a compact provenance line.
      lines.push(`**Steps** ${done.map((w) => `\`${w.stepId}\``).join(" · ")}`);
    } else {
      lines.push("**Steps**");
      for (const w of done) {
        const gist = w.result ? firstMeaningfulLine(w.result) : "";
        lines.push(gist ? `• **${w.stepId}** - ${gist}` : `• **${w.stepId}** - done`);
      }
    }
  }

  if (failed.length > 0) {
    lines.push("");
    lines.push("**Failed**");
    for (const w of failed) {
      const why = (w.error ?? "unknown error").split("\n")[0]!.slice(0, 120);
      lines.push(`• **${w.stepId}** - ⚠️ ${why}`);
    }
  }

  lines.push("");
  if (input.attachments && input.attachments.length > 0) {
    lines.push(`Attached: ${input.attachments.map((a) => `\`${a}\``).join(", ")}`);
  }
  if (input.artifactDir) {
    lines.push(`Full per-step output: \`${input.artifactDir}\` in the workspace.`);
  }

  return truncateToLimit(lines.join("\n"));
}

/**
 * Deterministic truncation at a line boundary, with an explicit marker so a cut
 * is never silent. Kept exported: every producer of this post must funnel
 * through it, because the attachment `content` path has no length guard at all.
 */
export function truncateToLimit(text: string, limit = MAX_SUMMARY_LENGTH): string {
  if (text.length <= limit) return text;
  const marker = "\n… (truncated)";
  const budget = limit - marker.length;
  const cut = text.slice(0, budget);
  const lastBreak = cut.lastIndexOf("\n");
  return `${(lastBreak > budget * 0.6 ? cut.slice(0, lastBreak) : cut).trimEnd()}${marker}`;
}
