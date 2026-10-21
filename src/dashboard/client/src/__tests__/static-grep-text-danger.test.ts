/**
 * Phase 120 Plan 02 T-02 (DASH-02 / D-10) — static-grep regression sentinel.
 *
 * Pins the rule: BenchmarksView percentile <td> cells must route through the
 * `percentileCell` utility — they MUST NOT inline `text-danger` on a
 * value-could-be-null branch. Without this, a future commit could regress
 * by re-introducing the `isBreach ? 'text-danger' : ...` pattern that mixed
 * "null data" with "true breach" before Phase 120.
 *
 * Scope: BenchmarksView.tsx ONLY. Broader `text-danger` usage across the
 * dashboard SPA is legitimate (error banners, status icons, breach badges
 * with no null-path) — Phase 120 D-08 explicitly rejects a global theme
 * abstraction. The sentinel is narrow on purpose.
 *
 * Pattern adapted from Phase 119 Plan 01 T-01 D-09 anti-pattern enforcement
 * and Phase 120 Plan 03's `static-grep-iterateWithTracing.test.ts`.
 */
import { describe, it, expect } from 'vitest'
import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import * as path from 'node:path'

const REPO_ROOT = path.resolve(__dirname, '../../../../..')
const BENCHMARKS_VIEW = path.join(
  REPO_ROOT,
  'src/dashboard/client/src/components/BenchmarksView.tsx',
)

describe('DASH-02 sentinel: BenchmarksView percentile cells route through percentileCell', () => {
  it('Test 1 — BenchmarksView.tsx imports percentileCell', () => {
    const src = readFileSync(BENCHMARKS_VIEW, 'utf8')
    // Match any of the project's percentileCell import shapes.
    const ok =
      /from\s+['"]@\/components\/percentileCell['"]/.test(src) ||
      /from\s+['"]\.\/percentileCell['"]/.test(src)
    expect(
      ok,
      'BenchmarksView.tsx must import percentileCell from @/components/percentileCell',
    ).toBe(true)
  })

  it('Test 2 — no raw text-danger className on percentile <td> in BenchmarksView.tsx', () => {
    const src = readFileSync(BENCHMARKS_VIEW, 'utf8')
    // Forbidden: a literal `text-danger` inside a className attribute on a
    // line that also looks like a percentile cell. We accept text-danger in
    // explicitly-status-driven branches (e.g. `r.aggregate.errored > 0 ? 'text-danger data'`)
    // because those are non-percentile, non-nullable predicates.
    const lines = src.split('\n')
    const offenders: string[] = []
    lines.forEach((line, i) => {
      // Look only at lines that contain a className attribute with a
      // template literal interpolating a ternary-derived color class AND
      // that also reference formatMs (the percentile-cell tell). The
      // pre-Phase-120 bug pattern was:
      //   <td className={`px-2 py-1 text-right data ${colorClass}`}>
      //     {formatMs(r.p50_ms)}
      // We don't grep for the runtime computation directly; instead we
      // assert no `text-danger` literal appears on a line that also calls
      // formatMs (the unique sentinel for a percentile cell).
      if (/text-danger/.test(line) && /formatMs\(/.test(line)) {
        offenders.push(`L${i + 1}: ${line.trim()}`)
      }
    })
    expect(
      offenders,
      `BenchmarksView percentile cell appears to inline text-danger:\n${offenders.join('\n')}`,
    ).toHaveLength(0)
  })

  it('Test 3 — empty-state literal pinned (DASH-03)', () => {
    const src = readFileSync(BENCHMARKS_VIEW, 'utf8')
    expect(
      src.includes("'No tool spans recorded in window'"),
      'BenchmarksView.tsx must contain the verbatim empty-state literal "No tool spans recorded in window"',
    ).toBe(true)
  })

  it('Test 4 — defensive (unnamed) fallback pinned (DASH-01)', () => {
    const src = readFileSync(BENCHMARKS_VIEW, 'utf8')
    expect(
      src.includes("'(unnamed)'"),
      'BenchmarksView.tsx must contain the defensive (unnamed) tool-name fallback',
    ).toBe(true)
  })

  it('Test 5 — positive control: grep machinery finds text-danger elsewhere in client', () => {
    // Confirms the test's grep / source-read machinery is functional. If a
    // typo silently broke the literal match in Test 2, this control would
    // still pass (text-danger exists in DreamQueue, McpHealthPanel, etc.).
    const raw = execSync(
      "grep -RIln --include='*.tsx' 'text-danger' src/dashboard/client/src/components/ || true",
      { encoding: 'utf8', cwd: REPO_ROOT },
    )
    expect(raw.trim().length, 'positive control failed — text-danger grep broke').toBeGreaterThan(0)
  })
})
