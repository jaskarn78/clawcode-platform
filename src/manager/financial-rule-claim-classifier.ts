/**
 * 999.63b — regulatory/eligibility rule-claim classifier (pure sibling of
 * `financial-classifier.ts`).
 *
 * The Plan 01 figure classifier answers "does this draft emit financial
 * FIGURES?" (currency / percentage / finance keywords). It is structurally
 * blind to RULE claims — "you must separate from service before rolling
 * over", "the RMD age is 73", "an ACAT transfer is not a taxable event" —
 * which carry no currency, no percentage, and no finance keyword. The
 * 2026-08-26 fin-client incident (a client-shipped 401(k)
 * separation-from-service claim that was false) is exactly that class.
 *
 * This module detects rule-shaped assertions. Deliberately a SIBLING, not
 * an extension of `classifyFinancialDraft`: the figure classifier's
 * contract is pinned by static-grep tests, and the two classes need
 * independently tunable precision postures.
 *
 * Detection (all regexes precompiled, linear-time, `matchAll` only — the
 * same ReDoS/purity discipline as the figure classifier):
 *
 *   PAIR PATH — a modal/deontic term (`must`, `cannot`, `eligible`,
 *   `penalty`, `only if`, `once you`, …) co-occurring with a domain term
 *   (`401(k)`, `IRA`, `rollover`, `annuity`, `ACAT`, `step-up`, …) within
 *   `RULE_PROXIMITY_WINDOW_CHARS`. Document-level co-occurrence would
 *   degenerate to "flag every substantive draft"; the window is the main
 *   precision device. Domain vocabulary spans BOTH retirement/tax and
 *   brokerage-procedural terms — roughly half the historical retractions
 *   (ACAT taxability, LPOA scope, fractional shares, cost-basis step-up,
 *   trust/estate) are brokerage rules, not IRS rules.
 *
 *   AGE PATH — an age-threshold shape (`59½`, `age 73`, …) plus any
 *   domain term anywhere in the draft. An age threshold IS a rule
 *   parameter, and the shape is intrinsically low-collision.
 *
 *   CITATION PATH — a legal-citation shape (`IRC §…`, `Rev. Proc.`,
 *   `Pub. 590`, …). A hallucinated citation is the scarier variant of the
 *   confident-parametric failure mode, so cited claims still flag in v1;
 *   shadow telemetry decides whether to relax this later.
 *
 * False-positive suppressions (pair path only):
 *   - `>`-quoted lines — quoted user text is not an agent assertion
 *     (match-level: quoted matches are dropped entirely).
 *   - Interrogative segments — a pair wholly inside a `?`-terminated
 *     segment is the agent ASKING, which is the desired behavior.
 *   - Primary-source-cited segments — a pair whose segment cites
 *     irs.gov / dol.gov / ssa.gov / ecfr.gov is treated as already
 *     verified. This is load-bearing: for the rules class, in-draft
 *     citation evidence co-located with the claim replaces turn-level
 *     tool presence as the "already verified" signal (turn-level tool
 *     presence is gameable by unrelated searches — the incident turn had
 *     unrelated WebSearches that would have satisfied it).
 *   - Explicit verification-delegation hedges ("confirm with your plan
 *     administrator", "check with your CPA") — verification is being
 *     handed to a human.
 *   Soft hedges (`typically`, `generally`) are deliberately NOT
 *   suppressed: a hedged eligibility claim is still load-bearing, and
 *   hedge-suppression teaches the model that hedging silences the gate.
 */

/** Result of scanning a draft for regulatory/eligibility rule assertions. */
export interface RuleClaimClassification {
  /** True when the draft asserts rule-shaped claims (see file header). */
  readonly hasRuleClaims: boolean;
  /**
   * Deduped matched substrings (modal, domain, age, citation tokens) that
   * contributed to the verdict, capped at `MAX_RULE_TOKENS`. Empty when
   * `hasRuleClaims` is false. Surfaced in phase999.63-verify telemetry.
   */
  readonly matchedRuleTokens: readonly string[];
  /**
   * 999.63d — true when at least one modal+domain pair was suppressed
   * BECAUSE its segment cites a primary source (irs.gov / dol.gov /
   * ssa.gov / ecfr.gov). This is positive evidence that the draft's rule
   * claims carry inline citations — i.e. inline verification demonstrably
   * happened — and powers the ✅ verified-inline badge. Question- and
   * delegation-suppressed pairs deliberately do NOT count: asking or
   * delegating is not verifying. Independent of `hasRuleClaims` (a draft
   * can have both cited and uncited pairs).
   */
  readonly citedRuleClaimsDetected: boolean;
}

/** Telemetry token cap — mirror of the figure classifier's MAX_MATCHED_TOKENS. */
export const MAX_RULE_TOKENS = 20;

/**
 * Max distance (chars) between a modal match and a domain match for the
 * pair to count. ~1–2 sentences: wide enough for "Once you separate from
 * Acme Corp, we open a Schwab Rollover IRA", narrow enough that a `must` in
 * one paragraph cannot pair with an `IRA` three paragraphs later.
 */
export const RULE_PROXIMITY_WINDOW_CHARS = 160;

/**
 * Domain terms matched case-INSENSITIVELY, word-bounded. Frozen + pinned
 * by the static-grep regression test (a future edit that empties the set
 * makes the classifier silently inert — the worst failure mode).
 */
export const RULE_DOMAIN_TERMS: readonly string[] = Object.freeze([
  // Retirement / tax
  "401(k)",
  "401k",
  "403(b)",
  "457(b)",
  "Roth",
  "rollover",
  "roll over",
  "annuity",
  "participation rate",
  "surrender",
  "withholding",
  "72(t)",
  "Rule of 55",
  "five-year rule",
  "5-year rule",
  "in-service",
  "contribution limit",
  "catch-up",
  "required minimum",
  "early withdrawal",
  "separation from service",
  "separate from service",
  "qualified plan",
  "pre-tax",
  "after-tax",
  "529",
  // Brokerage / estate procedural (≈half the historical retractions)
  "fractional shares",
  "cost basis",
  "step-up",
  "beneficiary",
  "trust",
  "estate",
  "probate",
  "taxable event",
]);

/**
 * Domain acronyms matched CASE-SENSITIVELY as standalone UPPERCASE tokens
 * (the AUM/NAV precedent): `IRA` must not match the given name "Ira",
 * `IRS`/`IRC`/`RMD`/`HSA`/`ACAT`/`LPOA` likewise stay uppercase-only.
 */
export const RULE_DOMAIN_ACRONYMS: readonly string[] = Object.freeze([
  "IRA",
  "RMD",
  "HSA",
  "IRS",
  "IRC",
  "ACAT",
  "LPOA",
]);

/**
 * Modal/deontic/conditional terms, case-insensitive, word-bounded.
 * Frozen + static-grep pinned.
 */
export const RULE_MODAL_TERMS: readonly string[] = Object.freeze([
  "must",
  "cannot",
  "can't",
  "can’t",
  "can only",
  "may not",
  "required",
  "requires",
  "need to",
  "have to",
  "eligible",
  "ineligible",
  "allowed",
  "allows",
  "not allowed",
  "prohibited",
  "penalty",
  "penalty-free",
  "exempt",
  "no longer",
  "only if",
  "only after",
  "only once",
  "only step",
  "once you",
  "until you",
  "before you can",
  "tax-free",
  "taxable",
  "without penalty",
  "mandatory",
  "qualifies",
  "qualify",
  "waived",
  "avoids",
  "not a taxable",
]);

/**
 * Age-threshold shapes. `59½` in its three spellings; `age <threshold>`
 * for the statutory ages. Linear-time, bounded alternations.
 */
const AGE_HALF_REGEX = /\b59\s?(?:½|1\/2\b|\.5\b)/g;
// Optional linking verb so "the RMD age is 73" matches, not only "age 73".
const AGE_THRESHOLD_REGEX =
  /\bage\s+(?:is\s+|of\s+)?(?:50|55|59|62|65|70|72|73|75)\b/gi;

/**
 * Legal-citation shapes. `IRC` stays case-sensitive (acronym rule).
 * No nested quantifiers (ReDoS guard).
 */
const CITATION_REGEXES: readonly RegExp[] = Object.freeze([
  /\bIRC\s*§/g,
  /§\s*\d/g,
  /\bRev\.\s?(?:Proc|Rul)\./g,
  /\bPub(?:lication)?\.?\s?590/g,
  /\bNotice\s+\d{4}-\d+/g,
  /\b26\s+U\.?S\.?C\.?/g,
]);

/**
 * Primary-source hosts whose in-segment citation suppresses a pair (the
 * "already verified" signal). Extend deliberately — every addition
 * weakens the gate for claims citing that host.
 */
export const PRIMARY_SOURCE_HOSTS: readonly string[] = Object.freeze([
  "irs.gov",
  "dol.gov",
  "ssa.gov",
  "ecfr.gov",
]);

const PRIMARY_SOURCE_URL_REGEX = new RegExp(
  `https?://(?:www\\.)?(?:${PRIMARY_SOURCE_HOSTS.map((h) =>
    h.replace(/\./g, "\\."),
  ).join("|")})`,
  "i",
);

/**
 * Explicit verification-delegation hedges — the draft hands verification
 * to a human/later step, so the pair in that segment is not an
 * unverified assertion. Soft hedges (`typically`, `generally`) are
 * deliberately absent (see file header).
 */
const DELEGATION_HEDGE_REGEX =
  /confirm with your|check with your plan|your CPA|plan administrator|I'll verify|I will verify|don't quote me/i;

function escapeRegExpLiteral(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Word-bounded regex for a term. Terms that start/end with a non-word
 * char (`401(k)`, `72(t)`, `step-up`) get lookaround-free guards: `\b`
 * only binds where a word char is adjacent, so leading/trailing bounds
 * are applied to the word-char ends only.
 */
function wordBoundedRegex(term: string, caseInsensitive: boolean): RegExp {
  const escaped = escapeRegExpLiteral(term);
  const lead = /^\w/.test(term) ? "\\b" : "";
  const tail = /\w$/.test(term) ? "\\b" : "";
  return new RegExp(`${lead}${escaped}${tail}`, caseInsensitive ? "gi" : "g");
}

const DOMAIN_REGEXES: ReadonlyMap<string, RegExp> = new Map([
  ...RULE_DOMAIN_TERMS.map(
    (term) => [term, wordBoundedRegex(term, true)] as const,
  ),
  ...RULE_DOMAIN_ACRONYMS.map(
    (term) => [term, wordBoundedRegex(term, false)] as const,
  ),
]);

const MODAL_REGEXES: ReadonlyMap<string, RegExp> = new Map(
  RULE_MODAL_TERMS.map((term) => [term, wordBoundedRegex(term, true)]),
);

/** A single match: its canonical token and its char offset in the draft. */
interface OffsetMatch {
  readonly token: string;
  readonly index: number;
}

function collectOffsetMatches(
  text: string,
  regexes: ReadonlyMap<string, RegExp>,
): OffsetMatch[] {
  const out: OffsetMatch[] = [];
  for (const [token, regex] of regexes) {
    for (const match of text.matchAll(regex)) {
      out.push({ token, index: match.index ?? 0 });
    }
  }
  out.sort((a, b) => a.index - b.index);
  return out;
}

/** Char ranges of `>`-quoted lines — matches inside them are dropped. */
function quotedLineRanges(text: string): Array<readonly [number, number]> {
  const ranges: Array<readonly [number, number]> = [];
  let lineStart = 0;
  for (let i = 0; i <= text.length; i++) {
    if (i === text.length || text[i] === "\n") {
      const line = text.slice(lineStart, i);
      if (/^\s*>/.test(line)) {
        ranges.push([lineStart, i] as const);
      }
      lineStart = i + 1;
    }
  }
  return ranges;
}

/**
 * A segment: a sentence-ish span with its suppression flags. Boundaries
 * are newlines and `.`/`!`/`?` followed by whitespace — cheap and
 * imperfect by design.
 */
interface Segment {
  readonly start: number;
  readonly end: number;
  readonly suppressed: boolean;
  /**
   * 999.63d — true when the suppression reason is (or includes) an
   * in-segment primary-source citation. Split out from the combined
   * `suppressed` flag so the ✅ verified-inline badge can distinguish
   * "cited" (verification evidence) from "question/delegation" (not).
   */
  readonly suppressedByCitation: boolean;
}

function segmentize(text: string): Segment[] {
  const segments: Segment[] = [];
  let start = 0;
  const pushSegment = (end: number): void => {
    if (end <= start) {
      start = end + 1;
      return;
    }
    const body = text.slice(start, end);
    const trimmed = body.trim();
    const suppressedByCitation = PRIMARY_SOURCE_URL_REGEX.test(body);
    const suppressed =
      trimmed.endsWith("?") ||
      suppressedByCitation ||
      DELEGATION_HEDGE_REGEX.test(body);
    segments.push({ start, end, suppressed, suppressedByCitation });
    start = end + 1;
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "\n") {
      pushSegment(i);
    } else if (
      (ch === "." || ch === "!" || ch === "?") &&
      (i + 1 === text.length || /\s/.test(text[i + 1] ?? ""))
    ) {
      pushSegment(i + 1);
    }
  }
  pushSegment(text.length);
  return segments;
}

function segmentIndexAt(segments: readonly Segment[], offset: number): number {
  // Segments are ordered and near-contiguous; linear scan is fine for the
  // match counts involved (bounded by MAX-token-scale inputs).
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (seg && offset >= seg.start && offset < seg.end) {
      return i;
    }
  }
  return -1;
}

function inRanges(
  ranges: readonly (readonly [number, number])[],
  offset: number,
): boolean {
  return ranges.some(([s, e]) => offset >= s && offset < e);
}

/**
 * Scan a draft agent response for rule-shaped assertions.
 *
 * Pure: no I/O, no Date, no global mutation. Deterministic.
 */
export function classifyRuleClaims(response: string): RuleClaimClassification {
  if (typeof response !== "string" || response.length === 0) {
    return {
      hasRuleClaims: false,
      matchedRuleTokens: [],
      citedRuleClaimsDetected: false,
    };
  }

  const quoted = quotedLineRanges(response);
  const domainAll = collectOffsetMatches(response, DOMAIN_REGEXES);
  // Quoted matches are excluded entirely (quoted text is not an assertion).
  const domainMatches = domainAll.filter((m) => !inRanges(quoted, m.index));

  const tokens: string[] = [];

  // PAIR PATH — modal+domain within the proximity window, minus
  // suppressed same-segment pairs. Merge-scan over the two sorted lists:
  // for each modal, examine only domain matches within the window.
  let pairFired = false;
  // 999.63d — a pair skipped because its segment carries a primary-source
  // citation is EVIDENCE of inline verification (see interface doc).
  let citedPairSeen = false;
  if (domainMatches.length > 0) {
    const modalMatches = collectOffsetMatches(response, MODAL_REGEXES).filter(
      (m) => !inRanges(quoted, m.index),
    );
    const segments = segmentize(response);
    let dLow = 0;
    for (const modal of modalMatches) {
      while (
        dLow < domainMatches.length &&
        (domainMatches[dLow]?.index ?? 0) <
          modal.index - RULE_PROXIMITY_WINDOW_CHARS
      ) {
        dLow++;
      }
      for (let d = dLow; d < domainMatches.length; d++) {
        const domain = domainMatches[d];
        if (!domain) {
          break;
        }
        if (domain.index > modal.index + RULE_PROXIMITY_WINDOW_CHARS) {
          break;
        }
        const modalSeg = segmentIndexAt(segments, modal.index);
        const domainSeg = segmentIndexAt(segments, domain.index);
        // Same-segment pairs inherit the segment's suppression (question /
        // primary-source citation / delegation hedge). Cross-segment pairs
        // count — recall-leaning by design.
        if (
          modalSeg === domainSeg &&
          modalSeg >= 0 &&
          segments[modalSeg]?.suppressed
        ) {
          if (segments[modalSeg]?.suppressedByCitation) {
            citedPairSeen = true;
          }
          continue;
        }
        pairFired = true;
        tokens.push(modal.token, domain.token);
        break;
      }
    }
  }

  // AGE PATH — an age shape plus any (unquoted) domain term anywhere.
  const ageMatches = [
    ...collectMatchStrings(response, AGE_HALF_REGEX),
    ...collectMatchStrings(response, AGE_THRESHOLD_REGEX),
  ];
  const ageFired = ageMatches.length > 0 && domainMatches.length > 0;
  if (ageFired) {
    tokens.push(...ageMatches);
  }

  // CITATION PATH — legal-citation shapes flag unconditionally in v1.
  const citationMatches = CITATION_REGEXES.flatMap((regex) =>
    collectMatchStrings(response, regex),
  );
  const citationFired = citationMatches.length > 0;
  if (citationFired) {
    tokens.push(...citationMatches);
  }

  const hasRuleClaims = pairFired || ageFired || citationFired;
  if (!hasRuleClaims) {
    return {
      hasRuleClaims: false,
      matchedRuleTokens: [],
      citedRuleClaimsDetected: citedPairSeen,
    };
  }

  const deduped: string[] = [];
  const seen = new Set<string>();
  for (const token of tokens) {
    if (!seen.has(token)) {
      seen.add(token);
      deduped.push(token);
    }
  }
  return {
    hasRuleClaims: true,
    matchedRuleTokens: Object.freeze(deduped.slice(0, MAX_RULE_TOKENS)),
    citedRuleClaimsDetected: citedPairSeen,
  };
}

function collectMatchStrings(text: string, regex: RegExp): string[] {
  const out: string[] = [];
  for (const match of text.matchAll(regex)) {
    out.push(match[0]);
  }
  return out;
}
