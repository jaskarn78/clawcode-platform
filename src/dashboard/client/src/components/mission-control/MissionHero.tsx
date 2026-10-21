/**
 * dash-redesign (Mission Control) — Hero strip + StatTiles.
 *
 * Headline + 4 stat tiles. Reads:
 *   - useAgents()              → fleet size + live count (derived)
 *   - useAgentLatency(each)    → median p50 across live agents
 *   - useAgentCache(each)      → mean tier1_budget_pct
 *   - /api/advisor-budget      → TODO endpoint, gracefully degrades
 *
 * Headline is the kit's "Six agents. One steady pulse." with the
 * agent count parameterized: ${N} agents / One steady pulse.
 *
 * TanStack Query dedupes — the per-agent queries here share cache
 * keys with MissionAgentTile so no duplicate network round-trips.
 *
 * TODO: advisor-budget endpoint. The daemon stores rolled call
 * counts in src/usage/advisor-budget.ts (advisor-budget.db). There
 * is no /api/advisor-budget route in src/dashboard/server.ts today.
 * Until that lands, the tile renders "—" with the operator-visible
 * note "endpoint pending". File a follow-up plan to wire:
 *   GET /api/advisor-budget → { calls_used: number, max_calls: number }
 * aggregated across the fleet for today.
 */
import { useEffect, useState } from 'react'
import type { JSX } from 'react'
import {
  useAgentCache,
  useAgentLatency,
  useAgents,
  type AgentStatusEntry,
} from '@/hooks/useApi'
import { deriveMissionStatus } from './MissionAgentTile'

// ---------------------------------------------------------------------------
// StatTile — kit's stat card. Local to the hero so the API surface
// stays small (no other section uses StatTile).
// ---------------------------------------------------------------------------

type StatTileProps = {
  readonly label: string
  readonly value: string
  readonly unit?: string
  readonly delta?: string
  readonly deltaDir?: 'up' | 'down'
}

function StatTile(props: StatTileProps): JSX.Element {
  return (
    <div className="stat" data-testid={`mission-stat-${props.label.toLowerCase().replace(/\s+/g, '-')}`}>
      <div className="lbl">{props.label}</div>
      <div className="val">
        {props.value}
        {props.unit && <span className="unit">{props.unit}</span>}
      </div>
      {props.delta && (
        <div className={`delta ${props.deltaDir ?? ''}`}>{props.delta}</div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Per-agent aggregator. One <PerAgentProbe> mounted per agent inside
// the Hero so each useAgentLatency / useAgentCache call is a real
// hook call (rules-of-hooks compliant). Reports its data up via a
// callback ref; the Hero owns the aggregation map.
// ---------------------------------------------------------------------------

type AgentProbeResult = {
  readonly name: string
  readonly p50: number | null
  readonly p50Threshold: number | null
  readonly p50Count: number
  readonly tier1Pct: number | null
  readonly rawStatus: string | undefined
  readonly lastTurnAt: string | number | null | undefined
}

type CachePayload = {
  readonly slos?: { readonly first_token_p50_ms?: number }
  readonly tier1_budget_pct?: number | null
}
type LatencyPayload = {
  readonly first_token_headline?: {
    readonly p50?: number | null
    readonly count?: number
  }
}

function PerAgentProbe(props: {
  readonly agent: AgentStatusEntry
  readonly onReport: (r: AgentProbeResult) => void
}): null {
  const { agent, onReport } = props
  const cacheQ = useAgentCache(agent.name)
  const latencyQ = useAgentLatency(agent.name)
  const cache = cacheQ.data as CachePayload | undefined
  const latency = latencyQ.data as LatencyPayload | undefined

  const p50 = latency?.first_token_headline?.p50 ?? null
  const p50Count = latency?.first_token_headline?.count ?? 0
  const p50Threshold = cache?.slos?.first_token_p50_ms ?? null
  const rawTier1 = cache?.tier1_budget_pct
  const tier1Pct =
    rawTier1 === null || rawTier1 === undefined
      ? null
      : Math.max(0, Math.min(100, rawTier1 > 1 ? rawTier1 : rawTier1 * 100))

  useEffect(() => {
    onReport({
      name: agent.name,
      p50,
      p50Threshold,
      p50Count,
      tier1Pct,
      rawStatus: agent.status,
      lastTurnAt: agent.lastTurnAt,
    })
  }, [
    agent.name,
    agent.status,
    agent.lastTurnAt,
    p50,
    p50Threshold,
    p50Count,
    tier1Pct,
    onReport,
  ])

  return null
}

// ---------------------------------------------------------------------------
// Aggregation helpers — pure, testable.
// ---------------------------------------------------------------------------

export function medianFinite(values: ReadonlyArray<number>): number | null {
  const sorted = values
    .filter((v) => Number.isFinite(v))
    .slice()
    .sort((a, b) => a - b)
  if (sorted.length === 0) return null
  const mid = Math.floor(sorted.length / 2)
  if (sorted.length % 2 === 1) return sorted[mid]
  return Math.round((sorted[mid - 1] + sorted[mid]) / 2)
}

export function meanFinite(values: ReadonlyArray<number>): number | null {
  const arr = values.filter((v) => Number.isFinite(v))
  if (arr.length === 0) return null
  const sum = arr.reduce((s, v) => s + v, 0)
  return Math.round(sum / arr.length)
}

// ---------------------------------------------------------------------------
// Advisor budget — graceful degrade. Try the (likely-missing) endpoint
// once; on 404 / network error, drop into the placeholder forever.
// ---------------------------------------------------------------------------

type AdvisorBudgetSnapshot = {
  readonly callsUsed: number | null
  readonly maxCalls: number | null
  readonly available: boolean
}

function useAdvisorBudget(): AdvisorBudgetSnapshot {
  const [snap, setSnap] = useState<AdvisorBudgetSnapshot>({
    callsUsed: null,
    maxCalls: null,
    available: false,
  })
  useEffect(() => {
    let cancelled = false
    fetch('/api/advisor-budget', { credentials: 'same-origin' })
      .then((r) => (r.ok ? r.json() : null))
      .then((data: unknown) => {
        if (cancelled || !data || typeof data !== 'object') return
        const d = data as Record<string, unknown>
        const callsUsed =
          typeof d.callsUsed === 'number'
            ? d.callsUsed
            : typeof d.calls_used === 'number'
              ? d.calls_used
              : null
        const maxCalls =
          typeof d.maxCalls === 'number'
            ? d.maxCalls
            : typeof d.max_calls === 'number'
              ? d.max_calls
              : null
        if (callsUsed !== null && maxCalls !== null) {
          setSnap({ callsUsed, maxCalls, available: true })
        }
      })
      .catch(() => {
        // 404 / network error → keep the placeholder state. No retry.
      })
    return () => {
      cancelled = true
    }
  }, [])
  return snap
}

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

export function MissionHero(): JSX.Element {
  const agentsQ = useAgents()
  const agents = agentsQ.data?.agents ?? []
  const fleetSize = agents.length

  // Per-agent probes report into this map. Map identity changes every
  // probe report so memoized derivations re-run; we accept the
  // re-render cost (handful of stats, no expensive paint).
  const [probes, setProbes] = useState<Record<string, AgentProbeResult>>({})

  const handleReport = (r: AgentProbeResult): void => {
    setProbes((prev) => {
      const cur = prev[r.name]
      if (
        cur &&
        cur.p50 === r.p50 &&
        cur.p50Threshold === r.p50Threshold &&
        cur.p50Count === r.p50Count &&
        cur.tier1Pct === r.tier1Pct &&
        cur.rawStatus === r.rawStatus &&
        cur.lastTurnAt === r.lastTurnAt
      ) {
        return prev
      }
      return { ...prev, [r.name]: r }
    })
  }

  // Live count — kit semantics: tile would render as 'live'. Cold-start
  // guard: probes with <5 samples don't contribute a real p50 yet, so
  // they're treated as no-data for status purposes.
  const liveCount = agents.reduce((n, a) => {
    const p = probes[a.name]
    const p50ForStatus =
      p && p.p50Count >= 5 ? p.p50 : null
    const { live } = deriveMissionStatus({
      rawStatus: a.status,
      lastTurnAt: a.lastTurnAt,
      p50Ms: p50ForStatus,
      p50Threshold: p?.p50Threshold ?? null,
    })
    return live ? n + 1 : n
  }, 0)

  // Fleet p50 — median of live agents' observed p50 (count >= 5).
  const livingP50s: number[] = []
  const tier1Values: number[] = []
  for (const a of agents) {
    const p = probes[a.name]
    if (!p) continue
    if (p.p50 !== null && p.p50Count >= 5) livingP50s.push(p.p50)
    if (p.tier1Pct !== null) tier1Values.push(p.tier1Pct)
  }
  const fleetP50 = medianFinite(livingP50s)
  const tier1Avg = meanFinite(tier1Values)

  const advisor = useAdvisorBudget()

  // Headline — number parameterized; subhead kept verbatim from kit
  // (it's the editorial copy the design team locked).
  const headlineCount = fleetSize > 0 ? `${fleetSize} agents.` : 'No agents.'

  return (
    <section className="hero" data-testid="mission-hero" data-fleet-size={fleetSize}>
      {/* Hidden probes — one per agent. Each issues a useAgentCache +
          useAgentLatency hook call inside its own component scope so
          rules-of-hooks is honoured. TanStack Query dedupes against
          the per-tile queries downstream. */}
      {agents.map((a) => (
        <PerAgentProbe key={a.name} agent={a} onReport={handleReport} />
      ))}

      <div className="hero-title">
        <h1>
          {headlineCount}
          <br />
          <span className="accent">One steady pulse.</span>
        </h1>
        <p>
          {liveCount} running,{' '}
          {Math.max(0, fleetSize - liveCount)} idle or warming. Tier-1
          averaging {tier1Avg ?? '—'}% across the fleet; advisor budget
          {advisor.available ? ' under control.' : ' tracked daemon-side.'}{' '}
          {fleetP50 !== null
            ? `Fleet p50 ${fleetP50}ms in the last 24h.`
            : 'Fleet p50 collecting samples.'}
        </p>
      </div>

      <StatTile
        label="Live agents"
        value={String(liveCount)}
        unit={`/ ${fleetSize}`}
        delta={agentsQ.isLoading ? 'loading…' : undefined}
      />
      <StatTile
        label="p50 across fleet"
        value={fleetP50 === null ? '—' : String(fleetP50)}
        unit={fleetP50 === null ? undefined : 'ms'}
        delta={
          livingP50s.length > 0
            ? `${livingP50s.length} live agents`
            : 'awaiting samples'
        }
      />
      <StatTile
        label="Tier-1 avg"
        value={tier1Avg === null ? '—' : String(tier1Avg)}
        unit={tier1Avg === null ? undefined : '%'}
        delta={tier1Values.length > 0 ? `${tier1Values.length} agents reporting` : undefined}
      />
      <StatTile
        label="Advisor budget"
        value={
          advisor.available
            ? String(advisor.callsUsed)
            : '—'
        }
        unit={
          advisor.available && advisor.maxCalls !== null
            ? `/ ${advisor.maxCalls}`
            : undefined
        }
        delta={
          advisor.available
            ? 'resets at local-day boundary'
            : 'endpoint pending'
        }
      />
    </section>
  )
}

export default MissionHero
