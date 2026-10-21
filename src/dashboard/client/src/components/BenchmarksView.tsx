/**
 * Phase 116-postdeploy 2026-05-13 — Benchmarks page (/dashboard/v2/benchmarks).
 *
 * Operator-facing surface for per-agent performance benchmarks across tools,
 * MCPs, memory operations, and end-to-end turns. Code-only (no deploy this
 * commit).
 *
 * Four sections, all lazy-loaded with the page (single chunk):
 *
 *   1. Per-agent tool latency rollup — sortable table over the existing
 *      `/api/agents/:name/tools` endpoint. Default sort: p95 DESC (tail
 *      dominators surface first). Answers "which tools are slow on this
 *      agent" — the headline question.
 *
 *   2. Trigger a benchmark run — operator picks an agent, scenario
 *      (discord-ack / tool-heavy / memory-recall / extended-thinking), and
 *      iteration count (1..10). Cost estimate shown BEFORE the run; operator
 *      confirms in a second click. Streams results back when complete (the
 *      backend runs sequentially so there's no per-iteration streaming —
 *      operator sees the full result table once the POST returns).
 *
 *      Cost estimates: rough TOKENS-per-scenario table multiplied by the
 *      current $/Mtok rate for the agent's model. Operator is on Claude
 *      Max OAuth (no per-call billing), so tokens are the primary signal;
 *      USD is a footnote.
 *
 *      cold-start is intentionally absent: it requires stop/start cycles
 *      that are unsafe to trigger from the dashboard. CLI is the only path.
 *
 *   3. Cross-agent comparison — pick 2..6 agents + a metric, render a
 *      horizontal bar chart. Useful for "why is X 5× slower than Y on this
 *      metric" forensics.
 *
 *   4. Memory operation latency — same table as Section 1, filtered to the
 *      five lazy-load memory tools.
 *
 * Bundle: lazy-loaded (App.tsx imports via React.lazy), Recharts is already
 * code-split by other lazy chunks so reusing it here doesn't bloat the
 * cold-load bundle.
 *
 * IMPORTANT divergence note rendered in-UI: the benchmark trigger goes
 * through `bench-run-prompt` (direct dispatchTurn, NO Discord), while the
 * baseline numbers in Sections 1/3 come from real production turns that DID
 * go through send-message. Numbers are NOT directly comparable. The UI
 * surfaces this explicitly so operators don't false-compare.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip as RechartsTooltip,
  ResponsiveContainer,
  Cell,
} from 'recharts'
import {
  useAgents,
  useAgentTools,
  useFleetActivitySummary,
  useFleetStats,
  runBenchmark,
  useBenchmarkCompare,
  type BenchmarkScenario,
  type BenchmarkResult,
  type ToolPercentileRow,
} from '@/hooks/useApi'
import { Card, CardContent, CardHeader } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { percentileCell } from '@/components/percentileCell'

// ---------------------------------------------------------------------------
// Scenario fixture metadata — kept in sync with backend BENCH_PROMPTS in
// src/dashboard/server.ts (which itself mirrors scripts/bench/115-perf-runner).
// Token-estimate rows are rough averages for cost-preview purposes ONLY; real
// usage is what bench-run-prompt reports back from the actual turn.
// ---------------------------------------------------------------------------

type ScenarioMeta = {
  readonly id: BenchmarkScenario
  readonly label: string
  readonly description: string
  /** Rough input-token estimate per iteration (prompt + tool defs + context). */
  readonly tokensIn: number
  /** Rough output-token estimate per iteration (response). */
  readonly tokensOut: number
  /** Span the backend uses as the headline number for this scenario. */
  readonly headlineSpan: string
}

const SCENARIOS: ReadonlyArray<ScenarioMeta> = [
  {
    id: 'discord-ack',
    label: 'discord-ack',
    description: 'Single-turn ack ("ok thx") with no tools. Measures the bare path.',
    tokensIn: 2_500,
    tokensOut: 50,
    headlineSpan: 'first_token',
  },
  {
    id: 'tool-heavy',
    label: 'tool-heavy',
    description: '3+ MCP calls (mysql + web-search). Measures real workload.',
    tokensIn: 8_000,
    tokensOut: 800,
    headlineSpan: 'end_to_end',
  },
  {
    id: 'memory-recall',
    label: 'memory-recall',
    description: 'Operator-recall question that exercises the lazy-load memory tools.',
    tokensIn: 5_000,
    tokensOut: 400,
    headlineSpan: 'end_to_end',
  },
  {
    id: 'extended-thinking',
    label: 'extended-thinking',
    description: 'Long-form reasoning with `think` budget. Captures thinking-token overhead.',
    tokensIn: 3_000,
    tokensOut: 2_500,
    headlineSpan: 'first_visible_token',
  },
]

// Approximate per-Mtok rates ($/Mtok). Claude Max OAuth eliminates per-call
// billing, but we surface the dollar number as a tertiary signal so operators
// can mentally sanity-check whether a scheduled benchmark sweep is sensible.
// Sonnet 4.5 and Opus 4.7 rates as of 2026-05; haiku is the latest Claude
// Haiku rate. Update inline if rates change — there is no daemon endpoint
// that exposes rate cards today.
const RATES_PER_MTOK: Record<string, { input: number; output: number }> = {
  haiku: { input: 0.8, output: 4.0 },
  sonnet: { input: 3.0, output: 15.0 },
  opus: { input: 15.0, output: 75.0 },
}

function estimateCost(
  scenario: ScenarioMeta,
  model: string,
  iterations: number,
): { tokens: number; usd: number } {
  const rate = RATES_PER_MTOK[model] ?? RATES_PER_MTOK.sonnet!
  const totalIn = scenario.tokensIn * iterations
  const totalOut = scenario.tokensOut * iterations
  const tokens = totalIn + totalOut
  const usd =
    (totalIn / 1_000_000) * rate.input +
    (totalOut / 1_000_000) * rate.output
  return { tokens, usd }
}

const MEMORY_TOOL_NAMES = new Set<string>([
  'tool_call.mcp__clawcode__memory_lookup',
  'tool_call.mcp__clawcode__memory_search',
  'tool_call.mcp__clawcode__clawcode_memory_search',
  'tool_call.mcp__clawcode__clawcode_memory_recall',
  'tool_call.mcp__clawcode__clawcode_memory_edit',
  'tool_call.mcp__clawcode__clawcode_memory_archive',
])

// ---------------------------------------------------------------------------
// Agent picker — minimal native select. Sized for one operator-driven page.
// ---------------------------------------------------------------------------

function AgentPicker(props: {
  readonly value: string
  readonly onChange: (next: string) => void
  readonly agents: ReadonlyArray<string>
}): JSX.Element {
  return (
    <select
      value={props.value}
      onChange={(e) => props.onChange(e.target.value)}
      className="bg-bg-elevated border border-bg-s3 rounded-md px-2 py-1 text-sm font-mono text-fg-1 min-w-[180px]"
    >
      {props.agents.map((a) => (
        <option key={a} value={a}>
          {a}
        </option>
      ))}
    </select>
  )
}

// ---------------------------------------------------------------------------
// Section 1 — Per-agent tool latency rollup
// ---------------------------------------------------------------------------

type SortKey = 'tool' | 'count' | 'p50_ms' | 'p95_ms' | 'p99_ms'
type SortDir = 'asc' | 'desc'

function formatMs(v: number | null | undefined): string {
  if (v === null || v === undefined) return '—'
  if (v >= 1000) return `${(v / 1000).toFixed(2)}s`
  return `${Math.round(v)}ms`
}

function ToolRollupTable(props: {
  readonly rows: ReadonlyArray<ToolPercentileRow>
  readonly memoryOnly?: boolean
}): JSX.Element {
  const [sortKey, setSortKey] = useState<SortKey>('p95_ms')
  const [sortDir, setSortDir] = useState<SortDir>('desc')

  const filtered = useMemo(
    () =>
      props.memoryOnly
        ? props.rows.filter((r) => MEMORY_TOOL_NAMES.has(r.tool))
        : props.rows,
    [props.rows, props.memoryOnly],
  )

  const sorted = useMemo(() => {
    const arr = [...filtered]
    arr.sort((a, b) => {
      const av = a[sortKey]
      const bv = b[sortKey]
      if (av === null || av === undefined)
        return bv === null || bv === undefined ? 0 : 1
      if (bv === null || bv === undefined) return -1
      if (typeof av === 'string' && typeof bv === 'string')
        return sortDir === 'asc' ? av.localeCompare(bv) : bv.localeCompare(av)
      const an = Number(av)
      const bn = Number(bv)
      return sortDir === 'asc' ? an - bn : bn - an
    })
    return arr
  }, [filtered, sortKey, sortDir])

  function toggleSort(key: SortKey): void {
    if (key === sortKey) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortKey(key)
      setSortDir(key === 'tool' ? 'asc' : 'desc')
    }
  }

  if (filtered.length === 0) {
    // Phase 120 Plan 02 T-03 (DASH-03) — literal string per CONTEXT D-06.
    // memoryOnly variant gets its own literal so both states are operator-
    // attributable. text-fg-3 neutral per D-05 (not a breach).
    return (
      <p className="text-fg-3 font-sans text-sm">
        {props.memoryOnly
          ? 'No memory-tool spans recorded in window'
          : 'No tool spans recorded in window'}
      </p>
    )
  }

  function HeaderCell(props: {
    readonly k: SortKey
    readonly children: React.ReactNode
    readonly align?: 'left' | 'right'
  }): JSX.Element {
    const active = sortKey === props.k
    const align = props.align ?? 'left'
    return (
      <th
        onClick={() => toggleSort(props.k)}
        className={`cursor-pointer select-none px-2 py-1 text-xs font-sans font-semibold text-fg-2 hover:text-fg-1 ${align === 'right' ? 'text-right' : 'text-left'}`}
      >
        {props.children}
        {active ? (
          <span className="ml-1 text-fg-3">{sortDir === 'asc' ? '↑' : '↓'}</span>
        ) : null}
      </th>
    )
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm border-collapse">
        <thead className="border-b border-bg-s3">
          <tr>
            <HeaderCell k="tool">Tool</HeaderCell>
            <HeaderCell k="count" align="right">
              n
            </HeaderCell>
            <HeaderCell k="p50_ms" align="right">
              p50
            </HeaderCell>
            <HeaderCell k="p95_ms" align="right">
              p95
            </HeaderCell>
            <HeaderCell k="p99_ms" align="right">
              p99
            </HeaderCell>
          </tr>
        </thead>
        <tbody>
          {sorted.map((r) => {
            const isBreach = r.slo_status === 'breach'
            // Phase 120 Plan 02 T-01 (DASH-01) — defensive (unnamed) fallback.
            // Production diagnostic shows tool names well-formed in trace_spans
            // and SUBSTR strips the prefix correctly (see 120-DIAGNOSTIC.md), so
            // a blank cell would indicate a future regression — render an
            // attributable label instead of silent blank.
            const toolLabel =
              typeof r.tool === 'string' && r.tool.length > 0
                ? r.tool
                : '(unnamed)'
            // p99 stays neutral text-fg-2 per pre-Phase-120 convention — only
            // p50/p95 carry the SLO-breach indicator. Phase 120 routes those
            // through percentileCell so null wins over isBreach (DASH-02).
            const dataClass = 'px-2 py-1 text-right data'
            return (
              <tr key={r.tool} className="border-b border-bg-s3/40">
                <td className="px-2 py-1 font-mono text-xs text-fg-1">
                  {toolLabel}
                </td>
                <td className="px-2 py-1 text-right data text-fg-2">
                  {r.count}
                </td>
                {percentileCell({
                  value: r.p50_ms ?? null,
                  isBreach,
                  format: formatMs,
                  className: dataClass,
                })}
                {percentileCell({
                  value: r.p95_ms ?? null,
                  isBreach,
                  format: formatMs,
                  className: dataClass,
                })}
                {percentileCell({
                  value: r.p99_ms ?? null,
                  isBreach: false,
                  format: formatMs,
                  className: `${dataClass} text-fg-2`,
                })}
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function ToolRollupSection(props: {
  readonly agent: string
  readonly since: string
  readonly onChangeAgent: (next: string) => void
  readonly onChangeSince: (next: string) => void
  readonly agents: ReadonlyArray<string>
}): JSX.Element {
  const toolsQ = useAgentTools(props.agent, props.since)
  const rows = toolsQ.data?.tools ?? []

  return (
    <Card
      className="bg-bg-elevated border-bg-s3 text-fg-1"
      data-testid="benchmarks-tool-rollup"
    >
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <div>
            <h2 className="font-display text-base font-bold">
              Per-agent tool latency
            </h2>
            <p className="text-xs text-fg-3 font-sans mt-0.5">
              Sortable rollup over <code className="data">trace_spans</code> for the
              last {props.since}. Default sort: p95 desc (tail dominators).
            </p>
          </div>
          <div className="flex items-center gap-2">
            <AgentPicker
              value={props.agent}
              onChange={props.onChangeAgent}
              agents={props.agents}
            />
            <select
              value={props.since}
              onChange={(e) => props.onChangeSince(e.target.value)}
              className="bg-bg-elevated border border-bg-s3 rounded-md px-2 py-1 text-sm font-mono text-fg-1"
            >
              <option value="24h">24h</option>
              <option value="7d">7d</option>
            </select>
            <Badge variant="outline" className="font-mono text-[10px]">
              {rows.length} tools
            </Badge>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {toolsQ.isLoading && (
          <p className="text-fg-2 font-sans text-sm">Loading…</p>
        )}
        {toolsQ.isError && (
          <p className="text-danger font-sans text-sm">
            Failed to load tools — daemon unreachable.
          </p>
        )}
        {!toolsQ.isLoading && !toolsQ.isError && (
          <ToolRollupTable rows={rows} />
        )}
      </CardContent>
    </Card>
  )
}

// ---------------------------------------------------------------------------
// Section 2 — Trigger a benchmark run
// ---------------------------------------------------------------------------

function BenchmarkTriggerSection(props: {
  readonly defaultAgent: string
  readonly agents: ReadonlyArray<string>
  readonly modelByAgent: Record<string, string>
}): JSX.Element {
  const [agent, setAgent] = useState(props.defaultAgent)
  const [scenarioId, setScenarioId] = useState<BenchmarkScenario>('discord-ack')
  const [iterations, setIterations] = useState(3)
  const [confirming, setConfirming] = useState(false)
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState<BenchmarkResult | null>(null)
  const [error, setError] = useState<string | null>(null)

  const scenario =
    SCENARIOS.find((s) => s.id === scenarioId) ?? SCENARIOS[0]!
  const model = props.modelByAgent[agent] ?? 'sonnet'
  const cost = estimateCost(scenario, model, iterations)

  async function run(): Promise<void> {
    setRunning(true)
    setError(null)
    setResult(null)
    try {
      const r = await runBenchmark(agent, scenarioId, iterations)
      setResult(r)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'unknown error')
    } finally {
      setRunning(false)
      setConfirming(false)
    }
  }

  return (
    <Card
      className="bg-bg-elevated border-bg-s3 text-fg-1"
      data-testid="benchmarks-trigger"
    >
      <CardHeader className="pb-3">
        <h2 className="font-display text-base font-bold">Trigger a benchmark</h2>
        <p className="text-xs text-fg-3 font-sans mt-0.5">
          Sends a real turn through <code className="data">bench-run-prompt</code>
          {' '}— in-process, NOT the Discord path. Numbers will differ from the
          24h baseline above (which came from real send-message turns).
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <label className="text-xs font-sans text-fg-2">Agent</label>
          <AgentPicker
            value={agent}
            onChange={setAgent}
            agents={props.agents}
          />
          <label className="text-xs font-sans text-fg-2 ml-2">Scenario</label>
          <select
            value={scenarioId}
            onChange={(e) =>
              setScenarioId(e.target.value as BenchmarkScenario)
            }
            className="bg-bg-elevated border border-bg-s3 rounded-md px-2 py-1 text-sm font-mono text-fg-1"
          >
            {SCENARIOS.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </select>
          <label className="text-xs font-sans text-fg-2 ml-2">Iterations</label>
          <input
            type="number"
            min={1}
            max={10}
            value={iterations}
            onChange={(e) =>
              setIterations(
                Math.max(1, Math.min(10, Number(e.target.value) || 1)),
              )
            }
            className="bg-bg-elevated border border-bg-s3 rounded-md px-2 py-1 text-sm font-mono text-fg-1 w-16"
          />
        </div>

        <p className="text-xs text-fg-3 font-sans">{scenario.description}</p>

        <div className="rounded-md border border-bg-s3 bg-bg/40 px-3 py-2 text-xs font-mono">
          <div className="text-fg-2">Estimated cost ({model})</div>
          <div className="mt-1 flex gap-4">
            <span className="text-fg-1 data">
              ~{cost.tokens.toLocaleString()} tokens
            </span>
            <span className="text-fg-3 data">
              (~${cost.usd.toFixed(4)} USD if on per-call billing — operator on
              Max OAuth pays $0)
            </span>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {!confirming && (
            <Button
              size="sm"
              disabled={running}
              onClick={() => setConfirming(true)}
            >
              Run benchmark
            </Button>
          )}
          {confirming && (
            <>
              <span className="text-xs font-sans text-warn">
                This generates {iterations} real agent turns. Continue?
              </span>
              <Button
                size="sm"
                variant="default"
                disabled={running}
                onClick={() => {
                  void run()
                }}
              >
                {running ? 'Running…' : `Confirm — run ${iterations}×`}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={running}
                onClick={() => setConfirming(false)}
              >
                Cancel
              </Button>
            </>
          )}
        </div>

        {error && (
          <p className="text-danger font-sans text-sm">Error: {error}</p>
        )}

        {result && <BenchmarkResultPanel result={result} />}
      </CardContent>
    </Card>
  )
}

function BenchmarkResultPanel(props: {
  readonly result: BenchmarkResult
}): JSX.Element {
  const r = props.result
  return (
    <div className="border-t border-bg-s3 pt-3 mt-2 space-y-2">
      <div className="flex gap-4 text-xs font-mono">
        <span className="text-fg-2">
          runs: <span className="text-fg-1 data">{r.aggregate.runs}</span>
        </span>
        <span className="text-fg-2">
          errored:{' '}
          <span
            className={
              r.aggregate.errored > 0 ? 'text-danger data' : 'text-fg-1 data'
            }
          >
            {r.aggregate.errored}
          </span>
        </span>
        <span className="text-fg-2">
          p50: <span className="text-fg-1 data">{formatMs(r.aggregate.p50_ms)}</span>
        </span>
        <span className="text-fg-2">
          p95: <span className="text-fg-1 data">{formatMs(r.aggregate.p95_ms)}</span>
        </span>
        <span className="text-fg-2">
          mean: <span className="text-fg-1 data">{formatMs(r.aggregate.mean_ms)}</span>
        </span>
      </div>
      <p className="text-[10px] font-sans text-fg-3">
        Headline span: <code className="data">{r.headlineSpan}</code> · path:{' '}
        <code className="data">{r.path}</code>
      </p>
      <details className="text-xs">
        <summary className="cursor-pointer text-fg-2 hover:text-fg-1">
          Per-iteration breakdown
        </summary>
        <table className="w-full mt-2 text-xs border-collapse">
          <thead className="border-b border-bg-s3">
            <tr>
              <th className="px-2 py-1 text-left font-sans text-fg-2">#</th>
              <th className="px-2 py-1 text-left font-sans text-fg-2">turnId</th>
              <th className="px-2 py-1 text-right font-sans text-fg-2">
                headline
              </th>
              <th className="px-2 py-1 text-left font-sans text-fg-2">
                segments / error
              </th>
            </tr>
          </thead>
          <tbody>
            {r.rows.map((row) => (
              <tr key={row.index} className="border-b border-bg-s3/40">
                <td className="px-2 py-1 font-mono text-fg-2">{row.index}</td>
                <td className="px-2 py-1 font-mono text-fg-2 truncate max-w-[200px]">
                  {row.turnId ?? '—'}
                </td>
                <td className="px-2 py-1 text-right data">
                  {formatMs(row.headline_ms)}
                </td>
                <td className="px-2 py-1 text-xs text-fg-3">
                  {row.error ? (
                    <span className="text-danger">{row.error}</span>
                  ) : (
                    Object.entries(row.segments)
                      .map(([k, v]) => `${k}=${Math.round(v)}ms`)
                      .join(' · ')
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Section 3 — Cross-agent comparison
// ---------------------------------------------------------------------------

const COMPARE_METRICS: ReadonlyArray<{
  readonly value: string
  readonly label: string
}> = [
  { value: 'first_token_p50', label: 'first_token p50' },
  { value: 'first_token_p95', label: 'first_token p95' },
  { value: 'first_visible_token_p50', label: 'first_visible_token p50' },
  { value: 'end_to_end_p50', label: 'end_to_end p50' },
  { value: 'end_to_end_p95', label: 'end_to_end p95' },
  { value: 'tool_call_p50', label: 'tool_call (combined) p50' },
  { value: 'tool_call_p95', label: 'tool_call (combined) p95' },
]

function CompareSection(props: {
  readonly agents: ReadonlyArray<string>
}): JSX.Element {
  const [selected, setSelected] = useState<ReadonlyArray<string>>(() =>
    props.agents.slice(0, Math.min(3, props.agents.length)),
  )
  const [metric, setMetric] = useState('first_token_p50')
  const compareQ = useBenchmarkCompare(selected, metric)

  function toggle(agent: string): void {
    setSelected((curr) => {
      if (curr.includes(agent)) return curr.filter((a) => a !== agent)
      if (curr.length >= 6) return curr
      return [...curr, agent]
    })
  }

  const points = compareQ.data?.points ?? []
  const chartData = points.map((p) => ({
    agent: p.agent,
    value: p.value_ms ?? 0,
    null: p.value_ms === null,
  }))

  return (
    <Card
      className="bg-bg-elevated border-bg-s3 text-fg-1"
      data-testid="benchmarks-compare"
    >
      <CardHeader className="pb-3">
        <h2 className="font-display text-base font-bold">Cross-agent comparison</h2>
        <p className="text-xs text-fg-3 font-sans mt-0.5">
          Pick 2–6 agents and a metric. Useful for "why is X 5× slower than Y"
          forensics. Empty bars = metric not observed in window.
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <label className="text-xs font-sans text-fg-2">Metric</label>
          <select
            value={metric}
            onChange={(e) => setMetric(e.target.value)}
            className="bg-bg-elevated border border-bg-s3 rounded-md px-2 py-1 text-sm font-mono text-fg-1"
          >
            {COMPARE_METRICS.map((m) => (
              <option key={m.value} value={m.value}>
                {m.label}
              </option>
            ))}
          </select>
          <Badge variant="outline" className="font-mono text-[10px] ml-2">
            {selected.length}/6 agents
          </Badge>
        </div>

        <div className="flex flex-wrap gap-1">
          {props.agents.map((a) => {
            const on = selected.includes(a)
            return (
              <button
                key={a}
                type="button"
                onClick={() => toggle(a)}
                className={`text-xs font-mono px-2 py-1 rounded-md border transition-colors ${on ? 'bg-primary text-bg-1 border-primary' : 'bg-bg-elevated text-fg-2 border-bg-s3 hover:text-fg-1'}`}
              >
                {a}
              </button>
            )
          })}
        </div>

        {compareQ.isLoading && (
          <p className="text-fg-2 font-sans text-sm">Loading…</p>
        )}
        {compareQ.isError && (
          <p className="text-danger font-sans text-sm">
            Failed to load comparison — daemon unreachable.
          </p>
        )}
        {chartData.length > 0 && (
          <div className="w-full" style={{ height: 280 }}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart
                data={chartData}
                layout="vertical"
                margin={{ top: 8, right: 16, bottom: 8, left: 8 }}
                barCategoryGap={8}
              >
                <XAxis
                  type="number"
                  stroke="rgb(var(--fg-3))"
                  tick={{ fill: 'rgb(var(--fg-2))', fontSize: 11 }}
                  label={{
                    value: 'ms',
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
                  width={140}
                />
                <RechartsTooltip
                  cursor={{ fill: 'rgb(var(--bg-muted))', opacity: 0.4 }}
                  contentStyle={{
                    backgroundColor: 'rgb(var(--bg-elevated))',
                    border: '1px solid rgb(var(--bg-s3))',
                    fontSize: 11,
                  }}
                  formatter={(v: number) => `${Math.round(v)}ms`}
                />
                <Bar
                  dataKey="value"
                  fill="hsl(var(--primary))"
                  fillOpacity={0.85}
                  barSize={14}
                >
                  {chartData.map((d) => (
                    <Cell
                      key={d.agent}
                      fill={
                        d.null
                          ? 'rgb(var(--bg-s3))'
                          : 'hsl(var(--primary))'
                      }
                    />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}

        {points.some((p) => p.error) && (
          <div className="rounded-md border border-warn/40 bg-warn/10 px-3 py-2 text-xs font-sans">
            <strong>Missing data:</strong>
            <ul className="mt-1 list-disc list-inside">
              {points
                .filter((p) => p.error)
                .map((p) => (
                  <li key={p.agent}>
                    <code className="data">{p.agent}</code>: {p.error}
                  </li>
                ))}
            </ul>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

// ---------------------------------------------------------------------------
// Section 4 — Memory operation latency (filtered Section-1 view)
// ---------------------------------------------------------------------------

function MemorySection(props: {
  readonly agent: string
  readonly since: string
}): JSX.Element {
  const toolsQ = useAgentTools(props.agent, props.since)
  const rows = toolsQ.data?.tools ?? []
  return (
    <Card
      className="bg-bg-elevated border-bg-s3 text-fg-1"
      data-testid="benchmarks-memory"
    >
      <CardHeader className="pb-3">
        <h2 className="font-display text-base font-bold">
          Memory operation latency
        </h2>
        <p className="text-xs text-fg-3 font-sans mt-0.5">
          Per-tool rollup filtered to the five lazy-load memory tools
          (search / recall / edit / archive + the legacy memory_lookup).
        </p>
      </CardHeader>
      <CardContent>
        {toolsQ.isLoading && (
          <p className="text-fg-2 font-sans text-sm">Loading…</p>
        )}
        {toolsQ.isError && (
          <p className="text-danger font-sans text-sm">
            Failed to load — daemon unreachable.
          </p>
        )}
        {!toolsQ.isLoading && !toolsQ.isError && (
          <ToolRollupTable rows={rows} memoryOnly />
        )}
      </CardContent>
    </Card>
  )
}

// ---------------------------------------------------------------------------
// Page shell
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Phase 119 D-05 — No-webhook fallbacks tile.
//
// Reads `noWebhookFallbacksTotal` from /api/fleet-stats and renders a
// 15-minute rolling delta. The counter itself is monotonic since daemon
// start; the tile tracks the operator-visible "fallbacks in the last 15
// minutes" window by snapshotting the first poll inside the window and
// subtracting it from the latest.
//
// SLO-breach styling (`text-danger`) renders when delta > 0 — operators
// see fallbacks as a visible alarm rather than silently-absorbed signal.
// Empty state ("no fallbacks") renders explicitly when the field is
// present but zero, so a stuck `useFleetStats` query is visibly distinct
// from a quiet 15-minute window.
// ---------------------------------------------------------------------------

type FleetStatsPayload = {
  readonly noWebhookFallbacksTotal?: Readonly<Record<string, number>>
}

const FALLBACK_WINDOW_MS = 15 * 60 * 1000

function sumFallbacks(map: Readonly<Record<string, number>> | undefined): number {
  if (!map) return 0
  let total = 0
  for (const v of Object.values(map)) total += v
  return total
}

function NoWebhookFallbacksTile(): JSX.Element {
  const fleetQ = useFleetStats()
  const fleet = fleetQ.data as FleetStatsPayload | undefined
  const counter = fleet?.noWebhookFallbacksTotal
  const currentTotal = sumFallbacks(counter)

  // Roll the 15-minute window client-side. The first poll inside an active
  // window seeds `windowStartValue`; subsequent polls compute the delta
  // against that seed. Once the window expires the seed re-anchors to the
  // current value, so a fallback burst from 24h ago doesn't ghost-trigger
  // the SLO-breach styling.
  const windowRef = useRef<{ seedValue: number; seedAt: number } | null>(null)
  const [delta, setDelta] = useState(0)

  useEffect(() => {
    if (counter === undefined) return
    const now = Date.now()
    const seed = windowRef.current
    if (seed === null || now - seed.seedAt >= FALLBACK_WINDOW_MS) {
      windowRef.current = { seedValue: currentTotal, seedAt: now }
      setDelta(0)
      return
    }
    setDelta(Math.max(0, currentTotal - seed.seedValue))
  }, [counter, currentTotal])

  // Per-pair breakdown for the operator's hover context. Sorted by count
  // descending so the noisiest (agent, channel) pair surfaces first.
  const pairs = useMemo(() => {
    if (!counter) return [] as ReadonlyArray<readonly [string, number]>
    return Object.entries(counter)
      .filter(([, v]) => v > 0)
      .sort((a, b) => b[1] - a[1])
  }, [counter])

  const isBreach = delta > 0
  const valueClass = isBreach
    ? 'text-danger data text-2xl font-display font-bold'
    : 'text-fg-3 data text-2xl font-display font-bold'

  return (
    <Card
      className="bg-bg-elevated border-bg-s3 text-fg-1"
      data-testid="benchmarks-no-webhook-fallbacks"
    >
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <div>
            <h2 className="font-display text-base font-bold">
              No-webhook fallbacks (15min)
            </h2>
            <p className="text-xs text-fg-3 font-sans mt-0.5">
              <code className="data">no_webhook_fallbacks_total</code> rolling
              delta over a 15-minute window. Increments on every bot-direct
              fallback OR inbox-only return path.{' '}
              <span className="text-danger">Non-zero = SLO breach</span>.
            </p>
          </div>
          <Badge
            variant="outline"
            className={
              isBreach
                ? 'font-mono text-[10px] border-danger text-danger'
                : 'font-mono text-[10px]'
            }
          >
            since deploy: {currentTotal}
          </Badge>
        </div>
      </CardHeader>
      <CardContent>
        {fleetQ.isLoading && (
          <p className="text-fg-2 font-sans text-sm">Loading…</p>
        )}
        {fleetQ.isError && (
          <p className="text-danger font-sans text-sm">
            Failed to load fleet stats — daemon unreachable.
          </p>
        )}
        {!fleetQ.isLoading && !fleetQ.isError && counter !== undefined && (
          <div className="space-y-2">
            <div>
              <span className={valueClass}>{delta}</span>
              <span className="text-fg-3 font-sans text-sm ml-2">
                fallbacks in last 15min
              </span>
            </div>
            {pairs.length === 0 && (
              <p className="text-fg-3 font-sans text-xs">
                No fallbacks recorded — webhook delivery path healthy.
              </p>
            )}
            {pairs.length > 0 && (
              <ul className="flex flex-wrap gap-2 mt-2">
                {pairs.map(([key, value]) => (
                  <li key={key}>
                    <Badge
                      variant="outline"
                      className="font-mono text-[11px] border-bg-s3 text-fg-2"
                    >
                      <span className="text-fg-1 mr-1">{key}</span>
                      <span className="text-fg-3">{value}×</span>
                    </Badge>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
        {!fleetQ.isLoading && !fleetQ.isError && counter === undefined && (
          <p className="text-fg-3 font-sans text-xs">
            Counter not yet exposed by daemon (pre-Phase-119 build).
          </p>
        )}
      </CardContent>
    </Card>
  )
}

export function BenchmarksView(): JSX.Element {
  const agentsQ = useAgents()
  const activityQ = useFleetActivitySummary()
  const allAgents = useMemo(
    () => (agentsQ.data?.agents ?? []).map((a) => a.name),
    [agentsQ.data],
  )

  // Default-pick the most-used agent (highest turns_24h). Fall back to the
  // first agent if activity hasn't loaded yet.
  const defaultAgent = useMemo(() => {
    const activity = activityQ.data?.agents ?? []
    const ranked = [...activity].sort(
      (a, b) => (b.turns_24h ?? 0) - (a.turns_24h ?? 0),
    )
    for (const r of ranked) {
      if (allAgents.includes(r.agent)) return r.agent
    }
    return allAgents[0] ?? ''
  }, [activityQ.data, allAgents])

  const [agent, setAgent] = useState<string>('')
  const effectiveAgent = agent || defaultAgent
  const [since, setSince] = useState('24h')

  const modelByAgent = useMemo(() => {
    const map: Record<string, string> = {}
    for (const a of agentsQ.data?.agents ?? []) {
      const model = typeof a.model === 'string' ? a.model : 'sonnet'
      map[a.name] = model
    }
    return map
  }, [agentsQ.data])

  if (agentsQ.isLoading) {
    return (
      <div className="mx-auto max-w-7xl p-4 text-sm text-fg-3">
        Loading agents…
      </div>
    )
  }
  if (allAgents.length === 0) {
    return (
      <div className="mx-auto max-w-7xl p-4 text-sm text-fg-3">
        No agents reported.
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-7xl px-7 py-6 space-y-4">
      {/* dash-redesign sweep — section-head pattern. */}
      <div className="section-head">
        <div className="flex items-baseline">
          <h2>Benchmarks</h2>
          <span className="sub">
            per-agent tool latency, turn timings, memory ops · ad-hoc
            runs in Section 2
          </span>
        </div>
      </div>

      {/* Phase 119 D-05 — no-webhook fallbacks tile. Surfaced near the top
          alongside the per-agent tool latency rollup so an SLO breach is
          visible on the operator's first scan of the page. */}
      <NoWebhookFallbacksTile />

      <ToolRollupSection
        agent={effectiveAgent}
        since={since}
        onChangeAgent={setAgent}
        onChangeSince={setSince}
        agents={allAgents}
      />

      <BenchmarkTriggerSection
        defaultAgent={effectiveAgent}
        agents={allAgents}
        modelByAgent={modelByAgent}
      />

      <CompareSection agents={allAgents} />

      <MemorySection agent={effectiveAgent} since={since} />
    </div>
  )
}

export default BenchmarksView
