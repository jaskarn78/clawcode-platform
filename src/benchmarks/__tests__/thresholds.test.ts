import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { BenchmarkConfigError, type Baseline, type BenchReport } from "../types.js";
import {
  evaluateRegression,
  loadThresholds,
  type ThresholdsConfig,
} from "../thresholds.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "clawcode-thresholds-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function writeYaml(name: string, contents: string): string {
  const path = join(tmpDir, name);
  writeFileSync(path, contents, "utf-8");
  return path;
}

const baseReport: BenchReport = {
  run_id: "r1",
  started_at: "2026-04-13T20:00:00Z",
  git_sha: "abc",
  node_version: "v22.22.0",
  prompt_results: [],
  overall_percentiles: [
    { segment: "end_to_end", p50: 1200, p95: 5000, p99: 5500, count: 25 },
    { segment: "first_token", p50: 800, p95: 1900, p99: 2100, count: 25 },
    {
      segment: "context_assemble",
      p50: 80,
      p95: 250,
      p99: 290,
      count: 25,
    },
    { segment: "tool_call", p50: 350, p95: 1200, p99: 1450, count: 18 },
  ],
};

const baseBaseline: Baseline = {
  ...baseReport,
  updated_at: "2026-04-12T20:00:00Z",
  updated_by: "clawdy",
};

describe("loadThresholds", () => {
  it("parses a valid thresholds.yaml with default + per-segment override", () => {
    const path = writeYaml(
      "default.yaml",
      [
        "defaultP95MaxDeltaPct: 20",
        "segments:",
        "  - segment: context_assemble",
        "    p95MaxDeltaPct: 30",
        "    p95MaxDeltaMs: 100",
      ].join("\n"),
    );
    const cfg = loadThresholds(path);
    expect(cfg.defaultP95MaxDeltaPct).toBe(20);
    expect(cfg.segments).toHaveLength(1);
    expect(cfg.segments[0]).toEqual({
      segment: "context_assemble",
      p95MaxDeltaPct: 30,
      p95MaxDeltaMs: 100,
    });
    expect(Object.isFrozen(cfg)).toBe(true);
    expect(Object.isFrozen(cfg.segments)).toBe(true);
    expect(Object.isFrozen(cfg.segments[0])).toBe(true);
  });

  it("throws BenchmarkConfigError when the file does not exist", () => {
    const missing = join(tmpDir, "does-not-exist.yaml");
    expect(() => loadThresholds(missing)).toThrowError(BenchmarkConfigError);
    try {
      loadThresholds(missing);
    } catch (err) {
      expect(err).toBeInstanceOf(BenchmarkConfigError);
      expect((err as BenchmarkConfigError).message).toContain(missing);
    }
  });

  it("throws BenchmarkConfigError when defaultP95MaxDeltaPct is negative", () => {
    const path = writeYaml(
      "negative.yaml",
      "defaultP95MaxDeltaPct: -5\nsegments: []\n",
    );
    expect(() => loadThresholds(path)).toThrowError(BenchmarkConfigError);
  });

  it("throws BenchmarkConfigError when YAML cannot be parsed", () => {
    const path = writeYaml("broken.yaml", ":\n  : :\n - invalid yaml");
    expect(() => loadThresholds(path)).toThrowError(BenchmarkConfigError);
  });
});

describe("evaluateRegression", () => {
  const cleanThresholds: ThresholdsConfig = {
    defaultP95MaxDeltaPct: 20,
    segments: [],
  };

  it("returns clean status when every segment is within tolerance", () => {
    const result = evaluateRegression(baseReport, baseBaseline, cleanThresholds);
    expect(result.status).toBe("clean");
    expect(result.regressions).toHaveLength(0);
  });

  it("flags a regressed segment (end_to_end 5000 -> 6500 = 30% > 20%)", () => {
    const regressed = {
      ...baseReport,
      overall_percentiles: baseReport.overall_percentiles.map((row) =>
        row.segment === "end_to_end"
          ? { ...row, p95: 6500 }
          : row,
      ),
    };
    const result = evaluateRegression(regressed, baseBaseline, cleanThresholds);
    expect(result.status).toBe("regressed");
    expect(result.regressions).toHaveLength(1);
    const reg = result.regressions[0]!;
    expect(reg.segment).toBe("end_to_end");
    expect(reg.baselineMs).toBe(5000);
    expect(reg.currentMs).toBe(6500);
    expect(reg.deltaPct).toBeCloseTo(30, 5);
    expect(reg.thresholdPct).toBe(20);
  });

  it("honors per-segment absolute floor (context_assemble 250 -> 320 = 28% but only 70ms < 100ms floor)", () => {
    const regressed = {
      ...baseReport,
      overall_percentiles: baseReport.overall_percentiles.map((row) =>
        row.segment === "context_assemble"
          ? { ...row, p95: 320 }
          : row,
      ),
    };
    const noisyThresholds: ThresholdsConfig = {
      defaultP95MaxDeltaPct: 20,
      segments: [
        {
          segment: "context_assemble",
          p95MaxDeltaMs: 100,
        },
      ],
    };
    const result = evaluateRegression(regressed, baseBaseline, noisyThresholds);
    expect(result.status).toBe("clean");
    expect(result.regressions).toHaveLength(0);
  });

  it("skips segments where either baseline or report has count === 0 (no_data cannot regress)", () => {
    const regressed = {
      ...baseReport,
      overall_percentiles: baseReport.overall_percentiles.map((row) =>
        row.segment === "tool_call"
          ? { ...row, p95: 9999, count: 0 }
          : row,
      ),
    };
    const result = evaluateRegression(regressed, baseBaseline, cleanThresholds);
    expect(result.status).toBe("clean");
    expect(result.regressions).toHaveLength(0);

    // Mirror: baseline side has count 0, report has data
    const baselineNoTool = {
      ...baseBaseline,
      overall_percentiles: baseBaseline.overall_percentiles.map((row) =>
        row.segment === "tool_call" ? { ...row, count: 0 } : row,
      ),
    };
    const regressedAgain = {
      ...baseReport,
      overall_percentiles: baseReport.overall_percentiles.map((row) =>
        row.segment === "tool_call" ? { ...row, p95: 5000 } : row,
      ),
    };
    const result2 = evaluateRegression(
      regressedAgain,
      baselineNoTool,
      cleanThresholds,
    );
    expect(result2.status).toBe("clean");
  });
});
