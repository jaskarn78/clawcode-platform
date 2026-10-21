/** planOutboundTables — which tables become images, placeholders, fail-open, chunk mapping. */
import { describe, it, expect, vi } from "vitest";
import { chunkIndexForFile, isImageWorthy, placeholderLine, planOutboundTables, captionFor, stripTablePlaceholders } from "../table-delivery.js";
import { DEFAULT_TABLE_RENDER_CONFIG, findMarkdownTables, type TableRenderConfig } from "../markdown-table-wrap.js";

const CFG: TableRenderConfig = DEFAULT_TABLE_RENDER_CONFIG;
const fakeRender = vi.fn(async (svg: string) => Buffer.from(`PNG:${svg.length}`));

const wideGrid = [
  "**Firm retirement plan:**",
  "| Option | Max 2026 | Employer cost | Setup | Complexity |",
  "|---|---:|---:|---:|---|",
  "| Do nothing | $0 | $0 | $0 | none |",
  "| Solo 401(k) | $72,000 | $0 | $500 | low |",
  "| SEP IRA | $72,000 | 25% of comp | $0 | low |",
].join("\n");

describe("isImageWorthy", () => {
  it("wide numeric grid → image; 2-col, narrow, prose-like, and oversized tables stay text", () => {
    const [grid] = findMarkdownTables(wideGrid.split("\n"));
    expect(isImageWorthy(grid, CFG)).toBe(true);
    const twoCol = findMarkdownTables(["| A | B |", "|---|---|", "| a very long label indeed for the row | 1 |"])[0];
    expect(isImageWorthy(twoCol, CFG)).toBe(false);
    const narrow = findMarkdownTables(["| Plan | Limit | 50+ |", "|---|---:|---:|", "| IRA | $7,500 | $8,600 |"])[0];
    expect(isImageWorthy(narrow, CFG)).toBe(false); // fits the mobile budget → fenced grid
    const prose = findMarkdownTables([
      "| Option | Pros | Cons |",
      "|---|---|---|",
      "| Guaranteed payments | Predictable W-2-like income and easier mortgage underwriting | Subject to SE tax on the full amount |",
    ])[0];
    expect(isImageWorthy(prose, CFG)).toBe(false); // long cells → cards
    expect(isImageWorthy(grid, { ...CFG, image: { ...CFG.image!, enabled: false } })).toBe(false);
    expect(isImageWorthy(grid, { ...CFG, mode: "cards" })).toBe(false);
    expect(isImageWorthy(grid, { ...CFG, image: { ...CFG.image!, maxRows: 2 } })).toBe(false);
  });
});

describe("planOutboundTables", () => {
  it("replaces an image-worthy table with a placeholder and attaches the PNG with alt text", async () => {
    const plan = await planOutboundTables(`Intro line.\n\n${wideGrid}\n\nOutro.`, { cfg: CFG, render: fakeRender });
    expect(plan.files).toHaveLength(1);
    expect(plan.files[0].name).toBe("table-1.png");
    expect(plan.files[0].attachment.toString()).toMatch(/^PNG:\d+$/);
    expect(plan.files[0].description).toContain("Table — Firm retirement plan. Columns: Option, Max 2026");
    expect(plan.text).toContain("Intro line.");
    expect(plan.text).toContain("Outro.");
    expect(plan.text).not.toContain("| Option |");
    // The caption came from the bold heading directly above, so the
    // placeholder does not repeat it (and no row×column metadata either).
    expect(plan.text).toContain("-# 📊 table below");
    expect(plan.files[0].anchor).toBe("-# 📊 table below");
    // The caption line above the table is kept as prose (title also on the card).
    expect(plan.text).toContain("**Firm retirement plan:**");
  });
  it("leaves non-image tables to the text renderer and returns no files", async () => {
    const twoCol = "| Plan | Limit |\n|---|---|\n| IRA | $7,500 |";
    const plan = await planOutboundTables(twoCol, { cfg: CFG, render: fakeRender });
    expect(plan.files).toHaveLength(0);
    expect(plan.text).toBe("**Plan · Limit**\n**IRA:** $7,500");
  });
  it("fails open to the text renderer when rendering throws", async () => {
    const warn = vi.fn();
    const plan = await planOutboundTables(wideGrid, {
      cfg: CFG,
      render: async () => { throw new Error("resvg missing"); },
      log: { warn },
    });
    expect(plan.files).toHaveLength(0);
    expect(plan.text).toContain("**Do nothing** · Max 2026 **$0**"); // cards fallback
    expect(warn).toHaveBeenCalledTimes(1);
  });
  it("respects image.enabled=false and non-adaptive modes", async () => {
    const off = await planOutboundTables(wideGrid, { cfg: { ...CFG, image: { ...CFG.image!, enabled: false } }, render: fakeRender });
    expect(off.files).toHaveLength(0);
    expect(fakeRender).not.toHaveBeenCalledWith(expect.stringContaining("never"));
    const fence = await planOutboundTables(wideGrid, { cfg: { ...CFG, mode: "fence" }, render: fakeRender });
    expect(fence.files).toHaveLength(0);
    expect(fence.text).toContain("```text");
  });
  it("numbers multiple images and skips fenced tables", async () => {
    const two = `${wideGrid}\n\ntext\n\n\`\`\`\n| a | b | c |\n|---|---|---|\n| 1 | 2 | 3 |\n\`\`\`\n\n${wideGrid.replace("Firm retirement plan", "Second plan")}`;
    const plan = await planOutboundTables(two, { cfg: CFG, render: fakeRender });
    expect(plan.files.map((f) => f.name)).toEqual(["table-1.png", "table-2.png"]);
    expect(plan.text).toContain("table 1 of 2 below");
    expect(plan.text).toContain("table 2 of 2 below");
    expect(plan.text).toContain("| a | b | c |"); // fenced content untouched
  });
});

describe("captionFor / placeholderLine / chunkIndexForFile", () => {
  it("uses a heading or bold line right above the table, else the first header cell", () => {
    const lines = ["## Scenario A", "| Year | Total | Draw |", "|---|---:|---:|", "| 2026 | $1 | $2 |"];
    expect(captionFor(lines, findMarkdownTables(lines)[0])).toBe("Scenario A");
    const bare = ["| Year | Total | Draw |", "|---|---:|---:|", "| 2026 | $1 | $2 |"];
    expect(captionFor(bare, findMarkdownTables(bare)[0])).toBe("Year");
    const far = ["**Heading:**", "", "", "| Year | Total | Draw |", "|---|---:|---:|", "| 2026 | $1 | $2 |"];
    expect(captionFor(far, findMarkdownTables(far)[0])).toBe("Year"); // too far above
  });
  it("placeholder strips markdown and hints at tall tables", () => {
    expect(placeholderLine("**A** | `b`", 14, 3, 1)).toBe("-# 📊 A b · table below · tap to expand");
    expect(placeholderLine("x", 1, 3, 2, 3)).toBe("-# 📊 x · table 2 of 3 below");
    // Title lifted from an adjacent heading is not repeated.
    expect(placeholderLine("Scenario A", 3, 4, 1, 1, { titleFromHeading: true })).toBe("-# 📊 table below");
    // Long captions clip on a word boundary, never mid-word.
    expect(placeholderLine("retirement plan options for the LLP partners with new comparability testing", 3, 4, 1))
      .toMatch(/^-# 📊 retirement plan options for the LLP partners with new( comparability)? · table below$/);
  });
  it("maps a file to the chunk carrying its anchor, else the last chunk", () => {
    const f = { attachment: Buffer.alloc(0), name: "t.png", anchor: "-# 📊 anchor" };
    expect(chunkIndexForFile(["a", "b -# 📊 anchor c", "d"], f)).toBe(1);
    expect(chunkIndexForFile(["a", "b"], { ...f, anchor: "missing" })).toBe(1);
    expect(chunkIndexForFile(["a", "b"], { attachment: Buffer.alloc(0), name: "t.png" })).toBe(1);
  });
});

describe("stripTablePlaceholders (2026-08-28 — PNG rides the same message)", () => {
  it("removes placeholder lines of every shape and collapses blank runs", () => {
    const t = "**Lead.**\n\n-# 📊 Will's tickets · table below\n\nBody.\n\n-# 📊 table 2 of 2 below · tap to expand\n\n-# Sources: x";
    expect(stripTablePlaceholders(t)).toBe("**Lead.**\n\nBody.\n\n-# Sources: x");
    expect(stripTablePlaceholders("no marker")).toBe("no marker");
  });
});
