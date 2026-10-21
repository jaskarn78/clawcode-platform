/**
 * Baseline I/O + diff formatter (Plan 51-02).
 *
 * Three public functions, all pure (no side effects beyond the file
 * operations `readBaseline`/`writeBaseline` advertise):
 *
 *   - `readBaseline(path)` — read+validate baseline.json, throw
 *     `BenchmarkConfigError` on any failure (missing file, bad JSON,
 *     schema violation). Returns a frozen `Baseline`.
 *   - `writeBaseline(path, report, { username, gitSha })` — stamp
 *     `updated_at` (now ISO) + `updated_by: username` onto the
 *     BenchReport and write as formatted JSON. Creates parent dir.
 *   - `formatDiffTable(report, baseline)` — side-by-side diff table for
 *     human review: Segment / Baseline p95 / Current p95 / Delta / Delta%.
 *     Used by `--update-baseline` (print-then-confirm) AND by
 *     `--check-regression` (print on failure for CI logs).
 *
 * SECURITY: baseline.json only contains segment names, integer
 * percentiles, prompt ids, turnIds, git_sha, username. No prompt bodies,
 * no message contents — safe to commit to a public repo.
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

import {
  baselineSchema,
  BenchmarkConfigError,
  type Baseline,
  type BenchReport,
} from "./types.js";

/**
 * Phase 54 Plan 03 — baseline.json schema (`baselineSchema.segmentEnum`)
 * intentionally stays on 4 names for backward-compat with committed
 * baseline files. Runtime trace segments (Phase 54 `CANONICAL_SEGMENTS`)
 * now number 6, but the bench baseline world is frozen at 4. Render the
 * diff table against the 4-segment baseline shape so `formatDiffTable`
 * stays aligned with what the runner actually writes (Plan 54-03
 * `BACKWARD_COMPAT_BENCH_SEGMENTS` in `runner.ts`).
 */
const BENCH_DIFF_SEGMENTS = [
  "end_to_end",
  "first_token",
  "context_assemble",
  "tool_call",
] as const;

/**
 * Read and validate `.planning/benchmarks/baseline.json`. Returns a
 * frozen `Baseline`. Throws `BenchmarkConfigError` on any failure (file
 * missing, unparseable JSON, or schema violation) with the offending
 * path attached for operator diagnosis.
 */
export function readBaseline(path: string): Baseline {
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown read error";
    throw new BenchmarkConfigError(`read failed: ${msg}`, path);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown parse error";
    throw new BenchmarkConfigError(`json parse failed: ${msg}`, path);
  }

  const result = baselineSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    throw new BenchmarkConfigError(`schema invalid: ${issues}`, path);
  }
  return Object.freeze(result.data) as Baseline;
}

/** Provenance fields stamped onto a new baseline. */
export type BaselineProvenance = {
  readonly username: string;
  /** Explicit git sha override. Falls back to `report.git_sha` if absent. */
  readonly gitSha?: string;
};

/**
 * Write a fresh `BenchReport` as the new baseline, stamping `updated_at`
 * (now ISO) and `updated_by: provenance.username`. If `provenance.gitSha`
 * is present it overrides `report.git_sha`; otherwise the report's own
 * git_sha is preserved.
 *
 * Creates the parent directory if missing. Writes pretty-printed JSON
 * with a trailing newline (diff-friendly).
 *
 * @returns The written Baseline (frozen).
 */
export function writeBaseline(
  path: string,
  report: BenchReport,
  provenance: BaselineProvenance,
): Baseline {
  const baseline: Baseline = Object.freeze({
    ...report,
    git_sha: provenance.gitSha ?? report.git_sha,
    updated_at: new Date().toISOString(),
    updated_by: provenance.username,
  });
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(baseline, null, 2) + "\n", "utf-8");
  return baseline;
}

/**
 * Format a side-by-side p95 diff table for human review. Always renders
 * all 4 canonical segments (one row each) so operators see every
 * segment's status at a glance — including segments with no data.
 *
 * Columns: Segment / Baseline p95 / Current p95 / Delta / Delta %.
 *
 * If `baseline` is `null` (first-time bench), the Baseline+Delta columns
 * show `(no baseline yet)` and `—`.
 */
export function formatDiffTable(
  report: BenchReport,
  baseline: Baseline | null,
): string {
  const headers = ["Segment", "Baseline p95", "Current p95", "Delta", "Delta %"];
  const baselineBySeg = new Map(
    baseline?.overall_percentiles.map((r) => [r.segment, r]) ?? [],
  );
  const reportBySeg = new Map(
    report.overall_percentiles.map((r) => [r.segment, r]),
  );

  const dataRows: string[][] = BENCH_DIFF_SEGMENTS.map((seg) => {
    const cur = reportBySeg.get(seg);
    const base = baselineBySeg.get(seg);
    const curP95 = cur?.p95 ?? null;
    if (!base) {
      return [
        seg,
        "(no baseline yet)",
        curP95 === null ? "—" : `${curP95} ms`,
        "—",
        "—",
      ];
    }
    if (base.p95 === null || curP95 === null) {
      return [
        seg,
        base.p95 === null ? "—" : `${base.p95} ms`,
        curP95 === null ? "—" : `${curP95} ms`,
        "—",
        "—",
      ];
    }
    const deltaMs = curP95 - base.p95;
    const deltaPct = base.p95 === 0 ? 0 : (deltaMs / base.p95) * 100;
    const sign = deltaMs >= 0 ? "+" : "";
    return [
      seg,
      `${base.p95} ms`,
      `${curP95} ms`,
      `${sign}${deltaMs} ms`,
      `${sign}${deltaPct.toFixed(1)}%`,
    ];
  });

  const allRows: string[][] = [headers, ...dataRows];
  const widths = headers.map((_, col) =>
    Math.max(...allRows.map((r) => (r[col] ?? "").length)),
  );
  const separator = widths.map((w) => "-".repeat(w)).join("  ");
  const formatted = allRows.map((row, idx) => {
    const line = row
      .map((cell, col) =>
        col === 0 ? cell.padEnd(widths[col]!) : cell.padStart(widths[col]!),
      )
      .join("  ");
    return idx === 0 ? `${line}\n${separator}` : line;
  });
  return formatted.join("\n");
}
