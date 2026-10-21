import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// Phase 999.8 Plan 02 — RED static-HTML parse coverage for the tier legend (COLOR-02).
// Anchors path against the test file location so vitest resolves correctly
// regardless of cwd (RESEARCH Pitfall 8 mitigation).
const __dirname = dirname(fileURLToPath(import.meta.url));
const graphHtmlPath = join(__dirname, "../static/graph.html");

let html = "";
beforeAll(() => {
  html = readFileSync(graphHtmlPath, "utf8");
});

describe("graph.html tier legend (Phase 999.8 Plan 02, COLOR-02)", () => {
  it("contains a .graph-legend container", () => {
    expect(html).toMatch(/class="graph-legend"/);
  });

  it("uses native <details open> for collapse (matches existing Forces-panel idiom)", () => {
    expect(html).toMatch(/<details open>/);
  });

  it("contains exactly 4 .legend-row blocks — one per tier (hot, warm, cold, orphan)", () => {
    expect(html).toMatch(/<div class="legend-row" data-tier="hot"/);
    expect(html).toMatch(/<div class="legend-row" data-tier="warm"/);
    expect(html).toMatch(/<div class="legend-row" data-tier="cold"/);
    expect(html).toMatch(/<div class="legend-row" data-tier="orphan"/);
    const rows = html.match(/<div class="legend-row" data-tier="/g) || [];
    expect(rows.length).toBe(4);
  });

  it("each tier swatch uses the canonical hex from D-COLOR-01", () => {
    expect(html).toMatch(/background:\s*#e06c75/);
    expect(html).toMatch(/background:\s*#7f6df2/);
    expect(html).toMatch(/background:\s*#5a8db8/);
    expect(html).toMatch(/background:\s*#444/);
  });

  it("exposes count placeholders with ids ct-hot, ct-warm, ct-cold, ct-orphan", () => {
    expect(html).toMatch(/id="ct-hot"/);
    expect(html).toMatch(/id="ct-warm"/);
    expect(html).toMatch(/id="ct-cold"/);
    expect(html).toMatch(/id="ct-orphan"/);
  });

  it("legend container is positioned absolute (HTML overlay, not inside <svg> — Pitfall 4)", () => {
    expect(html).toMatch(/\.graph-legend\s*\{[^}]*position:\s*absolute/);
  });
});
