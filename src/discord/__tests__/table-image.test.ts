/** Table image — pure layout/SVG + one real resvg render (embedded font). */
import { describe, it, expect } from "vitest";
import {
  buildAltText,
  buildTableSvg,
  looksNumeric,
  normalizeCellText,
  wrapText,
  TABLE_IMAGE_STYLE,
  ALT_TEXT_MAX,
} from "../table-image/table-image.js";
import { renderSvgToPng, ensureFontFiles } from "../table-image/render-png.js";
import { existsSync } from "node:fs";

describe("normalizeCellText", () => {
  it("strips inline markdown and maps emoji to glyphs the embedded font has", () => {
    expect(normalizeCellText("**$72,000**")).toBe("$72,000");
    expect(normalizeCellText("[irs.gov](https://irs.gov/x)")).toBe("irs.gov");
    expect(normalizeCellText("✅ best fit")).toBe("✓ best fit");
    expect(normalizeCellText("❌ too small")).toBe("✗ too small");
    expect(normalizeCellText("⚠️ only if")).toBe("⚠ only if");
    expect(normalizeCellText("🆕 added")).toBe("NEW added");
    expect(normalizeCellText("a \\| b")).toBe("a | b");
  });
  it("drops glyphs outside the subset instead of rendering tofu", () => {
    expect(normalizeCellText("🚀 launch 中文")).toBe("launch");
  });
});

describe("looksNumeric / wrapText", () => {
  it("recognises money, percentages, negatives, dashes", () => {
    for (const s of ["$72,000", "3%", "(1,200)", "-$4.50", "1.2M", "—", "n/a", "25 bps"]) expect(looksNumeric(s)).toBe(true);
    for (const s of ["low", "3% match", "Solo 401(k)", ""]) expect(looksNumeric(s)).toBe(false);
  });
  it("wraps on words and hard-splits only over-long tokens", () => {
    expect(wrapText("leaves $72,000 on the table", 12)).toEqual(["leaves", "$72,000 on", "the table"]);
    expect(wrapText("comparability", 6)).toEqual(["compar", "abilit", "y"]);
    expect(wrapText("", 10)).toEqual([""]);
  });
});

const header = ["Option", "Max 2026", "Employer cost", "Setup", "Complexity", "Fits client-b?"];
const rows = [
  ["Do nothing", "$0", "$0", "$0", "none", "❌ leaves $72,000 on the table"],
  ["Solo 401(k)", "$72,000", "$0", "$500", "low", "✅ best fit"],
  ["401(k) + new comparability", "$72,000", "~$9,000", "$3,500", "high", "❌ overkill at 2 employees"],
];

describe("buildTableSvg", () => {
  it("lays out within the max width, right-aligns numeric columns, keeps words whole", () => {
    const l = buildTableSvg({ header, rows, title: "Firm retirement plan — 2026 comparison" });
    expect(l.width).toBeLessThanOrEqual(TABLE_IMAGE_STYLE.maxWidth);
    expect(l.width).toBeGreaterThanOrEqual(TABLE_IMAGE_STYLE.minWidth);
    expect(l.nCols).toBe(6);
    expect(l.nRows).toBe(3);
    expect(l.svg.startsWith("<svg")).toBe(true);
    // Numeric "Max 2026" column → text-anchor end; first column → start.
    expect(l.svg).toMatch(/text-anchor="end">\$72,000</);
    expect(l.svg).toMatch(/text-anchor="start">Solo 401\(k\)</);
    // Words are never split: every rendered fragment of the long label is a whole word.
    expect(l.svg).not.toMatch(/>comparabilit</);
    expect(l.svg).toContain(">comparability<");
    // Emoji mapped, XML escaped.
    expect(l.svg).toContain("✓ best fit");
    expect(l.svg).not.toContain("✅");
    expect(l.svg).toContain("Firm retirement plan — 2026 comparison");
  });
  it("escapes XML specials and survives ragged / empty tables", () => {
    const l = buildTableSvg({ header: ["A & B", "<C>"], rows: [["1"], ["2", "x\"y", "extra"]] });
    expect(l.svg).toContain("A &amp; B");
    expect(l.svg).toContain("&lt;C&gt;");
    expect(l.svg).toContain("x&quot;y");
    expect(l.nCols).toBe(3);
    const empty = buildTableSvg({ header: ["A"], rows: [] });
    expect(empty.svg).toContain("(no rows)");
  });
  it("alt text names the columns and rows, capped", () => {
    const alt = buildAltText("T", ["Year", "Total"], [["2026", "$715,500"]]);
    expect(alt).toBe("Table — T. Columns: Year, Total. 2026: Total $715,500.");
    const big = buildAltText("", ["A", "B"], Array.from({ length: 200 }, (_, i) => [`r${i}`, "v".repeat(40)]));
    expect(big.length).toBeLessThanOrEqual(ALT_TEXT_MAX);
    expect(big).toContain("(truncated)");
  });
});

describe("renderSvgToPng (real resvg + embedded JetBrains Mono)", () => {
  it("materialises the fonts once and renders a 2× PNG", async () => {
    const fonts = ensureFontFiles();
    expect(fonts).toHaveLength(2);
    for (const f of fonts) expect(existsSync(f)).toBe(true);
    const l = buildTableSvg({ header, rows, title: "t" });
    const png = await renderSvgToPng(l.svg, { scale: 2 });
    // PNG signature + IHDR width/height at 2× the logical size.
    expect(png.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
    expect(png.readUInt32BE(16)).toBe(l.width * 2);
    expect(png.readUInt32BE(20)).toBe(l.height * 2);
    expect(png.length).toBeGreaterThan(5_000);
  }, 20_000);
});
