/**
 * Phase 96 Plan 07 Task 2 — RELOADABLE_FIELDS extension tests (WFR-).
 *
 * Wave 3 of Phase 96. Wave 1 (96-01) authored SCHFA-6 as a forward-looking
 * pin asserting `RELOADABLE_FIELDS.has("agents.*.fileAccess") === false`.
 * THIS plan (96-07) extends RELOADABLE_FIELDS with 4 new entries:
 *   - agents.*.fileAccess  (Phase 96 D-03 — fs-capability re-probe on edit)
 *   - defaults.fileAccess  (Phase 96 D-03)
 *   - agents.*.outputDir   (Phase 96 D-09 — share-file outputDir resolution)
 *   - defaults.outputDir   (Phase 96 D-09)
 *
 * After this plan lands, the SCHFA-6 forward-looking assertion in
 * src/config/__tests__/schema-fileAccess.test.ts FLIPS from `false` to `true`
 * (handled in the same task — RED→GREEN includes both files).
 *
 * Reload semantics (CHOSEN — simpler heartbeat-tick fallback, per
 * 96-07-PLAN.md `<rule id="2">` Alternative simpler approach):
 *   - Watcher classifies fileAccess + outputDir change as reloadable
 *     (RELOADABLE_FIELDS extension below) — daemon does NOT restart
 *   - Next heartbeat tick (≤60s) within fs-probe check (Task 1) reads
 *     the freshly-loaded fileAccess paths via deps.getResolvedConfig
 *     and runs runFsProbe with new paths
 *   - Operator workflow: edit clawcode.yaml → up to 60s lag for fresh
 *     capability snapshot. Sub-60s response: run /clawcode-probe-fs
 *     <agent> manually (96-05).
 *
 * Tests pin:
 *   - WFR-FILEACCESS-RELOADABLE         agents.*.fileAccess  ∈ RELOADABLE_FIELDS
 *   - WFR-DEFAULTS-FILEACCESS-RELOADABLE defaults.fileAccess ∈ RELOADABLE_FIELDS
 *   - WFR-OUTPUTDIR-RELOADABLE          agents.*.outputDir   ∈ RELOADABLE_FIELDS
 *   - WFR-DEFAULTS-OUTPUTDIR-RELOADABLE defaults.outputDir   ∈ RELOADABLE_FIELDS
 *   - WFR-NON-FILEACCESS-UNCHANGED      no regression on existing entries
 *   - WFR-NON-RELOADABLE-PRESERVED      agents.*.model is still NOT reloadable
 */
import { describe, it, expect } from "vitest";

import { RELOADABLE_FIELDS, NON_RELOADABLE_FIELDS } from "../types.js";

describe("Phase 96 Plan 07 Task 2 — RELOADABLE_FIELDS extension (WFR-)", () => {
  it("WFR-FILEACCESS-RELOADABLE: agents.*.fileAccess is classified reloadable", () => {
    // 96-07 D-03: fs-capability re-probe fires on edit; no daemon restart.
    expect(RELOADABLE_FIELDS.has("agents.*.fileAccess")).toBe(true);
  });

  it("WFR-DEFAULTS-FILEACCESS-RELOADABLE: defaults.fileAccess is classified reloadable", () => {
    expect(RELOADABLE_FIELDS.has("defaults.fileAccess")).toBe(true);
  });

  it("WFR-OUTPUTDIR-RELOADABLE: agents.*.outputDir is classified reloadable", () => {
    // 96-07 D-09: outputDir affects clawcode_share_file behavior at runtime;
    // resolveOutputDirTemplate is read lazily on each share. No restart.
    expect(RELOADABLE_FIELDS.has("agents.*.outputDir")).toBe(true);
  });

  it("WFR-DEFAULTS-OUTPUTDIR-RELOADABLE: defaults.outputDir is classified reloadable", () => {
    expect(RELOADABLE_FIELDS.has("defaults.outputDir")).toBe(true);
  });

  it("WFR-NON-FILEACCESS-UNCHANGED: existing reloadable entries still classified correctly", () => {
    // No regression on Phase 22 / Phase 83 / Phase 86 / Phase 89 / Phase 90 /
    // Phase 94 / Phase 95 entries. Sample check across phases.
    expect(RELOADABLE_FIELDS.has("agents.*.channels")).toBe(true);
    expect(RELOADABLE_FIELDS.has("agents.*.skills")).toBe(true);
    expect(RELOADABLE_FIELDS.has("agents.*.heartbeat")).toBe(true);
    expect(RELOADABLE_FIELDS.has("agents.*.effort")).toBe(true);
    expect(RELOADABLE_FIELDS.has("agents.*.allowedModels")).toBe(true);
    expect(RELOADABLE_FIELDS.has("agents.*.greetOnRestart")).toBe(true);
    expect(RELOADABLE_FIELDS.has("agents.*.memoryAutoLoad")).toBe(true);
    expect(RELOADABLE_FIELDS.has("agents.*.systemPromptDirectives")).toBe(true);
    expect(RELOADABLE_FIELDS.has("agents.*.dream")).toBe(true);
  });

  it("WFR-NON-RELOADABLE-PRESERVED: agents.*.model + workspace + memoryPath remain NOT reloadable", () => {
    // The NON_RELOADABLE_FIELDS Set is documentation-of-intent (the differ
    // falls through to false for any field not in RELOADABLE_FIELDS), but
    // both invariants must hold: NOT in RELOADABLE_FIELDS AND in
    // NON_RELOADABLE_FIELDS where present.
    expect(RELOADABLE_FIELDS.has("agents.*.model")).toBe(false);
    expect(RELOADABLE_FIELDS.has("agents.*.workspace")).toBe(false);
    expect(RELOADABLE_FIELDS.has("agents.*.memoryPath")).toBe(false);

    expect(NON_RELOADABLE_FIELDS.has("agents.*.model")).toBe(true);
    expect(NON_RELOADABLE_FIELDS.has("agents.*.workspace")).toBe(true);
    expect(NON_RELOADABLE_FIELDS.has("agents.*.memoryPath")).toBe(true);
  });
});
