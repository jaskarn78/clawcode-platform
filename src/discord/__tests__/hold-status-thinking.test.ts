/**
 * 999.171 — live thinking on the status trail.
 *
 * Pinned here:
 *   - `formatThinkingTokens` rounding / k-formatting;
 *   - `StatusTrail.setThinking`: thinking is always the CURRENT line
 *     (`→ thinking · 2.4k tokens`, no trailing ellipsis), replaced in place by
 *     a newer count and by the next tool, never promoted to a ✓ done line;
 *   - SC-2: a trail that never receives a thinking event renders
 *     byte-identically to the pre-change module (literals captured from
 *     `git show 0194750d:src/discord/hold-status.ts` run on the same
 *     sequences);
 *   - `composeTrailHeader` reproduces the bridge header verbatim plus the
 *     one new "Thinking" branch;
 *   - the thinking-only first-paint floor.
 */
import { describe, it, expect } from "vitest";
import {
  StatusTrail,
  THINKING_FIRST_PAINT_MIN_MS,
  composeTrailHeader,
  formatThinkingTokens,
  shouldPaintThinkingOnly,
} from "../hold-status.js";
import { formatElapsed } from "../duration-format.js";

describe("formatThinkingTokens", () => {
  it("prints whole tokens below 1000 with the right plural", () => {
    expect(formatThinkingTokens(0)).toBe("0 tokens");
    expect(formatThinkingTokens(1)).toBe("1 token");
    expect(formatThinkingTokens(185)).toBe("185 tokens");
  });

  it("switches to one-decimal k from 1000 (rounding first)", () => {
    expect(formatThinkingTokens(999.6)).toBe("1.0k tokens");
    expect(formatThinkingTokens(2400)).toBe("2.4k tokens");
    expect(formatThinkingTokens(2449)).toBe("2.4k tokens");
    expect(formatThinkingTokens(12345)).toBe("12.3k tokens");
  });
});

describe("StatusTrail.setThinking", () => {
  it("on an empty trail shows the current thinking line under the Thinking header, with no ellipsis", () => {
    const trail = new StatusTrail();
    expect(trail.thinkingSeen).toBe(false);
    expect(trail.setThinking(2400)).toBe(true);
    expect(trail.renderSubtext("Thinking")).toBe("**Thinking**\n-# → thinking · 2.4k tokens");
    expect(trail.thinkingSeen).toBe(true);
  });

  it("an unchanged count is a no-op; a new count replaces the line in place", () => {
    const trail = new StatusTrail();
    trail.setThinking(2400);
    expect(trail.setThinking(2400)).toBe(false);
    expect(trail.setThinking(3100)).toBe(true);
    expect(trail.renderSubtext("Thinking")).toBe("**Thinking**\n-# → thinking · 3.1k tokens");
  });

  it("the next tool replaces the thinking line; thinking is never promoted to a done line", () => {
    const trail = new StatusTrail();
    trail.setThinking(2400);
    expect(trail.push("reading irs.gov")).toBe(true);
    const body = trail.renderSubtext("Working · 1 step");
    expect(body).toBe("**Working · 1 step**\n-# → reading irs.gov…");
    expect(body).not.toContain("thinking");
    expect(trail.render()).toBe("working\n→ reading irs.gov…");
    // thinkingSeen stays latched for the header composer.
    expect(trail.thinkingSeen).toBe(true);
  });

  it("thinking after a tool promotes the tool to done and becomes current", () => {
    const trail = new StatusTrail();
    trail.push("reading a.pdf");
    expect(trail.setThinking(500)).toBe(true);
    expect(trail.renderSubtext("Working · 1 step")).toBe(
      "**Working · 1 step**\n-# ✓ reading a.pdf\n-# → thinking · 500 tokens",
    );
  });

  it("repeated think / tool cycles never leave a ✓ thinking line and keep the done cap", () => {
    const trail = new StatusTrail();
    for (const tool of ["a", "b", "c", "d", "e"]) {
      trail.setThinking(100);
      trail.push(`reading ${tool}.pdf`);
    }
    trail.setThinking(900);
    const body = trail.renderSubtext("Working · 5 steps");
    expect(body).not.toContain("✓ thinking");
    expect(body).toBe(
      "**Working · 5 steps**\n-# ✓ reading c.pdf\n-# ✓ reading d.pdf\n-# ✓ reading e.pdf\n-# → thinking · 900 tokens",
    );
  });

  it("push() refuses the thinking kind — thinking enters only through setThinking", () => {
    const trail = new StatusTrail();
    expect(trail.push("thinking · 5 tokens", "thinking")).toBe(false);
    expect(trail.renderSubtext()).toBe("**Working**");
    expect(trail.thinkingSeen).toBe(false);
  });

  it("rejects NaN, negative and infinite counts", () => {
    const trail = new StatusTrail();
    expect(trail.setThinking(Number.NaN)).toBe(false);
    expect(trail.setThinking(-1)).toBe(false);
    expect(trail.setThinking(Number.POSITIVE_INFINITY)).toBe(false);
    expect(trail.renderSubtext()).toBe("**Working**");
    expect(trail.thinkingSeen).toBe(false);
  });
});

describe("SC-2 — a trail with no thinking event renders exactly as before", () => {
  it("tool items and the done cap at 3 (render + renderSubtext)", () => {
    const trail = new StatusTrail();
    for (const l of [
      "searching “lisbon food”",
      "reading timeout.com",
      "reading eater.com",
      "reading a.pdf",
      "running analysis",
    ]) {
      trail.push(l);
    }
    expect(trail.render()).toBe(
      "working\n✓ reading timeout.com\n✓ reading eater.com\n✓ reading a.pdf\n→ running analysis…",
    );
    expect(trail.renderSubtext("Working · 5 steps · 52s")).toBe(
      "**Working · 5 steps · 52s**\n-# ✓ reading timeout.com\n-# ✓ reading eater.com\n-# ✓ reading a.pdf\n-# → running analysis…",
    );
    expect(trail.thinkingSeen).toBe(false);
  });

  it("speech and claim items (render + renderSubtext)", () => {
    const trail = new StatusTrail();
    trail.push("reading irs.gov");
    trail.push("Checking the plan file next.", "speech");
    trail.push("✓ RMDs begin at 73 · irs.gov");
    expect(trail.render()).toBe(
      "working\n✓ reading irs.gov\n“Checking the plan file next”\n✓ RMDs begin at 73 · irs.gov…",
    );
    expect(trail.renderSubtext()).toBe(
      "**Working**\n-# ✓ reading irs.gov\n-# “Checking the plan file next”\n-# ✓ RMDs begin at 73 · irs.gov…",
    );
  });

  it("dedupe and the empty trail", () => {
    const trail = new StatusTrail();
    expect(trail.push("reading a.pdf")).toBe(true);
    expect(trail.push("reading a.pdf")).toBe(false);
    expect(trail.push("")).toBe(false);
    expect(trail.render()).toBe("working\n→ reading a.pdf…");
    expect(new StatusTrail().renderSubtext()).toBe("**Working**");
    expect(new StatusTrail().render()).toBe("working");
  });
});

describe("composeTrailHeader", () => {
  const base = { claimCount: 0, toolCallsSeen: 0, thinkingSeen: false, elapsedMs: 0 };

  it("bare Working with nothing seen and elapsed under the floor", () => {
    expect(composeTrailHeader(base)).toBe("Working");
  });

  it("counts steps and appends elapsed once past the floor", () => {
    expect(composeTrailHeader({ ...base, toolCallsSeen: 1 })).toBe("Working · 1 step");
    expect(composeTrailHeader({ ...base, toolCallsSeen: 3, elapsedMs: 52_000 })).toBe(
      `Working · 3 steps · ${formatElapsed(52_000)}`,
    );
  });

  it("claims win over everything", () => {
    expect(composeTrailHeader({ ...base, claimCount: 2 })).toBe("Verifying · 2 claims");
    expect(
      composeTrailHeader({ claimCount: 1, toolCallsSeen: 4, thinkingSeen: true, elapsedMs: 0 }),
    ).toBe("Verifying · 1 claim");
  });

  it("Thinking only before the first tool; steps take over after it", () => {
    expect(composeTrailHeader({ ...base, thinkingSeen: true })).toBe("Thinking");
    expect(composeTrailHeader({ ...base, thinkingSeen: true, elapsedMs: 12_000 })).toBe(
      `Thinking · ${formatElapsed(12_000)}`,
    );
    expect(composeTrailHeader({ ...base, thinkingSeen: true, toolCallsSeen: 2 })).toBe(
      "Working · 2 steps",
    );
  });
});

describe("thinking-only first paint floor", () => {
  it("paints a thinking-only turn only from 5 s", () => {
    expect(THINKING_FIRST_PAINT_MIN_MS).toBe(5000);
    expect(shouldPaintThinkingOnly(4999)).toBe(false);
    expect(shouldPaintThinkingOnly(5000)).toBe(true);
    expect(shouldPaintThinkingOnly(Number.NaN)).toBe(false);
    expect(shouldPaintThinkingOnly(900, 1000)).toBe(false);
    expect(shouldPaintThinkingOnly(1000, 1000)).toBe(true);
  });
});
