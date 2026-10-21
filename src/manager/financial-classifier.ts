/**
 * Phase 999.63 Plan 01 — financial-draft regex classifier.
 *
 * Pure, deterministic, dependency-free detection surface for the
 * financial-data verification enforcement gate. Scans a draft agent
 * response for finance-shaped tokens and returns a structured verdict.
 *
 * Per CONTEXT.md D3 (regex-only, haiku pre-pass deferred):
 *   - CURRENCY  — `$` followed by a digit, then a REAL currency shape:
 *                 at least one of {a second digit, a thousands
 *                 separator, a decimal, a K/M/B magnitude suffix}. A
 *                 bare `$<single-digit>` (`$1`..`$9`) is deliberately
 *                 NOT a match — it collides with shell positional
 *                 params (`$1`, `$2`). Strong signal.
 *   - PERCENTAGE — a number (optional decimal) followed by `%`.
 *                 Strong signal.
 *   - FINANCE KEYWORDS — yield / AUM / NAV / basis points / bps /
 *                 coupon / dividend. Matched WORD-BOUNDED (`\b...\b`)
 *                 so a keyword inside a larger word never matches
 *                 (`rate` inside `iterate`/`migrate`, `nav` inside
 *                 `navigate`). `yield`/`coupon`/`dividend`/`bps`/
 *                 `basis points` are case-insensitive word-bounded;
 *                 `AUM` and `NAV` are matched CASE-SENSITIVELY as
 *                 standalone UPPERCASE tokens so `navigate` /
 *                 `navigation` never match `NAV`. Strong signal.
 *   - RATE — `rate` is in the keyword set (static-grep pin) but is
 *                 CORROBORATING ONLY: a bare word-bounded `rate` never
 *                 flags a turn on its own. It is reported in
 *                 matchedTokens and counts only when a currency match,
 *                 a percentage match, OR another (non-`rate`) finance
 *                 keyword also matched.
 *   - TICKER — `\b[A-Z]{2,5}\b`. CORROBORATING ONLY: a bare ALL-CAPS
 *                 word never flags a turn on its own. A ticker is
 *                 reported in matchedTokens only when at least one
 *                 STRONG finance keyword also matched in the same
 *                 response.
 *
 * Rationale for the word-boundary + corroborating rules: finance
 * keyword substrings collide with ordinary code/ops English (`rate`
 * inside `iterate`/`generate`/`rate limit`, `nav` inside `navigate`),
 * and English ALL-CAPS words (`API`, `SDK`, `FED`, `SEC`) collide with
 * the ticker shape. Word-bounded matching plus corroborating-only
 * `rate`/ticker avoids flagging plain ops text while still catching
 * `VOO yields 1.3%` (ticker `VOO` + strong keyword `yield`).
 *
 * The classifier errs toward flagging (CONTEXT.md D3 false-positive
 * tolerance): a false positive costs one corrective re-prompt; a false
 * negative ships a stale number — the failure this phase prevents.
 *
 * Consumed by (Plan 03) `firePostTurnDetectors` financial-verification
 * gate — pure-function import, wrapped in the post-turn hook try/catch.
 */

/** Result of scanning a draft agent response for finance-shaped tokens. */
export interface FinancialClassification {
  /** True when the draft looks like it emits financial figures. */
  readonly isFinancial: boolean;
  /**
   * The specific substrings that triggered the classification. Empty
   * when isFinancial is false. Used by Plan 03's phase999.63-verify
   * telemetry payload (financialTokensDetected). Bounded to
   * MAX_MATCHED_TOKENS so a pathological response cannot bloat the log
   * line.
   */
  readonly matchedTokens: readonly string[];
}

/**
 * Upper bound on the number of distinct substrings reported in
 * `matchedTokens`. Caps the downstream telemetry log line and bounds
 * memory against an adversarial / very long draft (ReDoS-adjacent
 * threat T-999.63-01-01).
 */
export const MAX_MATCHED_TOKENS = 20;

/**
 * Canonical finance keyword set (case-insensitive match). Frozen so
 * the array cannot be mutated at runtime. Pinned by the T-01
 * static-grep regression test — a future edit that deletes a keyword
 * fails that test.
 */
export const FINANCE_KEYWORDS: readonly string[] = Object.freeze([
  "yield",
  "rate",
  "AUM",
  "NAV",
  "basis points",
  "bps",
  "coupon",
  "dividend",
]);

/**
 * CURRENCY token: `$`, optional whitespace, a leading digit, then a
 * REAL currency shape — at least one of {a run of digits/commas ending
 * in a digit, a `.` + digits, a K/M/B suffix}, with an optional
 * trailing K/M/B magnitude suffix. A bare `$<single-digit>`
 * (`$1`..`$9`) is deliberately NOT a match: it collides with shell
 * positional params. Linear-time — a single alternation of simple
 * character classes plus a bounded optional suffix, no nested
 * quantifiers (ReDoS guard).
 * Matches: `$12`, `$ 1,200`, `$1.5`, `$5M`, `$1.5M`, `$432.10`, `$1.5B`.
 * Non-matches: `$1`, `$2`, `$5`.
 */
const CURRENCY_REGEX = /\$\s?\d(?:[\d,]*\d|\.\d+|[KMB])[KMB]?/g;

/**
 * PERCENTAGE token: a number with an optional decimal, optional
 * whitespace, then `%`. Linear-time. Examples: `5%`, `4.25 %`, `0.5%`.
 */
const PERCENTAGE_REGEX = /\d+(?:\.\d+)?\s?%/g;

/**
 * TICKER token: a word-bounded run of 2–5 uppercase letters. Bounded
 * repetition — linear-time. CORROBORATING ONLY (see file header).
 */
// 2026-08-27 — was {2,5}. Two-letter matches were pure noise in prod
// telemetry (`CA`, `HQ`, `US`, `IT` reported as tickers on every re-prompt);
// real tickers that matter here are 3-5 letters. Corroborating-only either
// way, so this changes what is REPORTED, not what fires.
const TICKER_REGEX = /\b[A-Z]{3,5}\b/g;

/**
 * Collect every match of a (global) regex against `text`. `matchAll`
 * is used so there is no stateful `lastIndex` bug across calls — the
 * module-level regexes are never mutated.
 */
function collectMatches(text: string, regex: RegExp): string[] {
  const out: string[] = [];
  for (const match of text.matchAll(regex)) {
    out.push(match[0]);
  }
  return out;
}

/**
 * The corroborating-only finance keyword. `rate` is a real finance term
 * but collides too readily with ordinary code/ops English (`iterate`,
 * `generate`, `rate limit`) — so even word-bounded it never flags a
 * turn on its own. It corroborates exactly like a ticker does.
 */
const CORROBORATING_KEYWORD = "rate";

/**
 * Acronyms matched CASE-SENSITIVELY as standalone UPPERCASE tokens.
 * `\bAUM\b` / `\bNAV\b` against the ORIGINAL response (not a lowercased
 * copy) so `navigate` / `navigation` / `aum` never match.
 */
const CASE_SENSITIVE_KEYWORDS: readonly string[] = ["AUM", "NAV"];

/**
 * Escape a literal string for safe embedding in a RegExp source. The
 * canonical finance keywords contain only `[a-z ]`, so this is belt-
 * and-suspenders against a future keyword edit introducing a metachar.
 */
function escapeRegExpLiteral(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Build a word-bounded, global regex for `keyword`. Multi-word keywords
 * (`basis points`) match the whole phrase word-bounded. Linear-time —
 * a simple `\b...\b` wrapper, no nested quantifiers (ReDoS guard).
 */
function wordBoundedRegex(keyword: string, caseInsensitive: boolean): RegExp {
  return new RegExp(
    `\\b${escapeRegExpLiteral(keyword)}\\b`,
    caseInsensitive ? "gi" : "g",
  );
}

/**
 * Per-keyword precompiled word-boundary regexes — built once at module
 * load. `AUM` / `NAV` are case-sensitive; every other keyword (incl.
 * the corroborating `rate`) is case-insensitive.
 */
const KEYWORD_REGEXES: ReadonlyMap<string, RegExp> = new Map(
  FINANCE_KEYWORDS.map((keyword) => [
    keyword,
    wordBoundedRegex(
      keyword,
      !CASE_SENSITIVE_KEYWORDS.includes(keyword),
    ),
  ]),
);

/**
 * Scan a draft agent response for finance-shaped tokens.
 *
 * Pure: no I/O, no Date, no global mutation. Deterministic — the same
 * input always yields the same verdict.
 *
 * Verdict: `isFinancial` is true when a currency match OR a percentage
 * match OR a STRONG finance-keyword match is present. The corroborating
 * signals — a bare `rate` and a ticker — never flag on their own; each
 * is reported in matchedTokens only when a strong signal already fired.
 */
export function classifyFinancialDraft(response: string): FinancialClassification {
  if (typeof response !== "string" || response.length === 0) {
    return { isFinancial: false, matchedTokens: [] };
  }

  const currencyMatches = collectMatches(response, CURRENCY_REGEX);
  const percentageMatches = collectMatches(response, PERCENTAGE_REGEX);

  // Finance keywords — WORD-BOUNDED scan via precompiled per-keyword
  // regexes. `AUM`/`NAV` match case-sensitively (uppercase only);
  // every other keyword is case-insensitive. The keyword's canonical
  // form (from FINANCE_KEYWORDS) is recorded so matchedTokens is stable
  // regardless of the draft's casing. `rate` is split out as the
  // corroborating-only keyword: it never sets `isFinancial` on its own.
  const strongKeywordMatches: string[] = [];
  let rateMatched = false;
  for (const keyword of FINANCE_KEYWORDS) {
    const regex = KEYWORD_REGEXES.get(keyword);
    // `collectMatches` uses `matchAll`, which does NOT mutate the
    // regex's `lastIndex` — safe to share the precompiled regexes
    // across calls (a stateful `.test()` would leak `lastIndex`).
    if (!regex || collectMatches(response, regex).length === 0) {
      continue;
    }
    if (keyword === CORROBORATING_KEYWORD) {
      rateMatched = true;
    } else {
      strongKeywordMatches.push(keyword);
    }
  }

  // 2026-08-27 — a LONE percentage is not a financial figure. Prod sample
  // (fin-client, 24h): 40 corrective re-prompts vs 37 clean turns, the
  // measured hops ~all false positives, and the representative trigger was
  // `financialTokensDetected: ["100%","CA","ESOP","HQ"]` — one "100%" in
  // prose. A percentage counts as a strong signal only when corroborated:
  // a second distinct percentage, any currency amount, a strong keyword, or
  // the `rate` corroborator. "87% bonds at 84%" still fires; "100% sure"
  // does not.
  const distinctPercentages = new Set(percentageMatches).size;
  const percentageIsStrong =
    distinctPercentages >= 2 ||
    (distinctPercentages === 1 &&
      (currencyMatches.length > 0 ||
        strongKeywordMatches.length > 0 ||
        rateMatched));
  const hasStrongSignal =
    currencyMatches.length > 0 ||
    percentageIsStrong ||
    strongKeywordMatches.length > 0;

  if (!hasStrongSignal) {
    // No strong signal — a bare `rate` and/or a ticker cannot flag a
    // turn on their own.
    return { isFinancial: false, matchedTokens: [] };
  }

  // A strong signal fired. `rate` (if it matched, even word-bounded)
  // and tickers now corroborate and are reported in matchedTokens.
  const tickerMatches = collectMatches(response, TICKER_REGEX);
  const rateTokens = rateMatched ? [CORROBORATING_KEYWORD] : [];

  // Dedupe (preserving first-seen order) then cap at MAX_MATCHED_TOKENS.
  const deduped: string[] = [];
  const seen = new Set<string>();
  for (const token of [
    ...currencyMatches,
    ...percentageMatches,
    ...strongKeywordMatches,
    ...rateTokens,
    ...tickerMatches,
  ]) {
    if (!seen.has(token)) {
      seen.add(token);
      deduped.push(token);
    }
  }

  return {
    isFinancial: true,
    matchedTokens: Object.freeze(deduped.slice(0, MAX_MATCHED_TOKENS)),
  };
}
