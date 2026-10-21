/**
 * Guards consolidation summarize output against API error strings.
 *
 * When dispatchTurn hits credit/rate/auth errors it returns the error
 * text as the completion string rather than throwing. Without this guard
 * the consolidation worker writes those strings verbatim as digest content.
 *
 * Intentionally separate from restart-greeting's API_ERROR_FINGERPRINTS,
 * which checks session turn domination (% of turns). This module checks
 * whether a single LLM output string is UNUSABLE as digest content —
 * either an error response, or absent/degenerate output.
 *
 * 2026-08-28 (Phase 999.113 WS-5) — the absent case was missing and it was
 * the dangerous one. `summarizeWithHaiku` returns "" on any bridge failure
 * (`summarize-with-haiku.ts`, and the bridge has been failing ~240x/week),
 * "" matched none of the patterns below, and `runConsolidation` then wrote a
 * digest with an EMPTY body and archived — `rename`d — that week's live daily
 * logs in exchange for it. The header of `summarize-with-haiku.ts` already
 * asserted "consolidation pipeline already treats empty -> skip via
 * isErrorSummary"; this makes that documented contract true instead of false.
 */

/**
 * Shortest output accepted as a real summary. A weekly digest is built from a
 * week of daily logs; anything under this is truncation or a stub, and
 * archiving live memory in exchange for it is the same data loss as the empty
 * case with extra steps.
 */
export const MIN_USABLE_SUMMARY_CHARS = 24;

const SUMMARY_ERROR_PATTERNS: readonly RegExp[] = [
  /\bCredit balance is too low\b/i,
  /\bAPI Error:\s*\d{3}\b/i,
  /\bFailed to authenticate\b/i,
  /\bpermission_error\b/i,
  /\brate_limit_error\b/i,
  /\bauthentication_error\b/i,
  /\bauthentication error\b/i,
  /\bnot a member of the organization\b/i,
  /\b(401|403|429|500|502|503|529)\s+error\b/i,
];

/**
 * Returns true if the LLM summary output appears to be an API error string
 * rather than a valid summary. Used to prevent error text from being
 * persisted as digest content.
 */
export function isErrorSummary(text: string): boolean {
  // Absent / degenerate output first: it is the failure mode that reaches
  // here most often (every bridge failure returns "") and the only one whose
  // consequence is destructive rather than cosmetic.
  if (typeof text !== "string" || text.trim().length < MIN_USABLE_SUMMARY_CHARS) {
    return true;
  }
  return SUMMARY_ERROR_PATTERNS.some((p) => p.test(text));
}
