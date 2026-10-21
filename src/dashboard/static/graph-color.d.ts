/**
 * Phase 999.8 Plan 02 (COLOR-01) — declaration shim for the extracted
 * graph-color.js. The .js file is shipped verbatim to the dashboard
 * static dir (loaded by graph.html), and is unit-tested headlessly by
 * src/dashboard/__tests__/graph-color.test.ts. Adding declarations here
 * keeps the test typecheck-clean without enabling allowJs project-wide.
 */

export type Tier = "hot" | "warm" | "cold" | "frozen";

export interface NodeClrInput {
  // Both fields optional — graph-color.js defaults missing tier to "warm"
  // and missing linkCount to 0 (orphan path). Tests cover both paths.
  readonly tier?: Tier;
  readonly linkCount?: number;
}

export function nodeClr(input: NodeClrInput): string;
