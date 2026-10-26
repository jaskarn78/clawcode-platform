/**
 * Phase 90 MEM-02 — pure chunker + path-weighter + time-window filter.
 *
 * Splits workspace memory/*.md content on H2 boundaries (## headings).
 * Memory overhaul WP2 (2026-10-25): a section longer than about 220 words
 * is split into parts headed "<heading> (part n/N)" so a part fits
 * bge-small's 350-word window whole and MiniLM's 200-word window nearly
 * whole, and a fact in the last paragraph of a long section is still
 * reachable by vector search.
 * Files with only H1/body become a single chunk (or several parts, all
 * with a null heading so the renderer falls back to the file path). Empty /
 * whitespace-only content → zero chunks.
 *
 * Pure functions — no I/O, no mutation of inputs. DI-friendly for the
 * MemoryScanner (Plan 90-02 Task 1) and retrieval time-window gate
 * (Plan 90-02 Task 2).
 */

/**
 * Rough token-per-character estimate used by the chunker. 4 chars ≈ 1 token
 * in English prose; inverse is 0.25 token/char. Matches the retrieval
 * token-budget math in memory-retrieval.ts.
 */
const TOKEN_PER_CHAR = 0.25;

/** Rough words per token, used to turn the legacy token cap into a word cap. */
const WORDS_PER_TOKEN = 0.75;

/** Default soft cap per chunk. Exported for test visibility. */
export const DEFAULT_MAX_TOKENS = 800;

/** Hard cap ratio over soft — chunk is split if tokenCount > MAX_TOKENS * 1.25. */
const HARD_CAP_RATIO = 1.25;

/**
 * WP2: a section (or headless file) longer than this many words is split
 * into parts. bge-small (v2) embeds up to 350 words, so a part plus the
 * heading line the scanner prepends is embedded whole; MiniLM (v1) stops at
 * 200 words because its window is 256 tokens, so on v1 only the last few
 * words of a full part fall outside the vector (FTS still indexes them).
 */
export const DEFAULT_MAX_WORDS_PER_PART = 220;

/**
 * WP2: version of the chunking rules. The scanner skips a file whose
 * sha256 is unchanged, so files indexed by the pre-WP2 chunker keep their
 * long, partly-unembedded chunks until they change. A scanner that folds
 * this value into its skip check re-chunks them once (memory-scanner.ts is
 * owned by another package; exported for it).
 */
export const MEMORY_CHUNKER_VERSION = 2;

export type MemoryChunk = Readonly<{
  heading: string | null;
  body: string;
  tokenCount: number;
  /** Always 0 at chunker output — scanner applies path-derived weight later. */
  scoreWeight: number;
}>;

/** WP2: `"Heading (part 2/5)"` → `"Heading"`; other headings unchanged. */
export function stripPartSuffix(heading: string | null): string | null {
  if (heading === null) return null;
  return heading.replace(/\s\(part \d+\/\d+\)$/, "");
}

/**
 * Split markdown content on H2 (##) boundaries. Content preceding the first
 * H2 is discarded (typically just the H1 title). Oversized sections are
 * split into parts of at most `maxWordsPerPart` words on paragraph, then
 * line, then sentence boundaries; every part keeps the section heading
 * with a "(part n/N)" suffix. Parts of a file with no H2 keep a null
 * heading (as the pre-WP2 paragraph split did).
 *
 * Phase 90 D-20 — H2 is the canonical boundary for memory/*.md. H3/H4 are
 * treated as body content within their parent H2.
 *
 * `maxTokens` is kept for signature compatibility: it still bounds a part
 * (converted to words) when a caller passes a cap tighter than
 * `maxWordsPerPart`.
 */
export function chunkMarkdownByH2(
  content: string,
  maxTokens: number = DEFAULT_MAX_TOKENS,
  maxWordsPerPart: number = DEFAULT_MAX_WORDS_PER_PART,
): readonly MemoryChunk[] {
  const maxWords = Math.max(
    1,
    Math.min(maxWordsPerPart, Math.floor(maxTokens * HARD_CAP_RATIO * WORDS_PER_TOKEN)),
  );
  const chunks: MemoryChunk[] = [];

  const emit = (heading: string | null, body: string): void => {
    const parts = splitIntoParts(body, maxWords);
    const total = parts.length;
    parts.forEach((part, i) => {
      const partHeading =
        total === 1 || heading === null ? heading : `${heading} (part ${i + 1}/${total})`;
      chunks.push({
        heading: partHeading,
        body: part,
        tokenCount: Math.ceil(part.length * TOKEN_PER_CHAR),
        scoreWeight: 0,
      });
    });
  };

  // Two-pass: decide if any H2 boundaries exist. If so, all content before
  // the first H2 is discarded (typically the document's H1 title + preamble).
  // If not, the entire content becomes one chunk (or its parts) with null heading.
  const hasH2 = /^##\s+/m.test(content);

  if (!hasH2) {
    const trimmed = content.trim();
    if (trimmed.length === 0) return Object.freeze(chunks);
    emit(null, trimmed);
    return Object.freeze(chunks);
  }

  const lines = content.split("\n");
  let currentHeading: string | null = null;
  let currentBody: string[] = [];
  let seenFirstH2 = false;

  const flush = () => {
    // Skip the pre-H2 region — we only emit chunks for H2-anchored sections.
    if (!seenFirstH2) return;
    const body = currentBody.join("\n").trim();
    if (body.length === 0) return;
    emit(currentHeading, body);
  };

  for (const line of lines) {
    const m = /^##\s+(.+)/.exec(line);
    if (m) {
      flush();
      currentHeading = m[1].trim();
      currentBody = [];
      seenFirstH2 = true;
    } else {
      currentBody.push(line);
    }
  }
  flush();

  return Object.freeze(chunks);
}

function wordCount(text: string): number {
  const t = text.trim();
  return t.length === 0 ? 0 : t.split(/\s+/).length;
}

/**
 * WP2: split `text` into parts of at most `maxWords` words. Paragraphs
 * (blank-line separated) are packed greedily; a paragraph that is itself
 * too long is split on lines (bullet lists), then sentences, then as a last
 * resort on fixed word windows. Pure helper, no state, no I/O.
 */
export function splitIntoParts(text: string, maxWords: number): readonly string[] {
  const trimmed = text.trim();
  if (trimmed.length === 0) return [];
  if (wordCount(trimmed) <= maxWords) return [trimmed];
  const units = trimmed
    .split(/\n\n+/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
    .flatMap((p) => (wordCount(p) > maxWords ? splitLongParagraph(p, maxWords) : [p]));
  return pack(units, maxWords, "\n\n");
}

function splitLongParagraph(paragraph: string, maxWords: number): readonly string[] {
  const lines = paragraph.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
  if (lines.length > 1) {
    const units = lines.flatMap((l) => (wordCount(l) > maxWords ? splitLongLine(l, maxWords) : [l]));
    return pack(units, maxWords, "\n");
  }
  return splitLongLine(paragraph, maxWords);
}

function splitLongLine(line: string, maxWords: number): readonly string[] {
  const sentences = line.split(/(?<=[.!?])\s+/).filter((s) => s.length > 0);
  const units = sentences.flatMap((s) => (wordCount(s) > maxWords ? windowWords(s, maxWords) : [s]));
  return pack(units, maxWords, " ");
}

function windowWords(text: string, maxWords: number): readonly string[] {
  const words = text.trim().split(/\s+/);
  const out: string[] = [];
  for (let i = 0; i < words.length; i += maxWords) {
    out.push(words.slice(i, i + maxWords).join(" "));
  }
  return out;
}

/** Greedy packing of units into parts of at most `maxWords` words. */
function pack(units: readonly string[], maxWords: number, joiner: string): readonly string[] {
  const parts: string[] = [];
  let buf = "";
  let bufWords = 0;
  for (const unit of units) {
    const n = wordCount(unit);
    if (bufWords > 0 && bufWords + n > maxWords) {
      parts.push(buf);
      buf = "";
      bufWords = 0;
    }
    buf = buf.length > 0 ? `${buf}${joiner}${unit}` : unit;
    bufWords += n;
  }
  if (buf.trim().length > 0) parts.push(buf);
  return parts;
}

/**
 * Phase 90 D-19, path-derived retrieval-ranking weight. Multiplies the RRF
 * fused score at hydration time (memory-retrieval.ts: fused * (1 + weight),
 * memory overhaul WP2). Vault content (standing rules) ranks a little
 * higher; archive content (old session logs) a little lower. Dated files at
 * the memory/ root default to neutral.
 *
 * Weights are small (±0.2) so they nudge, not dominate: the multiplier stays
 * within [0.8, 1.2] of the relevance score. (Pre-WP2 they were ADDED to the
 * RRF score, whose range is roughly [0, 0.033] per ranker, and therefore
 * decided the order outright.)
 */
export function scoreWeightForPath(absPath: string): number {
  if (absPath.includes("/memory/vault/")) return 0.2;
  if (absPath.includes("/memory/procedures/")) return 0.1;
  if (absPath.includes("/memory/archive/")) return -0.2;
  return 0.0;
}

/**
 * Phase 90 D-24 — time-window filter. Dated memory/*.md files older than
 * `days` are dropped. Files under vault/ or procedures/ survive all-time
 * regardless of mtime (they're standing rules / runbooks, not dated session
 * notes).
 *
 * Additionally, paths beginning with `document:` are exempted (Phase 101 U6
 * cross-ingest — documents survive the standard expiry because they're
 * operator-curated artifacts, not session notes). CF-1 fix.
 *
 * WP2: retrieval applies this only when called with `timeWindowMode:
 * "hard"`; the default is a soft recency multiplier (see
 * memory-retrieval.ts softRecencyFactor). Still exported and used.
 *
 * `now` defaulted to Date.now() for production; tests pass a fixed epoch to
 * make assertions deterministic.
 */
export function applyTimeWindowFilter<
  T extends { path: string; file_mtime_ms: number },
>(chunks: readonly T[], days: number, now: number = Date.now()): readonly T[] {
  // Phase 999.187 — `days <= 0` means "no window": the lazy
  // `clawcode_memory_search` tool exists for older context, so it must not
  // silently hide everything older than two weeks.
  if (!(days > 0)) return chunks;
  const cutoff = now - days * 86_400_000;
  return chunks.filter((c) => {
    if (isStandingMemoryPath(c.path)) return true;
    return c.file_mtime_ms >= cutoff;
  });
}

/**
 * Phase 999.187 — paths that hold STANDING memory and therefore survive the
 * dated-file time window regardless of mtime:
 *   - `memory/vault/` and `memory/procedures/` (Phase 90 D-24: rules, runbooks);
 *   - `document:` cross-ingested documents (Phase 101 CF-1);
 *   - "remember this" cue files (`…-remember-<id>.md`, Phase 90 MEM-05). A
 *     user who says "remember this: standing rule" expects it to hold. Until
 *     999.187 these expired from EVERY retrieval path after 14 days and were
 *     never consolidated either (consolidation only reads `YYYY-MM-DD.md`);
 *   - `memory/digests/` weekly and monthly digests — the consolidated record
 *     of everything older than the window, which is exactly what "older
 *     context" means.
 */
export function isStandingMemoryPath(path: string): boolean {
  if (path.startsWith("document:")) return true;
  if (path.includes("/memory/vault/")) return true;
  if (path.includes("/memory/procedures/")) return true;
  if (path.includes("/memory/digests/")) return true;
  if (CUE_FILE_RE.test(path)) return true;
  return false;
}

/** `YYYY-MM-DD-remember-<nanoid4>.md` as written by memory-cue.ts. */
const CUE_FILE_RE = /\/\d{4}-\d{2}-\d{2}-remember-[A-Za-z0-9_-]+\.md$/;
