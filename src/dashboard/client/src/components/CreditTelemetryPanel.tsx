/**
 * Phase 138 Plan 02 T-04 — `CreditTelemetryPanel`.
 *
 * Dashboard SPA panel rendering the fleet-aggregate per-provider credit
 * telemetry that the daemon attaches to the `heartbeat-status` IPC
 * response (`creditTelemetry` field — see `src/ipc/protocol.ts`
 * `CreditTelemetryPayloadSchema`).
 *
 * Each provider row shows: provider name, `$cost / $cap`, a percentage
 * bar coloured by usage bucket, and a 24-DAY SVG sparkline (one point
 * per UTC day, oldest left → today rightmost). A sub-line carries the
 * turn count and token totals.
 *
 * **D6 cap cascade.** `cap_usd` is the fleet-level daily cap for the
 * provider, resolved daemon-side as `max` across agents of
 * `agent.providers.<name>.dailyCapUsd ?? defaults.providers.<name>.dailyCapUsd
 * ?? DEFAULT_DAILY_CAP_USD (6.67)` — the panel renders the resolved
 * number verbatim, no client-side cap math.
 *
 * ADDITIVE — the panel renders nothing when telemetry is absent or has
 * zero providers, so it never disturbs the existing usage layout. Uses
 * existing Tailwind utility classes + design tokens only; no new
 * packages, no new design tokens.
 */

import { Card, CardContent, CardHeader } from '@/components/ui/card'
import type { CreditTelemetryPayload } from '@/hooks/useApi'

/** Color buckets — match the `clawcode status` CLI footer exactly. */
function barColor(pct: number): string {
  if (pct >= 95) return 'bg-red-500'
  if (pct >= 90) return 'bg-orange-500'
  if (pct >= 75) return 'bg-yellow-500'
  return 'bg-emerald-500'
}

/**
 * Build an SVG polyline `points` string for a 24-day daily-cost array.
 * The viewBox is 200×30; the y-axis is normalised against the array's
 * max so a flat-zero array renders as a flat baseline. Oldest sample is
 * leftmost (x=0), today is rightmost (x=200).
 */
function sparklinePoints(samples: readonly number[]): string {
  const n = samples.length
  if (n === 0) return ''
  const max = Math.max(0, ...samples)
  const width = 200
  const height = 30
  const pad = 2
  return samples
    .map((v, i) => {
      const x = n > 1 ? (i / (n - 1)) * width : 0
      // Invert y — SVG origin is top-left; higher cost → higher on screen.
      const norm = max > 0 ? v / max : 0
      const y = height - pad - norm * (height - pad * 2)
      return `${x.toFixed(1)},${y.toFixed(1)}`
    })
    .join(' ')
}

/** One per-provider row. */
function ProviderRow(props: {
  readonly entry: CreditTelemetryPayload['providers'][number]
}): JSX.Element {
  const e = props.entry
  // pct can exceed 100 (overage) — clamp the BAR width only; the numeric
  // label still shows the true percentage.
  const barPct = Math.min(100, Math.max(0, e.pct))
  const color = barColor(e.pct)
  const tokens = e.tokens_in + e.tokens_out
  const name = e.provider.charAt(0).toUpperCase() + e.provider.slice(1)

  return (
    <div
      data-testid="credit-telemetry-row"
      data-provider={e.provider}
      className="space-y-1"
    >
      <div className="flex items-baseline justify-between text-xs font-mono">
        <span className="text-fg-1 font-semibold">{name}</span>
        <span className="text-fg-2 data">
          ${e.cost_usd.toFixed(2)} / ${e.cap_usd.toFixed(2)} (
          {Math.round(e.pct)}%)
        </span>
      </div>

      <div className="h-1.5 w-full bg-bg-s3 rounded overflow-hidden">
        <div
          className={`h-full ${color}`}
          style={{ width: `${barPct}%` }}
        />
      </div>

      <div className="flex items-center justify-between gap-3">
        <span className="text-[10px] text-fg-3 font-mono">
          {e.turn_count} turns · {tokens.toLocaleString()} tokens
        </span>
        <svg
          viewBox="0 0 200 30"
          preserveAspectRatio="none"
          className="h-6 w-40 text-fg-2"
          role="img"
          aria-label={`${name} 24-day cost sparkline`}
        >
          <polyline
            points={sparklinePoints(e.sparkline)}
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        </svg>
      </div>
    </div>
  )
}

/**
 * Fleet credit-telemetry panel. Renders nothing when `telemetry` is
 * absent or carries no providers — keeps the surrounding usage panel
 * layout untouched on pre-138 daemons.
 */
export default function CreditTelemetryPanel(props: {
  readonly telemetry?: CreditTelemetryPayload
}): JSX.Element | null {
  const telemetry = props.telemetry
  if (!telemetry || telemetry.providers.length === 0) return null

  return (
    <Card
      className="bg-bg-elevated border-bg-s3 mb-4"
      data-testid="credit-telemetry-panel"
    >
      <CardHeader className="pb-1">
        <span className="font-display text-sm font-bold text-fg-1">
          Credit telemetry · per provider
        </span>
        <span className="text-[10px] text-fg-3 font-sans">
          Fleet-aggregate cost vs daily cap (UTC {telemetry.date}). Cap is
          the per-provider D6 cascade — max across agents. Sparkline: last
          24 UTC days, oldest left.
        </span>
      </CardHeader>
      <CardContent>
        <div className="space-y-3">
          {telemetry.providers.map((entry) => (
            <ProviderRow key={entry.provider} entry={entry} />
          ))}
        </div>
      </CardContent>
    </Card>
  )
}
