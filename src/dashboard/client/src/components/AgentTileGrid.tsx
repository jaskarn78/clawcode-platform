/**
 * Phase 116 Plan 01 T02 — F03 agent tile grid.
 *
 * Responsive layout (Tailwind config screens: sm=375 md=768 lg=1024 xl=1280 2xl=1920):
 *   - default (<375px): 1-col
 *   - sm (≥375):       1-col (mobile-first)
 *   - md (≥768):       2-col (tablet portrait)
 *   - xl (≥1280):      3-col (laptop)
 *   - 2xl (≥1920):     4-col (desktop)
 *
 * Dormant agents (status === 'stopped' OR no lastTurnAt within 7 days) collapse
 * into a small footer list rather than consuming a full tile. Per plan T02 §3.
 *
 * Click on tile → no-op today (drawer ships in 116-04); the AgentTile passes
 * through `onSelect` for future wire-up.
 */
import { useMemo } from 'react'
import { AgentTile } from './AgentTile'
import { useAgents, useFleetActivitySummary } from '@/hooks/useApi'

// 7d dormant threshold — agents quieter than this collapse to the footer.
const DORMANT_AGE_MS = 7 * 24 * 60 * 60 * 1000

type FleetAgent = {
  readonly name: string
  readonly model?: string
  readonly status?: string
  readonly lastTurnAt?: string | number | null
  readonly startedAt?: number | null
  readonly uptime?: number | null
  readonly restartCount?: number
  readonly lastError?: string | null
}

type FleetPayload = {
  readonly agents?: ReadonlyArray<FleetAgent>
}

function lastTurnMs(a: FleetAgent): number | null {
  const lt = a.lastTurnAt
  if (lt === null || lt === undefined) return null
  const ms = typeof lt === 'number' ? lt : new Date(lt).getTime()
  return Number.isFinite(ms) ? ms : null
}

function isDormant(a: FleetAgent, now: number): boolean {
  if (a.status === 'stopped' || a.status === 'idle') {
    // Still hide stopped agents only when also old; an operator-stopped
    // agent in the last hour should stay visible.
    const ms = lastTurnMs(a)
    if (ms === null) return true
    return now - ms > DORMANT_AGE_MS
  }
  return false
}

export type AgentTileGridProps = {
  readonly onSelectAgent?: (agent: string) => void
}

export function AgentTileGrid(props: AgentTileGridProps): JSX.Element {
  const agentsQuery = useAgents()
  // Phase 116-postdeploy 2026-05-12 — operator: "the main dashboard page
  // should show agents ordered by whats used the most." Independent query
  // keyed for sort only; the per-tile sparkline keeps its own cache key
  // so the sort refetch doesn't thrash the Recharts mounts.
  const activityQuery = useFleetActivitySummary()
  const payload = agentsQuery.data as FleetPayload | undefined
  const all = useMemo(() => payload?.agents ?? [], [payload])

  // Build a stable {agent → turns_24h} lookup. Missing entries treated as
  // 0 (agent reported by /api/status but no traces.db turns in window —
  // e.g., a brand-new agent or one that's been stopped > 24h). When the
  // activity query is still in flight, the lookup is empty and every
  // agent ties at 0 → fall through to alphabetical, which matches the
  // pre-sort default visually until data arrives.
  const turns24h = useMemo(() => {
    const m = new Map<string, number>()
    for (const row of activityQuery.data?.agents ?? []) {
      m.set(row.agent, row.turns_24h)
    }
    return m
  }, [activityQuery.data])

  const now = Date.now()
  const { active, dormant } = useMemo(() => {
    const a: FleetAgent[] = []
    const d: FleetAgent[] = []
    for (const agent of all) {
      if (isDormant(agent, now)) d.push(agent)
      else a.push(agent)
    }
    // Sort active by turns_24h DESC; tie-break alphabetical ASC.
    // Stopped agents already live in `d` (dormant footer) per
    // `isDormant`, so this only sorts the visible tile grid.
    a.sort((x, y) => {
      const tx = turns24h.get(x.name) ?? 0
      const ty = turns24h.get(y.name) ?? 0
      if (tx !== ty) return ty - tx
      return x.name.localeCompare(y.name)
    })
    return { active: a, dormant: d }
  }, [all, now, turns24h])

  if (agentsQuery.isLoading) {
    return (
      <p className="text-fg-2 font-sans p-6" data-testid="agent-tile-grid-loading">
        Loading fleet…
      </p>
    )
  }

  if (agentsQuery.isError) {
    return (
      <p className="text-danger font-sans p-6" data-testid="agent-tile-grid-error">
        Failed to load fleet — daemon unreachable.
      </p>
    )
  }

  if (all.length === 0) {
    return (
      <p className="text-fg-2 font-sans p-6" data-testid="agent-tile-grid-empty">
        No agents reported. Confirm <code className="data">/api/status</code>{' '}
        returns <code className="data">{'{ agents: [...] }'}</code>.
      </p>
    )
  }

  // Phase 116-postdeploy 2026-05-12 — small indicator so the operator
  // knows the order isn't alphabetical. Kept as a static label rather
  // than a dropdown to minimise surface — operator's literal ask was
  // "ordered by what's used the most" (24h), so we ship that as the
  // single default. A dropdown can land later if other sort modes get
  // asked for.
  const sortReady = activityQuery.data !== undefined
  return (
    <div className="space-y-6" data-testid="agent-tile-grid">
      <div className="flex items-center justify-end">
        <span
          className="font-mono text-[10px] uppercase tracking-wider text-fg-3"
          data-testid="agent-tile-grid-sort-indicator"
          title={
            sortReady
              ? 'Tiles ordered by turn count over the last 24 hours (most active first).'
              : 'Tiles will reorder by 24h usage once the fleet-activity summary loads.'
          }
        >
          Sort: most used 24h
          {!sortReady && activityQuery.isLoading ? ' · loading…' : ''}
          {activityQuery.isError ? ' · offline (alphabetical)' : ''}
        </span>
      </div>
      <div className="grid gap-4 grid-cols-1 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
        {active.map((agent) => (
          <AgentTile
            key={agent.name}
            agent={agent}
            onSelect={props.onSelectAgent}
          />
        ))}
      </div>

      {dormant.length > 0 && (
        <footer
          className="border-t border-bg-s3 pt-4"
          data-testid="agent-tile-grid-dormant"
        >
          <h3 className="text-xs uppercase tracking-wide text-fg-3 mb-2 font-sans">
            Dormant ({dormant.length})
          </h3>
          <ul className="flex flex-wrap gap-2">
            {dormant.map((agent) => (
              <li key={agent.name}>
                <button
                  type="button"
                  onClick={() => props.onSelectAgent?.(agent.name)}
                  className="font-mono text-xs text-fg-2 hover:text-fg-1 border border-bg-s3 rounded-md px-2 py-1 bg-bg-muted"
                >
                  {agent.name}
                </button>
              </li>
            ))}
          </ul>
        </footer>
      )}
    </div>
  )
}

export default AgentTileGrid
