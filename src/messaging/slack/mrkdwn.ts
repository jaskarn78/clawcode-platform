/**
 * Discord-flavored Markdown → Slack `mrkdwn` translator.
 *
 * ClawCode agents emit Discord-flavored Markdown (that's the canonical text
 * the bridge carries). Slack renders a DIFFERENT dialect, so without
 * translation an agent's `**bold**` shows the literal asterisks and a
 * `[label](url)` link shows its raw `[...](...)` form. This is the single
 * highest-value Slack gap (see .planning/messaging-platform-parity-PLAN.md §2).
 *
 * Dialect map (Discord → Slack):
 *   **bold**        → *bold*
 *   *italic* / _italic_ → _italic_
 *   __underline__   → _underline_   (Slack has no underline; degrade to italic)
 *   ~~strike~~      → ~strike~
 *   # / ## / ### H  → *H*           (Slack has no headings; bold the text)
 *   [label](url)    → <url|label>
 *   `code` / ```fences``` → left INTACT
 *
 * Correctness invariants:
 *   - **Code is sacred.** Code spans (inline `` `…` `` and fenced ```` ``` ````)
 *     are tokenized out first and never transformed — `**` inside code must
 *     stay literal.
 *   - **Streaming-safe.** The bridge calls this on *accumulating* text, so the
 *     tokenizer will routinely see an UNTERMINATED trailing fence. We treat a
 *     dangling fence as code-to-end, so a half-streamed code block isn't
 *     mangled until its closing fence arrives.
 *   - **Single-pass / non-idempotent by design.** `*x*`→`_x_` but `**x**`→`*x*`,
 *     so translating already-translated output would corrupt it. Callers MUST
 *     only ever translate canonical (Discord-flavored) text once — never feed
 *     adapter output back in. Plain control strings (placeholder, error notice)
 *     pass through unchanged because they contain none of these constructs.
 */

/**
 * Sentinel standing in for Slack bold (`*`) between passes, so the italic pass
 * can't re-touch it. A NUL control char — it can't occur in real chat text, so
 * the final restore is collision-free. Built at runtime (not a literal NUL in
 * source) and any stray NUL in the input is stripped up front.
 */
const BOLD_SENTINEL = String.fromCharCode(0);

/**
 * Translate one Discord-flavored Markdown string to Slack `mrkdwn`.
 * Length-non-increasing (every rule shrinks or preserves), so it is safe to
 * apply AFTER chunking without risking the platform's max-length ceiling.
 */
export function toSlackMrkdwn(text: string): string {
  if (text.length === 0) return text;
  // Strip any pre-existing NUL so it can't be confused with our sentinel.
  const clean = text.includes(BOLD_SENTINEL) ? text.split(BOLD_SENTINEL).join("") : text;
  return tokenizeCodeSpans(clean)
    .map((seg) => (seg.code ? seg.text : transformProse(seg.text)))
    .join("");
}

type Segment = { readonly code: boolean; readonly text: string };

/**
 * Split text into alternating prose / code segments. Fenced blocks (```` ``` ````)
 * and inline spans (`` ` ``) are emitted as `code: true` and pass through
 * untouched. An unterminated trailing fence swallows the rest as code
 * (streaming-safe); an unterminated inline backtick is treated as a literal
 * character so it can't swallow the tail.
 */
function tokenizeCodeSpans(text: string): Segment[] {
  const segments: Segment[] = [];
  let prose = "";
  let i = 0;

  const flushProse = (): void => {
    if (prose.length > 0) {
      segments.push({ code: false, text: prose });
      prose = "";
    }
  };

  while (i < text.length) {
    // Fenced code block: ```...```
    if (text.startsWith("```", i)) {
      flushProse();
      const close = text.indexOf("```", i + 3);
      if (close === -1) {
        // Unterminated (mid-stream) — treat the rest as code, don't transform.
        segments.push({ code: true, text: text.slice(i) });
        i = text.length;
      } else {
        const end = close + 3;
        segments.push({ code: true, text: text.slice(i, end) });
        i = end;
      }
      continue;
    }

    // Inline code span: `...`
    if (text[i] === "`") {
      const close = text.indexOf("`", i + 1);
      if (close === -1) {
        // Stray backtick — treat as literal prose, keep scanning after it.
        prose += text[i];
        i += 1;
      } else {
        flushProse();
        const end = close + 1;
        segments.push({ code: true, text: text.slice(i, end) });
        i = end;
      }
      continue;
    }

    prose += text[i];
    i += 1;
  }

  flushProse();
  return segments;
}

/** Apply the prose-level dialect rewrites (never runs on code segments). */
function transformProse(text: string): string {
  let out = text;

  // 1. Headings (line-anchored): strip leading #'s, wrap content in the bold
  //    sentinel so the italic pass below can't mistake the `*` for italics.
  //    Inner formatting in the heading text is still handled by later rules.
  out = out.replace(/^[ \t]*#{1,6}[ \t]+(.+?)[ \t]*$/gm, `${BOLD_SENTINEL}$1${BOLD_SENTINEL}`);

  // 2. Links: [label](url) → <url|label>. URL stops at whitespace/`)`.
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, "<$2|$1>");

  // 3. Bold+italic: ***x*** → *_x_*. Handled before plain bold so the
  //    non-greedy bold match below can't steal one of the three asterisks.
  out = out.replace(/\*\*\*(.+?)\*\*\*/g, `${BOLD_SENTINEL}_$1_${BOLD_SENTINEL}`);

  // 4. Bold: **x** → sentinel-wrapped, BEFORE single-asterisk italic so the
  //    two don't collide.
  out = out.replace(/\*\*(.+?)\*\*/g, `${BOLD_SENTINEL}$1${BOLD_SENTINEL}`);

  // 5. Underline → italic (Slack has no underline). __x__ → _x_.
  out = out.replace(/__(.+?)__/g, "_$1_");

  // 6. Italic: remaining single *x* → _x_ ( _x_ italic is already Slack-correct).
  out = out.replace(/\*(.+?)\*/g, "_$1_");

  // 7. Strikethrough: ~~x~~ → ~x~.
  out = out.replace(/~~(.+?)~~/g, "~$1~");

  // 8. Restore bold sentinels to Slack's single `*`.
  out = out.split(BOLD_SENTINEL).join("*");

  return out;
}
