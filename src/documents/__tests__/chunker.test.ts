import { describe, it, expect } from "vitest";
import { chunkText, chunkPdf } from "../chunker.js";

describe("chunkText", () => {
  it("returns empty array for empty string", () => {
    const result = chunkText("", 500, 50);
    expect(result).toEqual([]);
  });

  it("returns empty array for whitespace-only string", () => {
    const result = chunkText("   \n\t  ", 500, 50);
    expect(result).toEqual([]);
  });

  it("returns single chunk for short text", () => {
    const text = "Hello world this is a short text.";
    const result = chunkText(text, 500, 50);
    expect(result).toHaveLength(1);
    expect(result[0].chunkIndex).toBe(0);
    expect(result[0].content).toBe(text);
    expect(result[0].startChar).toBe(0);
    expect(result[0].endChar).toBe(text.length);
  });

  it("returns multiple chunks for long text with correct overlap", () => {
    // Generate ~2000 words (well above 375 words per chunk)
    const words = Array.from({ length: 2000 }, (_, i) => `word${i}`);
    const text = words.join(" ");
    const chunks = chunkText(text, 500, 50);

    // Should produce multiple chunks
    expect(chunks.length).toBeGreaterThan(1);

    // All chunks should have sequential indices
    chunks.forEach((chunk, i) => {
      expect(chunk.chunkIndex).toBe(i);
    });

    // Verify overlap: chunk N+1 should start before chunk N ends
    // (in terms of words, there should be ~37 words of overlap)
    for (let i = 1; i < chunks.length; i++) {
      // The start of chunk i should be before the end of chunk i-1
      // in terms of character positions
      expect(chunks[i].startChar).toBeLessThan(chunks[i - 1].endChar);
    }
  });

  it("chunk boundaries match original text via startChar/endChar", () => {
    const words = Array.from({ length: 800 }, (_, i) => `test${i}`);
    const text = words.join(" ");
    const chunks = chunkText(text, 500, 50);

    for (const chunk of chunks) {
      const extracted = text.slice(chunk.startChar, chunk.endChar);
      expect(extracted).toBe(chunk.content);
    }
  });

  it("uses token-to-word heuristic (1 token ~ 0.75 words)", () => {
    // 500 tokens ~ 375 words. Create exactly 750 words -> should get ~2 chunks
    const words = Array.from({ length: 750 }, (_, i) => `w${i}`);
    const text = words.join(" ");
    const chunks = chunkText(text, 500, 50);
    // With 375 words per chunk and 37 word overlap, step = 338 words
    // 750 / 338 ~ 2.2 -> expect 3 chunks
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    expect(chunks.length).toBeLessThanOrEqual(4);
  });
});

describe("chunkPdf", () => {
  it("rejects invalid buffer", async () => {
    const badBuffer = Buffer.from("this is not a PDF");
    await expect(chunkPdf(badBuffer)).rejects.toThrow();
  });

  it("is an async function that accepts a buffer", () => {
    expect(typeof chunkPdf).toBe("function");
  });
});
