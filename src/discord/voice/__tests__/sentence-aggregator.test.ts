/**
 * Phase 135.1 Phase 4 — SentenceAggregator unit tests.
 *
 * Simulates dispatchStream's growing-accumulated-string contract token by token
 * and asserts: early first-sentence emission, abbreviation/decimal guards,
 * newline splits, no double-emission, and flush of the tail.
 */
import { describe, it, expect } from "vitest";
import { SentenceAggregator } from "../sentence-aggregator.js";

/** Feed a full string one character at a time (worst-case streaming). */
function streamCharByChar(text: string, agg: SentenceAggregator): string[] {
  const out: string[] = [];
  let acc = "";
  for (const ch of text) {
    acc += ch;
    out.push(...agg.push(acc));
  }
  const tail = agg.flush(acc);
  if (tail) out.push(tail);
  return out;
}

/** Feed a string in arbitrary growing chunks. */
function streamChunks(chunks: string[], agg: SentenceAggregator): string[] {
  const out: string[] = [];
  let acc = "";
  for (const c of chunks) {
    acc += c;
    out.push(...agg.push(acc));
  }
  const tail = agg.flush(acc);
  if (tail) out.push(tail);
  return out;
}

describe("SentenceAggregator", () => {
  it("emits sentences as they complete, in order", () => {
    const agg = new SentenceAggregator();
    const out = streamCharByChar(
      "The meeting is at three. Bring the report. We start on time.",
      agg,
    );
    expect(out).toEqual([
      "The meeting is at three.",
      "Bring the report.",
      "We start on time.",
    ]);
  });

  it("emits the first sentence early (before the rest is generated)", () => {
    const agg = new SentenceAggregator();
    let acc = "";
    const emittedAfterFirst: string[] = [];
    for (const ch of "Yes, absolutely. Let me pull the numbers for you now.") {
      acc += ch;
      const s = agg.push(acc);
      if (s.length && emittedAfterFirst.length === 0) emittedAfterFirst.push(...s);
    }
    // The first sentence is available before the second is finished streaming.
    expect(emittedAfterFirst[0]).toBe("Yes, absolutely.");
  });

  it("does not split on decimals or abbreviations", () => {
    const agg = new SentenceAggregator();
    const out = streamCharByChar(
      "Dr. Smith says pi is 3.14 approximately. That's the value.",
      agg,
    );
    expect(out).toEqual([
      "Dr. Smith says pi is 3.14 approximately.",
      "That's the value.",
    ]);
  });

  it("does not split on initials or e.g./i.e.", () => {
    const agg = new SentenceAggregator();
    const out = streamCharByChar(
      "Ask J. Doe about it, e.g. the budget line. Then report back.",
      agg,
    );
    expect(out).toEqual([
      "Ask J. Doe about it, e.g. the budget line.",
      "Then report back.",
    ]);
  });

  it("splits on newlines (list-y output)", () => {
    const agg = new SentenceAggregator();
    const out = streamChunks(
      ["First item here\n", "Second item here\n", "Third item here"],
      agg,
    );
    expect(out).toEqual(["First item here", "Second item here", "Third item here"]);
  });

  it("flushes a tail with no terminal punctuation", () => {
    const agg = new SentenceAggregator();
    const out = streamCharByChar("All done here. And one more thought", agg);
    expect(out).toEqual(["All done here.", "And one more thought"]);
  });

  it("never emits the same text twice across many small chunks", () => {
    const agg = new SentenceAggregator();
    const full = "One. Two. Three. Four. Five.";
    const out = streamChunks(full.split(""), agg);
    // Rejoining the emitted sentences reproduces the input exactly (no dropped
    // or double-emitted text). Very short sentences may be batched, so we don't
    // assert an exact count — only the no-loss / no-duplication invariant.
    expect(out.join(" ").replace(/\s+/g, " ").trim()).toBe(full);
    expect(out.length).toBeGreaterThan(0);
    expect(out.length).toBeLessThanOrEqual(5);
  });

  it("holds a too-short fragment until it can stand alone", () => {
    const agg = new SentenceAggregator({ minSentenceChars: 24, firstSentenceChars: 12 });
    // "Hi." (3 chars) is below the 12-char first-sentence floor, so it should be
    // merged forward rather than emitted as its own choppy clip.
    const out = streamCharByChar("Hi. Here is the full detailed answer.", agg);
    expect(out[0]).toBe("Hi. Here is the full detailed answer.");
  });
});
