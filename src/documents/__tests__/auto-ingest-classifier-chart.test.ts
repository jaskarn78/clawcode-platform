/**
 * Phase 999.43-fu2 Path B T04 — `isChartLike` chart-detection predicate.
 *
 * 8 test fixtures per brief: 5 chart-like + 3 non-chart controls.
 *
 * The fixtures explicitly cover all three rungs (filename, vision keywords,
 * aspect ratio) plus the no-cue control:
 *
 *   Chart-like (5):
 *     1. Filename keyword "candle"
 *     2. Filename keyword "trend"
 *     3. Vision keyword "x-axis" — filename neutral, vision-analysis hits
 *     4. Vision keyword "candlestick" — both filename and vision say chart
 *     5. Aspect ratio ≥ 1.6 — filename + vision neutral, only dimensions hit
 *
 *   Non-chart controls (3):
 *     6. Square dashboard — filename has no keyword, vision says "dashboard",
 *        aspect ratio 1.0
 *     7. Photo — filename "vacation-2026", vision says "beach photo", 4:3
 *        aspect (1.33 — below threshold)
 *     8. Tall portrait screenshot of a form — aspect 0.5, no chart keywords
 */

import { describe, it, expect } from "vitest";
import { isChartLike } from "../auto-ingest-classifier.js";

describe("isChartLike — chart-detection cascade (Phase 999.43-fu2 T04)", () => {
  // ---- chart-like fixtures ----
  it("Fixture 1: filename 'candle' → isChart true", () => {
    const r = isChartLike({
      filename: "aapl-candle-2026-05-17.png",
    });
    expect(r.isChart).toBe(true);
    expect(r.reason).toMatch(/filename keyword \(candle\)/);
  });

  it("Fixture 2: filename 'trend' → isChart true", () => {
    const r = isChartLike({
      filename: "portfolio-trend-line.png",
    });
    expect(r.isChart).toBe(true);
    expect(r.reason).toMatch(/filename keyword \(trend\)/);
  });

  it("Fixture 3: vision keyword 'x-axis' (filename neutral) → isChart true", () => {
    const r = isChartLike({
      filename: "image0.png",
      visionAnalysis:
        "TYPE: chart\nSUMMARY: A line plot with labeled x-axis and y-axis showing values over time.",
    });
    expect(r.isChart).toBe(true);
    expect(r.reason).toMatch(/vision keyword \(x-axis\)/);
  });

  it("Fixture 4: filename + vision both say chart → filename hits first (short-circuit)", () => {
    const r = isChartLike({
      filename: "chart-snapshot.png",
      visionAnalysis: "TYPE: chart\nSUMMARY: A candlestick view of AAPL.",
    });
    expect(r.isChart).toBe(true);
    // Filename rung short-circuits before vision rung — reason cites filename.
    expect(r.reason).toMatch(/filename keyword \(chart\)/);
  });

  it("Fixture 5: aspect ratio 1.78 (no filename/vision cue) → isChart true via dimensions rung", () => {
    const r = isChartLike({
      filename: "image-2026-05-17.png",
      visionAnalysis:
        "TYPE: other\nSUMMARY: A wide screenshot. UI_STATE: none",
      dimensions: { widthPx: 1920, heightPx: 1080 },
    });
    expect(r.isChart).toBe(true);
    expect(r.reason).toMatch(/aspect ratio 1\.78 >= 1\.6/);
  });

  // ---- non-chart control fixtures ----
  it("Fixture 6: square dashboard, no keyword, ratio 1.0 → isChart false", () => {
    const r = isChartLike({
      filename: "dashboard-snapshot.png",
      visionAnalysis:
        "TYPE: screenshot\nSUMMARY: A square dashboard tile.",
      dimensions: { widthPx: 800, heightPx: 800 },
    });
    expect(r.isChart).toBe(false);
    expect(r.reason).toBe("no chart cues");
  });

  it("Fixture 7: photo, ratio 1.33 (below threshold) → isChart false", () => {
    const r = isChartLike({
      filename: "vacation-2026-beach.jpg",
      visionAnalysis:
        "TYPE: photo\nSUMMARY: A beach photo with palm trees.",
      dimensions: { widthPx: 4032, heightPx: 3024 },
    });
    expect(r.isChart).toBe(false);
    expect(r.reason).toBe("no chart cues");
  });

  it("Fixture 8: tall portrait form screenshot → isChart false", () => {
    const r = isChartLike({
      filename: "Screenshot 2026-05-17 form-fill.png",
      visionAnalysis:
        "TYPE: screenshot\nSUMMARY: A web form with several input fields.",
      dimensions: { widthPx: 600, heightPx: 1200 },
    });
    expect(r.isChart).toBe(false);
    expect(r.reason).toBe("no chart cues");
  });

  // ---- defensive: no inputs at all ----
  it("Edge: filename-only with no chart keyword and no dimensions → isChart false", () => {
    const r = isChartLike({ filename: "random-image.png" });
    expect(r.isChart).toBe(false);
  });
});
