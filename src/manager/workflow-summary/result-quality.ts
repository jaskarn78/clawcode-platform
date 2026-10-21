/**
 * INC-2026-08-14 (wf_X2SbTV) — workflow workers keep losing their findings.
 *
 * The orchestrator collects a worker's FINAL assistant message as the step
 * result. Two recurring model behaviors defeat that:
 *
 *   1. "Report delivered above - ..." — the worker wrote its full report as an
 *      INTERMEDIATE message (between tool calls) and ended the turn with a
 *      pointer to it. The report exists in the worker's own transcript and
 *      nowhere the orchestrator looks. (wf_X2SbTV step 2, 421 bytes.)
 *   2. "All four research agents are running in parallel... when they all
 *      report back I'll rank everything" — the worker ended on a STATUS
 *      narration; the promised synthesis never became a message at all.
 *      (wf_X2SbTV step 0, 949 bytes.)
 *
 * Both are recoverable by ONE corrective re-dispatch to the same worker
 * session ("print your complete findings in full, as your only message") —
 * the worker still holds its context, so case 1 recovers verbatim and case 2
 * forces the promised synthesis to actually happen.
 *
 * This module is the pure detection half. Deliberately conservative: a false
 * positive costs one cheap extra turn on a session that already exists; a
 * false negative loses research — so the thresholds lean toward retrying.
 * The orchestrator bounds it to ONE retry per worker and keeps whichever
 * result is more substantial.
 */

/** Results shorter than this are suspect regardless of wording. */
export const THIN_RESULT_CHARS = 250;

/** Meta-summary wording only matters below this size — a 5k report that
 *  HAPPENS to say "as shown above" mid-text is not a pointer, it is a report.
 *  1200, not 900: the actual wf_X2SbTV status narration was 949 bytes and the
 *  first draft of this threshold missed it — the prod fixture in the test
 *  caught that immediately. Real findings in this fleet run 5-7k chars. */
export const META_SCAN_CHARS = 1200;

const META_PATTERNS: readonly RegExp[] = [
  // Pointers at output that lives earlier in the worker's own turn.
  /\b(delivered|provided|posted|written|shown|presented|compiled|included)\b[^.]{0,40}\babove\b/i,
  /\b(report|findings|results|analysis|answer|details?)\b[^.]{0,30}\babove\b/i,
  // Mid-work status narration that leaked into the final message.
  /\brunning in parallel\b/i,
  /\bwhen (they|these|those|all)\b[^.]{0,50}\b(report|come|check) back\b/i,
  /\bI('|’)?ll (then )?(rank|compile|synthesize|assemble|deliver|merge|combine)\b/i,
  /\bwaiting (on|for)\b[^.]{0,40}\b(agents?|results?|subagents?)\b/i,
  // Completion announcements with no content behind them.
  /\b(task|research|analysis|work|step) (is )?(now )?(complete|completed|finished|done)\b[^]{0,80}$/i,
];

/**
 * True when `result` looks like a meta-summary / status narration instead of
 * actual findings — the signal to run one corrective re-dispatch.
 */
export function looksLikeMetaSummary(result: string): boolean {
  const trimmed = result.trim();
  if (trimmed.length === 0) return true;
  if (trimmed.length < THIN_RESULT_CHARS) return true;
  if (trimmed.length > META_SCAN_CHARS) return false;
  return META_PATTERNS.some((p) => p.test(trimmed));
}

/**
 * The corrective prompt. Phrased for the two observed failure shapes: the
 * worker either repeats what it already wrote (case 1) or performs the
 * synthesis it narrated about (case 2).
 */
export const CORRECTIVE_PROMPT =
  "Your previous message was a summary or status update, not the findings " +
  "themselves - the orchestrator captures ONLY your final message, so " +
  "anything you wrote earlier in the turn was not collected. Output your " +
  "complete findings NOW, in full, as this single message: every fact, " +
  "number, name, price, and caveat. Do not reference earlier output " +
  "('as shown above'), do not summarize what you did, do not describe " +
  "what is still running - if work is unfinished, report what you have " +
  "with each item's verification status.";

/**
 * Pick the better of the original and the retry. Longer wins UNLESS the
 * retry is itself meta (the model doubled down) and the original was not -
 * then keep the original. Pure, tested.
 */
export function pickBetterResult(original: string, retry: string): string {
  const retryMeta = looksLikeMetaSummary(retry);
  const originalMeta = looksLikeMetaSummary(original);
  if (retryMeta && !originalMeta) return original;
  if (!retryMeta && originalMeta) return retry;
  return retry.trim().length >= original.trim().length ? retry : original;
}

/**
 * Appended to EVERY step prompt at dispatch — the contract that prevents the
 * failure at the source. The retry above is the backstop for models that
 * ignore it.
 */
export const STEP_DELIVERY_CONTRACT =
  "\n\nDELIVERY CONTRACT: your FINAL message IS the deliverable. The " +
  "orchestrator collects only the last message of this turn - anything " +
  "written earlier (between tool calls) is NOT captured. End the turn with " +
  "the complete findings in full: every fact, figure, and caveat. Never end " +
  "with a status update, a summary of what you did, or a reference to " +
  "output 'above'.";
