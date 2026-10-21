/**
 * Phase 116 Plan 02 T02 — F07 Tool latency split panel.
 *
 * Visualizes the prompt-bloat tax gap by rendering BOTH `tool_execution_ms`
 * (filled emerald bar — actual tool work time) AND `tool_roundtrip_ms`
 * (outlined emerald bar — full turn elapsed including LLM-resume) PER AGENT.
 *
 * Data source: `/api/agents/:name/cache` fields populated by the Phase
 * 115-08 producer port (now live on master, commit a0f30a6):
 *   - tool_execution_ms_p50
 *   - tool_roundtrip_ms_p50
 *   - parallel_tool_call_rate
 *
 * The 115-08 columns are per-TURN aggregates (one p50 per agent per
 * window), not per-tool. The plan's original "top 10 tools by p95" framing
 * would require per-tool granularity in the new columns, which doesn't
 * exist in traces.db. For per-tool latency operators have:
 *   - `/api/agents/:name/tools` (per-tool p50/p95/p99 from trace_spans,
 *     single-bar — drawer 116-04 will surface this)
 *
 * What this panel shows: ONE pair of bars per AGENT (top N by p95
 * roundtrip; default top 10), making the cross-fleet exec-vs-roundtrip
 * gap visible at a glance. Operators flip to the agent drawer for
 * per-tool depth.
 *
 * Empty-data state: if neither column populates for ANY agent, render a
 * "no split data yet — daemon restart required" notice rather than
 * silently falling back. The 115-08 port shipped; if columns are null
 * the daemon hasn't been restarted since the deploy. Operator decides.
 */
import { useMemo, useState, useCallback, useEffect } from 'react'
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip as RechartsTooltip,
  ResponsiveContainer,
  Cell,
} from 'recharts'
import { useAgents, useAgentCache } from '@/hooks/useApi'
import { Card, CardContent, CardHeader } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'

type CachePayload = {
  readonly tool_execution_ms_p50?: number | null
  readonly tool_roundtrip_ms_p50?: number | null
  readonly parallel_tool_call_rate?: number | null
  readonly slos?: {
    readonly first_token_p50_ms?: number
  }
}

type Row = {
  readonly agent: string
  readonly execMs: number | null
  readonly roundtripMs: number | null
  readonly parallelRate: number | null
  readonly thresholdMs: number | null
}

// Recharts data row shape — both `exec` and `roundtrip` keys map to dataKey
// props in the <Bar> components below.
type ChartDatum = {
  readonly agent: string
  readonly exec: number
  readonly roundtrip: number
  readonly gap: number
}

// ---------------------------------------------------------------------------
// Per-agent probe — one row per agent. Renders nothing; reports row up via
// callback. Same pattern as SloBreachBanner's AgentBreachProbe.
// ---------------------------------------------------------------------------

function AgentLatencyProbe(props: {
  readonly agent: string
  readonly onResult: (row: Row) => void
}): null {
  const cacheQ = useAgentCache(props.agent)
  const cache = cacheQ.data as CachePayload | undefined
  const { onResult, agent } = props

  // Forward via effect so we don't setState during render in the parent.
  // Parent dedups via the map setter so identical payloads don't churn.
  useEffect(() => {
    onResult({
      agent,
      execMs: cache?.tool_execution_ms_p50 ?? null,
      roundtripMs: cache?.tool_roundtrip_ms_p50 ?? null,
      parallelRate: cache?.parallel_tool_call_rate ?? null,
      thresholdMs: cache?.slos?.first_token_p50_ms ?? null,
    })
  }, [cache, agent, onResult])

  return null
}

// ---------------------------------------------------------------------------
// Custom Recharts tooltip — renders both numbers + the gap delta.
// ---------------------------------------------------------------------------

type TooltipPayload = {
  readonly payload?: ChartDatum
}

function SplitTooltip({
  active,
  payload,
}: {
  active?: boolean
  payload?: TooltipPayload[]
}): JSX.Element | null {
  if (!active || !payload || payload.length === 0) return null
  const datum = payload[0]?.payload
  if (!datum) return null
  return (
    <div className="bg-bg-elevated border border-bg-s3 rounded-md px-3 py-2 text-xs font-mono shadow-lg">
      <div className="font-display font-bold text-fg-1 mb-1">{datum.agent}</div>
      <div className="flex items-center gap-2">
        <span className="inline-block w-2 h-2 bg-primary rounded-sm" aria-hidden />
        <span className="text-fg-2">exec_ms</span>
        <span className="text-fg-1 data">{Math.round(datum.exec)}</span>
      </div>
      <div className="flex items-center gap-2">
        <span
          className="inline-block w-2 h-2 border border-primary rounded-sm"
          aria-hidden
        />
        <span className="text-fg-2">roundtrip_ms</span>
        <span className="text-fg-1 data">{Math.round(datum.roundtrip)}</span>
      </div>
      <div className="mt-1 pt-1 border-t border-bg-s3 text-warn">
        gap (bloat tax): {Math.round(datum.gap)}ms
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

export type ToolLatencySplitProps = {
  /** Show this many agents by default; "Expand" reveals the long tail. */
  readonly topN?: number
}

export function ToolLatencySplit(
  props: ToolLatencySplitProps,
): JSX.Element {
  const topN = props.topN ?? 10
  const agentsQ = useAgents()
  const payload = agentsQ.data as
    | { agents?: ReadonlyArray<{ name: string }> }
    | undefined
  const agentNames = useMemo(
    () => (payload?.agents ?? []).map((a) => a.name),
    [payload],
  )

  // Rows keyed by agent name. AgentLatencyProbe pushes into this via callback.
  // A plain object keeps the reducer cheap — Object.values gives the array
  // we sort below.
  const [rowMap, setRowMap] = useState<Record<string, Row>>({})

  const handleResult = useCallback((row: Row) => {
    setRowMap((curr) => {
      const prev = curr[row.agent]
      if (
        prev &&
        prev.execMs === row.execMs &&
        prev.roundtripMs === row.roundtripMs &&
        prev.parallelRate === row.parallelRate
      ) {
        return curr
      }
      return { ...curr, [row.agent]: row }
    })
  }, [])

  // Filter to agents with EITHER value populated (both null → no data yet).
  // Sort by roundtripMs desc (slowest agents at top).
  const populated = useMemo(() => {
    const all = Object.values(rowMap)
    return all
      .filter((r) => r.execMs !== null || r.roundtripMs !== null)
      .sort((a, b) => (b.roundtripMs ?? 0) - (a.roundtripMs ?? 0))
  }, [rowMap])

  const [expanded, setExpanded] = useState(false)
  const shown = expanded ? populated : populated.slice(0, topN)

  const chartData = useMemo<readonly ChartDatum[]>(
    () =>
      shown.map((r) => {
        const exec = r.execMs ?? 0
        const roundtrip = r.roundtripMs ?? 0
        return {
          agent: r.agent,
          exec,
          roundtrip,
          gap: Math.max(0, roundtrip - exec),
        }
      }),
    [shown],
  )

  // Empty-data state — 115-08 columns null across the fleet. Render the
  // graceful notice the prompt mandates rather than silently falling back.
  const allRows = Object.values(rowMap)
  const totalCount = agentNames.length
  const reportedCount = allRows.length
  const nullCount = allRows.filter(
    (r) => r.execMs === null && r.roundtripMs === null,
  ).length
  const everyReportedIsNull =
    reportedCount > 0 && nullCount === reportedCount

  return (
    <Card
      className="bg-bg-elevated border-bg-s3 text-fg-1"
      data-testid="tool-latency-split"
    >
      {/* Probe per agent — mounts as a sibling chain, reports asynchronously. */}
      {agentNames.map((name) => (
        <AgentLatencyProbe key={name} agent={name} onResult={handleResult} />
      ))}

      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0">
            <h2 className="font-display text-base font-bold">
              Tool latency split
            </h2>
            <p className="text-xs text-fg-3 font-sans mt-0.5">
              Filled bar = tool exec time. Outline = full turn (incl. LLM
              resume). Gap = prompt-bloat tax.
            </p>
          </div>
          <Badge
            variant="outline"
            className="font-mono text-[10px] border-bg-s3 text-fg-2 shrink-0"
          >
            {populated.length}/{totalCount} agents
          </Badge>
        </div>
      </CardHeader>

      <CardContent className="pb-4">
        {agentsQ.isLoading && (
          <p className="text-fg-2 font-sans text-sm">Loading fleet…</p>
        )}
        {agentsQ.isError && (
          <p className="text-danger font-sans text-sm">
            Failed to load fleet — daemon unreachable.
          </p>
        )}
        {!agentsQ.isLoading && !agentsQ.isError && totalCount === 0 && (
          <p className="text-fg-2 font-sans text-sm">No agents reported.</p>
        )}
        {!agentsQ.isLoading &&
          !agentsQ.isError &&
          totalCount > 0 &&
          everyReportedIsNull && (
            <div
              className="rounded-md border border-warn/40 bg-warn/10 px-3 py-3 text-sm font-sans text-fg-1"
              data-testid="tool-latency-split-no-data"
            >
              <p className="font-bold mb-1">No split-latency data yet</p>
              <p className="text-fg-2 text-xs leading-relaxed">
                Phase 115-08 producer port shipped (commit{' '}
                <code className="data">a0f30a6</code>), but the daemon hasn't
                been restarted since deploy. After restart, new turns will
                populate <code className="data">tool_execution_ms</code> +{' '}
                <code className="data">tool_roundtrip_ms</code> and this panel
                will render automatically. Operator decides when to redeploy.
              </p>
            </div>
          )}
        {!agentsQ.isLoading &&
          !agentsQ.isError &&
          !everyReportedIsNull &&
          populated.length === 0 &&
          reportedCount < totalCount && (
            <p className="text-fg-2 font-sans text-sm">
              Waiting for first cache report from {totalCount} agents…
            </p>
          )}
        {populated.length > 0 && (
          <>
            <div className="w-full" style={{ height: 320 }}>
              <ResponsiveContainer width="100%" height="100%">
                <BarChart
                  data={chartData as ChartDatum[]}
                  margin={{ top: 12, right: 12, bottom: 12, left: 12 }}
                  layout="vertical"
                  barCategoryGap={8}
                >
                  {/* 116-postdeploy fix-pass — all chart fills/strokes
                      resolved through CSS vars so the chart flips
                      light/dark with the theme toggle. RGB channels for
                      `--fg-*` (custom surface tokens), HSL for `--primary`
                      (shadcn semantic). */}
                  <XAxis
                    type="number"
                    stroke="rgb(var(--fg-3))"
                    tick={{ fill: 'rgb(var(--fg-2))', fontSize: 11 }}
                    label={{
                      value: 'ms (p50)',
                      position: 'insideBottom',
                      offset: -2,
                      fill: 'rgb(var(--fg-3))',
                      fontSize: 11,
                    }}
                  />
                  <YAxis
                    dataKey="agent"
                    type="category"
                    stroke="rgb(var(--fg-3))"
                    tick={{
                      fill: 'rgb(var(--fg-1))',
                      fontSize: 11,
                      fontFamily: 'monospace',
                    }}
                    width={120}
                  />
                  <RechartsTooltip
                    content={<SplitTooltip />}
                    cursor={{ fill: 'rgb(var(--bg-muted))', opacity: 0.4 }}
                  />
                  {/* Outline (roundtrip) drawn first so the filled exec bar
                      stacks visually in front. Recharts renders bars at the
                      same Y in declaration order. */}
                  <Bar
                    dataKey="roundtrip"
                    fill="transparent"
                    stroke="hsl(var(--primary))"
                    strokeWidth={1.5}
                    barSize={14}
                  >
                    {chartData.map((d) => (
                      <Cell key={`rt-${d.agent}`} />
                    ))}
                  </Bar>
                  <Bar
                    dataKey="exec"
                    fill="hsl(var(--primary))"
                    fillOpacity={0.85}
                    barSize={14}
                  >
                    {chartData.map((d) => (
                      <Cell key={`ex-${d.agent}`} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
            {populated.length > topN && (
              <button
                type="button"
                onClick={() => setExpanded((v) => !v)}
                className="mt-3 text-xs font-sans text-primary hover:underline"
                data-testid="tool-latency-split-expand"
              >
                {expanded
                  ? `Collapse (showing all ${populated.length})`
                  : `Expand (${populated.length - topN} more)`}
              </button>
            )}
          </>
        )}
      </CardContent>
    </Card>
  )
}

export default ToolLatencySplit
