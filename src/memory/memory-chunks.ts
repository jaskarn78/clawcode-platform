/**
 * Phase 90 MEM-02 — pure chunker + path-weighter + time-window filter.
 *
 * Splits workspace memory/*.md content on H2 boundaries (## headings) with
 * a soft token cap (default 800, hard cap 1000). Files with only H1/body
 * become a single chunk. Empty / whitespace-only content → zero chunks.
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

/** Default soft cap per chunk. Exported for test visibility. */
export const DEFAULT_MAX_TOKENS = 800;

/** Hard cap ratio over soft — chunk is split if tokenCount > MAX_TOKENS * 1.25. */
const HARD_CAP_RATIO = 1.25;

export type MemoryChunk = Readonly<{
  heading: string | null;
  body: string;
  tokenCount: number;
  /** Always 0 at chunker output — scanner applies path-derived weight later. */
  scoreWeight: number;
}>;

/**
 * Split markdown content on H2 (##) boundaries. Content preceding the first
 * H2 is discarded (typically just the H1 title). Oversized sections get
 * further split on blank-line paragraphs to respect maxTokens.
 *
 * Phase 90 D-20 — H2 is the canonical boundary for memory/*.md. H3/H4 are
 * treated as body content within their parent H2.
 */
export function chunkMarkdownByH2(
  content: string,
  maxTokens: number = DEFAULT_MAX_TOKENS,
): readonly MemoryChunk[] {
  // Two-pass: decide if any H2 boundaries exist. If so, all content before
  // the first H2 is discarded (typically the document's H1 title + preamble).
  // If not, the entire content becomes one chunk with null heading.
  const hasH2 = /^##\s+/m.test(content);
  const chunks: MemoryChunk[] = [];

  if (!hasH2) {
    const trimmed = content.trim();
    if (trimmed.length === 0) return Object.freeze(chunks);
    const tokenCount = Math.ceil(trimmed.length * TOKEN_PER_CHAR);
    if (tokenCount > maxTokens * HARD_CAP_RATIO) {
      for (const sub of splitByParagraphs(trimmed, maxTokens)) {
        chunks.push({
          heading: null,
          body: sub,
          tokenCount: Math.ceil(sub.length * TOKEN_PER_CHAR),
          scoreWeight: 0,
        });
      }
    } else {
      chunks.push({
        heading: null,
        body: trimmed,
        tokenCount,
        scoreWeight: 0,
      });
    }
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
    const tokenCount = Math.ceil(body.length * TOKEN_PER_CHAR);
    if (tokenCount > maxTokens * HARD_CAP_RATIO) {
      for (const sub of splitByParagraphs(body, maxTokens)) {
        chunks.push({
          heading: currentHeading,
          body: sub,
          tokenCount: Math.ceil(sub.length * TOKEN_PER_CHAR),
          scoreWeight: 0,
        });
      }
    } else {
      chunks.push({
        heading: currentHeading,
        body,
        tokenCount,
        scoreWeight: 0,
      });
    }
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

/**
 * Split long body text into sub-chunks on paragraph boundaries (blank lines),
 * packing paragraphs up to maxTokens each. Pure helper — no state, no I/O.
 */
function splitByParagraphs(text: string, maxTokens: number): readonly string[] {
  const parts: string[] = [];
  let buf = "";
  for (const para of text.split(/\n\n+/)) {
    const projected = (buf.length + para.length + 2) * TOKEN_PER_CHAR;
    if (projected > maxTokens && buf.length > 0) {
      parts.push(buf.trim());
      buf = "";
    }
    buf += (buf ? "\n\n" : "") + para;
  }
  if (buf.trim().length > 0) parts.push(buf.trim());
  return parts;
}

/**
 * Phase 90 D-19 — path-derived retrieval-ranking weight. Additive nudge to
 * the RRF fused score at hydration time (memory-retrieval.ts). Vault content
 * (standing rules) ranks higher; archive content (old session logs) ranks
 * lower. Dated files at the memory/ root default to neutral.
 *
 * Weights are small (±0.2) so they nudge, not dominate. RRF k=60 already
 * compresses the score range to roughly [0, 0.033] per ranker.
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
