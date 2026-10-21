/**
 * Phase 120 Plan 02 T-02 (DASH-02) — single canonical percentile-cell renderer.
 *
 * Why: prior to this utility, every percentile `<td>` in the dashboard chose
 * its className inline via `isBreach ? 'text-danger' : ...`. When the
 * underlying p50/p95 value was null (no data, broken metric, empty window),
 * the breach decision was made off an unrelated `slo_status` field and the
 * cell rendered red — making "metric broken" indistinguishable from
 * "metric in breach". DASH-02 routes every percentile cell through this
 * single utility so the null-takes-precedence-over-breach rule is enforced
 * in one place.
 *
 * Defensive: when `value` is null, the cell renders neutral regardless of
 * `isBreach`. Callers can pass `isBreach: true` without first null-checking
 * the value — the utility handles it. This is per Plan 02 T-02 Test 4
 * (caller-bug defense).
 *
 * Per CONTEXT D-05 — single utility, applied universally; D-08 — no
 * `MetricCell` framework, this is the entire abstraction footprint.
 */
import type { ReactNode } from 'react'

export interface PercentileCellProps {
  readonly value: number | null
  readonly isBreach: boolean
  readonly format?: (v: number) => ReactNode
  readonly className?: string
}

export function percentileCell({
  value,
  isBreach,
  format,
  className,
}: PercentileCellProps): JSX.Element {
  const isNull = value === null
  const colorClass = isNull
    ? 'text-fg-3'
    : isBreach
      ? 'text-danger'
      : 'text-fg-1'
  const content: ReactNode = isNull ? '—' : format ? format(value) : value
  const finalClass = className
    ? `${className} ${colorClass}`
    : colorClass
  return <td className={finalClass}>{content}</td>
}
