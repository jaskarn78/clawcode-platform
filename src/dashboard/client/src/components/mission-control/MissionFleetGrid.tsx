/**
 * dash-redesign (Mission Control) — fleet grid + filter chips.
 *
 * Ported from the design-system kit's `FleetGrid`. Reads
 * `useAgents()` and renders one `<MissionAgentTile>` per agent.
 * Filter chips (all / live / warn / idle) gate the rendered set
 * using the per-tile status derivation in MissionAgentTile.
 *
 * The MissionAgentTile owns its own status derivation (it has access
 * to the per-agent latency hook). Filter at the grid level by
 * fetching the same hooks again would be a duplicate query; instead
 * we filter by `rawStatus` heuristically and let each tile mount
 * regardless. Operator-visible filter semantics:
 *   - all : every agent
 *   - live: rawStatus === 'running' OR 'active'
 *   - warn: rawStatus === 'errored' OR 'crashed'
 *   - idle: rawStatus === 'stopped' OR 'idle' OR unknown
 *
 * This is intentionally coarser than the per-tile status derivation
 * (which factors in SLO breach and recency). A tile filtered into
 * `live` may still render as `warn` if its p50 has breached — which
 * is fine: operators looking at the live cohort should see breached-
 * but-still-streaming agents to investigate. The status dot tells
 * the truth.
 */
import { useMemo, useState } from 'react'
import type { JSX } from 'react'
import {
  useAgents,
  useFleetActivitySummary,
  type AgentStatusEntry,
  type FleetActivityAgent,
} from '@/hooks/useApi'
import { MissionAgentTile } from './MissionAgentTile'

export type FleetFilter = 'all' | 'live' | 'warn' | 'idle'
const FILTERS: ReadonlyArray<FleetFilter> = ['all', 'live', 'warn', 'idle']

export function matchesFilter(
  agent: AgentStatusEntry,
  filter: FleetFilter,
): boolean {
  if (filter === 'all') return true
  const status = agent.status
  if (filter === 'live') return status === 'running' || status === 'active'
  if (filter === 'warn') return status === 'errored' || status === 'crashed'
  // idle bucket — everything else falls here (stopped, idle, starting,
  // unknown). Starting is debatable but operators usually want it
  // visible in the calm bucket while it spins up.
  return (
    status === 'stopped' ||
    status === 'idle' ||
    status === 'starting' ||
    status === undefined ||
    status === null
  )
}

/**
 * Sort agents by 24h activity (most active first). Operator-facing
 * landing-page ordering — answers the "who's been doing work?"
 * question at a glance.
 *
 * Ordering precedence (deterministic, all-finite):
 *   1. turns_24h desc                    (real activity signal)
 *   2. last_turn_at desc (epoch ms)      (recency tie-breaker)
 *   3. name asc                          (stable final tiebreaker)
 *
 * Activity data may be absent (cold cache, daemon-side endpoint
 * blip). Missing entries default to `turns_24h=0` + `last_turn_at=0`,
 * which sorts them to the tail in name order — same as fully-idle
 * agents.
 */
export function sortByActivity(
  agents: ReadonlyArray<AgentStatusEntry>,
  activity: ReadonlyArray<FleetActivityAgent>,
): ReadonlyArray<AgentStatusEntry> {
  const activityByName = new Map<string, FleetActivityAgent>()
  for (const a of activity) activityByName.set(a.agent, a)

  const score = (
    a: AgentStatusEntry,
  ): { readonly turns: number; readonly lastMs: number } => {
    const row = activityByName.get(a.name)
    const turns = row?.turns_24h ?? 0
    const lastMs = row?.last_turn_at
      ? new Date(row.last_turn_at).getTime()
      : 0
    return {
      turns: Number.isFinite(turns) ? turns : 0,
      lastMs: Number.isFinite(lastMs) ? lastMs : 0,
    }
  }

  // .slice() so we don't mutate the readonly input — Immutable per
  // the project coding-style rule.
  return agents.slice().sort((a, b) => {
    const sa = score(a)
    const sb = score(b)
    if (sb.turns !== sa.turns) return sb.turns - sa.turns
    if (sb.lastMs !== sa.lastMs) return sb.lastMs - sa.lastMs
    return a.name.localeCompare(b.name)
  })
}

export type MissionFleetGridProps = {
  readonly onSelect?: (name: string) => void
}

export function MissionFleetGrid(
  props: MissionFleetGridProps,
): JSX.Element {
  const [filter, setFilter] = useState<FleetFilter>('all')
  const agentsQ = useAgents()
  const activityQ = useFleetActivitySummary()
  const payload = agentsQ.data
  const agents: ReadonlyArray<AgentStatusEntry> = payload?.agents ?? []
  const activity: ReadonlyArray<FleetActivityAgent> =
    activityQ.data?.agents ?? []

  // Sort first (most-active-first), then filter — this keeps the
  // active cohort ordering stable as the operator toggles chips.
  // useMemo avoids re-sorting on every render (the activity hook
  // refetches on a 60s interval).
  const sorted = useMemo(
    () => sortByActivity(agents, activity),
    [agents, activity],
  )
  const filtered = sorted.filter((a) => matchesFilter(a, filter))

  return (
    <div data-testid="mission-fleet-grid" data-filter={filter}>
      <div className="section-head">
        <div style={{ display: 'flex', alignItems: 'baseline' }}>
          <h2>Agents</h2>
          <span className="sub">most active first · 24h</span>
        </div>
        <div className="filters">
          {FILTERS.map((f) => (
            <span
              key={f}
              role="button"
              tabIndex={0}
              className={`chip ${filter === f ? 'active' : ''}`}
              onClick={() => setFilter(f)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  setFilter(f)
                }
              }}
              data-testid={`mission-filter-${f}`}
              data-active={filter === f ? 'true' : 'false'}
            >
              {f}
            </span>
          ))}
        </div>
      </div>

      {agentsQ.isLoading && (
        <div className="feed-empty">Loading fleet…</div>
      )}
      {agentsQ.isError && (
        <div className="feed-empty" style={{ color: 'hsl(var(--danger))' }}>
          Failed to load fleet — daemon unreachable.
        </div>
      )}
      {!agentsQ.isLoading && !agentsQ.isError && filtered.length === 0 && (
        <div className="feed-empty">
          No agents match the <strong>{filter}</strong> filter.
        </div>
      )}

      <div className="fleet-grid">
        {filtered.map((a) => (
          <MissionAgentTile
            key={a.name}
            agent={{
              name: a.name,
              status: a.status,
              lastTurnAt: a.lastTurnAt,
              model: a.model,
            }}
            onSelect={props.onSelect}
          />
        ))}
      </div>
    </div>
  )
}

export default MissionFleetGrid
