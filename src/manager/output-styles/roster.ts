/**
 * 999.105 — the output-style roster.
 *
 * DESIGN FILTER (load-bearing): a style may prescribe FORM — order, length,
 * structure, evidence, readability. It may NEVER prescribe voice, persona, or
 * affect. Soul wins on personality. This filter is why most of the community
 * corpus was rejected: the popular collections are dominated by novelty
 * personas (Zen Master, Haiku Helper, Tabloid Journalist) which would fight
 * every agent's soul.
 *
 * Second filter: each style moves a DIFFERENT axis, so no two share a
 * one-liner. Styles researched 2026-08-14 against the credited-methodology
 * collection (github.com/smixs/awesome-claude-output-styles, 19 styles) and
 * the novelty collection (hesreallyhim/awesome-claude-code-output-styles);
 * three earned inclusion, the rest were collapsed or rejected — reasons in
 * the phase doc.
 *
 * Every block is ≤120 words. The overlay injects one per turn (Route O), so
 * block size is a per-turn token cost that accumulates in the transcript —
 * the 999.105 plan §3 trade, taken knowingly.
 *
 * `default` deliberately has NO block: it must never inject "be default",
 * which would cost tokens forever and make the true baseline unreachable.
 */

import { outputStyleSchema } from "../../config/schema.js";

/** Derived from the config enum - the single source of truth. */
export const OUTPUT_STYLE_IDS = outputStyleSchema.options;

export type OutputStyleId = (typeof OUTPUT_STYLE_IDS)[number];

export interface OutputStyleDef {
  readonly id: OutputStyleId;
  /** The axis this style moves — used in /clawcode-style choice labels. */
  readonly axis: string;
  /** One-line selector description (Discord choice label, ≤80 chars). */
  readonly line: string;
  /** The per-turn instruction block. Absent for `default`. */
  readonly block?: string;
}

export const OUTPUT_STYLES: readonly OutputStyleDef[] = [
  {
    id: "default",
    axis: "-",
    line: "Clear the style override - agent's natural form",
  },
  {
    id: "bluf",
    axis: "ORDER",
    line: "Answer or decision first, supporting detail after",
    // BLUF is an ORDER rule, not a length rule (AR 25-50). The bottom line is
    // the decisive moment of the argument, not a summary. Reasoning is KEPT,
    // just moved after the answer.
    block:
      "Style: BLUF (bottom line up front). Open with the answer, decision, or " +
      "request - the single sentence the reader must not miss - before any " +
      "background. Optionally tag it: ACTION / DECISION / REQUEST / INFO. Keep " +
      "your reasoning and detail, but place ALL of it after the bottom line. " +
      "No preamble, no scene-setting before the answer. This governs ordering " +
      "only; how much you write is governed by your own length rules, not by " +
      "this style.",
    // 2026-08-27 — the previous closing clause ("do not shorten or omit
    // content because of it") was measured on fin-client overriding the
    // agent's SOUL length rules: the overlay is the LAST instruction the model
    // reads each turn, so its "do not shorten" beat the SOUL's "one-line asks
    // get <=300 chars" on 16 of 16 short asks (median reply 2,282 chars). An
    // ORDER rule must stay neutral on length.
  },
  {
    id: "bluf-brief",
    axis: "ORDER+LENGTH",
    line: "Answer first, then only the words that carry the information",
    // Composite, because the roster is one-style-per-agent and operators
    // were forced to choose between answer-first and short. Same two
    // blocks, fused; each half keeps its own guardrail (BLUF never
    // omits the reasoning that matters; brief never omits a needed
    // fact, number, or caveat).
    block:
      "Style: BLUF + brief. Open with the answer, decision, or request - the " +
      "single sentence the reader must not miss - before any background. " +
      "Then use the fewest words that carry the information: no preamble, no " +
      "recap of the question, no closing summary, no offers of further help, " +
      "no narration of what you did. A one-line ask gets a one-line answer. " +
      "Prefer a tight list over prose only when there are 3+ distinct items. " +
      "Cut hedges and qualifiers unless the uncertainty is the point. Never " +
      "omit a fact, number, source, or caveat the reader needs - brevity comes " +
      "from cutting words, not content.",
  },
  {
    id: "proportional",
    axis: "PROPORTION",
    line: "Answer first; figures on their own lines; ### per part; asides as subtext",
    // 2026-08-27 — built for fin-client after measuring its channel: 22
    // of 31 replies carried NO heading, bullet or list, the average longest
    // paragraph was 513 chars and one ran 1,908. Cause was a gate keyed on
    // ITEM COUNT ("lists only when 3+ distinct items") present in BOTH the
    // agent's SOUL and the `bluf-brief` block — so a 1,900-char answer about
    // two things was instructed to be plain prose.
    //
    // Distinct from `smart-brevity` (SCANNABILITY), which imposes a fixed
    // Axios template (lead / Why it matters / Go deeper). This one prescribes
    // no sections at all — only that form scale with size.
    //
    // The final clause is load-bearing. This axis touches LENGTH, and the last
    // clause here that strayed into length ("do not shorten or omit content")
    // overrode the agent's own brevity rules on 16 of 16 short asks and pushed
    // the median reply to 2,282 chars. "Structure rearranges words; it never
    // adds them" is the guard against re-earning that.
    // 2026-08-28 — shape rules fixed with the operator (a contact record had
    // shipped as one run-on sentence): records -> one field per line, fact
    // lists -> one bullet each, long form -> bold section leads and NO `##`
    // (Discord renders them huge on a phone), asides -> `-#` at the bottom,
    // client drafts -> a ```draft fence the daemon posts as its own message.
    // 2026-08-28 (2) — `###` headings ARE used for multi-part answers: Discord
    // renders H3 as a small bold header on phone and desktop (H1/H2 are the
    // ones that render huge), and figures-in-prose was the remaining habit.
    block:
      "Style: proportional. Open with the answer in one bold sentence, " +
      "alone. Then only words that carry information: no " +
      "preamble, no recap, no summary, no offers. A one-line ask gets a " +
      "one-line answer. A figure never hides in a sentence: it gets its " +
      "own `Label: value` line or its own bullet, bold. Facts about one " +
      "thing go one field per line; separate facts one bullet each. An " +
      "answer with several parts gets a `###` heading per part (never " +
      "`#` or `##`), with lines or bullets under it and no paragraph over " +
      "two sentences. Asides sit at the bottom on `-#` lines. Anything a " +
      "client will receive goes verbatim inside a ```draft fence. " +
      "Structure rearranges words; it never adds them.",
  },
  {
    id: "ledger",
    axis: "SHAPE",
    line: "Bold answer line; figures and facts one per line; ### per part; -# asides",
    // 2026-08-28 — built for fin-client after measuring the channel
    // under `proportional`: 42% of replies still carried a paragraph over
    // two sentences (the worst were 1,300-char single bullets), figures sat
    // inside prose, and 35% wrote their own `Sources:` line on top of the
    // one the channel appends.
    //
    // `proportional` fuses a LENGTH half ("only words that carry
    // information", "one-line ask gets a one-line answer") with its shape
    // rules. This one is the body shape ALONE, written as per-line rules the
    // measurer in src/discord/reply-shape.ts can score: one sentence per
    // bullet, one field per line, `###` per part, `-#` asides, never a
    // Sources line. Length stays with the agent's own SOUL rules.
    block:
      "Style: ledger. Open with the answer in one bold sentence, alone. A " +
      "figure never sits inside a sentence: it gets its own `Label: value` " +
      "line or its own bullet, bold. Facts about one thing go one field per " +
      "line. Separate facts go one bullet each, one sentence per bullet. An " +
      "answer with two or more parts gets a `###` heading per part (never " +
      "`#` or `##`), with lines or bullets under it and no paragraph over " +
      "two sentences. Asides and caveats sit at the bottom on `-#` lines. " +
      "Anything a client will receive goes verbatim inside a ```draft " +
      "fence. Never write a Sources line; the channel appends one. " +
      "Structure rearranges words; it never adds them.",
  },
  {
    id: "brief",
    axis: "LENGTH",
    line: "Fewest words that carry the information",
    block:
      "Style: brief. Use the fewest words that carry the information. No " +
      "preamble, no recap of the question, no closing summary, no offers of " +
      "further help. Prefer a tight list over prose when listing. Cut hedges " +
      "and qualifiers unless the uncertainty is the point. Never omit a fact, " +
      "number, or caveat the reader needs - brevity comes from cutting " +
      "packaging, not information.",
  },
  {
    id: "smart-brevity",
    axis: "SCANNABILITY",
    // Axios Smart Brevity (VandeHei/Allen/Schwartz) - added 2026-08-14 from
    // the credited-methodology collection. Distinct from `brief` (pure length)
    // and `bluf` (pure order): it prescribes a named three-part STRUCTURE.
    line: "Axios-style: one-line lead, Why it matters, Go deeper",
    block:
      "Style: Smart Brevity (Axios). Structure every substantive reply as: " +
      "(1) a bold one-sentence lead with the single most important fact; " +
      "(2) a short section starting exactly '**Why it matters:**' giving the " +
      "consequence for the reader; (3) optionally '**Go deeper:**' with " +
      "supporting detail, tight bullets over prose. Trivial replies (one-line " +
      "answers, acknowledgements) are exempt - do not inflate them to fit the " +
      "template. This governs structure only.",
  },
  {
    id: "steps",
    axis: "ACTIONABILITY",
    // Adapted from the collection's action-first pattern (credited to
    // ADHD-communication research): verbs first, numbered, bounded lists.
    line: "Action-first: numbered steps, each starting with a verb",
    block:
      "Style: steps. When the reply involves anything the reader could do, " +
      "lead with a numbered list of concrete actions - each step starts with " +
      "an imperative verb and fits on one line, at most 7 steps (split into " +
      "phases beyond that). Detail and rationale go under or after the list, " +
      "never woven into it. Purely informational replies (no action to take) " +
      "are exempt. This governs structure only - every step must still be " +
      "complete and correct.",
  },
  {
    id: "plain",
    axis: "READABILITY",
    // ASD-STE100 Simplified Technical English (aerospace, 1983) - added
    // 2026-08-14. Distinct from `brief`: a long reply can be plain, a short
    // one can be jargon-dense. Earns its slot from the fleet's non-technical
    // surfaces (health coaching, household).
    line: "Simplified Technical English: short sentences, no jargon",
    block:
      "Style: plain English (after ASD-STE100). Sentences of at most 20 " +
      "words. Active voice. One idea per sentence. Use the same word for the " +
      "same thing every time - no elegant variation. Replace jargon with the " +
      "everyday word when one exists; when a technical term is necessary, " +
      "define it in the same sentence. Numbers stay exact. This governs " +
      "wording only - do not simplify the substance, only the language.",
  },
  {
    id: "explanatory",
    axis: "PEDAGOGY",
    line: "Answers, then a short Insight on why it works that way",
    block:
      "Style: explanatory. Answer first, as normal. Then add one short " +
      "section starting exactly '**Insight:**' that explains WHY - the " +
      "mechanism, principle, or trade-off behind the answer, in 2-4 " +
      "sentences. One insight per reply, chosen for what the reader most " +
      "likely doesn't know. Skip the section when the reply is trivial or " +
      "purely operational. This adds a section; it changes nothing else.",
  },
  {
    id: "sourced",
    axis: "RIGOR",
    line: "Every claim carries its number, source, and as-of date",
    block:
      "Style: sourced. Every factual claim carries its evidence inline: the " +
      "number, where it came from (file, command output, API, publication), " +
      "and when it was true (as-of date or 'just measured'). Distinguish " +
      "MEASURED (you ran it), REPORTED (a source says it), and ASSUMED " +
      "(unverified) - never present one as another. A claim you cannot " +
      "source, label explicitly as unsourced. This governs evidence " +
      "presentation only.",
  },
  {
    id: "proactive",
    axis: "AUTONOMY",
    // Half-fails the form-not-voice filter (changes WHEN the agent asks, not
    // how output is shaped). Kept per the 999.105 gate decision; every
    // permission gate still applies - this changes defaults, not rights.
    line: "Acts on reasonable defaults and reports, instead of asking",
    block:
      "Style: proactive. When a request is ambiguous in a way a careful " +
      "colleague could resolve with a reasonable default, act on that default " +
      "and state it in one line ('Assumed X; say the word to redo with Y') " +
      "instead of stopping to ask. Still ask when choices are destructive, " +
      "irreversible, expensive, or would produce materially different work. " +
      "All permission and safety gates apply unchanged - this governs " +
      "clarifying questions only.",
  },
];

/** Lookup by id. `default` returns a def with no block. */
export function getOutputStyle(id: string): OutputStyleDef | undefined {
  return OUTPUT_STYLES.find((s) => s.id === id);
}

/**
 * Wrap a style block for per-turn injection. The tag delimits the overlay so
 * transcript readers (and the model) can see where instruction ends and the
 * user's message begins - same convention as <memory-context>.
 */
export function renderStyleOverlay(id: OutputStyleId): string | null {
  const def = getOutputStyle(id);
  if (!def?.block) return null;
  return `<output-style>\n${def.block}\n</output-style>\n\n`;
}
