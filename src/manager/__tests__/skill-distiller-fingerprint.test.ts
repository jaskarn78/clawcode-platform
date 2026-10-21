/**
 * Phase 132 Plan 01 T-02 — trajectory fingerprint helper.
 *
 * Backs D-07 sticky-rejection dedup: rejected drafts' trajectory
 * fingerprints are stored alongside the rejection record so a similar
 * future trajectory (same tool composition, different parameters)
 * collapses to the same hash and is SKIPPED at distillation time.
 *
 * Per CONTEXT.md §specifics: "SHA256 of sorted-unique tool-call names +
 * count buckets. Drops parameter content."
 */

import { describe, it, expect } from "vitest";
import {
  trajectoryFingerprint,
  normalizeTrajectory,
} from "../skill-distiller-fingerprint.js";

describe("trajectoryFingerprint (Phase 132 T-02 / D-07)", () => {
  it("FP-01: same trajectory shape with different timestamps → identical fingerprint (param-content dropped)", () => {
    const a = trajectoryFingerprint([
      { tool: "bash", ts: 1 },
      { tool: "bash", ts: 2 },
      { tool: "edit", ts: 3 },
    ]);
    const b = trajectoryFingerprint([
      { tool: "bash", ts: 5 },
      { tool: "bash", ts: 6 },
      { tool: "edit", ts: 7 },
    ]);
    expect(a).toBe(b);
  });

  it("FP-02: different tool composition → different fingerprint", () => {
    const a = trajectoryFingerprint([
      { tool: "bash", ts: 1 },
      { tool: "edit", ts: 2 },
    ]);
    const b = trajectoryFingerprint([
      { tool: "bash", ts: 1 },
      { tool: "read", ts: 2 },
    ]);
    expect(a).not.toBe(b);
  });

  it("FP-03: count-bucket sensitivity — bash×3 vs bash×5 produce different fingerprints", () => {
    const a = trajectoryFingerprint([
      { tool: "bash" },
      { tool: "bash" },
      { tool: "bash" },
    ]);
    const b = trajectoryFingerprint([
      { tool: "bash" },
      { tool: "bash" },
      { tool: "bash" },
      { tool: "bash" },
      { tool: "bash" },
    ]);
    expect(a).not.toBe(b);
  });

  it("FP-04: order-insensitive (sorted-unique normalization per §specifics)", () => {
    const a = trajectoryFingerprint([
      { tool: "bash" },
      { tool: "edit" },
      { tool: "read" },
    ]);
    const b = trajectoryFingerprint([
      { tool: "read" },
      { tool: "edit" },
      { tool: "bash" },
    ]);
    expect(a).toBe(b);
  });

  it("FP-05: empty trajectory → SHA256 of canonical empty string", () => {
    const fp = trajectoryFingerprint([]);
    // SHA256("") = e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
    expect(fp).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });

  it("FP-06: fingerprint is exactly 64 lowercase hex chars", () => {
    const fp = trajectoryFingerprint([
      { tool: "bash" },
      { tool: "edit" },
    ]);
    expect(fp).toHaveLength(64);
    expect(fp).toMatch(/^[0-9a-f]{64}$/);
  });

  it("FP-07: normalizeTrajectory exposes sorted-unique {tool,count} entries for telemetry", () => {
    const norm = normalizeTrajectory([
      { tool: "edit" },
      { tool: "bash" },
      { tool: "bash" },
      { tool: "read" },
      { tool: "bash" },
    ]);
    // Sorted ascending by tool name: bash, edit, read
    expect(norm).toEqual([
      { tool: "bash", count: 3 },
      { tool: "edit", count: 1 },
      { tool: "read", count: 1 },
    ]);
  });

  it("FP-bonus: tool-name case is normalized (lowercase) so 'Bash' and 'bash' collapse", () => {
    const a = trajectoryFingerprint([{ tool: "Bash" }, { tool: "edit" }]);
    const b = trajectoryFingerprint([{ tool: "bash" }, { tool: "edit" }]);
    expect(a).toBe(b);
  });
});
