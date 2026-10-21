import { describe, it, expect } from "vitest";
// Phase 999.8 Plan 02 — RED contract for the extracted nodeClr helper (COLOR-01).
// Source file is created in Task 2 GREEN; this import intentionally fails RED.
import { nodeClr } from "../static/graph-color.js";

describe("nodeClr — 4-color tier palette (Phase 999.8 Plan 02, COLOR-01)", () => {
  it("returns #e06c75 (red) for hot tier with links", () => {
    expect(nodeClr({ tier: "hot", linkCount: 5 })).toBe("#e06c75");
  });

  it("returns #7f6df2 (brand purple) for warm tier with links", () => {
    expect(nodeClr({ tier: "warm", linkCount: 5 })).toBe("#7f6df2");
  });

  it("returns #5a8db8 (muted blue) for cold tier with links", () => {
    expect(nodeClr({ tier: "cold", linkCount: 5 })).toBe("#5a8db8");
  });

  it("orphan check dominates for hot tier with linkCount=0 (returns #444)", () => {
    expect(nodeClr({ tier: "hot", linkCount: 0 })).toBe("#444");
  });

  it("orphan check dominates for warm tier with linkCount=0 (returns #444)", () => {
    expect(nodeClr({ tier: "warm", linkCount: 0 })).toBe("#444");
  });

  it("orphan check dominates for cold tier with linkCount=0 (returns #444)", () => {
    expect(nodeClr({ tier: "cold", linkCount: 0 })).toBe("#444");
  });

  it("missing tier defaults to warm (#7f6df2) when there are links", () => {
    expect(nodeClr({ linkCount: 5 })).toBe("#7f6df2");
  });

  it("missing linkCount is treated as 0 — orphan dominates over tier", () => {
    expect(nodeClr({ tier: "hot" })).toBe("#444");
  });

  it("emits exactly 4 distinct colors across the tier x linkCount matrix", () => {
    const set = new Set([
      nodeClr({ tier: "hot", linkCount: 1 }),
      nodeClr({ tier: "warm", linkCount: 1 }),
      nodeClr({ tier: "cold", linkCount: 1 }),
      nodeClr({ tier: "hot", linkCount: 0 }),
    ]);
    expect(set.size).toBe(4);
  });
});
