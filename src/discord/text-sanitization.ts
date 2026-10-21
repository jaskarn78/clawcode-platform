/**
 * Phase 999.79 (2026-05-23) — strip AI-tell dashes from outbound text.
 *
 * Em dashes (—, U+2014) are the single most recognizable LLM-output
 * tell. Even non-technical readers reliably clock a Discord message
 * containing them as AI-generated. This module strips them from prose
 * while preserving code blocks and inline code spans.
 *
 * 2026-05-23 (later same day) — extended to also strip space-padded
 * en dashes (` – `, U+2013 with whitespace on BOTH sides). Production
 * observation: after the em-dash strip shipped, the model started
 * substituting en dashes in the SAME prose-separator role
 * (e.g. "document – the CH-100 petition") — semantically identical to
 * an em dash, just a different codepoint. Stripping only the
 * em-dash codepoint missed the substitution. The space-padded rule
 * preserves legitimate en-dash uses (number ranges `1990–2020`, score
 * lines `4–3`) because those have NO surrounding whitespace.
 *
 * Companion to the `no-em-dashes` directive in
 * `src/config/schema.ts` (DEFAULT_SYSTEM_PROMPT_DIRECTIVES). The
 * directive nudges the model away from generating em dashes in the
 * first place (saves tokens); this strip is the deterministic
 * post-hoc guarantee for the cases where the model emits them anyway
 * (em dashes) OR substitutes (space-padded en dashes).
 *
 * Composed with `wrapMarkdownTablesInCodeFence` in
 * `markdown-table-wrap.ts` → `formatOutboundText`, called at every
 * outbound Discord write chokepoint. Strip-BEFORE-wrap composition:
 * dashes inside markdown-table cells get stripped before the table
 * is fenced for Discord display.
 *
 * Preservation rules:
 *   - Fenced code blocks (```...```): all dashes survive.
 *   - Inline code spans (`...`): all dashes survive.
 *   - Unpadded en dashes (`1990–2020`, `4–3`): preserved — legitimate
 *     grammatical uses (number ranges, score lines, compound
 *     modifiers like `New York–based`).
 *   - Lone en dashes with whitespace on only ONE side (typos, ASCII-
 *     boundary cases): preserved conservatively — the
 *     prose-separator AI-tell pattern requires whitespace on BOTH
 *     sides.
 *
 * Known limitation: indented (4-space) code blocks are NOT recognized
 * (only fenced and inline). Dashes inside indented code get
 * stripped. Real-world risk is low — agents virtually always use
 * fenced blocks in Discord output.
 *
 * Streaming-partial-fence behavior: when called per-chunk during
 * streaming, an unclosed fence at the end of the input is treated as
 * code (dashes preserved — conservative-safe). When the fence
 * closes in a later accumulated-chunk invocation, the strip on the
 * full text correctly identifies the pair. Per-chunk + idempotent +
 * conservative-on-unclosed-fence = consistent end state.
 *
 * Pure function — no I/O, no logging, no side effects.
 */

const EM_DASH = "—";
const EN_DASH = "–";
// Match an em dash with optional surrounding horizontal whitespace —
// collapse `  — `, ` — `, `— `, ` —`, `—` all to ` - `. Newlines are
// NOT consumed; an em dash at the end of one line and content on the
// next is replaced in place without joining the lines.
const EM_DASH_WHITESPACE = /[ \t]*—[ \t]*/g;
// Match an en dash with whitespace on BOTH sides (` – `, `\t–\t`,
// etc.) — collapse to ` - `. The both-sides requirement is what
// distinguishes the AI-tell prose-separator pattern from legitimate
// number-range / score-line / compound-modifier usage. `1990–2020`,
// `4–3`, and `New York–based` have NO surrounding whitespace on at
// least one side, so they are preserved verbatim. Newlines are NOT
// consumed (matches em-dash behavior — single-line scope).
const EN_DASH_PADDED = /[ \t]+–[ \t]+/g;
// Fenced code block opener/closer: triple-backtick at start-of-line
// (allowing leading whitespace). Quadruple+ backticks (Phase 122 SC-3
// escape-hatch for tables containing literal triple-backticks) also
// match since the regex requires ≥3 backticks. `i` is the regex
// being applied per-line via .split("\n"), so the `^` anchor is
// effectively line-start.
const FENCE_LINE_RE = /^[ \t]*```/;
// 2026-08-27 — daemon-authored footer lines (`*— consulted advisor (Opus)
// before responding*`, `*— steered …*`) are byte-pinned by the bridge tests
// and by operators' eyes; they are not AI-tell prose. Since exit C (bot
// edit-in-place) now runs formatOutboundText like every other exit, these
// lines pass through verbatim on ALL exits instead of losing their dash on
// the webhook leg only.
const DAEMON_FOOTER_LINE_RE = /^\*— [^\n]*\*[ \t]*$/;

/**
 * Strip AI-tell dashes (em + space-padded en) from `prose` (assumed
 * to be outside any fenced block). Handles inline code spans
 * (single-backtick toggle) by splitting on backticks and processing
 * only the even-indexed parts.
 */
function stripDashesInProse(prose: string): string {
  const hasEm = prose.includes(EM_DASH);
  const hasEn = prose.includes(EN_DASH);
  if (!hasEm && !hasEn) return prose;
  const parts = prose.split("`");
  // Even indices (0, 2, 4, ...) are plain prose; odd indices are
  // inline-code-span contents. If the prose has an unclosed inline
  // span (odd count of backticks), the trailing odd-indexed part is
  // treated as code — conservative-safe (dashes preserved).
  for (let i = 0; i < parts.length; i += 2) {
    if (parts[i].includes(EM_DASH)) {
      parts[i] = parts[i].replace(EM_DASH_WHITESPACE, " - ");
    }
    if (parts[i].includes(EN_DASH)) {
      // Only the space-padded prose-separator pattern; unpadded
      // en dashes (`1990–2020`, `4–3`, `New York–based`) survive.
      parts[i] = parts[i].replace(EN_DASH_PADDED, " - ");
    }
  }
  return parts.join("`");
}

/**
 * Strip AI-tell dashes from `text` while preserving fenced code
 * blocks and inline code spans:
 *   - Em dashes (U+2014): always stripped from prose. `\s*—\s*` → ` - `
 *     (collapsing horizontal whitespace to a single space-hyphen-space).
 *   - Space-padded en dashes (U+2013 with whitespace on BOTH sides):
 *     stripped as a prose separator. `[ \t]+–[ \t]+` → ` - `.
 *   - Unpadded en dashes (`1990–2020`, `4–3`, `New York–based`):
 *     preserved — legitimate grammatical uses.
 *
 * Idempotent: applying twice yields the same result as applying once.
 *
 * Function name retained as `stripEmDashes` for back-compat with the
 * 13 chokepoint call sites (em dash is still the primary target; the
 * en-dash extension is a substitution-pattern follow-up).
 *
 * @param text Outbound text destined for Discord.
 * @returns Text with em dashes + space-padded en dashes stripped from
 *          prose; code blocks/spans and number-range en dashes
 *          preserved verbatim.
 */
export function stripEmDashes(text: string): string {
  if (!text || text.length === 0) return text;
  // Fast path: no dash worth stripping anywhere → return input
  // verbatim. Both codepoints checked here; the in-prose helper will
  // skip whichever isn't present.
  if (!text.includes(EM_DASH) && !text.includes(EN_DASH)) return text;

  const lines = text.split("\n");
  const out: string[] = [];
  let inFence = false;
  let pendingProse: string[] = [];

  const flushProse = (): void => {
    if (pendingProse.length === 0) return;
    out.push(stripDashesInProse(pendingProse.join("\n")));
    pendingProse = [];
  };

  for (const line of lines) {
    const isFenceMarker = FENCE_LINE_RE.test(line);
    if (isFenceMarker) {
      if (!inFence) {
        // Opening a fence — flush accumulated prose before pushing
        // the fence marker line itself.
        flushProse();
      }
      // The fence marker line itself is preserved verbatim — never
      // stripped. (Em dashes in a fence-marker info string like
      // ```text—example are unusual; we'd rather preserve than strip
      // structural markers.)
      out.push(line);
      inFence = !inFence;
    } else if (!inFence && DAEMON_FOOTER_LINE_RE.test(line)) {
      flushProse();
      out.push(line);
    } else if (inFence) {
      // Inside a fenced block: preserve everything, em dashes included.
      out.push(line);
    } else {
      pendingProse.push(line);
    }
  }
  // Flush any trailing prose after the last line.
  flushProse();
  return out.join("\n");
}
