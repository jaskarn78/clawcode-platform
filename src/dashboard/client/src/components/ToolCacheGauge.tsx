/**
 * Phase 116 Plan 01 T04 — F05 Tool cache hit rate gauge.
 *
 * Recharts donut showing `tool_cache_hit_rate` (0-1) from `useAgentCache`.
 * Color band:
 *   - ≥ 40% → primary (emerald)  ← target
 *   - 20-39% → warn (amber)
 *   - < 20%  → danger (red)
 *
 * Click the donut → shadcn <Popover> with hit-rate detail + cache size +
 * target-threshold callout. **Per-tool breakdown is NOT in the current
 * cache endpoint** (verified against daemon.ts case "cache" — it surfaces
 * `tool_cache_hit_rate` fleet-wide only). The popover renders the
 * available aggregate signals + a forward-pointer note. Documented as a
 * deviation in the plan summary.
 *
 * Tool cache size also surfaces (`tool_cache_size_mb`); helpful operator
 * context next to the rate.
 */
import { useMemo } from 'react'
import { PieChart, Pie, Cell, ResponsiveContainer } from 'recharts'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'

export type ToolCacheGaugeProps = {
  /** 0-1 fraction. Null = no data. */
  readonly toolCacheHitRate: number | null
  readonly toolCacheSizeMb: number | null
  readonly toolCacheTurns?: number
}

const TARGET_HIT_RATE = 0.4 // ≥40% per 116-CONTEXT

// 116-postdeploy fix-pass — fills returned as `hsl(var(--…))` /
// `rgb(var(--…))` so the donut flips between light + dark at theme-
// toggle time without a React re-render (same pattern as
// AgentTile.tsx ActivitySparkline). HSL for shadcn semantic tokens,
// RGB for the custom surface channels (--fg-3, --bg-s3).
function gaugeBand(rate: number | null): {
  readonly fill: string
  readonly tw: string
  readonly label: string
} {
  if (rate === null) {
    return { fill: 'rgb(var(--fg-3))', tw: 'text-fg-3', label: 'no_data' }
  }
  if (rate >= TARGET_HIT_RATE) {
    return { fill: 'hsl(var(--primary))', tw: 'text-primary', label: 'ok' }
  }
  if (rate >= 0.2) {
    return { fill: 'hsl(var(--warn))', tw: 'text-warn', label: 'warn' }
  }
  return { fill: 'hsl(var(--danger))', tw: 'text-danger', label: 'danger' }
}

export function ToolCacheGauge(props: ToolCacheGaugeProps): JSX.Element {
  const rate = props.toolCacheHitRate
  const band = gaugeBand(rate)
  const pct = rate === null ? 0 : Math.max(0, Math.min(100, rate * 100))
  const displayPct = rate === null ? '—' : `${(rate * 100).toFixed(0)}%`

  // Recharts wants two slices for a donut: the filled portion and the
  // remainder. Track color is the muted surface to match other meters.
  // 116-postdeploy fix-pass — miss-bucket fill resolved through `--bg-s3`
  // (RGB channels in index.css) so the donut ring flips light/dark.
  const data = useMemo(
    () => [
      { name: 'hit', value: pct, color: band.fill },
      { name: 'miss', value: 100 - pct, color: 'rgb(var(--bg-s3))' },
    ],
    [pct, band.fill],
  )

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="relative inline-flex items-center justify-center w-16 h-16 rounded-full focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          data-testid="tool-cache-gauge"
          data-band={band.label}
          aria-label={`Tool cache hit rate ${displayPct}`}
        >
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <Pie
                data={data}
                dataKey="value"
                cx="50%"
                cy="50%"
                innerRadius={20}
                outerRadius={30}
                startAngle={90}
                endAngle={-270}
                stroke="none"
                isAnimationActive={false}
              >
                {data.map((d) => (
                  <Cell key={d.name} fill={d.color} />
                ))}
              </Pie>
            </PieChart>
          </ResponsiveContainer>
          <span
            className={`absolute inset-0 flex items-center justify-center font-mono text-[11px] data ${band.tw}`}
          >
            {displayPct}
          </span>
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="center"
        className="bg-bg-elevated text-fg-1 border-bg-s3 font-sans"
      >
        <div className="space-y-3">
          <header>
            <h4 className="font-display font-bold text-sm">Tool cache</h4>
            <p className="text-xs text-fg-3 mt-0.5">
              MCP tool response cache; target ≥{' '}
              <span className="font-mono data text-primary">
                {(TARGET_HIT_RATE * 100).toFixed(0)}%
              </span>{' '}
              hit rate.
            </p>
          </header>
          <dl className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-xs">
            <dt className="text-fg-3">Hit rate</dt>
            <dd className={`font-mono data ${band.tw}`}>{displayPct}</dd>
            <dt className="text-fg-3">Cache size</dt>
            <dd className="font-mono data text-fg-2">
              {typeof props.toolCacheSizeMb === 'number'
                ? `${props.toolCacheSizeMb.toFixed(1)} MB`
                : '—'}
            </dd>
            <dt className="text-fg-3">Turns sampled</dt>
            <dd className="font-mono data text-fg-2">
              {typeof props.toolCacheTurns === 'number'
                ? props.toolCacheTurns.toLocaleString('en-US')
                : '—'}
            </dd>
          </dl>
          <p className="text-[11px] text-fg-3 italic pt-1 border-t border-bg-s3">
            Per-tool breakdown lands in 116-02 (needs a new daemon endpoint;
            current /api/agents/:name/cache returns the fleet rate only).
          </p>
        </div>
      </PopoverContent>
    </Popover>
  )
}

export default ToolCacheGauge
