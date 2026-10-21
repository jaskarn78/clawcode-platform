/**
 * 999.178 R1 — `:cc_name:` shortcode rewrite for AGENT-authored text.
 *
 * the operator's locked icon rule: ClawCode renders its own Lucide application-emoji
 * set (`cc_*`) everywhere and NEVER a Unicode glyph. Agents can't emit the
 * `<:cc_name:id>` wire form directly (they don't know the ids, and the rule
 * forbids hardcoding them), so they write the stable `:cc_name:` shortcode
 * and the daemon resolves it through the registry at a delivery chokepoint.
 *
 * Two entry points:
 *   - `rewriteIconShortcodes` turns `:cc_name:` into `<:cc_name:id>` for
 *     channel delivery. An unknown name — or a known name whose icon is not
 *     in the loaded set — is stripped cleanly (never a Unicode fallback,
 *     never a stray double space).
 *   - `stripIconShortcodes` removes every icon token (shortcode AND formed
 *     `<:cc_name:id>`) for CLIENT-FACING drafts, which get pasted into texts
 *     and emails and must carry no icons in either form.
 *
 * Pure module — the registry is injected, so callers in either process
 * (daemon with a loaded set, or a context with none) get correct behaviour.
 */

/** The registry surface this module needs: resolve a bare icon name to its
 * `<:cc_name:id>` wire form, or `""` when the icon is not loaded. `icons`
 * from `./icons.js` satisfies this. */
export interface IconLookup {
  inline(name: string): string;
}

const ICON_SHORTCODE_PREFIX = "cc_";

// One scanner, tried in priority order so a shortcode that happens to sit
// INSIDE a fenced block, inline-code span, or an already-formed emoji token
// is never touched:
//   1. ```fence```  — up to the closing fence, or end of text (unclosed
//      fence protects the rest, matching how Discord renders it).
//   2. `inline code` — single line.
//   3. <a?:name:id>  — an already-formed custom-emoji token (ours or any
//      other app's); left verbatim so we never double-wrap.
//   4. :cc_name:     — the shortcode to resolve (capturing group 1).
const REWRITE_SCANNER =
  /```[\s\S]*?(?:```|$)|`[^`\n]*`|<a?:[A-Za-z0-9_]+:\d+>|:(cc_[a-z0-9_]+):/g;

// The strip scanner has no code-preservation branches: a client draft is
// plain prose, and an icon token anywhere in it must go. Only the `cc_`
// namespace is touched, so an unrelated `:shrug:` or `<:emoji:1>` survives.
const STRIP_SCANNER = /<a?:cc_[A-Za-z0-9_]+:\d+>|:cc_[a-z0-9_]+:/g;

/**
 * When a token resolves to nothing (unknown / not loaded, or a strip),
 * drop the one space it would otherwise leave doubled. `out` is the text
 * emitted so far; `nextIndex` points at the char after the removed token.
 * Returns the possibly-advanced next index. Trailing space wins; a
 * boundary (start / newline) drops the leading space instead.
 */
function collapseRemovedTokenSpace(
  out: string,
  text: string,
  nextIndex: number,
): { out: string; nextIndex: number } {
  const nextChar = text[nextIndex]; // undefined at end of text
  if (out.endsWith(" ")) {
    // Trailing space is doubled by a following space, or dangles at a line
    // break / end of text — drop it either way.
    if (nextChar === " " || nextChar === "\n" || nextChar === undefined) {
      return { out: out.slice(0, -1), nextIndex };
    }
    return { out, nextIndex };
  }
  // A token that led the line / text leaves its trailing space instead.
  if ((out.length === 0 || out.endsWith("\n")) && nextChar === " ") {
    return { out, nextIndex: nextIndex + 1 };
  }
  return { out, nextIndex };
}

/**
 * Resolve `:cc_name:` shortcodes in agent-authored text to `<:cc_name:id>`.
 * Unknown or unloaded names are stripped. Fenced blocks, inline code, and
 * already-formed emoji tokens pass through untouched. Idempotent on text
 * that already carries formed tokens.
 */
export function rewriteIconShortcodes(text: string, registry: IconLookup): string {
  if (!text) return text;
  let out = "";
  let last = 0;
  REWRITE_SCANNER.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = REWRITE_SCANNER.exec(text)) !== null) {
    const shortcodeName = m[1];
    out += text.slice(last, m.index);
    last = m.index + m[0].length;
    if (shortcodeName === undefined) {
      // A code span or a formed token — leave it exactly as written.
      out += m[0];
      continue;
    }
    const resolved = registry.inline(shortcodeName.slice(ICON_SHORTCODE_PREFIX.length));
    if (resolved.length > 0) {
      out += resolved;
    } else {
      const collapsed = collapseRemovedTokenSpace(out, text, last);
      out = collapsed.out;
      last = collapsed.nextIndex;
    }
  }
  out += text.slice(last);
  return out;
}

/**
 * Remove every `cc_` icon token — shortcode `:cc_name:` and formed
 * `<:cc_name:id>` alike — for client-facing drafts. Non-`cc_` colons and
 * other apps' emoji are left alone. Space left by a removed token collapses.
 */
export function stripIconShortcodes(text: string): string {
  if (!text) return text;
  let out = "";
  let last = 0;
  STRIP_SCANNER.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = STRIP_SCANNER.exec(text)) !== null) {
    out += text.slice(last, m.index);
    last = m.index + m[0].length;
    const collapsed = collapseRemovedTokenSpace(out, text, last);
    out = collapsed.out;
    last = collapsed.nextIndex;
  }
  out += text.slice(last);
  return out;
}
