/**
 * Phase 116-05 F16 — fleet comparison table.
 *
 * One row per agent with sortable columns and a filter bar above the
 * table. CSV export builds the CSV string client-side via Blob +
 * URL.createObjectURL + temporary <a download>; no server-side
 * serialization needed (no PII transit, no extra round trip).
 *
 * Data sources (per-agent, hook-fetched in each row):
 *  - useAgentCache(name)   — model, tier1_budget_pct, tool_cache_hit_rate,
 *                            slos.first_token_p50_ms (threshold for color)
 *  - useAgentLatency(name) — first_token_headline.p50, end_to_end p95
 *                            (segments[].p95 by name)
 *  - useCosts('today')     — daily_cost (aggregated outer query, reduced
 *                            client-side by agent name)
 *
 * Cross-cutting fleet payloads (one fetch, applies to all rows):
 *  - useAgents()           — name + status (the row enumeration)
 *  - useIpcInboxes()       — IPC delivery success rate (deliveryStats)
 *  - useDreamQueue?        — NOT available fleet-wide; 7d count is approximated
 *                            from the dream-queue per-agent endpoint when a row
 *                            is expanded. For the table we render '—' for any
 *                            agent we haven't drilled into, with a footnote
 *                            link to the per-agent drawer's F15 panel.
 *
 * SLO color (column "first_token p50"): same F02 logic as AgentTile.tsx —
 * observed > 2× threshold → danger, > 1× → warn, else primary.
 *
 * CSV format: standard RFC 4180-ish — comma-separated, double-quote any
 * field containing comma/quote/newline, escape internal quotes by
 * doubling. UTF-8 with no BOM. Filename: `clawcode-fleet-<YYYY-MM-DD>.csv`.
 */
import { useEffect, useMemo, useState } from 'react'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Button } from '@/components/ui/button'
import {
  useAgents,
  useAgentCache,
  useAgentLatency,
  useCosts,
  useIpcInboxes,
  type AgentStatusEntry,
} from '@/hooks/useApi'
import { ActivityHeatmap } from './ActivityHeatmap'

// 116-06 F22 — small wrapper so the fleet-wide ActivityHeatmap reads as
// "fleet" at the call site (no `agent` prop → server aggregates over
// every running agent).
function FleetActivityHeatmap(): JSX.Element {
  return <ActivityHeatmap />
}

// ---------------------------------------------------------------------------
// Column definitions + sort state
// ---------------------------------------------------------------------------

type SortDir = 'asc' | 'desc'
type SortKey =
  | 'name'
  | 'status'
  | 'model'
  | 'first_token_p50'
  | 'end_to_end_p95'
  | 'tool_cache_hit_rate'
  | 'tier1_budget_pct'
  | 'ipc_delivery_pct'
  | 'daily_cost_usd'

type RowData = {
  readonly name: string
  readonly status: string
  readonly model: string
  readonly first_token_p50: number | null
  readonly first_token_slo_threshold: number | null
  readonly first_token_slo_color: 'primary' | 'warn' | 'danger' | 'fg-3'
  readonly end_to_end_p95: number | null
  readonly tool_cache_hit_rate: number | null
  readonly tier1_budget_pct: number | null
  readonly daily_cost_usd: number
}

function sloColor(
  observed: number | null,
  threshold: number | null,
  count: number,
): RowData['first_token_slo_color'] {
  if (observed === null || threshold === null || count < 5) return 'fg-3'
  if (observed > threshold * 2) return 'danger'
  if (observed > threshold) return 'warn'
  return 'primary'
}

function compareRows(a: RowData, b: RowData, key: SortKey, dir: SortDir): number {
  const av = a[key]
  const bv = b[key]
  // null-sort: nulls always last regardless of direction (operators
  // shopping for breach data don't want nulls in the high-cost bucket).
  if (av === null && bv === null) return 0
  if (av === null) return 1
  if (bv === null) return -1
  if (typeof av === 'string' && typeof bv === 'string') {
    const cmp = av.localeCompare(bv)
    return dir === 'asc' ? cmp : -cmp
  }
  const cmp = (av as number) - (bv as number)
  return dir === 'asc' ? cmp : -cmp
}

// ---------------------------------------------------------------------------
// CSV serialization
// ---------------------------------------------------------------------------

const CSV_HEADER = [
  'agent',
  'status',
  'model',
  'first_token_p50_ms',
  'first_token_slo_threshold_ms',
  'end_to_end_p95_ms',
  'tool_cache_hit_rate',
  'tier1_budget_pct',
  'daily_cost_usd',
] as const

function csvEscape(value: unknown): string {
  if (value === null || value === undefined) return ''
  const s = String(value)
  if (/[",\n\r]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`
  }
  return s
}

function rowsToCsv(rows: readonly RowData[]): string {
  const lines: string[] = []
  lines.push(CSV_HEADER.join(','))
  for (const r of rows) {
    lines.push(
      [
        r.name,
        r.status,
        r.model,
        r.first_token_p50 ?? '',
        r.first_token_slo_threshold ?? '',
        r.end_to_end_p95 ?? '',
        r.tool_cache_hit_rate ?? '',
        r.tier1_budget_pct ?? '',
        r.daily_cost_usd,
      ]
        .map(csvEscape)
        .join(','),
    )
  }
  return lines.join('\n')
}

function downloadCsv(rows: readonly RowData[]): void {
  const csv = rowsToCsv(rows)
  const today = new Date().toISOString().slice(0, 10)
  const filename = `clawcode-fleet-${today}.csv`
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  // Defer revoke so Safari/Firefox finish the download trigger first.
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

// ---------------------------------------------------------------------------
// Per-row data fetcher — sits inside the table body so each row owns its
// useAgentCache/useAgentLatency calls. Hoists the resulting RowData into
// the parent via a `report` callback so the parent can drive sort/CSV
// from the aggregated set.
// ---------------------------------------------------------------------------

type CachePayload = {
  readonly slos?: { readonly first_token_p50_ms?: number; readonly model?: string }
  readonly tool_cache_hit_rate?: number | null
  readonly tier1_budget_pct?: number | null
}

type LatencyPayload = {
  readonly first_token_headline?: { readonly p50?: number | null; readonly count?: number }
  readonly segments?: ReadonlyArray<{ readonly name: string; readonly p95?: number | null }>
}

function FleetRow(props: {
  readonly agent: AgentStatusEntry
  readonly dailyCostUsd: number
  readonly onReport: (row: RowData) => void
}): JSX.Element {
  const cacheQ = useAgentCache(props.agent.name)
  const latencyQ = useAgentLatency(props.agent.name)

  const cache = (cacheQ.data ?? {}) as CachePayload
  const latency = (latencyQ.data ?? {}) as LatencyPayload

  const headline = latency.first_token_headline ?? {}
  const p50 = typeof headline.p50 === 'number' ? headline.p50 : null
  const count = typeof headline.count === 'number' ? headline.count : 0
  const threshold =
    typeof cache.slos?.first_token_p50_ms === 'number'
      ? cache.slos.first_token_p50_ms
      : null
  const end2end =
    latency.segments?.find((s) => s.name === 'end_to_end')?.p95 ?? null
  const toolRate =
    typeof cache.tool_cache_hit_rate === 'number'
      ? cache.tool_cache_hit_rate
      : null
  const tier1 =
    typeof cache.tier1_budget_pct === 'number' ? cache.tier1_budget_pct : null
  const model =
    (props.agent.model as string | undefined) ?? cache.slos?.model ?? '—'
  const status = props.agent.status ?? '—'
  const color = sloColor(p50, threshold, count)

  const row: RowData = useMemo(
    () => ({
      name: props.agent.name,
      status,
      model,
      first_token_p50: p50,
      first_token_slo_threshold: threshold,
      first_token_slo_color: color,
      end_to_end_p95: typeof end2end === 'number' ? end2end : null,
      tool_cache_hit_rate: toolRate,
      tier1_budget_pct: tier1,
      daily_cost_usd: props.dailyCostUsd,
    }),
    [
      props.agent.name,
      status,
      model,
      p50,
      threshold,
      color,
      end2end,
      toolRate,
      tier1,
      props.dailyCostUsd,
    ],
  )

  // Report rows up to the parent so sort + CSV operate on the aggregated set.
  // useEffect-driven so the call is a real side effect (not abuse of
  // useMemo); JSON-serialized key avoids re-reporting identical rows.
  //
  // IMPORTANT: every field in RowData must be STABLE across renders for
  // this pattern to avoid a render storm. Don't add time-relative values
  // (e.g. "X seconds ago" strings, Date.now() outputs) to RowData — they
  // would churn rowKey every render → effect fires every render → parent
  // setReportedRows fires every render → renders cascade. If you need a
  // relative time in the table, compute it INSIDE the cell render path
  // (so it derives from row.lastTurnAt, not from row itself).
  const rowKey = JSON.stringify(row)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    props.onReport(row)
  }, [rowKey])

  return (
    <TableRow data-testid="fleet-row" data-agent={row.name}>
      <TableCell className="font-bold text-fg-1">{row.name}</TableCell>
      <TableCell>
        <StatusBadge status={row.status} />
      </TableCell>
      <TableCell className="text-fg-2">{row.model}</TableCell>
      <TableCell className={`text-${row.first_token_slo_color} data`}>
        {row.first_token_p50 === null
          ? '—'
          : `${Math.round(row.first_token_p50)}ms`}
      </TableCell>
      <TableCell className="text-fg-2 data">
        {row.end_to_end_p95 === null ? '—' : `${Math.round(row.end_to_end_p95)}ms`}
      </TableCell>
      <TableCell className="text-fg-2 data">
        {row.tool_cache_hit_rate === null
          ? '—'
          : `${(row.tool_cache_hit_rate * 100).toFixed(1)}%`}
      </TableCell>
      <TableCell className="text-fg-2 data">
        {row.tier1_budget_pct === null
          ? '—'
          : `${row.tier1_budget_pct.toFixed(0)}%`}
      </TableCell>
      <TableCell className="text-fg-2 data">
        ${row.daily_cost_usd.toFixed(3)}
      </TableCell>
    </TableRow>
  )
}

function StatusBadge(props: { readonly status: string }): JSX.Element {
  // dash-redesign sweep — use the kit's `.mc-dot` semantics instead of
  // shadcn <Badge> color drift. Live agents pulse (live ring class);
  // errored/crashed show warn dot; everything else is calm-idle.
  const s = props.status
  const isLive = s === 'running' || s === 'active'
  const isWarn = s === 'errored' || s === 'crashed'
  const tone = isLive ? 'ok' : isWarn ? 'warn' : 'idle'
  const dotClass = `mc-dot ${isLive ? 'live ' : ''}${tone}`.trim()
  return (
    <span className="inline-flex items-center gap-2 font-mono text-[11px] text-fg-2">
      <span className={dotClass} />
      {s}
    </span>
  )
}

// ---------------------------------------------------------------------------
// Table-level filter bar
// ---------------------------------------------------------------------------

type StatusFilter = 'all' | 'running' | 'stopped' | 'errored'
type ModelFilter = 'all' | 'opus' | 'sonnet' | 'haiku'
type BreachFilter = 'any' | 'breach' | 'healthy'

function FilterBar(props: {
  readonly status: StatusFilter
  readonly setStatus: (v: StatusFilter) => void
  readonly model: ModelFilter
  readonly setModel: (v: ModelFilter) => void
  readonly breach: BreachFilter
  readonly setBreach: (v: BreachFilter) => void
  readonly onExport: () => void
  readonly rowCount: number
}): JSX.Element {
  return (
    <div className="flex flex-wrap items-end gap-3 py-2 border-b border-bg-s3 mb-2">
      <FilterSelect
        label="status"
        value={props.status}
        onChange={(v) => props.setStatus(v as StatusFilter)}
        options={['all', 'running', 'stopped', 'errored']}
      />
      <FilterSelect
        label="model"
        value={props.model}
        onChange={(v) => props.setModel(v as ModelFilter)}
        options={['all', 'opus', 'sonnet', 'haiku']}
      />
      <FilterSelect
        label="SLO"
        value={props.breach}
        onChange={(v) => props.setBreach(v as BreachFilter)}
        options={['any', 'breach', 'healthy']}
      />
      <div className="flex-1" />
      <span className="text-xs text-fg-3 self-center" data-testid="fleet-row-count">
        {props.rowCount} agent{props.rowCount === 1 ? '' : 's'}
      </span>
      <Button
        variant="outline"
        size="sm"
        onClick={props.onExport}
        data-testid="fleet-csv-export"
      >
        Export CSV
      </Button>
    </div>
  )
}

function FilterSelect(props: {
  readonly label: string
  readonly value: string
  readonly onChange: (v: string) => void
  readonly options: readonly string[]
}): JSX.Element {
  return (
    <label className="flex flex-col gap-1 text-[10px] font-display uppercase tracking-wide text-fg-3">
      {props.label}
      <select
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
        className="rounded border border-bg-s3 bg-bg-elevated px-2 py-1 text-xs text-fg-1 font-mono"
        data-testid={`fleet-filter-${props.label}`}
      >
        {props.options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    </label>
  )
}

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

export function FleetComparisonTable(): JSX.Element {
  const agentsQ = useAgents()
  const costsQ = useCosts('today')
  // useIpcInboxes loaded for parity with the column list in the plan (IPC
  // delivery success rate); deliveryStats is fleet-wide (DeliveryQueue) not
  // per-agent, so we render it as a single footer stat rather than a
  // per-row column. Documented as a forward-pointer.
  const ipcQ = useIpcInboxes()

  const [sortKey, setSortKey] = useState<SortKey>('daily_cost_usd')
  const [sortDir, setSortDir] = useState<SortDir>('desc')
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [modelFilter, setModelFilter] = useState<ModelFilter>('all')
  const [breachFilter, setBreachFilter] = useState<BreachFilter>('any')

  // Aggregated rows reported up from FleetRow children. Keyed by agent name
  // so re-reports overwrite rather than append.
  const [reportedRows, setReportedRows] = useState<Record<string, RowData>>({})

  const agentList = useMemo(() => {
    const payload = agentsQ.data as
      | { agents?: readonly AgentStatusEntry[] }
      | undefined
    return [...(payload?.agents ?? [])].sort((a, b) =>
      a.name.localeCompare(b.name),
    )
  }, [agentsQ.data])

  // Per-agent daily cost (sum across models within the agent).
  const costsByAgent = useMemo(() => {
    const m = new Map<string, number>()
    for (const row of costsQ.data?.costs ?? []) {
      m.set(row.agent, (m.get(row.agent) ?? 0) + row.cost_usd)
    }
    return m
  }, [costsQ.data])

  // Filter + sort the aggregated rows for display.
  const visibleRows = useMemo(() => {
    let rs = Object.values(reportedRows)
    if (statusFilter !== 'all') {
      rs = rs.filter((r) => {
        if (statusFilter === 'running') return r.status === 'running' || r.status === 'active'
        if (statusFilter === 'errored') return r.status === 'errored' || r.status === 'crashed'
        return r.status === 'stopped' || r.status === 'idle'
      })
    }
    if (modelFilter !== 'all') {
      rs = rs.filter((r) => r.model.toLowerCase().includes(modelFilter))
    }
    if (breachFilter !== 'any') {
      rs = rs.filter((r) =>
        breachFilter === 'breach'
          ? r.first_token_slo_color === 'warn' || r.first_token_slo_color === 'danger'
          : r.first_token_slo_color === 'primary',
      )
    }
    rs = [...rs].sort((a, b) => compareRows(a, b, sortKey, sortDir))
    return rs
  }, [reportedRows, statusFilter, modelFilter, breachFilter, sortKey, sortDir])

  const reportRow = (row: RowData): void => {
    setReportedRows((prev) => {
      const existing = prev[row.name]
      // Only update if something actually changed (rowKey upstream
      // already gates re-reports, but defensive equality keeps the
      // setState call no-op on identical content).
      if (existing && JSON.stringify(existing) === JSON.stringify(row)) {
        return prev
      }
      return { ...prev, [row.name]: row }
    })
  }

  const handleSort = (key: SortKey): void => {
    if (key === sortKey) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortKey(key)
      setSortDir('asc')
    }
  }

  const ipcDelivery = ipcQ.data as
    | {
        readonly deliveryStats?: {
          readonly pending?: number
          readonly inFlight?: number
          readonly failed?: number
          readonly delivered?: number
        }
      }
    | undefined
  const deliveryStats = ipcDelivery?.deliveryStats
  const totalDelivered = deliveryStats?.delivered ?? 0
  const totalFailed = deliveryStats?.failed ?? 0
  const deliveryPct =
    totalDelivered + totalFailed > 0
      ? totalDelivered / (totalDelivered + totalFailed)
      : null

  return (
    <div className="mx-auto max-w-7xl px-7 py-6">
      {/* dash-redesign sweep — section-head + .sub mirrors the home
          view's MissionFleetGrid header. Body copy moves into the
          subtitle slot so the scan path is heading → context → table. */}
      <div className="section-head mb-5">
        <div className="flex items-baseline">
          <h2>Fleet comparison</h2>
          <span className="sub">
            click any column header to sort · CSV export below
          </span>
        </div>
      </div>

      {/* 116-06 F22 — fleet-wide 30-day activity heatmap. Sums turn
          counts across every agent so the operator question "when is
          the fleet busy?" answers in one glance (informs deploy-window
          scheduling — see plan must-have). Mounted above the table so
          the rhythm sits in the operator's primary scan path. */}
      <div className="mb-6">
        <FleetActivityHeatmap />
      </div>

      <FilterBar
        status={statusFilter}
        setStatus={setStatusFilter}
        model={modelFilter}
        setModel={setModelFilter}
        breach={breachFilter}
        setBreach={setBreachFilter}
        onExport={() => downloadCsv(visibleRows)}
        rowCount={visibleRows.length}
      />

      {/* Hidden data-fetcher rows — one per agent in the fleet. Each row
          renders its OWN useAgentCache/useAgentLatency hook + reports the
          normalized RowData up via onReport. We render these inside the
          table body so the visible TableRow stays the same DOM node. */}
      <Table>
        <TableHeader>
          <TableRow>
            <SortHead k="name" cur={sortKey} dir={sortDir} onClick={handleSort}>
              agent
            </SortHead>
            <SortHead k="status" cur={sortKey} dir={sortDir} onClick={handleSort}>
              status
            </SortHead>
            <SortHead k="model" cur={sortKey} dir={sortDir} onClick={handleSort}>
              model
            </SortHead>
            <SortHead
              k="first_token_p50"
              cur={sortKey}
              dir={sortDir}
              onClick={handleSort}
            >
              first-tok p50
            </SortHead>
            <SortHead
              k="end_to_end_p95"
              cur={sortKey}
              dir={sortDir}
              onClick={handleSort}
            >
              end-to-end p95
            </SortHead>
            <SortHead
              k="tool_cache_hit_rate"
              cur={sortKey}
              dir={sortDir}
              onClick={handleSort}
            >
              tool$ hit
            </SortHead>
            <SortHead
              k="tier1_budget_pct"
              cur={sortKey}
              dir={sortDir}
              onClick={handleSort}
            >
              tier1 %
            </SortHead>
            <SortHead
              k="daily_cost_usd"
              cur={sortKey}
              dir={sortDir}
              onClick={handleSort}
            >
              daily $
            </SortHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {agentList.map((a) => (
            <FleetRow
              key={a.name}
              agent={a}
              dailyCostUsd={costsByAgent.get(a.name) ?? 0}
              onReport={reportRow}
            />
          ))}
          {agentList.length === 0 && (
            <TableRow>
              <TableCell colSpan={8} className="text-center text-fg-3 py-6">
                {agentsQ.isLoading ? 'Loading fleet…' : 'No agents found.'}
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>

      {/* Footer — fleet-wide stats that aren't per-row */}
      {deliveryStats && (
        <div className="mt-4 flex flex-wrap gap-4 text-xs text-fg-3 border-t border-bg-s3 pt-3">
          <div data-testid="fleet-delivery-stat">
            Discord delivery (fleet):{' '}
            <span className="text-fg-1 font-mono">
              {totalDelivered.toLocaleString()} delivered
            </span>{' '}
            ·{' '}
            <span className="text-warn font-mono">
              {totalFailed.toLocaleString()} failed
            </span>{' '}
            {deliveryPct !== null && (
              <span className="text-fg-1 font-mono">
                ({(deliveryPct * 100).toFixed(1)}% success)
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

function SortHead(props: {
  readonly k: SortKey
  readonly cur: SortKey
  readonly dir: SortDir
  readonly onClick: (k: SortKey) => void
  readonly children: React.ReactNode
}): JSX.Element {
  const active = props.k === props.cur
  const arrow = !active ? '' : props.dir === 'asc' ? ' ↑' : ' ↓'
  return (
    <TableHead
      onClick={() => props.onClick(props.k)}
      className={`cursor-pointer select-none hover:text-fg-1 ${active ? 'text-fg-1' : ''}`}
      data-testid={`fleet-sort-${props.k}`}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          props.onClick(props.k)
        }
      }}
    >
      {props.children}
      {arrow}
    </TableHead>
  )
}

export default FleetComparisonTable
