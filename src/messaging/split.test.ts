import { describe, it, expect } from "vitest";
import { splitMessage } from "./split.js";

describe("splitMessage", () => {
  it("returns the text unchanged when within the limit", () => {
    expect(splitMessage("short", 100)).toEqual(["short"]);
  });

  it("splits long text into chunks under the limit", () => {
    const text = "a".repeat(250);
    const chunks = splitMessage(text, 100);
    expect(chunks.length).toBe(3);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(100);
    expect(chunks.join("")).toBe(text);
  });

  it("prefers splitting on a newline boundary (in the latter half of the window)", () => {
    // The algorithm rejects split points before maxLength/2 to avoid tiny
    // chunks (matches the Discord splitter), so place the newline past the
    // halfway mark of the 100-char window.
    const text = "x".repeat(70) + "\n" + "y".repeat(70);
    const chunks = splitMessage(text, 100);
    expect(chunks[0]).toBe("x".repeat(70));
    expect(chunks[1]).toBe("y".repeat(70));
  });

  it("falls back to a space boundary when no good newline exists", () => {
    const text = "word ".repeat(40); // 200 chars, spaces only
    const chunks = splitMessage(text, 100);
    expect(chunks.length).toBeGreaterThan(1);
    // no chunk should exceed the limit
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(100);
  });

  it("hard-splits a single very long token", () => {
    const text = "x".repeat(305);
    const chunks = splitMessage(text, 100);
    expect(chunks.length).toBe(4);
    expect(chunks[0].length).toBe(100);
  });

  it("never returns an empty array (empty input → single empty chunk)", () => {
    expect(splitMessage("", 100)).toEqual([""]);
  });
});
