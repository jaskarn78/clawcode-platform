// src/dashboard/static/graph-color.js
// Phase 999.8 Plan 02 — extracted from graph.html so the tier-color
// mapping is unit-testable headlessly (vitest, no JSDOM required).
//
// Palette per CONTEXT D-COLOR-01:
//   hot    → #e06c75 (red, unchanged)
//   warm   → #7f6df2 (brand purple, unchanged)
//   cold   → #5a8db8 (muted blue, NEW — split from warm)
//   orphan → #444    (grey, unchanged; dominates over tier when linkCount===0)
export function nodeClr(d) {
  if ((d.linkCount || 0) === 0) return "#444";
  switch (d.tier) {
    case "hot":
      return "#e06c75";
    case "cold":
      return "#5a8db8";
    case "warm":
      return "#7f6df2";
    default:
      return "#7f6df2";
  }
}
