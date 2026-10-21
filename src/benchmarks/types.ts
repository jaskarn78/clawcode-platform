/**
 * Bench harness data contracts (Plan 51-01).
 *
 * The Zod schemas in this module are the SINGLE source of truth for both the
 * `clawcode bench` report (Plan 51-02) and the git-tracked baseline file
 * (`.planning/benchmarks/baseline.json`). Keeping them symmetric — Baseline
 * is the BenchReport shape PLUS provenance fields — guarantees diff logic in
 * `evaluateRegression` (src/benchmarks/thresholds.ts) is structurally sound:
 * for any (segment, metric) the same accessor reads both sides.
 *
 * SECURITY: bench reports never contain prompt bodies, message contents, or
 * secrets — only segment names, integer ms percentiles, prompt ids, turn ids,
 * and small provenance strings. The `BenchmarkConfigError` mirrors
 * `MemoryError` (src/memory/errors.ts) — domain-specific Error with a
 * readonly path field for diagnostics.
 */

import { z } from "zod/v4";

import { CANONICAL_SEGMENTS } from "../performance/types.js";

/**
 * Canonical segment names — duplicated as a Zod enum (mirrors
 * src/performance/types.ts CANONICAL_SEGMENTS) to avoid a runtime dependency
 * on a TypeScript const-array. `CANONICAL_SEGMENTS` is re-exported below for
 * call sites that want both the runtime list and the schema validator.
 */
const segmentEnum = z.enum([
  "end_to_end",
  "first_token",
  "context_assemble",
  "tool_call",
]);

/**
 * A single percentile row. Mirrors `PercentileRow` from src/performance/types.ts
 * but expressed as a Zod schema so report/baseline files can be parsed at load
 * time. p50/p95/p99 are nullable to allow no-data rows (count === 0).
 */
export const percentileRowSchema = z.object({
  segment: segmentEnum,
  p50: z.number().int().nullable(),
  p95: z.number().int().nullable(),
  p99: z.number().int().nullable(),
  count: z.number().int().nonnegative(),
});

/** Per-prompt result inside a bench run. */
export const promptResultSchema = z.object({
  id: z.string().min(1),
  turnIds: z.array(z.string()),
  percentiles: z.array(percentileRowSchema),
});

/**
 * A complete bench invocation report — written to
 * `.planning/benchmarks/reports/<timestamp>.json` and consumed by
 * `--update-baseline` / `--check-regression`.
 */
export const benchReportSchema = z.object({
  run_id: z.string().min(1),
  started_at: z.iso.datetime(),
  git_sha: z.string().min(1),
  node_version: z.string().min(1),
  prompt_results: z.array(promptResultSchema),
  overall_percentiles: z.array(percentileRowSchema),
  /**
   * Phase 53 Plan 03 — per-prompt average response length in characters.
   * Populated only when `runBench({ captureResponses: true })` is set
   * (used by `clawcode bench --context-audit` to diff against baseline
   * and fail on > 15% drop). Absent in default bench runs for backward
   * compat with Phase 51 baselines.
   */
  response_lengths: z.record(z.string(), z.number()).optional(),
  /**
   * Phase 54 Plan 03 — count of Discord rate-limit errors observed during
   * this bench run. A non-zero value hard-fails `--check-regression`
   * because the tightened streaming cadence must never trigger rate-limits
   * in the bench matrix. See CONTEXT decision "Rate-limit regression
   * guard". Absent in pre-Phase-54 reports for backward compat.
   */
  rate_limit_errors: z.number().int().nonnegative().optional(),
});

/**
 * Baseline = a frozen historical BenchReport + provenance fields. Stored at
 * `.planning/benchmarks/baseline.json`, tracked in git, updated only via
 * `clawcode bench --update-baseline` (which always emits the diff and the
 * commit hint — never auto-writes).
 */
export const baselineSchema = benchReportSchema.extend({
  updated_at: z.iso.datetime(),
  updated_by: z.string().min(1),
});

/** Inferred type for one percentile row inside a bench report or baseline. */
export type PercentileRowSchema = z.infer<typeof percentileRowSchema>;
/** Inferred type for one prompt result entry. */
export type PromptResult = z.infer<typeof promptResultSchema>;
/** Inferred type for a complete bench report. */
export type BenchReport = z.infer<typeof benchReportSchema>;
/** Inferred type for the git-tracked baseline (BenchReport + provenance). */
export type Baseline = z.infer<typeof baselineSchema>;

/**
 * Thrown on bench config / parse failures. Mirrors `MemoryError` shape
 * (readonly path, sets `this.name`). Always include the offending file path
 * so the operator can locate the broken artifact immediately.
 */
export class BenchmarkConfigError extends Error {
  readonly path: string;

  constructor(message: string, path: string) {
    super(`Benchmark config error (${path}): ${message}`);
    this.name = "BenchmarkConfigError";
    this.path = path;
  }
}

// Re-export for symmetry — callers that need both the segment enum and the
// runtime list can import everything from this module.
export { CANONICAL_SEGMENTS };
