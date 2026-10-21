/**
 * CI regression-gate thresholds (Plan 51-01).
 *
 * `loadThresholds` is the only path through which `thresholds.yaml` enters
 * the system. It always throws `BenchmarkConfigError` with the offending
 * path on missing files, unparseable YAML, or schema violations.
 *
 * `evaluateRegression` compares a fresh `BenchReport` against a frozen
 * `Baseline` using per-segment thresholds (default 20% p95 delta) and an
 * optional absolute-floor escape hatch (`p95MaxDeltaMs`) for noisy segments
 * such as `context_assemble`. Skips comparisons where either side has
 * `count === 0` (no_data cannot regress).
 *
 * Pure functions — safe to call from CLI commands, tests, or future tooling.
 */

import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { z } from "zod/v4";

import {
  BenchmarkConfigError,
  type Baseline,
  type BenchReport,
} from "./types.js";
import { type CanonicalSegment } from "../performance/types.js";

const segmentEnum = z.enum([
  "end_to_end",
  "first_token",
  "context_assemble",
  "tool_call",
]);

/**
 * Per-segment override allowing both a per-segment percentage AND an
 * absolute floor. The absolute floor is the noisy-segment escape hatch:
 * `context_assemble` p95 of 250ms can swing 30-40% on a 50ms jitter, so
 * `p95MaxDeltaMs: 100` lets the percentage threshold be ignored when the
 * absolute movement is small.
 */
const segmentOverrideSchema = z.object({
  segment: segmentEnum,
  p95MaxDeltaPct: z.number().nonnegative().optional(),
  p95MaxDeltaMs: z.number().nonnegative().optional(),
});

/** Top-level shape of `.planning/benchmarks/thresholds.yaml`. */
export const thresholdsSchema = z.object({
  defaultP95MaxDeltaPct: z.number().nonnegative().default(20),
  segments: z.array(segmentOverrideSchema).default([]),
});

/** Parsed thresholds.yaml. Returned frozen by `loadThresholds`. */
export type ThresholdsConfig = z.infer<typeof thresholdsSchema>;

/** A single per-segment override. */
export type SegmentOverride = z.infer<typeof segmentOverrideSchema>;

/**
 * One regression entry — a (segment, baseline, current) triple plus the
 * computed delta percentage and the threshold that was breached.
 *
 * `deltaPct` = (currentMs - baselineMs) / baselineMs * 100.
 */
export type Regression = {
  readonly segment: CanonicalSegment;
  readonly baselineMs: number;
  readonly currentMs: number;
  readonly deltaPct: number;
  readonly thresholdPct: number;
};

/** Result of `evaluateRegression`. Frozen. */
export type RegressionResult = {
  readonly regressions: readonly Regression[];
  readonly status: "clean" | "regressed";
};

/**
 * Load and validate `.planning/benchmarks/thresholds.yaml`. Returns a frozen
 * `ThresholdsConfig`. Always throws `BenchmarkConfigError` (with the path)
 * on failure.
 *
 * Defaults applied when the YAML omits fields:
 *   - `defaultP95MaxDeltaPct: 20`
 *   - `segments: []`
 *
 * @param path - Absolute or relative path to thresholds.yaml.
 */
export function loadThresholds(path: string): ThresholdsConfig {
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown read error";
    throw new BenchmarkConfigError(`read failed: ${msg}`, path);
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown parse error";
    throw new BenchmarkConfigError(`yaml parse failed: ${msg}`, path);
  }

  const result = thresholdsSchema.safeParse(parsed ?? {});
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    throw new BenchmarkConfigError(`schema invalid: ${issues}`, path);
  }

  const frozenSegments = Object.freeze(
    result.data.segments.map((s) => Object.freeze({ ...s })),
  ) as readonly SegmentOverride[];

  // The outer freeze + readonly inner segments produce `Readonly<...>` at the
  // type level, but the public Zod-inferred `ThresholdsConfig` is mutable.
  // The runtime guarantee (frozen) is stronger than the declared type, so the
  // cast is safe — callers cannot mutate even if the type allowed it.
  const frozen = Object.freeze({
    defaultP95MaxDeltaPct: result.data.defaultP95MaxDeltaPct,
    segments: frozenSegments as SegmentOverride[],
  });
  return frozen as ThresholdsConfig;
}

function findOverride(
  thresholds: ThresholdsConfig,
  segment: CanonicalSegment,
): SegmentOverride | undefined {
  return thresholds.segments.find((s) => s.segment === segment);
}

/**
 * Compare a fresh bench report against a baseline. Returns a frozen
 * `RegressionResult` with `status: "clean" | "regressed"` and any breached
 * segments under `regressions`.
 *
 * Skip rules (no_data cannot regress):
 *   - Either side has `count === 0`.
 *   - Either side has `p95 === null`.
 *   - Baseline `p95 === 0` (no comparable baseline; treated as missing).
 *
 * Threshold rules:
 *   - Compute `deltaPct = (current - baseline) / baseline * 100`.
 *   - If `deltaPct <= thresholdPct` (per-segment override or
 *     `defaultP95MaxDeltaPct`), the segment is clean.
 *   - Otherwise, if the per-segment `p95MaxDeltaMs` floor is set AND the
 *     absolute `current - baseline` is smaller than the floor, treat as
 *     clean (noisy-segment escape hatch).
 *   - Else record a regression.
 *
 * @param report     - Fresh BenchReport from this CI run.
 * @param baseline   - Frozen Baseline loaded from `.planning/benchmarks/baseline.json`.
 * @param thresholds - Loaded thresholds (see `loadThresholds`).
 */
export function evaluateRegression(
  report: BenchReport,
  baseline: Baseline,
  thresholds: ThresholdsConfig,
): RegressionResult {
  const regressions: Regression[] = [];
  const baselineBySegment = new Map(
    baseline.overall_percentiles.map((row) => [row.segment, row]),
  );

  for (const reportRow of report.overall_percentiles) {
    const baseRow = baselineBySegment.get(reportRow.segment);
    if (!baseRow) continue;
    if (baseRow.count === 0 || reportRow.count === 0) continue;
    if (baseRow.p95 === null || reportRow.p95 === null) continue;
    if (baseRow.p95 === 0) continue; // avoid div-by-zero

    const segment = reportRow.segment as CanonicalSegment;
    const override = findOverride(thresholds, segment);
    const thresholdPct =
      override?.p95MaxDeltaPct ?? thresholds.defaultP95MaxDeltaPct;

    const deltaMs = reportRow.p95 - baseRow.p95;
    const deltaPct = (deltaMs / baseRow.p95) * 100;
    if (deltaPct <= thresholdPct) continue;

    // Per-segment absolute-floor escape hatch for noisy segments.
    if (
      override?.p95MaxDeltaMs !== undefined &&
      deltaMs < override.p95MaxDeltaMs
    ) {
      continue;
    }

    regressions.push(
      Object.freeze<Regression>({
        segment,
        baselineMs: baseRow.p95,
        currentMs: reportRow.p95,
        deltaPct,
        thresholdPct,
      }),
    );
  }

  return Object.freeze({
    regressions: Object.freeze(regressions) as readonly Regression[],
    status: regressions.length === 0 ? "clean" : "regressed",
  });
}
