/**
 * 999.63 — reply-shape measurer. PURE: text in, counts out, no I/O.
 *
 * Scores one delivered reply against the `ledger` output style
 * (src/manager/output-styles/roster.ts). The bridge logs one record per
 * reply under tag `phase999.63-shape`; scripts/client-shape-report.sh reads
 * those back from the journal. Built 2026-08-28 after measuring
 * fin-client: 42% of replies carried a paragraph over two sentences
 * (worst: 1,300-char single bullets), figures sat inside prose, and 35%
 * wrote their own `Sources:` line on top of the channel's.
 *
 * Definitions (line-based):
 *  - A fenced code block (``` ... ```) is invisible to every count except
 *    `drafts`, `tables` and `modelSourcesLine`; an unclosed fence hides the
 *    rest of the reply.
 *  - `-# ` subtext lines, `#` heading lines and `|` table rows are counted
 *    on their own and break paragraphs; they are never part of one.
 *  - A block is a run of visible lines between blank lines. Its non-bullet
 *    lines form ONE paragraph; each bullet line (`- `, `• `, `* `, `1. `)
 *    is one item, and an unmarked line after a bullet continues that item.
 *    `paragraphs` counts paragraphs only, never bullet items.
 *  - A sentence ends at `.`, `!` or `?` followed by whitespace or the end
 *    of the text (closing `**`, quotes and brackets may sit between). The
 *    abbreviations in ABBREVIATIONS never end one, and a decimal such as
 *    `1.5` never does because a digit, not whitespace, follows the point.
 *  - A label line is `Label: value`. Emphasis markers are stripped first,
 *    so `**Rate:** 5%` counts; the value must be one sentence of at most
 *    LABEL_VALUE_MAX chars, so a bold lead-in followed by prose
 *    (`**Why pre-tax:** because ... . And ...`) does NOT count. A
 *    Sources line never counts (the regex's `^[A-Z]` already rules out
 *    headings and URLs).
 *  - `figuresInProse` looks only at the non-label lines of a paragraph with
 *    two or more sentences: a figure on its own `Label: value` line is
 *    exactly what the style asks for.
 */

import { DRAFT_FENCE_RE } from "./draft-extract.js";

export interface ReplyShape {
  /** Length of the raw reply text. */
  readonly chars: number;
  /** Paragraphs: non-bullet runs in blank-line blocks, minus fences, subtext, headings, tables. */
  readonly paragraphs: number;
  /** Paragraphs with more than two sentences. */
  readonly parasOver2: number;
  /** Chars in the longest paragraph. */
  readonly longestPara: number;
  /** Bullet items with more than one sentence. */
  readonly bulletsOver1: number;
  /** Figures (`$1,234`, `12.5%`, `1,000`) inside prose lines of a paragraph of 2+ sentences. */
  readonly figuresInProse: number;
  /** Lines starting `### ` (Discord: small bold header). */
  readonly h3: number;
  /** Lines starting `# ` or `## ` (Discord: huge on a phone). */
  readonly h1h2: number;
  /** `Label: value` lines. */
  readonly labelLines: number;
  /** `-# ` subtext lines. */
  readonly subtextLines: number;
  /** True when the model wrote its own Sources/References/Citations line. */
  readonly modelSourcesLine: boolean;
  /** Closed ```draft|email|text|sms|message fences (the ones the channel posts separately). */
  readonly drafts: number;
  /** Markdown tables, counted by delimiter row (`|---`). */
  readonly tables: number;
}

const FENCE_LINE_RE = /^\s*```/;
const FENCE_TICKS_RE = /```/g;
const SUBTEXT_LINE_RE = /^\s*-#\s/;
const HEADING_LINE_RE = /^\s*#{1,6}\s/;
const H3_LINE_RE = /^\s*###\s/;
const H1H2_LINE_RE = /^\s*#{1,2}\s/;
const TABLE_ROW_RE = /^\s*\|/;
const TABLE_DELIM_RE = /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)*\|?\s*$/;
const BULLET_RE = /^\s*(?:[-*•]|\d{1,3}[.)])\s+/;
const LABEL_LINE_RE = /^[A-Z][^:\n]{1,28}: \S/;
const EMPHASIS_RE = /[*_]/g;
const SOURCES_LINE_RE = /^\s*(?:-#\s*)?[*_]{0,2}\s*(?:Sources?|References?|Citations?)\s*:/i;
const FIGURE_RE =
  /\$\s?\d[\d,]*(?:\.\d+)?(?:\s?[kKmMbB]\b)?|\d[\d,]*(?:\.\d+)?\s?%|\b\d{1,3}(?:,\d{3})+(?:\.\d+)?\b/g;
const SENTENCE_END_RE = /[.!?]+[*_"')\]]*(?=\s|$)/g;
const ABBREV_TOKEN_RE = /([A-Za-z][A-Za-z.]*)$/;
const WORD_RE = /[A-Za-z0-9]/;
/** Tokens (lower-cased, without the final point) that never end a sentence. */
const ABBREVIATIONS: ReadonlySet<string> = new Set([
  "e.g", "i.e", "u.s", "vs", "mr", "ms", "mrs", "dr", "jr", "sr",
  "rev", "proc", "pub", "sec", "a.m", "p.m", "approx",
]);
/** A `Label: value` value longer than this is a lead-in to prose, not a field. */
const LABEL_VALUE_MAX = 80;

/** Sentences in a run of text, with the abbreviation and decimal guards above. */
export function countSentences(text: string): number {
  let count = 0;
  let last = 0;
  for (const m of text.matchAll(SENTENCE_END_RE)) {
    const at = m.index ?? 0;
    const token = ABBREV_TOKEN_RE.exec(text.slice(0, at))?.[1]?.toLowerCase();
    if (token !== undefined && ABBREVIATIONS.has(token)) continue;
    const end = at + m[0].length;
    if (WORD_RE.test(text.slice(last, end))) count += 1;
    last = end;
  }
  if (WORD_RE.test(text.slice(last))) count += 1;
  return count;
}

/** `Label: value` — emphasis-stripped, value one short sentence, never a Sources line. */
export function isLabelLine(line: string): boolean {
  const plain = line.replace(EMPHASIS_RE, "").trim();
  if (!LABEL_LINE_RE.test(plain) || SOURCES_LINE_RE.test(plain)) return false;
  const value = plain.slice(plain.indexOf(": ") + 2);
  return value.length <= LABEL_VALUE_MAX && countSentences(value) <= 1;
}

/** Lines with fenced code blanked out (null); an unclosed fence hides the rest. */
function stripFences(lines: readonly string[]): readonly (string | null)[] {
  let inFence = false;
  return lines.map((line) => {
    if (FENCE_LINE_RE.test(line)) {
      const ticks = line.match(FENCE_TICKS_RE)?.length ?? 0;
      if (ticks < 2 || inFence) inFence = !inFence; // ```x``` on one line opens and closes itself
      return null;
    }
    return inFence ? null : line;
  });
}

interface BlockParts {
  readonly para: readonly string[];
  readonly bullets: readonly string[];
}

/** Split one block into its paragraph lines and its bullet items (markers stripped). */
function splitBlock(block: readonly string[]): BlockParts {
  return block.reduce<BlockParts>(
    (acc, line) => {
      const marker = BULLET_RE.exec(line);
      if (marker) return { ...acc, bullets: [...acc.bullets, line.slice(marker[0].length).trim()] };
      if (acc.bullets.length > 0) {
        const head = acc.bullets.slice(0, -1);
        const tail = acc.bullets[acc.bullets.length - 1];
        return { ...acc, bullets: [...head, `${tail} ${line.trim()}`] };
      }
      return { ...acc, para: [...acc.para, line.trim()] };
    },
    { para: [], bullets: [] },
  );
}

const countMatches = (text: string, re: RegExp): number => [...text.matchAll(re)].length;

interface Scan {
  /** Blank-line-separated blocks of visible, non-structural lines. */
  readonly blocks: readonly (readonly string[])[];
  readonly h3: number;
  readonly h1h2: number;
  readonly subtextLines: number;
}

/** One pass over the visible lines: count structural lines, group the rest into blocks. */
function scanLines(visible: readonly (string | null)[]): Scan {
  const blocks: string[][] = [];
  let block: string[] = [];
  let h3 = 0;
  let h1h2 = 0;
  let subtextLines = 0;
  const closeBlock = (): void => {
    if (block.length > 0) blocks.push(block);
    block = [];
  };
  for (const line of visible) {
    if (line === null || line.trim().length === 0 || TABLE_ROW_RE.test(line)) {
      closeBlock();
    } else if (SUBTEXT_LINE_RE.test(line)) {
      subtextLines += 1;
      closeBlock();
    } else if (HEADING_LINE_RE.test(line)) {
      if (H3_LINE_RE.test(line)) h3 += 1;
      else if (H1H2_LINE_RE.test(line)) h1h2 += 1;
      closeBlock();
    } else {
      block.push(line);
    }
  }
  closeBlock();
  return { blocks, h3, h1h2, subtextLines };
}

export function measureShape(text: string): ReplyShape {
  const lines = text.split(/\r?\n/);
  const { blocks, h3, h1h2, subtextLines } = scanLines(stripFences(lines));

  let paragraphs = 0;
  let parasOver2 = 0;
  let longestPara = 0;
  let bulletsOver1 = 0;
  let figuresInProse = 0;
  let labelLines = 0;
  for (const b of blocks) {
    const { para, bullets } = splitBlock(b);
    if (para.length > 0) {
      const prose = para.filter((l) => !isLabelLine(l));
      labelLines += para.length - prose.length;
      const body = para.join("\n");
      const sentences = countSentences(body);
      paragraphs += 1;
      longestPara = Math.max(longestPara, body.length);
      if (sentences > 2) parasOver2 += 1;
      if (sentences >= 2) figuresInProse += countMatches(prose.join("\n"), FIGURE_RE);
    }
    for (const item of bullets) if (countSentences(item) > 1) bulletsOver1 += 1;
  }

  return {
    chars: text.length,
    paragraphs,
    parasOver2,
    longestPara,
    bulletsOver1,
    figuresInProse,
    h3,
    h1h2,
    labelLines,
    subtextLines,
    modelSourcesLine: lines.some((l) => SOURCES_LINE_RE.test(l)),
    drafts: countMatches(text, DRAFT_FENCE_RE),
    tables: lines.filter((l) => l.includes("|") && TABLE_DELIM_RE.test(l)).length,
  };
}
