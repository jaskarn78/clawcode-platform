/**
 * summarizeWithHaiku — production SummarizeFn for SessionSummarizer.
 *
 * Delegates to callHaikuDirect (haiku-direct.ts) which uses @anthropic-ai/sdk
 * directly with the OAuth Bearer token from ~/.claude/.credentials.json.
 * This avoids the sdk.query() subprocess path that inherits ANTHROPIC_API_KEY
 * from /etc/clawcode/env and would bill the API key account instead of the
 * OAuth subscription.
 *
 * Signature matches `SummarizeFn` from src/memory/session-summarizer.types.ts
 * so it can be passed directly as deps.summarize to summarizeSession.
 */

import { callHaikuDirect } from "./haiku-direct.js";
import { logger } from "../shared/logger.js";

const SUMMARIZE_SYSTEM_PROMPT =
  "You are a concise summarizer. Respond with only the requested markdown sections. Do not add commentary outside the requested structure.";

/**
 * Runs a one-shot Haiku call for session summarization via direct OAuth auth.
 *
 * Phase 115 sub-scope 999.41 carve-out — fail-loud guard. When callHaikuDirect
 * throws OR returns an empty string, we now emit a daemon-side
 * `[diag] summary-fail-loud` log with `component: "summarize-with-haiku"` and
 * `action: "summary-failed"` so silent rolling-summary failures are operator-
 * visible. Empty returns (the original silent-fail mode) still produce an
 * empty string for backward compat with downstream callers (consolidation
 * pipeline already treats empty → skip via isErrorSummary).
 *
 * 🚨 2026-08-28 (Phase 999.113 WS-5): that parenthetical was FALSE for two
 * years — `isErrorSummary` matched only API-error phrases, so "" sailed
 * through and `runConsolidation` wrote an empty digest and then archived
 * (renamed) the week's live daily logs in exchange for it. The guard now
 * rejects blank/degenerate output, which is what finally makes this sentence
 * true. If you change either side, change both.
 *
 * @param prompt   The fully-built summarization prompt.
 * @param opts     Caller-supplied abort signal.
 * @returns        The result text, or empty string on failure.
 */
export async function summarizeWithHaiku(
  prompt: string,
  opts: { readonly signal?: AbortSignal },
): Promise<string> {
  try {
    // Phase 999.58 C7 — site tag for phase999.58-haiku-direct telemetry
    // attribution. Matches the callHaikuDirect default of "summarizer"
    // but explicit pays off if the default ever changes.
    const result = await callHaikuDirect(
      SUMMARIZE_SYSTEM_PROMPT,
      prompt,
      opts,
      "summarizer",
    );
    if (typeof result !== "string" || result.length === 0) {
      // Empty / non-string returns from callHaikuDirect were previously
      // silent-fail modes — sub-scope 999.41 makes them log-loud so the
      // operator + run-log surface the underlying failure.
      logger.error(
        {
          component: "summarize-with-haiku",
          action: "summary-failed",
          reason: "empty-or-non-string-result",
          promptChars: prompt.length,
        },
        "[diag] summary-fail-loud",
      );
      return "";
    }
    return result;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    logger.error(
      {
        component: "summarize-with-haiku",
        action: "summary-failed",
        reason: reason.length > 200 ? reason.slice(0, 200) : reason,
        promptChars: prompt.length,
      },
      "[diag] summary-fail-loud",
    );
    // Preserve back-compat: callers (consolidation pipeline) check the
    // returned text via isErrorSummary; an empty string is the well-known
    // "skip this cycle" signal. Re-throwing here would break that contract.
    return "";
  }
}

/** Test-only: kept for backward compat — no SDK cache to reset in this module. */
export function _resetSdkCacheForTests(): void {
  // no-op
}
