/**
 * Phase 132 Plan 01 T-03 — eligibility filter (threshold-matrix tests).
 *
 * Per CONTEXT.md D-03: minToolCalls=6, minDurationMs=180_000, outcomeFilter=["success"]
 * Per D-08: default OFF — config.enabled=false short-circuits regardless of trajectory.
 *
 * The filter is the FIRST gate (count/duration/outcome). Plan 02's
 * distiller chains the SECOND gate (fingerprint dedup via T-02 module)
 * downstream — eligibility filter does NOT compute fingerprints itself.
 */

import { describe, it, expect } from "vitest";
import {
  isEligibleForDistillation,
  type TaskCompletedEvent,
  type SkillDistillerConfig,
} from "../skill-distiller-eligibility.js";

const defaultConfig: SkillDistillerConfig = {
  enabled: true,
  minToolCalls: 6,
  minDurationMs: 180_000,
  outcomeFilter: ["success"],
};

function event(overrides: Partial<TaskCompletedEvent>): TaskCompletedEvent {
  return {
    agent: "Admin Clawdy",
    sessionId: "sess-test",
    trajectory: [],
    durationMs: 200_000,
    toolCallCount: 6,
    outcome: "success",
    ...overrides,
  };
}

describe("isEligibleForDistillation (Phase 132 T-03)", () => {
  it("E-01: enabled=false → reason=disabled (D-08 gate fires first)", () => {
    const result = isEligibleForDistillation(
      event({ toolCallCount: 999, durationMs: 999_999_999 }),
      { ...defaultConfig, enabled: false },
    );
    expect(result.eligible).toBe(false);
    if (!result.eligible) {
      expect(result.reason).toBe("disabled");
    }
  });

  it("E-02: toolCallCount=5 → reason=too-few-tool-calls with actual+threshold", () => {
    const result = isEligibleForDistillation(
      event({ toolCallCount: 5, durationMs: 200_000, outcome: "success" }),
      defaultConfig,
    );
    expect(result.eligible).toBe(false);
    if (!result.eligible) {
      expect(result.reason).toBe("too-few-tool-calls");
      expect((result as { actual: number }).actual).toBe(5);
      expect((result as { threshold: number }).threshold).toBe(6);
    }
  });

  it("E-03: durationMs=179_999 → reason=too-short-duration with actual+threshold", () => {
    const result = isEligibleForDistillation(
      event({ toolCallCount: 6, durationMs: 179_999, outcome: "success" }),
      defaultConfig,
    );
    expect(result.eligible).toBe(false);
    if (!result.eligible) {
      expect(result.reason).toBe("too-short-duration");
      expect((result as { actual: number }).actual).toBe(179_999);
      expect((result as { threshold: number }).threshold).toBe(180_000);
    }
  });

  it("E-04: outcome=partial → reason=outcome-filtered with actual+allowed", () => {
    const result = isEligibleForDistillation(
      event({ toolCallCount: 6, durationMs: 180_000, outcome: "partial" }),
      defaultConfig,
    );
    expect(result.eligible).toBe(false);
    if (!result.eligible) {
      expect(result.reason).toBe("outcome-filtered");
      expect((result as { actual: string }).actual).toBe("partial");
      expect((result as { allowed: readonly string[] }).allowed).toEqual([
        "success",
      ]);
    }
  });

  it("E-05: exact D-03 threshold values → eligible:true (boundary check)", () => {
    const result = isEligibleForDistillation(
      event({ toolCallCount: 6, durationMs: 180_000, outcome: "success" }),
      defaultConfig,
    );
    expect(result.eligible).toBe(true);
  });

  it("E-06: clearly-eligible large values → eligible:true", () => {
    const result = isEligibleForDistillation(
      event({
        toolCallCount: 999,
        durationMs: 999_999_999,
        outcome: "success",
      }),
      defaultConfig,
    );
    expect(result.eligible).toBe(true);
  });

  it("E-07: per-agent override widens outcomeFilter to ['success','partial'] → partial now eligible", () => {
    const result = isEligibleForDistillation(
      event({ toolCallCount: 6, durationMs: 180_000, outcome: "partial" }),
      { ...defaultConfig, outcomeFilter: ["success", "partial"] },
    );
    expect(result.eligible).toBe(true);
  });

  it("E-08: per-agent override raises minToolCalls to 20 → toolCallCount=10 rejected", () => {
    const result = isEligibleForDistillation(
      event({ toolCallCount: 10, durationMs: 200_000, outcome: "success" }),
      { ...defaultConfig, minToolCalls: 20 },
    );
    expect(result.eligible).toBe(false);
    if (!result.eligible) {
      expect(result.reason).toBe("too-few-tool-calls");
      expect((result as { threshold: number }).threshold).toBe(20);
    }
  });

  it("E-09: D-03 literal threshold references present in source-of-truth comments", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync(
      new URL("../skill-distiller-eligibility.ts", import.meta.url),
      "utf-8",
    );
    // D-03 verbatim literals (per acceptance_criteria + behavior spec)
    expect(src).toMatch(/minToolCalls/);
    expect(src).toMatch(/minDurationMs/);
    expect(src).toMatch(/outcomeFilter/);
    expect(src).toMatch(/180_?000|180000/);
    expect(src).toMatch(/\b6\b/);
    expect(src).toMatch(/"success"/);
  });
});
