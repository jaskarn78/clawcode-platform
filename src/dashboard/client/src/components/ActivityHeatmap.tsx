/**
 * Phase 116-06 T01 — F18 (per-agent) + F22 (fleet) activity heatmap.
 *
 * GitHub-style calendar grid: 30 days wide, 7 days-of-week tall.
 * Color intensity scales with turn count for that bucket. Tooltip shows
 * the raw count.
 *
 * One component, two consumers:
 *   - F18: <ActivityHeatmap agent="fin-client" /> — drawer right column.
 *   - F22: <ActivityHeatmap /> — fleet aggregate on /dashboard/v2/fleet
 *           (sums per-date across every agent).
 *
 * Implementation choice: bare SVG (NOT Recharts). Calendar heatmaps don't
 * benefit from Recharts' axis/legend primitives — they need precise grid
 * placement and we already pay for Recharts in the cost dashboard chunk.
 * The whole component lands at ~3 KB raw — tinier than any Recharts split
 * we'd pull in for a CalendarChart wrapper.
 *
 * Data source: GET /api/activity → daemon `activity-by-day` IPC →
 *   TraceStore.getActivityByDay. Rows: { date, agent, turn_count }.
 *   UTC-aligned start-of-day(now - 29) inclusive. 30 buckets exactly.
 */
import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Card, CardContent, CardHeader } from '@/components/ui/card'

type ActivityRow = {
  readonly date: string // YYYY-MM-DD
  readonly agent: string
  readonly turn_count: number
}

type ActivityResponse = {
  readonly days: number
  readonly since: string
  readonly until: string
  readonly rows: readonly ActivityRow[]
}

/**
 * Per-bucket color shade — emerald primary with five intensity stops.
 * `null` count → muted bg (no activity). Stops calibrated against
 * observed fleet data (a busy agent does ~50 turns/day; max stop kicks
 * in at >=80 to leave headroom).
 */
function pickShade(count: number): string {
  if (count === 0) return 'fill-bg-muted'
  if (count < 5) return 'fill-emerald-900'
  if (count < 15) return 'fill-emerald-700'
  if (count < 40) return 'fill-emerald-500'
  if (count < 80) return 'fill-emerald-400'
  return 'fill-emerald-300'
}

function utcDayLabel(date: Date): string {
  return date.toISOString().slice(0, 10) // YYYY-MM-DD
}

/**
 * Build the 30-bucket date list, oldest → newest, UTC-aligned.
 */
function buildDateList(days: number): readonly string[] {
  const out: string[] = []
  const now = new Date()
  const today = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
  )
  for (let i = days - 1; i >= 0; i -= 1) {
    out.push(utcDayLabel(new Date(today - i * 24 * 3600 * 1000)))
  }
  return out
}

export type ActivityHeatmapProps = {
  /**
   * F18: pass an agent name to scope to one agent.
   * F22: omit (undefined) to render the fleet aggregate.
   */
  readonly agent?: string
  /** Default 30. Plan locked at 30 — exposed for future re-skins. */
  readonly days?: number
  /** Compact mode for the drawer (smaller cells). Default false. */
  readonly compact?: boolean
}

export function ActivityHeatmap(props: ActivityHeatmapProps): JSX.Element {
  const days = props.days ?? 30
  const compact = props.compact ?? false

  const { data, isLoading, error } = useQuery<ActivityResponse>({
    queryKey: ['activity', props.agent ?? '__fleet__', days],
    queryFn: async () => {
      const url = new URL('/api/activity', window.location.origin)
      url.searchParams.set('days', String(days))
      if (props.agent) url.searchParams.set('agent', props.agent)
      const res = await fetch(url.toString())
      if (!res.ok) throw new Error(`fetch activity failed: ${res.status}`)
      return (await res.json()) as ActivityResponse
    },
    staleTime: 60_000,
  })

  // Sum per-date (F22 aggregates across all agents; F18 already pre-filtered
  // server-side but we still reduce defensively).
  const countsByDate = useMemo<ReadonlyMap<string, number>>(() => {
    const m = new Map<string, number>()
    if (!data) return m
    for (const row of data.rows) {
      m.set(row.date, (m.get(row.date) ?? 0) + row.turn_count)
    }
    return m
  }, [data])

  const dates = useMemo(() => buildDateList(days), [days])

  // Grid layout: 7 rows × N columns. Each column is one week; rows are
  // day-of-week (Sun..Sat). The oldest date pins to (row=dow(oldest),
  // col=0); each subsequent day moves down the row, wrapping to col+1
  // on Sunday. This is the canonical GitHub layout.
  const cellSize = compact ? 10 : 14
  const cellGap = 2
  const cols = Math.ceil(days / 7) + 1
  const width = cols * (cellSize + cellGap)
  const height = 7 * (cellSize + cellGap)

  const cells = useMemo(() => {
    if (dates.length === 0) return []
    const oldest = new Date(dates[0] + 'T00:00:00Z')
    const oldestDow = oldest.getUTCDay() // 0=Sun..6=Sat
    return dates.map((date, idx) => {
      const dayOffset = idx + oldestDow
      const row = dayOffset % 7
      const col = Math.floor(dayOffset / 7)
      const count = countsByDate.get(date) ?? 0
      return { date, row, col, count }
    })
  }, [dates, countsByDate])

  const title = props.agent
    ? `${props.agent} — last ${days} days`
    : `Fleet activity — last ${days} days`

  return (
    <Card data-testid="activity-heatmap">
      <CardHeader className="pb-2">
        <div className="flex items-baseline justify-between">
          <h3 className="text-xs uppercase tracking-wider text-fg-3">
            {title}
          </h3>
          {data && (
            <span className="text-[10px] text-fg-3 font-mono">
              {data.rows.reduce((s, r) => s + r.turn_count, 0)} turns
            </span>
          )}
        </div>
      </CardHeader>
      <CardContent>
        {error ? (
          <div className="text-xs text-danger">
            Failed to load activity: {(error as Error).message}
          </div>
        ) : isLoading ? (
          <div className="text-xs text-fg-3">Loading…</div>
        ) : (
          <svg
            width={width}
            height={height}
            viewBox={`0 0 ${width} ${height}`}
            xmlns="http://www.w3.org/2000/svg"
            role="img"
            aria-label={title}
          >
            {cells.map((cell) => (
              <rect
                key={cell.date}
                x={cell.col * (cellSize + cellGap)}
                y={cell.row * (cellSize + cellGap)}
                width={cellSize}
                height={cellSize}
                rx={2}
                className={pickShade(cell.count)}
                data-date={cell.date}
                data-count={cell.count}
              >
                <title>
                  {cell.date}: {cell.count} turn{cell.count === 1 ? '' : 's'}
                </title>
              </rect>
            ))}
          </svg>
        )}
      </CardContent>
    </Card>
  )
}
