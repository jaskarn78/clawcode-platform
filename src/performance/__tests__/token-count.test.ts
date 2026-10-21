/**
 * Phase 53 Plan 01 — tests for the canonical token counter.
 *
 * `countTokens` wraps @anthropic-ai/tokenizer so callers never import the
 * raw library directly. These tests pin the contract: zero on empty, positive
 * integer on non-empty, monotonic on concatenation, deterministic on repeat.
 */

import { describe, it, expect } from "vitest";
import { countTokens } from "../token-count.js";

describe("countTokens (Phase 53)", () => {
  it("returns 0 exactly for the empty string", () => {
    expect(countTokens("")).toBe(0);
  });

  it("returns a small positive integer for 'hello world'", () => {
    const n = countTokens("hello world");
    expect(Number.isInteger(n)).toBe(true);
    expect(n).toBeGreaterThanOrEqual(1);
    expect(n).toBeLessThanOrEqual(5);
  });

  it("is monotonically non-decreasing under concatenation (short.repeat(10) > short)", () => {
    const short = "hello world. ";
    const shortN = countTokens(short);
    const longN = countTokens(short.repeat(10));
    expect(longN).toBeGreaterThan(shortN);
  });

  it("is deterministic — same input yields identical integer on repeated calls", () => {
    const sample = "The quick brown fox jumps over the lazy dog.";
    const a = countTokens(sample);
    const b = countTokens(sample);
    expect(a).toBe(b);
    expect(Number.isInteger(a)).toBe(true);
  });
});
