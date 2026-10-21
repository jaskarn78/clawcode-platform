/**
 * 999.63d/5 — INBOUND-PROMPT financial-topic detection.
 *
 * Purpose: gate the live activity trail (`verification.ux
 * .streamStatus`) so it appears only on turns that are plausibly
 * verification-worthy, instead of on every turn that happens to call a
 * tool before emitting text (operator feedback 2026-08-26: "that kind
 * of step by step verification shouldn't be happening on every prompt,
 * just when it is deemed necessary").
 *
 * WHY A SEPARATE CLASSIFIER — the two existing classifiers both read a
 * finished DRAFT and are wrong for a prompt:
 *   - `classifyFinancialDraft` keys on emitted figures; a question that
 *     names no dollar amount ("is he eligible to roll over yet?") is
 *     exactly the load-bearing case and carries no figures.
 *   - `classifyRuleClaims` SUPPRESSES questions by design (a draft that
 *     asks something is not asserting a rule). A user prompt is almost
 *     always a question, so that suppression inverts the signal here.
 * It also deliberately drops the modal/deontic requirement: the ASKER
 * does not have to phrase a rule claim for the ANSWER to contain one.
 *
 * The VOCABULARY, however, is single-sourced from those two modules —
 * the frozen, static-grep-pinned term lists are imported rather than
 * re-declared, so a future vocabulary edit cannot silently drift this
 * gate away from the gate that does the actual verifying.
 *
 * This is a DISPLAY gate only. It never suppresses verification, a
 * corrective hop, or a delivery — it decides whether the trail renders.
 * Failing open (trail shown) is cosmetic noise; failing closed is a
 * silent turn. Both are harmless, so the matcher favours recall.
 */

import {
  DEFAULT_TOPIC_PROFILE,
  resolveTopicProfile,
  type TopicProfile,
} from "./topic-profiles.js";

/**
 * Upper bound on the prompt text scanned. A pathological paste cannot
 * turn this into a hot loop; the topic signal, when present, is
 * overwhelmingly in the opening prose anyway.
 */
export const TOPIC_SCAN_MAX_CHARS = 8000;

/**
 * Machine-generated prompt preambles that must never arm the trail.
 * Mirrors the `system-prompt-suppressor` steer trigger added hot on
 * 2026-08-26 after the resume payloads ("## Session Continuity") were
 * observed firing the financial steer 4×.
 */
const SYSTEM_PROMPT_PREFIXES: readonly RegExp[] = Object.freeze([
  /^##\s*Session Continuity/i,
  /^#\s*Context Health Monitor/i,
]);

/**
 * Route O prepends an `<output-style>…</output-style>` block to user
 * messages. Strip it so the style text cannot supply (or mask) topic
 * vocabulary.
 */
const OUTPUT_STYLE_BLOCK = /<output-style>[\s\S]*?<\/output-style>/gi;

/** Currency / percentage shapes — same intent as the draft classifier. */
const CURRENCY_REGEX = /\$\s?\d(?:[\d,]*\d|\.\d+|[KMB])[KMB]?/;
const PERCENTAGE_REGEX = /\d+(?:\.\d+)?\s?%/;

/** Escape a literal term for safe use inside a RegExp. */
function escapeLiteral(term: string): string {
  return term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Compiled matchers for one profile. Built once per distinct profile and
 * cached — a per-agent profile must not mean recompiling a ~45-term
 * alternation on every inbound message.
 */
interface CompiledProfile {
  readonly terms: RegExp | null;
  readonly acronyms: RegExp | null;
  readonly numericShapes: boolean;
}

/**
 * Cache key. Profile name alone is not enough once `extraTerms` exist —
 * two agents can share a profile name and differ in what they added.
 */
function cacheKey(p: TopicProfile): string {
  return `${p.name}\u0000${p.terms.length}\u0000${p.acronyms.length}\u0000${p.terms.join(",")}\u0000${p.acronyms.join(",")}`;
}

const COMPILED = new Map<string, CompiledProfile>();

/** Bound the cache — agents are few, but this is fed from config/chat. */
const MAX_COMPILED_PROFILES = 64;

function compile(profile: TopicProfile): CompiledProfile {
  const key = cacheKey(profile);
  const hit = COMPILED.get(key);
  if (hit) return hit;

  // Case-insensitive, word-bounded alternation. Terms containing
  // non-word characters (`401(k)`, `72(t)`) get a looser boundary — a
  // trailing `\b` after `)` never matches.
  const terms =
    profile.terms.length === 0
      ? null
      : new RegExp(
          `(?:${profile.terms
            .map((t) => {
              const lit = escapeLiteral(t);
              const lead = /^\w/.test(t) ? "\\b" : "";
              const trail = /\w$/.test(t) ? "\\b" : "";
              return `${lead}${lit}${trail}`;
            })
            .join("|")})`,
          "i",
        );
  // Acronyms stay CASE-SENSITIVE standalone uppercase tokens (the
  // AUM/NAV precedent): `IRA` must not match the given name "Ira".
  const acronyms =
    profile.acronyms.length === 0
      ? null
      : new RegExp(
          `\\b(?:${profile.acronyms.map(escapeLiteral).join("|")})\\b`,
        );

  const compiled: CompiledProfile = {
    terms,
    acronyms,
    numericShapes: profile.numericShapes,
  };
  if (COMPILED.size >= MAX_COMPILED_PROFILES) COMPILED.clear();
  COMPILED.set(key, compiled);
  return compiled;
}

/**
 * True when an inbound prompt is on the agent's verification topic — i.e.
 * the answer is likely to carry a claim worth showing the operator the
 * checking of.
 *
 * `profile` defaults to the built-in finance profile so existing callers
 * and tests keep their behaviour. Non-throwing: any non-string input is
 * simply not a topic prompt.
 */
export function isTopicPrompt(
  prompt: unknown,
  profile: TopicProfile = resolveTopicProfile(DEFAULT_TOPIC_PROFILE),
): boolean {
  if (typeof prompt !== "string" || prompt.length === 0) return false;

  const head = prompt.slice(0, TOPIC_SCAN_MAX_CHARS);
  const trimmed = head.trimStart();
  for (const re of SYSTEM_PROMPT_PREFIXES) {
    if (re.test(trimmed)) return false;
  }

  const text = trimmed.replace(OUTPUT_STYLE_BLOCK, " ");
  if (text.trim().length === 0) return false;

  const c = compile(profile);
  return (
    (c.terms !== null && c.terms.test(text)) ||
    (c.acronyms !== null && c.acronyms.test(text)) ||
    (c.numericShapes &&
      (CURRENCY_REGEX.test(text) || PERCENTAGE_REGEX.test(text)))
  );
}
