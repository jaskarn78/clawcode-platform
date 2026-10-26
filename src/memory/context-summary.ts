import { writeFile, readFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { countTokens } from "../performance/token-count.js";
import { renderAgentVisibleTimestamp } from "../shared/agent-visible-time.js";

/** Maximum word count for a context summary to avoid bloating system prompts. */
const DEFAULT_MAX_WORDS = 500;

/** Filename for the persisted context summary. */
const SUMMARY_FILENAME = "context-summary.md";

/**
 * Phase 53 Plan 02 (CTX-04) — default resume-summary token budget.
 * Per 53-CONTEXT D-04: 1500 tokens default. Operators tune via
 * `agentConfig.perf.resumeSummaryBudget`.
 */
export const DEFAULT_RESUME_SUMMARY_BUDGET = 1500;

/**
 * Phase 53 Plan 02 (CTX-04) — hard floor on resume-summary budget.
 * Per 53-CONTEXT D-04: Zod rejects values below 500 at the config layer;
 * `enforceSummaryBudget` enforces the same floor as a runtime backstop.
 */
export const MIN_RESUME_SUMMARY_BUDGET = 500;

/**
 * Memory overhaul WP6 (2026-10-25). A resume summary older than this is not
 * injected at boot: the "from previous session" framing is wrong for a file
 * written days or weeks ago, and nothing deletes the file after use. Seven
 * days matches the hot-tier recency window.
 */
export const DEFAULT_RESUME_SUMMARY_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * WP6. The heartbeat zone-snapshot callback writes a one-line placeholder
 * ("Auto-snapshot at 85% context fill [red zone]") through saveContextSummary.
 * A file whose whole body is that line carries no context and is skipped.
 */
const PLACEHOLDER_BODY_PREFIX = "Auto-snapshot at";

/** WP6. Options for `loadLatestSummary` (all optional, defaults keep the old call shape). */
export type LoadLatestSummaryOptions = {
  /** Epoch ms clock override for the age check (tests). Defaults to Date.now(). */
  readonly now?: number;
  /** Age ceiling in ms. Defaults to DEFAULT_RESUME_SUMMARY_MAX_AGE_MS. */
  readonly maxAgeMs?: number;
};

/**
 * A persisted context summary from a compaction event.
 */
export type ContextSummary = {
  readonly agentName: string;
  readonly summary: string;
  readonly createdAt: string;
};

/**
 * Phase 53 Plan 02 — regenerator signature.
 *
 * Called by `enforceSummaryBudget` when the current summary exceeds budget.
 * The `targetTokens` argument is the hard cap the caller wants the new
 * summary to fit under. Implementations MAY return a summary longer than
 * `targetTokens` — the enforcer will retry up to `maxAttempts` times or
 * hard-truncate.
 */
export type SummaryRegenerator = (
  summary: string,
  targetTokens: number,
) => Promise<string>;

/**
 * Phase 53 Plan 02 — minimal logger shape used by `enforceSummaryBudget`.
 *
 * Matches `pino.Logger.warn` so callers can pass their pino instance
 * directly. Kept as a local interface so this module has no `pino`
 * import dependency (keeps `src/memory/` runtime-neutral).
 *
 * SECURITY: callers MUST NOT pass summary bodies here — only
 * agent/budget/token-count/attempts metadata is serialized.
 */
export type LoggerLike = {
  readonly warn: (obj: Record<string, unknown>, msg?: string) => void;
  /**
   * 99-mdrop — optional error level for context-loss-class events that
   * MUST surface above warn (raw-turn fallback colliding with budget
   * truncation). Pino loggers always provide this; lighter shims may
   * omit it and callers fall back to warn.
   */
  readonly error?: (obj: Record<string, unknown>, msg?: string) => void;
};

/**
 * Phase 53 Plan 02 — input for `enforceSummaryBudget`.
 */
export type EnforceSummaryBudgetOpts = {
  readonly summary: string;
  readonly budget: number; // must be >= MIN_RESUME_SUMMARY_BUDGET
  readonly regenerate?: SummaryRegenerator;
  readonly maxAttempts?: number; // default 2
  readonly log?: LoggerLike;
  readonly agentName?: string;
};

/**
 * Phase 53 Plan 02 — result of `enforceSummaryBudget`.
 *
 * `attempts` counts the number of regenerator invocations (0 means the
 * initial summary already fit within budget). `truncated` is `true` ONLY
 * when the hard-truncate fallback ran.
 */
export type EnforceSummaryBudgetResult = {
  readonly summary: string;
  readonly tokens: number;
  readonly truncated: boolean;
  readonly attempts: number;
};

/**
 * Truncate a summary to a maximum word count.
 * Preserves full words -- does not split mid-word.
 *
 * @param text - The summary text to truncate
 * @param maxWords - Maximum number of words (default 500)
 * @returns Truncated text, with "..." appended if truncated
 */
export function truncateSummary(
  text: string,
  maxWords: number = DEFAULT_MAX_WORDS,
): string {
  const words = text.split(/\s+/).filter((w) => w.length > 0);
  if (words.length <= maxWords) {
    return text;
  }
  return words.slice(0, maxWords).join(" ") + "...";
}

/**
 * Save a context summary to the agent's memory directory.
 * Overwrites any existing summary (only latest is relevant).
 * Creates the directory if it doesn't exist.
 *
 * Phase 999.13 TZ-04 — `agentTz` (optional) controls the operator-local
 * TZ used in the `**Generated:**` header. When omitted, falls back to
 * host TZ via renderAgentVisibleTimestamp's resolution chain. Test 8's
 * `saveSummary.length === 3` invariant is preserved because optional
 * trailing parameters do not count toward Function.length.
 *
 * @param memoryDir - Path to the agent's memory directory
 * @param agentName - Name of the agent
 * @param summary - The summary text from compaction
 * @param agentTz - Optional IANA TZ for the Generated header (e.g. "America/Los_Angeles")
 */
export async function saveSummary(
  memoryDir: string,
  agentName: string,
  summary: string,
  agentTz?: string,
): Promise<void> {
  await mkdir(memoryDir, { recursive: true });

  const truncated = truncateSummary(summary);
  const content = [
    `# Context Summary`,
    ``,
    `**Agent:** ${agentName}`,
    `**Generated:** ${renderAgentVisibleTimestamp(new Date(), agentTz)}`,
    ``,
    truncated,
    ``,
  ].join("\n");

  await writeFile(join(memoryDir, SUMMARY_FILENAME), content, "utf-8");
}

/**
 * WP6. Parse the `**Generated:**` header value back to epoch ms.
 *
 * `saveSummary` writes "YYYY-MM-DD HH:mm:ss ZZZ" (renderAgentVisibleTimestamp);
 * older files carry an ISO string. V8 parses ISO and the US zone
 * abbreviations (PDT, EST, UTC...). For an abbreviation it does not know
 * (CEST, BST...) the wall-clock part is read as UTC: the error is at most a
 * few hours, far inside the 7-day window. Returns undefined when nothing
 * date-shaped is found, in which case the caller keeps the summary (no
 * evidence that it is stale).
 */
export function parseGeneratedTimestamp(raw: string): number | undefined {
  const text = raw.trim();
  if (text.length === 0) return undefined;
  const direct = new Date(text).getTime();
  if (!Number.isNaN(direct)) return direct;
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})/.exec(text);
  if (!m) return undefined;
  const fallback = new Date(`${m[1]}T${m[2]}Z`).getTime();
  return Number.isNaN(fallback) ? undefined : fallback;
}

/**
 * WP6. True when the body is nothing but the heartbeat zone-snapshot
 * placeholder line (see PLACEHOLDER_BODY_PREFIX).
 */
export function isPlaceholderSummary(body: string): boolean {
  const trimmed = body.trim();
  return trimmed.startsWith(PLACEHOLDER_BODY_PREFIX) && !trimmed.includes("\n");
}

/**
 * Load the latest context summary from the agent's memory directory.
 * Returns the summary text (without the metadata header), or undefined
 * if no summary file exists.
 *
 * WP6 (2026-10-25): also returns undefined when the body is only the
 * heartbeat placeholder ("Auto-snapshot at ...") or when the Generated
 * header is older than `opts.maxAgeMs` (default 7 days). A file with no
 * parseable Generated header is kept.
 *
 * @param memoryDir - Path to the agent's memory directory
 * @param opts - optional clock / age ceiling overrides
 * @returns The summary text, or undefined
 */
export async function loadLatestSummary(
  memoryDir: string,
  opts?: LoadLatestSummaryOptions,
): Promise<string | undefined> {
  try {
    const content = await readFile(
      join(memoryDir, SUMMARY_FILENAME),
      "utf-8",
    );

    // Extract just the summary body (after the metadata header)
    // Format: # Context Summary\n\n**Agent:**...\n**Generated:**...\n\n<body>
    const lines = content.split("\n");
    // Skip header: find the line after **Generated:** and the following blank line
    let bodyStartIndex = 0;
    let generatedRaw: string | undefined;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].startsWith("**Generated:**")) {
        generatedRaw = lines[i].slice("**Generated:**".length);
        // Skip the blank line after Generated
        bodyStartIndex = i + 2;
        break;
      }
    }

    const body = lines.slice(bodyStartIndex).join("\n").trim();
    if (body.length === 0) return undefined;
    if (isPlaceholderSummary(body)) return undefined;

    const generatedAt =
      generatedRaw !== undefined ? parseGeneratedTimestamp(generatedRaw) : undefined;
    if (generatedAt !== undefined) {
      const now = opts?.now ?? Date.now();
      const maxAgeMs = opts?.maxAgeMs ?? DEFAULT_RESUME_SUMMARY_MAX_AGE_MS;
      if (now - generatedAt > maxAgeMs) return undefined;
    }
    return body;
  } catch {
    return undefined;
  }
}

/**
 * Phase 53 Plan 02 (CTX-04) — enforce a hard token budget on a resume summary.
 *
 * Flow per 53-CONTEXT D-04:
 *   1. If under budget → return as-is (attempts: 0, truncated: false).
 *   2. Else call `regenerate(summary, budget)` up to `maxAttempts` times
 *      (default 2). Accept the first regenerated summary that fits.
 *   3. If still over budget after regeneration → hard-truncate at a
 *      word boundary, append "...", and emit `log.warn` with
 *      `{ agent, budget, beforeTokens, afterTokens, attempts }`. The
 *      full summary body is NEVER logged (SECURITY — see phase
 *      critical_constraints).
 *
 * Runtime backstop: budget < `MIN_RESUME_SUMMARY_BUDGET` (500) throws
 * `RangeError`. The Zod config layer (Plan 53-01) already rejects this
 * case; the runtime check guards against direct API callers.
 *
 * When `regenerate` is omitted and the summary is over budget, skips
 * straight to the hard-truncate fallback (attempts: 0, truncated: true).
 */
export async function enforceSummaryBudget(
  opts: EnforceSummaryBudgetOpts,
): Promise<EnforceSummaryBudgetResult> {
  if (opts.budget < MIN_RESUME_SUMMARY_BUDGET) {
    throw new RangeError(
      `resume-summary budget floor is ${MIN_RESUME_SUMMARY_BUDGET}, got ${opts.budget}`,
    );
  }

  const maxAttempts = opts.maxAttempts ?? 2;

  // Step 1: under-budget → passthrough.
  let current = opts.summary;
  let tokens = countTokens(current);
  if (tokens <= opts.budget) {
    return Object.freeze({
      summary: current,
      tokens,
      truncated: false,
      attempts: 0,
    });
  }

  // Step 2: regeneration loop.
  let attempts = 0;
  while (attempts < maxAttempts && opts.regenerate) {
    attempts++;
    const regen = await opts.regenerate(current, opts.budget);
    const regenTokens = countTokens(regen);
    if (regenTokens <= opts.budget) {
      return Object.freeze({
        summary: regen,
        tokens: regenTokens,
        truncated: false,
        attempts,
      });
    }
    current = regen; // next regen operates on the latest attempt
    tokens = regenTokens;
  }

  // Step 3: hard-truncate at word boundary + ellipsis.
  // Tokens-to-chars heuristic: Claude BPE averages ~3.5 chars/token. Use
  // 4 as a conservative upper bound so the resulting string reliably
  // fits under `budget` tokens even with dense tokenization.
  const maxChars = opts.budget * 4 - 3; // leave room for "..."
  let sliced = current.slice(0, Math.max(0, maxChars));
  const lastSpace = sliced.lastIndexOf(" ");
  // Only honor the word boundary when it's in the latter half of the
  // slice — otherwise we'd throw away too much useful content.
  if (lastSpace > Math.floor(maxChars * 0.5)) {
    sliced = sliced.slice(0, lastSpace);
  }
  sliced = sliced.trimEnd();
  let hardTruncated = sliced + "...";

  // Tokenizer can still overshoot on rare dense strings — iteratively
  // shrink by halving excess until within budget (bounded loop, max 16
  // iterations; converges fast).
  let finalTokens = countTokens(hardTruncated);
  for (let i = 0; i < 16 && finalTokens > opts.budget; i++) {
    const excessRatio = opts.budget / finalTokens;
    const newLen = Math.max(4, Math.floor(sliced.length * excessRatio));
    sliced = sliced.slice(0, newLen);
    const innerLastSpace = sliced.lastIndexOf(" ");
    if (innerLastSpace > Math.floor(newLen * 0.5)) {
      sliced = sliced.slice(0, innerLastSpace);
    }
    sliced = sliced.trimEnd();
    hardTruncated = sliced + "...";
    finalTokens = countTokens(hardTruncated);
  }

  opts.log?.warn(
    {
      agent: opts.agentName,
      budget: opts.budget,
      beforeTokens: tokens,
      afterTokens: finalTokens,
      attempts,
      section: "resume_summary",
    },
    "resume-summary hard-truncated after regeneration attempts",
  );

  return Object.freeze({
    summary: hardTruncated,
    tokens: finalTokens,
    truncated: true,
    attempts,
  });
}
