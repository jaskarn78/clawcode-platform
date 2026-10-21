/**
 * Phase 999.79 (2026-05-23) — text-sanitization unit tests.
 *
 * Cover stripEmDashes behavior + the composed formatOutboundText
 * (strip-then-wrap) order. The strip is the deterministic guarantee
 * that em dashes never reach a Discord surface; these tests pin both
 * the basic prose case AND the block-aware preservation cases.
 */

import { describe, it, expect } from "vitest";
import { performance } from "node:perf_hooks";

import { stripEmDashes } from "../text-sanitization.js";
import { formatOutboundText } from "../markdown-table-wrap.js";

describe("Phase 999.79 — stripEmDashes", () => {
  it("Test 1: replaces basic prose em dash with space-hyphen-space", () => {
    expect(stripEmDashes("Hello—world.")).toBe("Hello - world.");
    expect(stripEmDashes("It was hot—really hot.")).toBe(
      "It was hot - really hot.",
    );
  });

  it("Test 2: collapses adjacent horizontal whitespace around the em dash", () => {
    // ` — ` (space, em dash, space) → ` - `
    expect(stripEmDashes("foo — bar")).toBe("foo - bar");
    // `— ` (em dash, space) → ` - `
    expect(stripEmDashes("foo— bar")).toBe("foo - bar");
    // ` —` (space, em dash) → ` - `
    expect(stripEmDashes("foo —bar")).toBe("foo - bar");
    // `—` (no spaces) → ` - ` (adds spaces — matches casual typing)
    expect(stripEmDashes("foo—bar")).toBe("foo - bar");
    // Multiple horizontal spaces collapse to single space
    expect(stripEmDashes("foo   —   bar")).toBe("foo - bar");
    // Tabs treated as horizontal whitespace
    expect(stripEmDashes("foo\t—\tbar")).toBe("foo - bar");
  });

  it("Test 3: preserves em dashes inside fenced code blocks", () => {
    const input = [
      "Some prose — with em dash.",
      "```",
      "code with — em dash",
      "more code — here",
      "```",
      "More prose — with em dash.",
    ].join("\n");
    const expected = [
      "Some prose - with em dash.",
      "```",
      "code with — em dash",
      "more code — here",
      "```",
      "More prose - with em dash.",
    ].join("\n");
    expect(stripEmDashes(input)).toBe(expected);
  });

  it("Test 3b: preserves em dashes inside fenced code blocks with language tag", () => {
    const input = [
      "Prose — first.",
      "```typescript",
      "const x = '—'; // em dash literal",
      "```",
      "Prose — second.",
    ].join("\n");
    const result = stripEmDashes(input);
    expect(result).toContain("const x = '—'");
    expect(result).toContain("Prose - first.");
    expect(result).toContain("Prose - second.");
  });

  it("Test 4: preserves em dashes inside inline code spans", () => {
    expect(stripEmDashes("Run `cmd—flag` to see output.")).toBe(
      "Run `cmd—flag` to see output.",
    );
    // Mixed prose + inline code: prose stripped, span preserved.
    expect(stripEmDashes("Prose — with `code—span` — more prose.")).toBe(
      "Prose - with `code—span` - more prose.",
    );
  });

  it("Test 5: preserves en dashes (negative test — they have valid grammatical uses)", () => {
    // En dash (U+2013) for number ranges — must survive.
    expect(stripEmDashes("Years 1990–2020 inclusive.")).toBe(
      "Years 1990–2020 inclusive.",
    );
    expect(stripEmDashes("Pages 12–17 cover the topic.")).toBe(
      "Pages 12–17 cover the topic.",
    );
    // Mixed: em dash stripped, en dash preserved.
    expect(stripEmDashes("The span — covers 1990–2020 fully.")).toBe(
      "The span - covers 1990–2020 fully.",
    );
  });

  it("Test 6: idempotency — applying twice yields the same result as once", () => {
    const inputs = [
      "Plain prose — with em dash.",
      "```\ncode — preserved\n```",
      "Inline `code—stays` here.",
      "Mixed — text `with—span` and ```\nfenced — block\n```.",
      "", // empty
      "No em dash here.", // fast path
    ];
    for (const input of inputs) {
      const once = stripEmDashes(input);
      const twice = stripEmDashes(once);
      expect(twice).toBe(once);
    }
  });

  it("Test 7: composed idempotency — formatOutboundText is idempotent over the wrap+strip composition", () => {
    const inputs = [
      "| Col1 | Col2 |\n| --- | --- |\n| Em — dash | val |",
      "Prose — with table:\n| A | B |\n| - | - |\n| x | y |\nMore prose.",
      "Code: ```\ncode — preserved\n```",
      "```\nfenced em dash —\n```\nthen prose — with em dash.",
    ];
    for (const input of inputs) {
      const once = formatOutboundText(input);
      const twice = formatOutboundText(once);
      expect(twice).toBe(once);
    }
  });

  it("Test 8: em dashes inside table cells get stripped (pins strip-BEFORE-wrap composition order)", () => {
    // A markdown table with an em dash in a cell. If composition were
    // wrap-then-strip, the table would be wrapped FIRST (em dash now
    // inside a code fence), then the strip would preserve it → em
    // dash survives in the cell. THAT IS WRONG. We want strip-first
    // so the cell's em dash becomes " - " BEFORE the table is fenced.
    // 3-column narrow table → adaptive renders an aligned grid in a code
    // fence, so the strip-then-fence composition is still exercised. (A
    // 2-column table would render as key/value with no fence.)
    const input = [
      "| Col1 | Col2 | Col3 |",
      "| --- | --- | --- |",
      "| Em — dash | other | x |",
    ].join("\n");
    const result = formatOutboundText(input);
    // The em dash must be gone (replaced with " - ").
    expect(result).not.toContain("—");
    expect(result).toContain("Em - dash");
    // And the table is still wrapped in a code fence (the render ran).
    expect(result).toMatch(/^```text\n/);
    expect(result).toMatch(/\n```$/);
  });

  it("Test 9: unclosed fence at end of input treats trailing content as code (conservative-safe)", () => {
    // Single opening fence with no close — everything after is treated
    // as code, em dashes preserved. This is the conservative-on-
    // unclosed-fence behavior that makes streaming partial output safe.
    const input = [
      "Prose — gets stripped.",
      "```",
      "code — with em dash, fence never closes",
      "more code — also preserved",
    ].join("\n");
    const result = stripEmDashes(input);
    expect(result).toContain("Prose - gets stripped.");
    // After the opening fence, em dashes survive.
    expect(result).toContain("code — with em dash");
    expect(result).toContain("more code — also preserved");
  });

  it("Test 10: 10 KB input single-pass perf sanity (< 50 ms)", () => {
    // Build a ~10 KB string of prose interspersed with em dashes and
    // a few fenced blocks. Em dash density chosen to exercise the
    // replacement path heavily.
    // Each "sentence" terminates with \n so prose repeats become
    // distinct lines — guarantees the subsequent code-block opener
    // starts on its own line (required by the fence detection
    // heuristic, which is line-anchored).
    const sentence = "The quick brown fox jumps over — the lazy dog.\n";
    const code = "```\nconst x = 1; // — fenced\n```\n";
    const blocks = [
      sentence.repeat(110), // ~5 KB prose
      code,                 // ~30 B code
      sentence.repeat(110), // ~5 KB more prose
      code,                 // ~30 B code
    ];
    const input = blocks.join("");
    expect(input.length).toBeGreaterThan(10_000);

    const t0 = performance.now();
    const result = stripEmDashes(input);
    const elapsed = performance.now() - t0;

    expect(elapsed).toBeLessThan(50);
    // Em dashes outside fences are gone.
    expect(result).not.toMatch(/fox jumps over —/);
    // Em dashes inside fences survived.
    expect(result).toContain("// — fenced");
  });

  it("Test 11: empty + no-dash fast paths return input unchanged", () => {
    expect(stripEmDashes("")).toBe("");
    expect(stripEmDashes("No dashes anywhere.")).toBe("No dashes anywhere.");
    // Number-range en-dash without surrounding whitespace stays on the
    // fast path because the function STILL needs to enter to check the
    // padded-en-dash rule, but the in-prose helper short-circuits when
    // the padded pattern doesn't match. Final output is identical.
    const noStrip = "Just hyphens - and en dashes 1990–2020.";
    expect(stripEmDashes(noStrip)).toBe(noStrip);
  });
});

describe("Phase 999.79 follow-up (2026-05-23) — space-padded en-dash strip", () => {
  // Production observation after the em-dash strip shipped: the model
  // started substituting en dashes (U+2013) in the SAME prose-separator
  // role (`document – the CH-100 petition`). These tests pin the
  // space-padded en-dash rule WHILE preserving legitimate number-range
  // / score-line / compound-modifier usage.

  it("strips a space-padded en dash in prose (the model-substitution failure mode)", () => {
    expect(stripEmDashes("document – the CH-100 petition")).toBe(
      "document - the CH-100 petition",
    );
    expect(stripEmDashes("Hello – world.")).toBe("Hello - world.");
  });

  it("preserves number-range en dashes (no surrounding whitespace)", () => {
    expect(stripEmDashes("Years 1990–2020 inclusive.")).toBe(
      "Years 1990–2020 inclusive.",
    );
    expect(stripEmDashes("Pages 12–17 cover the topic.")).toBe(
      "Pages 12–17 cover the topic.",
    );
    expect(stripEmDashes("The 4–3 score.")).toBe("The 4–3 score.");
  });

  it("preserves compound-modifier en dashes (`New York–based`)", () => {
    expect(stripEmDashes("a New York–based firm")).toBe(
      "a New York–based firm",
    );
    expect(stripEmDashes("the pre–World War II era")).toBe(
      "the pre–World War II era",
    );
  });

  it("preserves asymmetric en dashes (whitespace on only one side — typo class, conservatively preserved)", () => {
    // Space on left only — not the prose-separator AI-tell pattern.
    expect(stripEmDashes("foo –bar")).toBe("foo –bar");
    // Space on right only.
    expect(stripEmDashes("foo– bar")).toBe("foo– bar");
  });

  it("collapses multiple horizontal whitespace around the padded en dash", () => {
    expect(stripEmDashes("foo   –   bar")).toBe("foo - bar");
    expect(stripEmDashes("foo\t–\tbar")).toBe("foo - bar");
  });

  it("preserves padded en dashes inside fenced code blocks", () => {
    const input = [
      "Prose – with padded en dash.",
      "```",
      "code – with en dash",
      "```",
      "More prose – with padded en dash.",
    ].join("\n");
    const expected = [
      "Prose - with padded en dash.",
      "```",
      "code – with en dash",
      "```",
      "More prose - with padded en dash.",
    ].join("\n");
    expect(stripEmDashes(input)).toBe(expected);
  });

  it("preserves padded en dashes inside inline code spans", () => {
    expect(stripEmDashes("see `foo – bar` here")).toBe("see `foo – bar` here");
  });

  it("strips em AND padded en dashes in the same input (mixed)", () => {
    expect(
      stripEmDashes("First — em dash, then – padded en dash."),
    ).toBe("First - em dash, then - padded en dash.");
  });

  it("is idempotent over the en-dash extension", () => {
    const input = "Prose – with padded en dash and 1990–2020 ranges.";
    const once = stripEmDashes(input);
    const twice = stripEmDashes(once);
    expect(twice).toBe(once);
    expect(once).toBe("Prose - with padded en dash and 1990–2020 ranges.");
  });
});
