/**
 * 999.63d/6 — TOPIC PROFILES.
 *
 * The activity trail arms on turns whose answer is likely to need
 * verifying. What counts as "likely" is domain-specific: fin-client
 * cares about figures and eligibility rules, a legal agent cares about
 * clauses and obligations, a general agent cares about neither.
 *
 * A profile is a named vocabulary bundle. Agents select one by name and
 * may ADD terms; they cannot remove built-in terms, and they cannot edit
 * the vocabulary used by the verification gate itself.
 *
 * WHY ADD-ONLY. The finance lists (`FINANCE_KEYWORDS`,
 * `RULE_DOMAIN_TERMS`, `RULE_DOMAIN_ACRONYMS`) are `Object.freeze`d and
 * pinned by static-grep regression tests, deliberately: a deleted keyword
 * is a real, previously-identified risk. Profiles keep that property —
 * the built-in set is the floor, config only raises it.
 *
 * SCOPE. This drives a DISPLAY decision (does the trail paint?). It is
 * deliberately NOT the vocabulary behind `classifyRuleClaims` /
 * `classifyFinancialDraft`, which feed corrective hops and gate what
 * reaches a client. Those stay code-and-config, reviewed and deployed —
 * a vocabulary that decides whether a client-facing error gets caught
 * should not be reachable from a chat message.
 */

import { FINANCE_KEYWORDS } from "./financial-classifier.js";
import {
  RULE_DOMAIN_ACRONYMS,
  RULE_DOMAIN_TERMS,
} from "./financial-rule-claim-classifier.js";

/** Built-in profile names. `none` never arms on topic. */
export const TOPIC_PROFILE_NAMES = ["finance", "legal", "none"] as const;
export type TopicProfileName = (typeof TOPIC_PROFILE_NAMES)[number];

/** Default when an agent enables the trail without naming a profile. */
export const DEFAULT_TOPIC_PROFILE: TopicProfileName = "finance";

/**
 * Caps on operator-supplied `extraTerms`. The built-in lists are frozen
 * literals; extra terms can arrive from config (and, once the slash
 * command lands, from chat), so they are bounded before being compiled
 * into a RegExp. `escapeLiteral` already neutralises metacharacters —
 * these bound the SIZE, which is the remaining ReDoS-adjacent surface.
 */
export const MAX_EXTRA_TERMS = 40;
export const MAX_TERM_CHARS = 64;

export interface TopicProfile {
  readonly name: TopicProfileName;
  /** Case-insensitive, word-bounded literals. */
  readonly terms: readonly string[];
  /** CASE-SENSITIVE standalone uppercase tokens (the AUM/NAV precedent). */
  readonly acronyms: readonly string[];
  /** Whether bare currency/percentage shapes are themselves a signal. */
  readonly numericShapes: boolean;
}

/**
 * Legal vocabulary. Same shape as finance: terms that mark an assertion
 * a reader would act on, where being wrong is expensive.
 */
const LEGAL_TERMS: readonly string[] = Object.freeze([
  "indemnif", "warrant", "liabilit", "governing law", "jurisdiction",
  "arbitration", "termination for cause", "notice period", "cure period",
  "force majeure", "confidential", "non-compete", "noncompete",
  "assignment", "severability", "limitation of liability",
  "statute of limitations", "breach", "counterparty",
  
  "effective date", "renewal term", "auto-renew", "SLA",
]);
const LEGAL_ACRONYMS: readonly string[] = Object.freeze([
  "NDA", "MSA", "SOW", "SLA", "LLC", "IP", "TOS", "DPA", "GDPR", "CCPA",
]);

const PROFILES: Readonly<Record<TopicProfileName, TopicProfile>> =
  Object.freeze({
    finance: Object.freeze({
      name: "finance" as const,
      terms: Object.freeze([...FINANCE_KEYWORDS, ...RULE_DOMAIN_TERMS]),
      acronyms: RULE_DOMAIN_ACRONYMS,
      numericShapes: true,
    }),
    legal: Object.freeze({
      name: "legal" as const,
      terms: LEGAL_TERMS,
      acronyms: LEGAL_ACRONYMS,
      // A dollar figure alone does not make a prompt a legal question.
      numericShapes: false,
    }),
    none: Object.freeze({
      name: "none" as const,
      terms: Object.freeze([]),
      acronyms: Object.freeze([]),
      numericShapes: false,
    }),
  });

/** True when `name` is a built-in profile. */
export function isTopicProfileName(name: unknown): name is TopicProfileName {
  return (
    typeof name === "string" &&
    (TOPIC_PROFILE_NAMES as readonly string[]).includes(name)
  );
}

/**
 * Resolve a profile by name, optionally widened by operator-supplied
 * terms. Unknown names fall back to the default rather than throwing —
 * this drives a cosmetic display decision, and a typo in config should
 * not take a turn down.
 *
 * Extra terms are trimmed, de-duplicated case-insensitively against the
 * built-ins, length-capped and count-capped. An extra term that is all
 * uppercase joins the ACRONYM set (case-sensitive) rather than the
 * case-insensitive term set, matching how the built-ins treat `IRA`.
 */
export function resolveTopicProfile(
  name: unknown,
  extraTerms: readonly string[] = [],
): TopicProfile {
  const base = PROFILES[isTopicProfileName(name) ? name : DEFAULT_TOPIC_PROFILE];
  if (extraTerms.length === 0) return base;

  const seen = new Set(base.terms.map((t) => t.toLowerCase()));
  const seenAcr = new Set(base.acronyms);
  const terms: string[] = [];
  const acronyms: string[] = [];
  for (const raw of extraTerms) {
    if (typeof raw !== "string") continue;
    const t = raw.trim().slice(0, MAX_TERM_CHARS).trim();
    if (t.length === 0) continue;
    if (terms.length + acronyms.length >= MAX_EXTRA_TERMS) break;
    if (/^[A-Z0-9]{2,}$/.test(t)) {
      if (!seenAcr.has(t)) {
        seenAcr.add(t);
        acronyms.push(t);
      }
      continue;
    }
    const k = t.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    terms.push(t);
  }
  if (terms.length === 0 && acronyms.length === 0) return base;
  return Object.freeze({
    name: base.name,
    terms: Object.freeze([...base.terms, ...terms]),
    acronyms: Object.freeze([...base.acronyms, ...acronyms]),
    numericShapes: base.numericShapes,
  });
}
