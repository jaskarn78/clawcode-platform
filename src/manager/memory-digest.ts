/**
 * Phase 999.127 — weekly "what I learned about you" digest.
 *
 * WHY. Agents save memories all week (memory_save, dreams, consolidation)
 * and the owner never sees them until one shapes a reply. A wrong memory
 * then reads as a hallucination. Once a week the agent posts what it
 * learned as a numbered list; reacting with an item's number tells it
 * that item is wrong and it forgets it on the spot; 👍 confirms them all.
 *
 * STATELESS BY DESIGN. Every item line carries the first eight characters
 * of its memory id in ⟨brackets⟩, so the reaction handler resolves the
 * memory from the message text itself: no message-id table, nothing to
 * lose across a restart. The header is the marker that makes a message a
 * digest.
 */

import type { MemoryStore } from "../memory/store.js";
import type { MemoryEntry } from "../memory/types.js";

export const DIGEST_HEADER = "🧠 **What I learned about you this week**";
export const DIGEST_MAX_ITEMS = 10;
export const DEFAULT_DIGEST_ITEMS = 8;
export const DIGEST_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
/** Tags that never make it into the digest (machine-generated or transient). */
export const DIGEST_EXCLUDE_TAGS: readonly string[] = [
  "session-summary",
  "mid-session",
  "raw-fallback",
  "confirmed",
];
export const CONFIRMED_TAG = "confirmed";
export const CONFIRMED_IMPORTANCE = 0.9;

/** Keycap emoji, index 0 = item 1. Discord reports them as `N️⃣` (or without FE0F). */
export const NUMBER_EMOJI: readonly string[] = [
  "1️⃣", "2️⃣", "3️⃣", "4️⃣", "5️⃣", "6️⃣", "7️⃣", "8️⃣", "9️⃣", "🔟",
];
export const CONFIRM_EMOJI = "👍";

const CODE_CHARS = 8;
const LINE_MAX = 160;
const ITEM_RE = /^(\d{1,2})\. (.*) ⟨([A-Za-z0-9_-]{6,12})⟩/u;

export interface DigestItem {
  readonly index: number;
  readonly id: string;
  readonly code: string;
  readonly line: string;
  readonly createdAt: string;
  readonly importance: number;
}

export interface SelectDigestOptions {
  readonly since: string;
  readonly until: string;
  readonly maxItems?: number;
  readonly excludeTags?: readonly string[];
}

function firstLine(content: string): string {
  const lines = content.split("\n").map((l) => l.trim());
  // Prefer the first prose line; a heading alone ("## Zaid") is a poor label.
  const prose = lines.find((l) => l.length > 0 && !/^#+(\s|$)/.test(l));
  const heading = lines.find((l) => l.length > 0);
  const line = (prose ?? heading ?? "").replace(/^#+\s*/, "").replace(/^[-*]\s+/, "").trim();
  const flat = line.replace(/\s+/g, " ").replace(/[⟨⟩]/g, "");
  return flat.length > LINE_MAX ? `${flat.slice(0, LINE_MAX - 1).trimEnd()}…` : flat;
}

const normKey = (s: string): string => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim().slice(0, 80);

/** Pick the week's memories worth showing: most important first, no near-repeats. */
export function selectDigestMemories(store: MemoryStore, options: SelectDigestOptions): DigestItem[] {
  const maxItems = Math.min(options.maxItems ?? DEFAULT_DIGEST_ITEMS, DIGEST_MAX_ITEMS);
  const exclude = new Set(options.excludeTags ?? DIGEST_EXCLUDE_TAGS);
  const candidates: MemoryEntry[] = store
    .listInRange(options.since, options.until, 300)
    .filter((m) => !m.tags.some((t) => exclude.has(t)))
    .filter((m) => firstLine(m.content).length > 0);
  candidates.sort((a, b) => b.importance - a.importance || b.createdAt.localeCompare(a.createdAt));
  const seen = new Set<string>();
  const items: DigestItem[] = [];
  for (const m of candidates) {
    const line = firstLine(m.content);
    const key = normKey(line);
    if (seen.has(key)) continue;
    seen.add(key);
    items.push(
      Object.freeze({
        index: items.length + 1,
        id: m.id,
        code: m.id.slice(0, CODE_CHARS),
        line,
        createdAt: m.createdAt,
        importance: m.importance,
      }),
    );
    if (items.length >= maxItems) break;
  }
  return items;
}

function shortDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? ""
    : d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/** The Discord message. Empty string when there is nothing to say. */
export function renderDigest(items: readonly DigestItem[], window: { since: string; until: string }): string {
  if (items.length === 0) return "";
  const lines = [
    DIGEST_HEADER,
    `-# ${shortDate(window.since)} to ${shortDate(window.until)} · ${items.length} new thing${items.length === 1 ? "" : "s"}`,
    "",
    ...items.map((it) => `${it.index}. ${it.line} ⟨${it.code}⟩ · ${shortDate(it.createdAt)}`),
    "",
    "-# React with an item's number if it's wrong and I'll forget it; 👍 means they're all right.",
  ];
  return lines.join("\n");
}

export function isDigestMessage(content: string): boolean {
  return content.startsWith(DIGEST_HEADER);
}

/** The items a digest message names, from its text alone. Null when not a digest. */
export function parseDigestMessage(content: string): ReadonlyArray<{ index: number; code: string; line: string }> | null {
  if (!isDigestMessage(content)) return null;
  const items: Array<{ index: number; code: string; line: string }> = [];
  for (const raw of content.split("\n")) {
    const m = ITEM_RE.exec(raw.trim());
    if (m) items.push({ index: Number(m[1]), code: m[3]!, line: m[2]! });
  }
  return items;
}

export type DigestFeedback =
  | { readonly kind: "dispute"; readonly index: number }
  | { readonly kind: "confirm-all" };

/** Map a reaction emoji to feedback; null for any other emoji. */
export function feedbackForEmoji(emojiName: string): DigestFeedback | null {
  const name = emojiName.replace(/️/g, "");
  if (name === CONFIRM_EMOJI) return { kind: "confirm-all" };
  const idx = NUMBER_EMOJI.findIndex((e) => e.replace(/️/g, "") === name);
  return idx === -1 ? null : { kind: "dispute", index: idx + 1 };
}

export type DigestFeedbackResult =
  | { readonly action: "forgot"; readonly index: number; readonly id: string; readonly line: string }
  | { readonly action: "confirmed"; readonly count: number }
  | { readonly action: "not-found"; readonly index: number }
  | { readonly action: "already-gone"; readonly index: number };

/** Resolve an item code to its full memory id (unique prefix), or null. */
export function resolveMemoryIdByCode(store: MemoryStore, code: string): string | null {
  const rows = store
    .getDatabase()
    .prepare("SELECT id FROM memories WHERE id LIKE ? LIMIT 2")
    .all(`${code.replace(/[%_]/g, "")}%`) as Array<{ id: string }>;
  return rows.length === 1 ? rows[0]!.id : null;
}

/** Apply the feedback to the store. Deleting goes through the FK-safe `store.delete`. */
export function applyDigestFeedback(
  store: MemoryStore,
  feedback: DigestFeedback,
  items: ReadonlyArray<{ index: number; code: string; line: string }>,
): DigestFeedbackResult {
  if (feedback.kind === "confirm-all") {
    const db = store.getDatabase();
    const read = db.prepare("SELECT tags FROM memories WHERE id = ?");
    const write = db.prepare(
      "UPDATE memories SET importance = MAX(importance, ?), tags = ?, updated_at = ? WHERE id = ?",
    );
    let count = 0;
    for (const it of items) {
      const id = resolveMemoryIdByCode(store, it.code);
      if (!id) continue;
      const row = read.get(id) as { tags: string } | undefined;
      if (!row) continue;
      const tags = new Set<string>(JSON.parse(row.tags) as string[]);
      tags.add(CONFIRMED_TAG);
      write.run(CONFIRMED_IMPORTANCE, JSON.stringify([...tags]), new Date().toISOString(), id);
      count += 1;
    }
    return { action: "confirmed", count };
  }
  const item = items.find((it) => it.index === feedback.index);
  if (!item) return { action: "not-found", index: feedback.index };
  const id = resolveMemoryIdByCode(store, item.code);
  if (!id) return { action: "already-gone", index: feedback.index };
  const deleted = store.delete(id);
  return deleted
    ? { action: "forgot", index: item.index, id, line: item.line }
    : { action: "already-gone", index: feedback.index };
}

/** The confirmation posted under the digest. */
export function digestReplyText(result: DigestFeedbackResult): string {
  switch (result.action) {
    case "forgot":
      return `Noted. I've forgotten #${result.index}: "${result.line}"`;
    case "confirmed":
      return result.count === 0
        ? "Nothing left to confirm; those memories are already gone."
        : `Thanks. I've marked ${result.count === 1 ? "that one" : `all ${result.count}`} as confirmed.`;
    case "not-found":
      return `There is no item #${result.index} in this digest.`;
    case "already-gone":
      return `Item #${result.index} is already gone.`;
  }
}
