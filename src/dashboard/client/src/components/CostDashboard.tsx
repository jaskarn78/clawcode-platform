/**
 * Phase 116-postdeploy — Usage page (subscription utilisation first).
 *
 * Replaces the old Costs page framing. Operator runs on Claude Max
 * ($200/mo flat OAuth subscription), so theoretical API-equivalent USD
 * totals are not what they're billed. Leading with dollar figures was
 * causing anxiety over numbers the operator does not actually pay.
 *
 * New hierarchy (top→bottom):
 *
 *  1. MaxBanner
 *     Dismissible explainer: "You're on Claude Max — token spend below
 *     is theoretical API-equivalent." Persists dismissal to localStorage
 *     under a versioned key so a future re-wording can re-show it.
 *
 *  2. Subscription utilisation (primary surface)
 *     Driven by /api/usage (Phase 116-postdeploy). Renders one wide bar
 *     per rate-limit type — 5-hour session, 7-day weekly, plus narrower
 *     bars for the Opus weekly and Sonnet weekly carve-outs. Each bar
 *     shows utilisation % + a "resets in …" countdown + status emoji
 *     (allowed / allowed_warning / rejected). Colour: green <70%, amber
 *     70–90%, red >90%. Overage state shown as a small footer row.
 *     Snapshot field `rateLimitType` is `string` not a union (Pitfall 10);
 *     unknown types render with a humanised fallback label, not dropped.
 *
 *  3. Token volume (secondary surface)
 *     Today / 7d / 30d token totals (in + out, K/M suffixed). Trend
 *     chart re-keyed off the same /api/costs/daily rows but expressing
 *     totals in tokens instead of USD.
 *
 *  4. Theoretical API-equivalent cost (DEMOTED, collapsible)
 *     Default collapsed. Inside: today/7d/30d USD cards + trend chart +
 *     per-model donut + month-end projection + the high-volume-day
 *     callout (renamed from "spend anomaly" so the framing doesn't
 *     suggest the operator is being billed for the spike).
 *
 *  5. Escalation budget gauges (unchanged)
 *     Token-unit per-agent caps from clawcode.yaml. These ARE real
 *     operator-configured constraints so they stay top-level.
 *
 * Lazy-loaded by App.tsx via React.lazy because recharts is ~70KB
 * minified. The new subscription-bar primitives are pure Tailwind divs
 * + numbers and don't add to the heavy-import surface.
 */
import { useEffect, useMemo, useState } from 'react'
import {
  Area,
  AreaChart,
  CartesianGrid,
  Cell,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip as RechartsTooltip,
  XAxis,
  YAxis,
  Legend,
} from 'recharts'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader } from '@/components/ui/card'
import {
  useBudgets,
  useCosts,
  useCostsDaily,
  useFleetUsage,
  useHeartbeatStatus,
  type CostByDay,
  type BudgetRow,
  type RateLimitSnapshot,
  type UsageFleetResponse,
} from '@/hooks/useApi'
import { parentAgentName } from '@/lib/agent-name'
import CreditTelemetryPanel from '@/components/CreditTelemetryPanel'

const ANOMALY_MULTIPLIER = 2 // CONTEXT-locked
const MIN_DAYS_FOR_PROJECTION = 14
const MIN_DAYS_FOR_ANOMALY = 5

// 116-postdeploy Bug 1 — cap "by agent" series count so the legend stays
// readable. Top-N agents by total spend retain their own series; the
// remainder collapse into a single "other" bucket. 7 is a balance between
// "see real agents" and "legend doesn't wrap to three lines" on a 280px
// chart. With ~14 root agents in the fleet today, this keeps the top
// half of the fleet legible and packs the long-tail subagent spam into
// one band.
const TOP_AGENT_SERIES = 7
const OTHER_BUCKET = 'other'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatUsd(n: number): string {
  if (n < 0.01) return `$${n.toFixed(4)}`
  if (n < 10) return `$${n.toFixed(3)}`
  if (n < 1000) return `$${n.toFixed(2)}`
  return `$${n.toLocaleString(undefined, { maximumFractionDigits: 0 })}`
}

// K/M suffix formatter for token counts. Tokens are integers so we don't
// chase fractional precision below 1K; above 1K we want one decimal place
// so 12.3K reads as different from 12.4K but 123K isn't noisy.
function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0'
  if (n < 1_000) return n.toLocaleString(undefined, { maximumFractionDigits: 0 })
  if (n < 1_000_000) return `${(n / 1_000).toFixed(1)}K`
  if (n < 1_000_000_000) return `${(n / 1_000_000).toFixed(2)}M`
  return `${(n / 1_000_000_000).toFixed(2)}B`
}

// Resets-in countdown formatter. Input is ms-epoch (Phase 999.4 normalisation
// guarantees ms units; seconds-epoch already multiplied by 1000 on capture).
// Returns "now" when in the past so we don't render negative durations.
function formatResetsIn(resetsAtMs: number | undefined): string {
  if (resetsAtMs === undefined) return ''
  const deltaMs = resetsAtMs - Date.now()
  if (deltaMs <= 0) return 'resets now'
  const seconds = Math.floor(deltaMs / 1000)
  const minutes = Math.floor(seconds / 60)
  const hours = Math.floor(minutes / 60)
  const days = Math.floor(hours / 24)
  if (days >= 1) return `resets in ${days}d ${hours % 24}h`
  if (hours >= 1) return `resets in ${hours}h ${minutes % 60}m`
  if (minutes >= 1) return `resets in ${minutes}m`
  return `resets in ${seconds}s`
}

// Snapshot.rateLimitType is `string` (Pitfall 10) — render a humanised
// label that covers the known SDK union AND any future type via fallback.
function humanizeRateLimitType(t: string): string {
  switch (t) {
    case 'five_hour':
      return '5-hour session'
    case 'seven_day':
      return 'Weekly (7-day)'
    case 'seven_day_opus':
      return 'Opus weekly'
    case 'seven_day_sonnet':
      return 'Sonnet weekly'
    case 'overage':
      return 'Overage'
    case 'unknown':
      return 'Unknown limit'
    default:
      // Best-effort prettification: snake_case → Title Case.
      return t
        .split('_')
        .map((s) => (s.length === 0 ? s : s[0]!.toUpperCase() + s.slice(1)))
        .join(' ')
  }
}

// Status emoji for the snapshot's allowed/warning/rejected state.
function statusEmoji(status: RateLimitSnapshot['status']): string {
  switch (status) {
    case 'allowed':
      return '🟢'
    case 'allowed_warning':
      return '🟡'
    case 'rejected':
      return '🔴'
  }
}

// Threshold-aware bar colour. green <70%, amber 70-90%, red >90%. Operator
// wanted a single visual cue at-a-glance; the status emoji handles the
// nuance between warning vs rejected within those bands.
function utilizationBarColor(util: number | undefined): string {
  const u = util ?? 0
  if (u >= 0.9) return 'bg-danger'
  if (u >= 0.7) return 'bg-warn'
  return 'bg-primary'
}

// Localstorage key for the Max-subscription banner dismissal. Versioned so
// a future re-wording can re-show it without needing a migration.
const MAX_BANNER_DISMISS_KEY = 'clawcode.usage.banner.dismissed.v1'

function modelBucket(model: string): 'opus' | 'sonnet' | 'haiku' | 'other' {
  const m = model.toLowerCase()
  if (m.includes('opus')) return 'opus'
  if (m.includes('sonnet')) return 'sonnet'
  if (m.includes('haiku')) return 'haiku'
  return 'other'
}

// 116-postdeploy fix-pass — model palette uses theme-aware CSS vars for
// the two colors that have semantic tokens (sonnet=primary, haiku=warn).
// Opus + other stay literal — `--primary` is owned by ok/healthy and
// `--warn` is owned by degraded/warning; co-opting them for model
// identity would cross semantic lanes. Violet + muted-grey are visually
// stable enough in both themes that a contrast fix isn't urgent. Lift
// to CSS vars if a real contrast bug surfaces.
const MODEL_COLORS = {
  opus: '#a855f7', // violet
  sonnet: 'hsl(var(--primary))', // emerald → theme-aware
  haiku: 'hsl(var(--warn))', // amber → theme-aware
  other: 'rgb(var(--fg-3))', // muted → theme-aware
} as const

// Linear regression (least squares) over an array of (x, y) pairs.
function linearRegression(
  points: ReadonlyArray<{ x: number; y: number }>,
): { slope: number; intercept: number } | null {
  if (points.length < 2) return null
  const n = points.length
  let sumX = 0
  let sumY = 0
  let sumXY = 0
  let sumXX = 0
  for (const p of points) {
    sumX += p.x
    sumY += p.y
    sumXY += p.x * p.y
    sumXX += p.x * p.x
  }
  const denom = n * sumXX - sumX * sumX
  if (denom === 0) return null
  const slope = (n * sumXY - sumX * sumY) / denom
  const intercept = (sumY - slope * sumX) / n
  return { slope, intercept }
}

// Aggregate cost rows by date → total USD per day.
function dailyTotals(rows: readonly CostByDay[]): Map<string, number> {
  const m = new Map<string, number>()
  for (const r of rows) {
    m.set(r.date, (m.get(r.date) ?? 0) + r.cost_usd)
  }
  return m
}

// Group rows by date with per-agent OR per-model columns. Recharts wants
// each row to be `{ date, [seriesName]: value, ... }`.
//
// 116-postdeploy Bug 1: when grouping by agent, names are first collapsed
// to their root parent (subagent threads like `<parent>-sub-<nanoid6>` or
// `<parent>-via-<delegate>-<nanoid6>` roll up into `<parent>`). Then the
// top-N parents by total spend retain individual series; the long tail
// merges into an `other` bucket. This avoids the operator-reported bug
// where hundreds of subagent session names spilled across the legend.
function buildChartRows(
  rows: readonly CostByDay[],
  groupBy: 'agent' | 'model',
): { rows: Array<Record<string, number | string>>; series: string[] } {
  // Pass 1 (agent-only): compute parent totals → pick top-N.
  let topAgents: Set<string> | null = null
  if (groupBy === 'agent') {
    const totals = new Map<string, number>()
    for (const r of rows) {
      const parent = parentAgentName(r.agent)
      totals.set(parent, (totals.get(parent) ?? 0) + r.cost_usd)
    }
    const ranked = [...totals.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, TOP_AGENT_SERIES)
      .map(([name]) => name)
    topAgents = new Set(ranked)
  }

  // Pass 2: bucket each row into a date × series cell.
  const dateMap = new Map<string, Record<string, number | string>>()
  const seriesSet = new Set<string>()
  for (const r of rows) {
    let series: string
    if (groupBy === 'agent') {
      const parent = parentAgentName(r.agent)
      series = topAgents!.has(parent) ? parent : OTHER_BUCKET
    } else {
      series = modelBucket(r.model)
    }
    seriesSet.add(series)
    let row = dateMap.get(r.date)
    if (!row) {
      row = { date: r.date }
      dateMap.set(r.date, row)
    }
    row[series] = ((row[series] as number | undefined) ?? 0) + r.cost_usd
  }
  const sortedDates = [...dateMap.keys()].sort()

  // Sort series: `other` always last (visual: long tail sits at the top
  // of the stack, recognisable as the muted band). Otherwise alphabetical
  // for stable layout across renders.
  const series = [...seriesSet].sort((a, b) => {
    if (a === OTHER_BUCKET) return 1
    if (b === OTHER_BUCKET) return -1
    return a.localeCompare(b)
  })

  return {
    rows: sortedDates.map((d) => dateMap.get(d)!),
    series,
  }
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function AnomalyBanner(props: {
  readonly today: number
  readonly avg30: number
  readonly dayCount: number
}): JSX.Element | null {
  if (props.dayCount < MIN_DAYS_FOR_ANOMALY) return null
  if (props.avg30 <= 0) return null
  const ratio = props.today / props.avg30
  if (ratio < ANOMALY_MULTIPLIER) return null
  // 116-postdeploy: copy reframed from "spend anomaly" (anxiety-inducing
  // for theoretical numbers) to "high-volume day" (factual + neutral). Now
  // also lives INSIDE the collapsed theoretical-cost section, never at the
  // page top — the operator complaint was over-emphasis on $ figures.
  return (
    <div
      className="mb-4 rounded border border-warn/40 bg-warn/10 px-3 py-2 text-sm"
      data-testid="cost-anomaly-banner"
      role="status"
    >
      <span className="font-bold text-warn">High token-volume day:</span>{' '}
      <span className="text-fg-1">
        today's theoretical spend is {ratio.toFixed(1)}× the 30-day daily
        average ({formatUsd(props.today)} vs {formatUsd(props.avg30)}).
      </span>
    </div>
  )
}

// 116-postdeploy — reset-expectations banner. Operator runs on Claude Max
// ($200/mo flat). Dollar totals shown below are theoretical API-equivalent,
// not what they're billed. Dismissible to localStorage with a versioned
// key so we can re-show on copy changes.
function MaxBanner(): JSX.Element | null {
  const [dismissed, setDismissed] = useState<boolean>(false)

  // Resolve dismissal on mount only (avoid hydration flash from
  // localStorage on SSR-style re-mounts — not strictly an SSR app but the
  // pattern is cheap insurance).
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(MAX_BANNER_DISMISS_KEY)
      if (raw === '1') setDismissed(true)
    } catch {
      // localStorage may be blocked (private mode / sandboxed iframe). Show
      // the banner in that case — better to be repetitive than to silently
      // hide the framing reset.
    }
  }, [])

  if (dismissed) return null

  const onDismiss = (): void => {
    try {
      window.localStorage.setItem(MAX_BANNER_DISMISS_KEY, '1')
    } catch {
      /* see useEffect above */
    }
    setDismissed(true)
  }

  return (
    <div
      className="mb-4 flex items-start gap-3 rounded border border-primary/40 bg-primary/10 px-3 py-2 text-sm"
      data-testid="usage-max-banner"
      role="note"
    >
      <span aria-hidden className="font-display text-base">
        💠
      </span>
      <div className="flex-1">
        <span className="font-bold text-primary">You're on Claude Max</span>{' '}
        <span className="text-fg-1">($200/mo).</span>{' '}
        <span className="text-fg-2">
          Token spend below is theoretical API-equivalent — you're not being
          billed these amounts. Your real constraints are session + weekly
          limits, shown above.
        </span>
      </div>
      <Button
        size="sm"
        variant="ghost"
        onClick={onDismiss}
        data-testid="usage-max-banner-dismiss"
      >
        Dismiss
      </Button>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Subscription utilisation (primary surface) — fed by /api/usage.
//
// Aggregates per-rate-limit-type across all running agents. We pick the
// max utilisation per type (most-constrained agent wins) because the
// operator's effective constraint is whoever is closest to the cap, not
// the fleet average. resetsAt is also taken from that max-util snapshot
// so the countdown is meaningful for the binding agent.
// ---------------------------------------------------------------------------

const RATE_LIMIT_PRIMARY_TYPES = ['five_hour', 'seven_day'] as const
const RATE_LIMIT_CARVEOUT_TYPES = ['seven_day_opus', 'seven_day_sonnet'] as const

type AggregatedSnapshot = Readonly<{
  rateLimitType: string
  status: RateLimitSnapshot['status']
  utilization: number | undefined
  resetsAt: number | undefined
  bindingAgent: string | undefined
}>

function aggregateByType(
  fleet: UsageFleetResponse | undefined,
): Map<string, AggregatedSnapshot> {
  const out = new Map<string, AggregatedSnapshot>()
  if (!fleet) return out
  for (const entry of fleet.agents) {
    for (const snap of entry.snapshots) {
      const existing = out.get(snap.rateLimitType)
      const existingUtil = existing?.utilization ?? -1
      const incomingUtil = snap.utilization ?? -1
      // Rule: pick the most-constrained snapshot per type. rejected always
      // wins over allowed regardless of utilisation since `rejected` means
      // the cap is HIT.
      const incomingPriority =
        snap.status === 'rejected' ? Number.POSITIVE_INFINITY : incomingUtil
      const existingPriority =
        existing?.status === 'rejected' ? Number.POSITIVE_INFINITY : existingUtil
      if (existing && existingPriority >= incomingPriority) continue
      out.set(snap.rateLimitType, {
        rateLimitType: snap.rateLimitType,
        status: snap.status,
        utilization: snap.utilization,
        resetsAt: snap.resetsAt,
        bindingAgent: entry.agent,
      })
    }
  }
  return out
}

function findOverageState(
  fleet: UsageFleetResponse | undefined,
): {
  readonly status: RateLimitSnapshot['overageStatus']
  readonly disabledReason: string | undefined
  readonly isUsing: boolean | undefined
} | null {
  if (!fleet) return null
  // Overage state is per-account, not per-agent — but the SDK emits it on
  // any snapshot's overageStatus field. Take the first non-undefined value
  // we see; if multiple agents disagree (shouldn't happen) the first wins,
  // which is fine since the operator only needs the *existence* signal.
  for (const entry of fleet.agents) {
    for (const snap of entry.snapshots) {
      if (snap.overageStatus !== undefined || snap.isUsingOverage !== undefined) {
        return {
          status: snap.overageStatus,
          disabledReason: snap.overageDisabledReason,
          isUsing: snap.isUsingOverage,
        }
      }
    }
  }
  return null
}

function UsageBar(props: {
  readonly snapshot: AggregatedSnapshot
  readonly narrow?: boolean
  readonly testid: string
}): JSX.Element {
  const s = props.snapshot
  const pct = Math.min(100, Math.max(0, (s.utilization ?? 0) * 100))
  const barColor = utilizationBarColor(s.utilization)
  const labelSize = props.narrow ? 'text-xs' : 'text-sm'
  return (
    <div
      data-testid={props.testid}
      data-rate-limit-type={s.rateLimitType}
      data-status={s.status}
    >
      <div className={`flex items-baseline justify-between ${labelSize}`}>
        <span className="font-display font-bold text-fg-1">
          {statusEmoji(s.status)}{' '}
          <span className="font-sans font-normal">
            {humanizeRateLimitType(s.rateLimitType)}
          </span>
        </span>
        <span className="font-mono text-fg-2 data">
          {s.utilization === undefined ? '—' : `${pct.toFixed(0)}%`}
        </span>
      </div>
      <div
        className={`mt-1 w-full ${props.narrow ? 'h-2' : 'h-3'} bg-bg-s3 rounded overflow-hidden`}
      >
        <div
          className={`h-full ${barColor} transition-all`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <div className="mt-1 flex items-center justify-between text-[10px] font-mono text-fg-3">
        <span>{formatResetsIn(s.resetsAt)}</span>
        {s.bindingAgent !== undefined && (
          <span className="opacity-70" title="binding agent">
            {s.bindingAgent}
          </span>
        )}
      </div>
    </div>
  )
}

function SubscriptionUtilization(props: {
  readonly fleet: UsageFleetResponse | undefined
  readonly isLoading: boolean
}): JSX.Element {
  const byType = useMemo(() => aggregateByType(props.fleet), [props.fleet])
  const overage = useMemo(() => findOverageState(props.fleet), [props.fleet])

  const hasAny =
    byType.size > 0 ||
    (props.fleet?.agents.some((a) => a.snapshots.length > 0) ?? false)

  return (
    <Card
      className="bg-bg-elevated border-bg-s3 mb-4"
      data-testid="usage-subscription-card"
    >
      <CardHeader className="pb-1">
        <span className="font-display text-sm font-bold text-fg-1">
          Subscription utilisation
        </span>
        <span className="text-[10px] text-fg-3 font-sans">
          Live from SDK rate_limit_event. Most-constrained agent wins per
          limit type.
        </span>
      </CardHeader>
      <CardContent>
        {props.isLoading && !hasAny ? (
          <p className="text-fg-3 text-sm py-6 text-center">Loading…</p>
        ) : !hasAny ? (
          <p
            className="text-fg-3 text-sm py-6 text-center"
            data-testid="usage-empty-state"
          >
            Subscription utilisation data will appear after the first turn.
            Captured per-agent from SDK rate_limit_event messages.
          </p>
        ) : (
          <div className="space-y-4">
            {/* Primary bars — full-width 5h + 7d. */}
            <div className="space-y-3">
              {RATE_LIMIT_PRIMARY_TYPES.map((t) => {
                const snap = byType.get(t)
                if (!snap) return null
                return (
                  <UsageBar
                    key={t}
                    snapshot={snap}
                    testid={`usage-bar-${t}`}
                  />
                )
              })}
            </div>

            {/* Carve-outs — narrower side-by-side. */}
            {(byType.has('seven_day_opus') || byType.has('seven_day_sonnet')) && (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {RATE_LIMIT_CARVEOUT_TYPES.map((t) => {
                  const snap = byType.get(t)
                  if (!snap) return null
                  return (
                    <UsageBar
                      key={t}
                      snapshot={snap}
                      narrow
                      testid={`usage-bar-${t}`}
                    />
                  )
                })}
              </div>
            )}

            {/* Any unknown / future types from a newer SDK release. */}
            {[...byType.values()]
              .filter(
                (s) =>
                  !RATE_LIMIT_PRIMARY_TYPES.includes(
                    s.rateLimitType as (typeof RATE_LIMIT_PRIMARY_TYPES)[number],
                  ) &&
                  !RATE_LIMIT_CARVEOUT_TYPES.includes(
                    s.rateLimitType as (typeof RATE_LIMIT_CARVEOUT_TYPES)[number],
                  ) &&
                  s.rateLimitType !== 'overage',
              )
              .map((s) => (
                <UsageBar
                  key={s.rateLimitType}
                  snapshot={s}
                  narrow
                  testid={`usage-bar-${s.rateLimitType}`}
                />
              ))}

            {/* Overage row — small indicator, not a full bar. */}
            {overage && (
              <div
                className="text-xs text-fg-2 font-mono border-t border-bg-s3 pt-2"
                data-testid="usage-overage-row"
              >
                Overage:{' '}
                {overage.status === 'rejected'
                  ? '🔴 exceeded'
                  : overage.status === 'allowed_warning'
                    ? '🟡 allowed (warning)'
                    : overage.status === 'allowed'
                      ? overage.isUsing
                        ? '🟢 in use'
                        : '🟢 allowed'
                      : overage.disabledReason
                        ? `disabled (${overage.disabledReason})`
                        : 'disabled'}
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  )
}

// ---------------------------------------------------------------------------
// Token volume (secondary surface) — re-keyed off the existing costs rows.
//
// We sum tokens_in + tokens_out across the same /api/costs?period={} rows
// the USD cards use, so the SAME canonical period semantics apply (today
// = local midnight, week = Sunday-start, month = calendar month). Trend
// chart reuses the daily rows with cost_usd swapped for token totals.
// ---------------------------------------------------------------------------

function TokenCard(props: {
  readonly label: string
  readonly tokens: number | null
  readonly testid: string
}): JSX.Element {
  return (
    <Card className="bg-bg-elevated border-bg-s3" data-testid={props.testid}>
      <CardHeader className="pb-1">
        <span className="font-display text-[10px] uppercase tracking-wide text-fg-3">
          {props.label}
        </span>
      </CardHeader>
      <CardContent>
        <div className="font-display text-2xl font-bold text-fg-1 data">
          {props.tokens === null ? '—' : formatTokens(props.tokens)}
        </div>
        <div className="text-[10px] text-fg-3 font-sans">tokens (in + out)</div>
      </CardContent>
    </Card>
  )
}

function TokenTrendChart(props: {
  readonly rows: readonly CostByDay[]
}): JSX.Element {
  // Per-day total tokens (in+out) across the 30d window. We don't split
  // by agent here — the per-agent split lives in the demoted theoretical
  // cost section so the operator sees both views without duplication.
  const chartRows = useMemo(() => {
    const byDate = new Map<string, number>()
    for (const r of props.rows) {
      byDate.set(r.date, (byDate.get(r.date) ?? 0) + r.tokens_in + r.tokens_out)
    }
    return [...byDate.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([date, tokens]) => ({ date, tokens }))
  }, [props.rows])

  return (
    <Card
      className="bg-bg-elevated border-bg-s3"
      data-testid="usage-token-trend-card"
    >
      <CardHeader className="pb-1">
        <span className="font-display text-sm font-bold text-fg-1">
          Token volume ({chartRows.length}d)
        </span>
      </CardHeader>
      <CardContent>
        {chartRows.length === 0 ? (
          <p className="text-fg-3 text-sm py-12 text-center">No data yet.</p>
        ) : (
          <div style={{ width: '100%', height: 220 }}>
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart
                data={chartRows}
                margin={{ left: 4, right: 12, top: 8, bottom: 4 }}
              >
                {/* 116-postdeploy fix-pass — all chart chrome flips via
                    CSS vars. RGB channels for `--bg-*` / `--fg-*`, HSL
                    for shadcn `--primary`. */}
                <CartesianGrid strokeDasharray="3 3" stroke="rgb(var(--bg-s3))" />
                <XAxis
                  dataKey="date"
                  stroke="rgb(var(--fg-3))"
                  tick={{ fontSize: 10, fontFamily: 'monospace' }}
                />
                <YAxis
                  stroke="rgb(var(--fg-3))"
                  tick={{ fontSize: 10, fontFamily: 'monospace' }}
                  tickFormatter={(v: number) => formatTokens(v)}
                  width={48}
                />
                <RechartsTooltip
                  contentStyle={{
                    background: 'rgb(var(--bg-elevated))',
                    border: '1px solid rgb(var(--bg-s3))',
                    fontSize: 11,
                  }}
                  formatter={(v: number) => formatTokens(v)}
                />
                <Area
                  type="monotone"
                  dataKey="tokens"
                  stroke="hsl(var(--primary))"
                  fill="hsl(var(--primary))"
                  fillOpacity={0.35}
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

function SpendCard(props: {
  readonly label: string
  readonly amount: number | null
  readonly testid: string
}): JSX.Element {
  return (
    <Card className="bg-bg-elevated border-bg-s3" data-testid={props.testid}>
      <CardHeader className="pb-1">
        <span className="font-display text-[10px] uppercase tracking-wide text-fg-3">
          {props.label}
        </span>
      </CardHeader>
      <CardContent>
        <div className="font-display text-2xl font-bold text-fg-1 data">
          {props.amount === null ? '—' : formatUsd(props.amount)}
        </div>
      </CardContent>
    </Card>
  )
}

function TrendChart(props: {
  readonly rows: readonly CostByDay[]
  readonly groupBy: 'agent' | 'model'
  readonly setGroupBy: (v: 'agent' | 'model') => void
}): JSX.Element {
  const { rows: chartRows, series } = useMemo(
    () => buildChartRows(props.rows, props.groupBy),
    [props.rows, props.groupBy],
  )

  return (
    <Card className="bg-bg-elevated border-bg-s3">
      <CardHeader className="flex flex-row items-center justify-between pb-1">
        <span className="font-display text-sm font-bold text-fg-1">
          Spend trend ({chartRows.length}d)
        </span>
        <div className="flex gap-1">
          <Button
            size="sm"
            variant={props.groupBy === 'agent' ? 'default' : 'outline'}
            onClick={() => props.setGroupBy('agent')}
            data-testid="cost-trend-by-agent"
          >
            by agent
          </Button>
          <Button
            size="sm"
            variant={props.groupBy === 'model' ? 'default' : 'outline'}
            onClick={() => props.setGroupBy('model')}
            data-testid="cost-trend-by-model"
          >
            by model
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {chartRows.length === 0 ? (
          <p className="text-fg-3 text-sm py-12 text-center">No data yet.</p>
        ) : (
          <div style={{ width: '100%', height: 280 }}>
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={chartRows} margin={{ left: 4, right: 12, top: 8, bottom: 4 }}>
                {/* 116-postdeploy fix-pass — theme-aware chart chrome. */}
                <CartesianGrid strokeDasharray="3 3" stroke="rgb(var(--bg-s3))" />
                <XAxis
                  dataKey="date"
                  stroke="rgb(var(--fg-3))"
                  tick={{ fontSize: 10, fontFamily: 'monospace' }}
                />
                <YAxis
                  stroke="rgb(var(--fg-3))"
                  tick={{ fontSize: 10, fontFamily: 'monospace' }}
                  tickFormatter={(v) => formatUsd(v)}
                  width={60}
                />
                <RechartsTooltip
                  contentStyle={{
                    background: 'rgb(var(--bg-elevated))',
                    border: '1px solid rgb(var(--bg-s3))',
                    fontSize: 11,
                  }}
                  formatter={(v: number) => formatUsd(v)}
                />
                <Legend
                  wrapperStyle={{ fontSize: 10, fontFamily: 'monospace' }}
                />
                {series.map((s, idx) => (
                  <Area
                    key={s}
                    type="monotone"
                    dataKey={s}
                    stackId="cost"
                    stroke={pickColor(props.groupBy, s, idx)}
                    fill={pickColor(props.groupBy, s, idx)}
                    fillOpacity={0.45}
                  />
                ))}
              </AreaChart>
            </ResponsiveContainer>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

// Series-color picker — when grouping by model, use the canonical model
// palette; when grouping by agent, fall back to a 6-color cycle.
//
// 116-postdeploy fix-pass — the two semantic-tokenable colors in the
// agent cycle (emerald=primary, amber=warn) flip with theme. The rest
// (violet/blue/pink/cyan) stay literal — they're visually identifiable
// in both themes and we don't have semantic CSS vars for them. Lift on
// demand.
const AGENT_COLORS = [
  'hsl(var(--primary))', // emerald — theme-aware
  '#a855f7',             // violet
  'hsl(var(--warn))',    // amber — theme-aware
  '#3b82f6',             // blue
  '#ec4899',             // pink
  '#06b6d4',             // cyan
]
function pickColor(
  groupBy: 'agent' | 'model',
  series: string,
  idx: number,
): string {
  if (groupBy === 'model') {
    return (
      MODEL_COLORS[series as keyof typeof MODEL_COLORS] ?? MODEL_COLORS.other
    )
  }
  // 116-postdeploy Bug 1 — stable muted color for the "other" bucket so
  // the long-tail collapse reads as such (and doesn't fight for attention
  // against the top-N real-agent bands). Routed through `--fg-2` so the
  // bucket reads as "muted-but-visible" in BOTH themes (zinc-600 hex was
  // dark-tuned and rendered too-faint on the white light-mode bg).
  if (series === OTHER_BUCKET) return 'rgb(var(--fg-2))'
  return AGENT_COLORS[idx % AGENT_COLORS.length]!
}

function ModelDonut(props: { readonly rows: readonly CostByDay[] }): JSX.Element {
  const data = useMemo(() => {
    const m = new Map<string, number>()
    for (const r of props.rows) {
      const b = modelBucket(r.model)
      m.set(b, (m.get(b) ?? 0) + r.cost_usd)
    }
    return [...m.entries()].map(([name, value]) => ({ name, value }))
  }, [props.rows])

  const total = data.reduce((acc, d) => acc + d.value, 0)

  return (
    <Card className="bg-bg-elevated border-bg-s3">
      <CardHeader className="pb-1">
        <span className="font-display text-sm font-bold text-fg-1">
          Spend by model (30d)
        </span>
      </CardHeader>
      <CardContent>
        {total === 0 ? (
          <p className="text-fg-3 text-sm py-12 text-center">No spend.</p>
        ) : (
          <div style={{ width: '100%', height: 220 }} data-testid="cost-model-donut">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie
                  data={data}
                  dataKey="value"
                  innerRadius={50}
                  outerRadius={80}
                  startAngle={90}
                  endAngle={-270}
                  stroke="none"
                  isAnimationActive={false}
                  label={(entry) => entry.name}
                  labelLine={false}
                >
                  {data.map((d) => (
                    <Cell
                      key={d.name}
                      fill={
                        MODEL_COLORS[d.name as keyof typeof MODEL_COLORS] ??
                        MODEL_COLORS.other
                      }
                    />
                  ))}
                </Pie>
                <RechartsTooltip
                  contentStyle={{
                    background: 'rgb(var(--bg-elevated))',
                    border: '1px solid rgb(var(--bg-s3))',
                    fontSize: 11,
                  }}
                  formatter={(v: number) => formatUsd(v)}
                />
              </PieChart>
            </ResponsiveContainer>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

function ProjectionCard(props: {
  readonly dailyTotals: ReadonlyMap<string, number>
}): JSX.Element {
  const dayCount = props.dailyTotals.size
  if (dayCount < MIN_DAYS_FOR_PROJECTION) {
    return (
      <Card className="bg-bg-elevated border-bg-s3" data-testid="cost-projection-card">
        <CardHeader className="pb-1">
          <span className="font-display text-sm font-bold text-fg-1">
            Month-end projection
          </span>
        </CardHeader>
        <CardContent>
          <p className="text-fg-3 text-sm">
            Insufficient data — gather {MIN_DAYS_FOR_PROJECTION}d for projection
            ({dayCount}/{MIN_DAYS_FOR_PROJECTION} so far).
          </p>
        </CardContent>
      </Card>
    )
  }

  // Sort daily totals chronologically; x = day index (0,1,2,...).
  const sorted = [...props.dailyTotals.entries()].sort((a, b) =>
    a[0].localeCompare(b[0]),
  )
  const points = sorted.map(([_d, y], i) => ({ x: i, y }))
  const reg = linearRegression(points)
  if (!reg) {
    return (
      <Card className="bg-bg-elevated border-bg-s3" data-testid="cost-projection-card">
        <CardHeader className="pb-1">
          <span className="font-display text-sm font-bold text-fg-1">
            Month-end projection
          </span>
        </CardHeader>
        <CardContent>
          <p className="text-fg-3 text-sm">
            Trend not fittable — variance too low.
          </p>
        </CardContent>
      </Card>
    )
  }

  // Extrapolate to month-end.
  const now = new Date()
  const monthEnd = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0),
  )
  // Days from first observed date to now (most recent x).
  const lastX = points.length - 1
  const todayDate = new Date(sorted[sorted.length - 1]![0] + 'T00:00:00Z')
  const daysToEnd = Math.max(
    0,
    Math.round((monthEnd.getTime() - todayDate.getTime()) / 86_400_000),
  )
  // Project remainder spend = sum_{i=lastX+1..lastX+daysToEnd} (slope*i + intercept).
  let projectedRest = 0
  for (let i = lastX + 1; i <= lastX + daysToEnd; i++) {
    projectedRest += Math.max(0, reg.slope * i + reg.intercept)
  }
  const observed = points.reduce((acc, p) => acc + p.y, 0)
  const projectedMonthEnd = observed + projectedRest
  const trendDirection =
    reg.slope > 0.0001 ? '↑' : reg.slope < -0.0001 ? '↓' : '→'

  return (
    <Card className="bg-bg-elevated border-bg-s3" data-testid="cost-projection-card">
      <CardHeader className="pb-1">
        <span className="font-display text-sm font-bold text-fg-1">
          Month-end projection
        </span>
      </CardHeader>
      <CardContent>
        <div className="font-display text-2xl font-bold text-fg-1 data">
          {formatUsd(projectedMonthEnd)} {trendDirection}
        </div>
        <p className="text-fg-3 text-xs mt-1">
          Linear extrapolation from {dayCount}d trend.{' '}
          {formatUsd(observed)} observed + {formatUsd(projectedRest)} projected
          ({daysToEnd}d remaining).
        </p>
      </CardContent>
    </Card>
  )
}

function BudgetGauges(props: { readonly rows: readonly BudgetRow[] }): JSX.Element {
  if (props.rows.length === 0) {
    return (
      <Card className="bg-bg-elevated border-bg-s3">
        <CardHeader className="pb-1">
          <span className="font-display text-sm font-bold text-fg-1">
            Escalation budgets (tokens)
          </span>
        </CardHeader>
        <CardContent>
          <p className="text-fg-3 text-sm">
            No escalation budgets configured. Add{' '}
            <code className="font-mono text-fg-2">escalationBudget</code> to an
            agent in clawcode.yaml to see usage here.
          </p>
        </CardContent>
      </Card>
    )
  }
  return (
    <Card className="bg-bg-elevated border-bg-s3">
      <CardHeader className="pb-1">
        <span className="font-display text-sm font-bold text-fg-1">
          Escalation budgets (tokens)
        </span>
        <span className="text-[10px] text-fg-3 font-sans">
          Units: tokens (matches AgentBudgetConfig schema). USD spend cards above
          are separate.
        </span>
      </CardHeader>
      <CardContent>
        <div className="space-y-2" data-testid="cost-budget-gauges">
          {props.rows.map((r) => (
            <BudgetBar key={`${r.agent}.${r.model}.${r.period}`} row={r} />
          ))}
        </div>
      </CardContent>
    </Card>
  )
}

function BudgetBar(props: { readonly row: BudgetRow }): JSX.Element {
  const r = props.row
  const pct = Math.min(100, r.pct * 100)
  const color =
    r.status === 'exceeded'
      ? 'bg-danger'
      : r.status === 'warning'
        ? 'bg-warn'
        : 'bg-primary'
  return (
    <div data-testid="cost-budget-row" data-agent={r.agent} data-status={r.status}>
      <div className="flex items-baseline justify-between text-xs font-mono">
        <span className="text-fg-1">
          {r.agent} · {r.model} ·{' '}
          <span className="text-fg-3">{r.period}</span>
        </span>
        <span className="text-fg-2 data">
          {r.tokens_used.toLocaleString()} / {r.tokens_limit.toLocaleString()}{' '}
          ({(r.pct * 100).toFixed(1)}%)
        </span>
      </div>
      <div className="mt-0.5 h-1.5 w-full bg-bg-s3 rounded overflow-hidden">
        <div
          className={`h-full ${color}`}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Demoted: theoretical API-equivalent cost section. Collapsible — default
// closed because Operator runs on Claude Max and these numbers are NOT
// what they're billed. Kept for budget-planning curiosity (e.g. "what
// would this cost if I switched off Max?") and so the existing telemetry
// surface isn't deleted; it's just reframed.
// ---------------------------------------------------------------------------

function TheoreticalCostSection(props: {
  readonly todayTotal: number
  readonly weekTotal: number
  readonly monthTotal: number
  readonly todayLoading: boolean
  readonly weekLoading: boolean
  readonly monthLoading: boolean
  readonly dailyRows: readonly CostByDay[]
  readonly dailyMap: ReadonlyMap<string, number>
  readonly avg30: number
}): JSX.Element {
  const [open, setOpen] = useState<boolean>(false)
  const [groupBy, setGroupBy] = useState<'agent' | 'model'>('agent')

  return (
    <Card
      className="bg-bg-elevated border-bg-s3 mb-4"
      data-testid="usage-theoretical-cost-section"
    >
      <CardHeader
        className="pb-1 cursor-pointer select-none flex flex-row items-center justify-between"
        onClick={() => setOpen((v) => !v)}
      >
        <div>
          <span className="font-display text-sm font-bold text-fg-1">
            Theoretical API-equivalent cost (if billed)
          </span>
          <span className="block text-[10px] text-fg-3 font-sans">
            What this would cost via the public API. Not what you're billed
            on Claude Max.
          </span>
        </div>
        <Button
          size="sm"
          variant="ghost"
          onClick={(e) => {
            e.stopPropagation()
            setOpen((v) => !v)
          }}
          data-testid="usage-theoretical-cost-toggle"
        >
          {open ? 'Hide' : 'Show'}
        </Button>
      </CardHeader>
      {open && (
        <CardContent>
          <AnomalyBanner
            today={props.todayTotal}
            avg30={props.avg30}
            dayCount={props.dailyMap.size}
          />

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-4">
            <SpendCard
              label="Today"
              amount={props.todayLoading ? null : props.todayTotal}
              testid="cost-card-today"
            />
            <SpendCard
              label="This week"
              amount={props.weekLoading ? null : props.weekTotal}
              testid="cost-card-week"
            />
            <SpendCard
              label="This month"
              amount={props.monthLoading ? null : props.monthTotal}
              testid="cost-card-month"
            />
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
            <div className="lg:col-span-2">
              <TrendChart
                rows={props.dailyRows}
                groupBy={groupBy}
                setGroupBy={setGroupBy}
              />
            </div>
            <div className="space-y-3">
              <ProjectionCard dailyTotals={props.dailyMap} />
              <ModelDonut rows={props.dailyRows} />
            </div>
          </div>
        </CardContent>
      )}
    </Card>
  )
}

export function UsageDashboard(): JSX.Element {
  // Subscription utilisation — primary surface.
  const usageQ = useFleetUsage()

  // Token + cost data (re-keyed: tokens are primary, USD is demoted).
  const todayQ = useCosts('today')
  const weekQ = useCosts('week')
  const monthQ = useCosts('month')
  const dailyQ = useCostsDaily(30, null)
  const budgetQ = useBudgets()

  // Phase 138 Plan 02 T-04 — fleet credit telemetry. Rides on the
  // heartbeat-status payload (REST initial fetch + `health` SSE event
  // refresh — see useApi.ts CreditTelemetryPayload doc). No new poller.
  const heartbeatQ = useHeartbeatStatus()

  // Token totals — sum tokens_in + tokens_out across the canonical period
  // rows so the period semantics match the USD cards exactly.
  const todayTokens = useMemo(
    () =>
      (todayQ.data?.costs ?? []).reduce(
        (acc, r) => acc + r.input_tokens + r.output_tokens,
        0,
      ),
    [todayQ.data],
  )
  const weekTokens = useMemo(
    () =>
      (weekQ.data?.costs ?? []).reduce(
        (acc, r) => acc + r.input_tokens + r.output_tokens,
        0,
      ),
    [weekQ.data],
  )
  const monthTokens = useMemo(
    () =>
      (monthQ.data?.costs ?? []).reduce(
        (acc, r) => acc + r.input_tokens + r.output_tokens,
        0,
      ),
    [monthQ.data],
  )

  // USD totals — retained for the demoted theoretical-cost section.
  const todayTotal = useMemo(
    () => (todayQ.data?.costs ?? []).reduce((acc, r) => acc + r.cost_usd, 0),
    [todayQ.data],
  )
  const weekTotal = useMemo(
    () => (weekQ.data?.costs ?? []).reduce((acc, r) => acc + r.cost_usd, 0),
    [weekQ.data],
  )
  const monthTotal = useMemo(
    () => (monthQ.data?.costs ?? []).reduce((acc, r) => acc + r.cost_usd, 0),
    [monthQ.data],
  )

  const dailyRows = useMemo(() => dailyQ.data?.rows ?? [], [dailyQ.data])
  const dailyMap = useMemo(() => dailyTotals(dailyRows), [dailyRows])
  const avg30 = useMemo(() => {
    if (dailyMap.size === 0) return 0
    const sum = [...dailyMap.values()].reduce((a, b) => a + b, 0)
    return sum / 30 // by-definition daily average over the 30d window
  }, [dailyMap])

  return (
    <div className="mx-auto max-w-7xl px-7 py-6">
      {/* dash-redesign sweep — section-head pattern. Subscription/
          token framing folds into .sub so the operator scans
          'Usage · subscription first · tokens second · USD collapsed'
          on one row. */}
      <div className="section-head mb-5">
        <div className="flex items-baseline">
          <h2>Usage</h2>
          <span className="sub">
            subscription utilisation first · token volume second · API-equivalent USD collapsed
          </span>
        </div>
      </div>

      <MaxBanner />

      <SubscriptionUtilization
        fleet={usageQ.data}
        isLoading={usageQ.isLoading}
      />

      {/* Phase 138 Plan 02 T-04 — fleet credit telemetry. Additive: the
          panel self-hides when the daemon omits `creditTelemetry`
          (pre-138) so the rest of the usage layout is undisturbed. */}
      <CreditTelemetryPanel telemetry={heartbeatQ.data?.creditTelemetry} />

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-4">
        <TokenCard
          label="Today"
          tokens={todayQ.isLoading ? null : todayTokens}
          testid="usage-tokens-today"
        />
        <TokenCard
          label="This week"
          tokens={weekQ.isLoading ? null : weekTokens}
          testid="usage-tokens-week"
        />
        <TokenCard
          label="This month"
          tokens={monthQ.isLoading ? null : monthTokens}
          testid="usage-tokens-month"
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-3 mb-4">
        <div className="lg:col-span-2">
          <TokenTrendChart rows={dailyRows} />
        </div>
        <div>
          <ModelDonut rows={dailyRows} />
        </div>
      </div>

      <TheoreticalCostSection
        todayTotal={todayTotal}
        weekTotal={weekTotal}
        monthTotal={monthTotal}
        todayLoading={todayQ.isLoading}
        weekLoading={weekQ.isLoading}
        monthLoading={monthQ.isLoading}
        dailyRows={dailyRows}
        dailyMap={dailyMap}
        avg30={avg30}
      />

      <BudgetGauges rows={budgetQ.data?.rows ?? []} />
    </div>
  )
}

// Backwards-compat alias: App.tsx historically imports `{ CostDashboard }`
// from this module via React.lazy. Re-exporting the new component under
// the old name keeps the lazy import resolver working without touching
// the route plumbing in this commit (handled separately in the nav rename
// commit so the diff stays atomic).
export const CostDashboard = UsageDashboard

export default UsageDashboard
