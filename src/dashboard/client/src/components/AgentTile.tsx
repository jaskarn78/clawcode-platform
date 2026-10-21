/**
 * Phase 116 Plan 01 T02 — F03 per-agent tile.
 *
 * One shadcn <Card> per agent, composing:
 *   - Status dot (running / starting / errored / stopped → palette colors)
 *   - Name + model badge (`useAgentCache.slos.model` — `/api/status` has no model)
 *   - ContextMeter (F04 — Tier 1 inject budget)
 *   - First-token p50, SLO-colored (observed from latency endpoint, threshold
 *     from cache.slos.first_token_p50_ms; > 2× threshold → red)
 *   - 24h activity sparkline — emerald area chart of hourly turn counts
 *     (Phase 116-postdeploy 2026-05-12; replaced the Skeleton placeholder)
 *   - Last-turn relative time ("2m ago") — from `useAgents().lastTurnAt`
 *   - ToolCacheGauge (F05)
 *   - MetricCounters (F08 — prompt-bloat + lazy-recall)
 *
 * Migration phase + per-agent MCP health are NOT in /api/status today —
 * those rows are conditionally rendered iff the daemon ever surfaces them.
 * Documented as plan deviations in 116-01-SUMMARY.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { AreaChart, Area, ResponsiveContainer } from 'recharts'
import { Card, CardContent, CardHeader } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import {
  useAgentCache,
  useAgentLatency,
  useAgentActivity,
  useHeartbeatStatus,
  type ActivityResponse,
} from '@/hooks/useApi'
import { ContextMeter } from './ContextMeter'
import { ToolCacheGauge } from './ToolCacheGauge'
import { MetricCounters } from './MetricCounters'

// ---------------------------------------------------------------------------
// ActivitySparkline — Phase 116-postdeploy 2026-05-12.
//
// Renders a tiny 24h hourly-turn-count area chart for the tile. Reads
// /api/agents/:name/activity via useAgentActivity. Empty / errored
// queries fall through to a slim "no turns 24h" mono empty state
// (operator hard requirement — stopped agents must NEVER render junk
// or a perpetual Skeleton).
//
// Theming: stroke + fill are CSS variables resolved at SVG paint time,
// so the chart flips between light + dark when the operator toggles
// theme without forcing a React re-render. `--primary` in index.css
// is declared as HSL components ("158 64% 39%"), so we wrap it in
// hsl(...) when passing to Recharts (which forwards to SVG attrs).
// ---------------------------------------------------------------------------
function ActivitySparkline(props: { readonly agentName: string }): JSX.Element {
  const q = useAgentActivity(props.agentName, 24)
  const data = q.data as ActivityResponse | undefined
  const buckets = data?.buckets ?? []
  const hasData = !q.isError && buckets.length > 0

  if (!hasData) {
    return (
      <div className="h-8 flex items-center text-[11px] font-mono text-fg-3">
        no turns 24h
      </div>
    )
  }
  // Recharts wants a plain mutable shape; map the readonly buckets to
  // {hour, count}. The chart has no axes, grid, tooltip, or legend —
  // just the area for visual density (per design constraint).
  const chartData = buckets.map((b) => ({
    hour: b.bucket,
    count: b.turn_count,
  }))
  return (
    <div className="h-8 w-full" data-testid="agent-tile-sparkline">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={chartData} margin={{ top: 2, right: 0, left: 0, bottom: 2 }}>
          <Area
            type="monotone"
            dataKey="count"
            stroke="hsl(var(--primary))"
            fill="hsl(var(--primary))"
            fillOpacity={0.3}
            strokeWidth={1.5}
            isAnimationActive={false}
            dot={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  )
}

// ---------------------------------------------------------------------------
// TokensSparkline — Phase 124 Plan 04 T-03.
//
// Renders a bounded ring buffer (≤60 samples) of `session_tokens` per
// agent, fed by successive `useHeartbeatStatus` polls. Lives adjacent
// to ActivitySparkline so operators see two orthogonal signals on each
// tile: 24h turn count + recent context-token trend.
//
// Scope-bounded: no new SSE channel, no backend time-series; the
// component derives the series locally from the existing poll cadence.
// Empty buffer (first poll OR no data) → "no tokens yet" mono fallback.
// ---------------------------------------------------------------------------
const TOKENS_RING_SIZE = 60

function TokensSparkline(props: { readonly agentName: string }): JSX.Element {
  const q = useHeartbeatStatus()
  const tokens = q.data?.agents?.[props.agentName]?.session_tokens ?? null
  // Ring buffer kept in component state. Updates only on truthy numeric
  // samples to avoid feeding null/undefined into the chart. A useRef
  // dedup gate prevents double-push from React StrictMode re-renders.
  const [buffer, setBuffer] = useState<ReadonlyArray<number>>([])
  const lastSampleRef = useRef<number | null>(null)

  useEffect(() => {
    if (typeof tokens !== 'number') return
    if (lastSampleRef.current === tokens) return
    lastSampleRef.current = tokens
    setBuffer((prev) => {
      const next = [...prev, tokens]
      return next.length > TOKENS_RING_SIZE
        ? next.slice(next.length - TOKENS_RING_SIZE)
        : next
    })
  }, [tokens])

  if (buffer.length === 0) {
    return (
      <div className="h-8 flex items-center text-[11px] font-mono text-fg-3">
        no tokens yet
      </div>
    )
  }
  const chartData = buffer.map((v, i) => ({ i, v }))
  return (
    <div className="h-8 w-full" data-testid="agent-tile-tokens-sparkline">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={chartData} margin={{ top: 2, right: 0, left: 0, bottom: 2 }}>
          <Area
            type="monotone"
            dataKey="v"
            stroke="hsl(var(--warn))"
            fill="hsl(var(--warn))"
            fillOpacity={0.25}
            strokeWidth={1.5}
            isAnimationActive={false}
            dot={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Loose payload types — useAgentCache / useAgentLatency return unknown.
// Narrow at the boundary.
// ---------------------------------------------------------------------------

type CachePayload = {
  readonly slos?: {
    readonly first_token_p50_ms?: number
    readonly model?: string
    readonly source?: string
  }
  readonly tier1_inject_chars?: number | null
  readonly tier1_budget_pct?: number | null
  readonly lazy_recall_call_count?: number | null
  readonly prompt_bloat_warnings_24h?: number | null
  readonly tool_cache_hit_rate?: number | null
  readonly tool_cache_size_mb?: number | null
  readonly tool_cache_size_mb_live?: number | null
  readonly tool_cache_turns?: number
}

type LatencyPayload = {
  readonly first_token_headline?: {
    readonly p50?: number | null
    readonly count?: number
    readonly slo_status?: string
  }
}

// ---------------------------------------------------------------------------
// Status palette — matches the v1 dashboard's well-known status strings.
// ---------------------------------------------------------------------------

function statusPalette(status: string | undefined): {
  readonly dot: string
  readonly ring: string
  readonly label: string
} {
  switch (status) {
    case 'running':
      return { dot: 'bg-primary', ring: 'ring-primary/30', label: 'running' }
    case 'starting':
      return { dot: 'bg-warn', ring: 'ring-warn/30', label: 'starting' }
    case 'errored':
    case 'crashed':
      return { dot: 'bg-danger', ring: 'ring-danger/30', label: 'errored' }
    case 'stopped':
    case 'idle':
      return { dot: 'bg-fg-3', ring: 'ring-fg-3/30', label: status }
    default:
      return { dot: 'bg-fg-3', ring: 'ring-fg-3/20', label: status ?? 'unknown' }
  }
}

// F02 SLO color logic — observed vs threshold.
function sloColor(
  observedMs: number | null,
  thresholdMs: number | null,
): string {
  if (observedMs === null || thresholdMs === null) return 'text-fg-3'
  if (observedMs > thresholdMs * 2) return 'text-danger'
  if (observedMs > thresholdMs) return 'text-warn'
  return 'text-primary'
}

// Relative-time formatter — handles ISO strings AND epoch ms. Compact:
// "2m ago", "3h ago", "5d ago".
function relativeTime(input: string | number | null | undefined): string {
  if (!input) return '—'
  const ms =
    typeof input === 'number' ? input : new Date(input).getTime()
  if (!Number.isFinite(ms)) return '—'
  const delta = Date.now() - ms
  if (delta < 0) return 'just now'
  const sec = Math.floor(delta / 1000)
  if (sec < 60) return `${sec}s ago`
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}m ago`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h ago`
  const d = Math.floor(hr / 24)
  return `${d}d ago`
}

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

export type AgentTileProps = {
  readonly agent: {
    readonly name: string
    readonly status?: string
    readonly lastTurnAt?: string | number | null
    readonly startedAt?: number | null
    readonly uptime?: number | null
    readonly restartCount?: number
    readonly lastError?: string | null
    // model is NOT in /api/status; we read it from useAgentCache. Defensive
    // passthrough only — wins over cache.slos.model if the daemon ever adds it.
    readonly model?: string
  }
  /** Click handler placeholder — 116-04 wires the drawer. */
  readonly onSelect?: (agent: string) => void
}

export function AgentTile(props: AgentTileProps): JSX.Element {
  const { agent } = props
  const cacheQ = useAgentCache(agent.name)
  const latencyQ = useAgentLatency(agent.name)
  const cache = cacheQ.data as CachePayload | undefined
  const latency = latencyQ.data as LatencyPayload | undefined

  const palette = statusPalette(agent.status)
  const model = agent.model ?? cache?.slos?.model ?? null
  const threshold = cache?.slos?.first_token_p50_ms ?? null
  const observedP50 = latency?.first_token_headline?.p50 ?? null
  const observedCount = latency?.first_token_headline?.count ?? 0
  // Cold-start guard — count < 5 → display as no-data rather than misleading.
  const p50Display =
    observedP50 === null || observedCount < 5
      ? '—'
      : `${Math.round(observedP50)}ms`
  const p50Color = sloColor(
    observedCount < 5 ? null : observedP50,
    threshold,
  )

  const tier1Chars = cache?.tier1_inject_chars ?? null
  const tier1Pct = cache?.tier1_budget_pct ?? null
  const toolRate = cache?.tool_cache_hit_rate ?? null
  // Prefer the fleet-wide live size over the per-agent rolled value when
  // available; rolled value can lag the very first turn.
  const toolSize =
    cache?.tool_cache_size_mb_live ?? cache?.tool_cache_size_mb ?? null
  const toolTurns = cache?.tool_cache_turns

  const lastTurn = useMemo(
    () => relativeTime(agent.lastTurnAt ?? null),
    [agent.lastTurnAt],
  )

  return (
    <Card
      onClick={() => props.onSelect?.(agent.name)}
      className="bg-bg-elevated border-bg-s3 text-fg-1 hover:border-primary/40 transition-colors cursor-pointer"
      data-testid="agent-tile"
      data-agent={agent.name}
      role={props.onSelect ? 'button' : undefined}
      tabIndex={props.onSelect ? 0 : undefined}
    >
      <CardHeader className="pb-3 space-y-2">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <TooltipProvider delayDuration={200}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <span
                    className={`inline-block w-2.5 h-2.5 rounded-full ${palette.dot} ring-2 ${palette.ring} shrink-0`}
                    aria-label={`Status: ${palette.label}`}
                  />
                </TooltipTrigger>
                <TooltipContent
                  side="top"
                  className="bg-bg-elevated text-fg-1 border border-bg-s3 font-mono text-xs"
                >
                  {palette.label}
                  {agent.lastError && (
                    <span className="block text-danger mt-1 max-w-xs whitespace-normal">
                      {agent.lastError}
                    </span>
                  )}
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
            <h3 className="font-display text-base font-bold truncate">
              {agent.name}
            </h3>
          </div>
          {model && (
            <Badge
              variant="outline"
              className="font-mono uppercase text-[10px] border-bg-s3 text-fg-2 shrink-0"
            >
              {model}
            </Badge>
          )}
        </div>

        {/* SLO + last turn row */}
        <div className="flex items-center justify-between text-xs font-sans">
          <div className="flex items-center gap-1.5">
            <span className="text-fg-3">first_token p50</span>
            <span className={`font-mono data ${p50Color}`}>{p50Display}</span>
            {threshold !== null && (
              <span className="text-fg-3">/ {Math.round(threshold)}ms</span>
            )}
          </div>
          <span className="text-fg-3 font-mono data">{lastTurn}</span>
        </div>
      </CardHeader>

      <CardContent className="space-y-4 pb-4">
        <ContextMeter
          tier1InjectChars={tier1Chars}
          tier1BudgetPct={tier1Pct}
          showSparkline={false}
        />

        {/* 24h activity sparkline — Phase 116-postdeploy 2026-05-12.
            Reads /api/agents/:name/activity (per-hour turn counts).
            Stopped / dormant agents render "no turns 24h" instead of
            a Skeleton; theme color flows via --primary CSS var. */}
        <div>
          <div className="text-[11px] uppercase tracking-wide text-fg-3 mb-1 font-sans">
            24h activity
          </div>
          <ActivitySparkline agentName={agent.name} />
        </div>

        {/* Tokens sparkline — Phase 124 Plan 04 T-03.
            Reads /api/heartbeat-status (session_tokens per agent),
            maintains a 60-sample ring buffer in component state.
            Warn-color stroke so it visually contrasts the activity
            primary-color sparkline. */}
        <div>
          <div className="text-[11px] uppercase tracking-wide text-fg-3 mb-1 font-sans">
            tokens
          </div>
          <TokensSparkline agentName={agent.name} />
        </div>

        <div className="flex items-center justify-between gap-3">
          <ToolCacheGauge
            toolCacheHitRate={toolRate}
            toolCacheSizeMb={toolSize}
            toolCacheTurns={toolTurns}
          />
          <MetricCounters
            agent={agent.name}
            promptBloatWarnings24h={cache?.prompt_bloat_warnings_24h ?? null}
            lazyRecallCallCount={cache?.lazy_recall_call_count ?? null}
          />
        </div>
      </CardContent>
    </Card>
  )
}

export default AgentTile
