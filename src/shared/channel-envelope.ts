/**
 * Memory overhaul WP2 (2026-10-25) - strip the Discord `<channel ...>` envelope.
 *
 * WHY. `formatDiscordMessage` (src/discord/bridge.ts) wraps every inbound
 * message as
 *
 *   <channel source="discord" chat_id="..." message_id="..." user="..." ts="...">
 *   the user's words
 *   </channel>
 *   [optional attachment metadata and vision analysis lines]
 *
 * and that whole string reached the pre-turn retrieval query, the cadence
 * gate's topic-shift cosine and (via WP4) the stored user turn. The FTS
 * ranker keeps only the first 12 non-stopword tokens, so on a Discord turn
 * every keyword slot was an envelope token (channel, source, discord,
 * chat_id, the snowflake ids, user, ts, the date parts) and the user's
 * question never reached BM25; the vector query was diluted the same way.
 *
 * This helper returns the inner text of each envelope and leaves any other
 * text (attachment metadata after the closing tag, plain messages with no
 * envelope) alone. Pure, no I/O, no imports, so src/memory and src/discord
 * can both use it without a dependency cycle.
 */

/** `<channel ...>inner</channel>` (any attributes, multi-line inner text). */
const CHANNEL_BLOCK_RE = /<channel(?=[\s>])[^>]*>\s*([\s\S]*?)\s*<\/channel>/gi;

/** A dangling opening tag with no closing tag (truncated message). */
const CHANNEL_OPEN_RE = /<channel(?=[\s>])[^>]*>\s*/gi;

/** A dangling closing tag with no opening tag. */
const CHANNEL_CLOSE_RE = /\s*<\/channel>/gi;

/**
 * Return `text` with every `<channel ...>...</channel>` wrapper replaced by
 * its inner text. Text outside the wrapper is kept in place (trailing
 * attachment lines survive). Input without an envelope is returned trimmed
 * but otherwise unchanged, so callers can apply it unconditionally.
 */
export function stripChannelEnvelope(text: string): string {
  if (typeof text !== "string" || text.length === 0) return "";
  if (!/<channel(?=[\s>])/i.test(text) && !/<\/channel>/i.test(text)) return text.trim();
  const unwrapped = text
    .replace(CHANNEL_BLOCK_RE, "$1")
    .replace(CHANNEL_OPEN_RE, "")
    .replace(CHANNEL_CLOSE_RE, "");
  return unwrapped.trim();
}

/** True when `text` carries a `<channel ...>` wrapper (opening tag present). */
export function hasChannelEnvelope(text: string): boolean {
  return typeof text === "string" && /<channel(?=[\s>])[^>]*>/i.test(text);
}
