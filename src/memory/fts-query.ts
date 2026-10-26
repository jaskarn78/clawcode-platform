/**
 * Phase 999.187 — build an FTS5 MATCH expression from a natural-language
 * query.
 *
 * WHY. `searchMemoryChunksFts` used to pass the whole user message to FTS5,
 * whose implicit operator is AND: "what did we decide about the database
 * engine?" only matched a chunk containing what, did, we, decide, about, the,
 * database AND engine. Multi-word questions therefore matched nothing and the
 * keyword half of hybrid retrieval was dead weight; ranking came from the
 * vector side alone.
 *
 * RULE. Lower-case, keep `[a-z0-9_]` tokens of two or more characters, drop
 * stopwords, dedupe, cap the term count, and OR the quoted terms. FTS5's
 * bm25 rank then favours rows that match MORE of the terms, which is the
 * ranking a hybrid fuser wants. The index tokenizer is `porter`, so "decided"
 * finds "decision" without prefix wildcards.
 *
 * Memory overhaul WP2 (2026-10-25): the Discord `<channel ...>` envelope is
 * stripped before tokenising. On a Discord turn the raw message starts with
 * about 130 characters of envelope, and its tokens (channel, source,
 * discord, chat_id, two snowflake ids, user, ts, the date parts) filled all
 * twelve term slots, so the user's words never reached BM25.
 *
 * Pure: no I/O.
 */

import { stripChannelEnvelope } from "../shared/channel-envelope.js";

export const FTS_MAX_TERMS = 12;

/** Small English stopword list: function words that carry no recall signal. */
export const FTS_STOPWORDS: ReadonlySet<string> = new Set([
  "a", "an", "and", "are", "as", "at", "be", "been", "but", "by", "can", "could",
  "did", "do", "does", "for", "from", "had", "has", "have", "he", "her", "him",
  "his", "how", "i", "if", "in", "into", "is", "it", "its", "just", "me", "my",
  "no", "not", "of", "on", "or", "our", "she", "should", "so", "than", "that",
  "the", "their", "them", "then", "there", "these", "they", "this", "those", "to",
  "up", "us", "was", "we", "were", "what", "when", "where", "which", "who", "why",
  "will", "with", "would", "you", "your", "about", "also", "any", "all", "some",
  "tell", "know", "remember", "again", "please", "thanks", "ok", "okay",
]);

const TOKEN_RE = /[a-z0-9_]+/g;

/** Tokens that survive sanitising, stopword removal and dedupe, in order. */
export function extractFtsTerms(raw: string, maxTerms: number = FTS_MAX_TERMS): readonly string[] {
  const text = stripChannelEnvelope(raw);
  const all = (text.toLowerCase().match(TOKEN_RE) ?? []).filter((t) => t.length >= 2);
  const kept: string[] = [];
  const seen = new Set<string>();
  const pick = (t: string) => {
    if (seen.has(t)) return;
    seen.add(t);
    kept.push(t);
  };
  for (const t of all) if (!FTS_STOPWORDS.has(t)) pick(t);
  // A query made only of stopwords ("what is it?") still gets a chance.
  if (kept.length === 0) for (const t of all) pick(t);
  return Object.freeze(kept.slice(0, maxTerms));
}

/**
 * `"term1" OR "term2" …`, or null when nothing searchable remains. Terms are
 * quoted so FTS5 never parses them as syntax (`NEAR`, `NOT`, column filters).
 */
export function buildFtsMatchQuery(raw: string, maxTerms: number = FTS_MAX_TERMS): string | null {
  const terms = extractFtsTerms(raw, maxTerms);
  if (terms.length === 0) return null;
  return terms.map((t) => `"${t}"`).join(" OR ");
}
