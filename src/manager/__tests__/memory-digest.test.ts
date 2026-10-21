/**
 * Phase 999.127 — weekly memory digest: selection, rendering, parsing and
 * reaction feedback against a real in-memory store.
 */

import { describe, it, expect, afterEach } from "vitest";
import { MemoryStore } from "../../memory/store.js";
import { ConversationStore } from "../../memory/conversation-store.js";
import {
  DIGEST_HEADER,
  applyDigestFeedback,
  digestReplyText,
  feedbackForEmoji,
  parseDigestMessage,
  renderDigest,
  selectDigestMemories,
} from "../memory-digest.js";

function unit(index: number): Float32Array {
  const v = new Float32Array(384);
  v[index % 384] = 1;
  return v;
}

const WINDOW = { since: "2026-08-29T00:00:00.000Z", until: "2026-09-05T00:00:00.000Z" };

describe("memory digest", () => {
  let store: MemoryStore;
  let seq = 0;

  function setup(): void {
    store = new MemoryStore(":memory:", { enabled: false, similarityThreshold: 0.85 });
    new ConversationStore(store.getDatabase());
    seq = 0;
  }
  afterEach(() => store?.close());

  function seed(content: string, at: string, importance = 0.5, tags: string[] = []): string {
    const e = store.insert({ content, source: "manual", importance, tags, skipDedup: true }, unit(seq++));
    store
      .getDatabase()
      .prepare("UPDATE memories SET created_at = ?, updated_at = ?, accessed_at = ? WHERE id = ?")
      .run(at, at, at, e.id);
    return e.id;
  }

  it("selects the week's memories, most important first, without repeats or excluded tags", () => {
    setup();
    const a = seed("## Zaid\nZaid wants 40% SGOV", "2026-09-01T10:00:00.000Z", 0.9);
    seed("Zaid wants 40% SGOV!", "2026-09-02T10:00:00.000Z", 0.4); // near-repeat of a's first line
    const b = seed("Operator prefers brief answers", "2026-09-03T10:00:00.000Z", 0.6);
    seed("Session summary text", "2026-09-03T11:00:00.000Z", 0.9, ["session-summary"]);
    seed("Too old", "2026-08-01T10:00:00.000Z", 0.9);
    const items = selectDigestMemories(store, WINDOW);
    expect(items.map((i) => i.id)).toEqual([a, b]);
    expect(items[0]).toMatchObject({ index: 1, line: "Zaid wants 40% SGOV", code: a.slice(0, 8) });
  });

  it("renders a numbered digest that parses back to the same items", () => {
    setup();
    const a = seed("Zaid wants 40% SGOV", "2026-09-01T10:00:00.000Z", 0.9);
    const b = seed("Operator prefers brief answers", "2026-09-03T10:00:00.000Z", 0.6);
    const items = selectDigestMemories(store, WINDOW);
    const text = renderDigest(items, WINDOW);
    expect(text.startsWith(DIGEST_HEADER)).toBe(true);
    expect(text).toContain(`1. Zaid wants 40% SGOV ⟨${a.slice(0, 8)}⟩`);
    expect(text).toContain(`2. Operator prefers brief answers ⟨${b.slice(0, 8)}⟩`);
    expect(text).toContain("React with an item's number");
    expect(parseDigestMessage(text)).toEqual([
      { index: 1, code: a.slice(0, 8), line: "Zaid wants 40% SGOV" },
      { index: 2, code: b.slice(0, 8), line: "Operator prefers brief answers" },
    ]);
    expect(parseDigestMessage("just a normal reply")).toBeNull();
    expect(renderDigest([], WINDOW)).toBe("");
  });

  it("maps keycap emoji (with or without the variation selector) and 👍 to feedback", () => {
    expect(feedbackForEmoji("2️⃣")).toEqual({ kind: "dispute", index: 2 });
    expect(feedbackForEmoji("2⃣")).toEqual({ kind: "dispute", index: 2 });
    expect(feedbackForEmoji("🔟")).toEqual({ kind: "dispute", index: 10 });
    expect(feedbackForEmoji("👍")).toEqual({ kind: "confirm-all" });
    expect(feedbackForEmoji("🔴")).toBeNull();
  });

  it("a number reaction forgets that memory; 👍 confirms them all; stale items are reported", () => {
    setup();
    const a = seed("Zaid wants 40% SGOV", "2026-09-01T10:00:00.000Z", 0.9);
    const b = seed("Operator prefers brief answers", "2026-09-03T10:00:00.000Z", 0.6);
    const items = parseDigestMessage(renderDigest(selectDigestMemories(store, WINDOW), WINDOW))!;

    const forgot = applyDigestFeedback(store, { kind: "dispute", index: 2 }, items);
    expect(forgot).toEqual({ action: "forgot", index: 2, id: b, line: "Operator prefers brief answers" });
    expect(store.getById(b)).toBeNull();
    expect(digestReplyText(forgot)).toBe('Noted. I\'ve forgotten #2: "Operator prefers brief answers"');

    expect(applyDigestFeedback(store, { kind: "dispute", index: 2 }, items)).toEqual({ action: "already-gone", index: 2 });
    expect(applyDigestFeedback(store, { kind: "dispute", index: 7 }, items)).toEqual({ action: "not-found", index: 7 });

    const confirmed = applyDigestFeedback(store, { kind: "confirm-all" }, items);
    expect(confirmed).toEqual({ action: "confirmed", count: 1 });
    const survivor = store.getById(a)!;
    expect(survivor.importance).toBe(0.9);
    expect(survivor.tags).toContain("confirmed");
    expect(digestReplyText(confirmed)).toBe("Thanks. I've marked that one as confirmed.");
    // Confirmed memories drop out of the next digest.
    expect(selectDigestMemories(store, WINDOW)).toHaveLength(0);
  });
});
