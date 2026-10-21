/**
 * dash-redesign (Mission Control) — signature agent tile.
 *
 * Ported from the design-system kit's `AgentTile`. Calmer 2-metric
 * layout (p50 + turns24h) with a tier-1 budget meter row + 24h
 * sparkline + last-turn footer. Status semantics derived from
 * production hook data (status + lastTurnAt freshness + threshold
 * breach):
 *   - 'live'  → status === 'running' AND lastTurnAt within 5 min
 *   - 'warn'  → status === 'errored' OR p50 > p50Threshold
 *   - 'idle'  → otherwise (stopped, never-run, long-idle)
 *
 * Data sourced from three production hooks per agent:
 *   - useAgents()        : status + lastTurnAt (passed in via props)
 *   - useAgentCache      : slos.{first_token_p50_ms, model} + tier1_budget_pct
 *   - useAgentLatency    : first_token_headline.{p50, count}
 *   - useAgentActivity   : 24-bucket hourly turn-count array
 *
 * Click → onSelect(name) so App.tsx can open the existing
 * AgentDetailDrawer. The drawer itself remains untouched per plan
 * scope (Mission Control covers Dashboard home only).
 */
import { useMemo } from 'react'
import type { JSX } from 'react'
import {
  useAgentActivity,
  useAgentCache,
  useAgentLatency,
  type ActivityResponse,
} from '@/hooks/useApi'
import { Sparkline } from './Sparkline'

// Threshold: agent counts as "live" if its last turn landed within
// this window. Five minutes mirrors the kit's intent — "running and
// recently active" — without being so tight that mid-turn pauses
// flicker the live indicator.
const LIVE_RECENCY_MS = 5 * 60 * 1000

// ---------------------------------------------------------------------------
// Loose payload types — the hooks return unknown by design (see useApi.ts).
// Narrow at the consumer boundary only.
// ---------------------------------------------------------------------------

type CachePayload = {
  readonly slos?: {
    readonly first_token_p50_ms?: number
    readonly model?: string
  }
  readonly tier1_budget_pct?: number | null
}

type LatencyPayload = {
  readonly first_token_headline?: {
    readonly p50?: number | null
    readonly count?: number
  }
}

// ---------------------------------------------------------------------------
// Helpers — small, local, no shared module. Same logic as AgentTile's
// `relativeTime` to keep two surfaces visually consistent.
// ---------------------------------------------------------------------------

export function formatRel(
  input: string | number | null | undefined,
): string {
  if (!input) return '—'
  const ms = typeof input === 'number' ? input : new Date(input).getTime()
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

/** Derive the kit's tri-state status from production state. */
export function deriveMissionStatus(input: {
  readonly rawStatus: string | undefined
  readonly lastTurnAt: string | number | null | undefined
  readonly p50Ms: number | null
  readonly p50Threshold: number | null
}): { readonly status: 'live' | 'warn' | 'idle'; readonly live: boolean } {
  const { rawStatus, lastTurnAt, p50Ms, p50Threshold } = input

  // Warn first: an errored agent or a breached SLO trumps any
  // recency signal — we want to surface trouble even if the agent
  // is technically still receiving turns.
  if (rawStatus === 'errored' || rawStatus === 'crashed') {
    return { status: 'warn', live: false }
  }
  if (
    p50Ms !== null &&
    p50Threshold !== null &&
    p50Ms > p50Threshold
  ) {
    // Warn-but-warming: still receiving turns, but breaching SLO.
    return { status: 'warn', live: false }
  }

  // Live: running AND recently active.
  if (rawStatus === 'running' || rawStatus === 'active') {
    const ts = lastTurnAt
      ? typeof lastTurnAt === 'number'
        ? lastTurnAt
        : new Date(lastTurnAt).getTime()
      : null
    const fresh =
      ts !== null && Number.isFinite(ts) && Date.now() - ts <= LIVE_RECENCY_MS
    if (fresh) return { status: 'live', live: true }
    // Running but stale → fall through to idle (calm, not warn).
  }

  return { status: 'idle', live: false }
}

/** Normalize hourly bucket counts to a 0..100 percentage array. */
function normalizeSpark(buckets: ReadonlyArray<{ readonly turn_count: number }>): number[] {
  if (buckets.length === 0) return []
  const max = buckets.reduce((m, b) => Math.max(m, b.turn_count), 0)
  if (max === 0) return []
  return buckets.map((b) => Math.round((b.turn_count / max) * 100))
}

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

export type MissionAgentTileProps = {
  readonly agent: {
    readonly name: string
    readonly status?: string
    readonly lastTurnAt?: string | number | null
    readonly model?: string
  }
  readonly onSelect?: (name: string) => void
}

export function MissionAgentTile(
  props: MissionAgentTileProps,
): JSX.Element {
  const { agent } = props
  const cacheQ = useAgentCache(agent.name)
  const latencyQ = useAgentLatency(agent.name)
  const activityQ = useAgentActivity(agent.name, 24)

  const cache = cacheQ.data as CachePayload | undefined
  const latency = latencyQ.data as LatencyPayload | undefined
  const activity = activityQ.data as ActivityResponse | undefined

  const model = agent.model ?? cache?.slos?.model ?? null
  const threshold = cache?.slos?.first_token_p50_ms ?? null
  const observedP50 = latency?.first_token_headline?.p50 ?? null
  const observedCount = latency?.first_token_headline?.count ?? 0
  // Cold-start guard — match AgentTile's: count < 5 → no-data display.
  const p50Display =
    observedP50 === null || observedCount < 5 ? null : Math.round(observedP50)
  const effectiveP50ForStatus = observedCount < 5 ? null : observedP50

  const buckets = activity?.buckets ?? []
  const turns24h = buckets.reduce((s, b) => s + b.turn_count, 0)
  const spark = normalizeSpark(buckets)

  // Tier-1 budget — daemon returns 0..1 (or 0..100; clamp) — surface
  // as a 0..100 rounded percentage for the kit's meter.
  const rawTier1 = cache?.tier1_budget_pct ?? 0
  const tier1 = Math.max(
    0,
    Math.min(100, Math.round(rawTier1 > 1 ? rawTier1 : rawTier1 * 100)),
  )

  const { status, live } = deriveMissionStatus({
    rawStatus: agent.status,
    lastTurnAt: agent.lastTurnAt,
    p50Ms: effectiveP50ForStatus,
    p50Threshold: threshold,
  })

  const isWarn = status === 'warn'
  const isIdle = status === 'idle'
  const p50ColorClass =
    p50Display === null
      ? ''
      : threshold !== null && p50Display > threshold * 2
        ? 'warn'
        : threshold !== null && p50Display > threshold
          ? 'warn'
          : 'ok'
  const meterClass = tier1 >= 85 ? 'danger' : tier1 >= 70 ? 'warn' : 'ok'
  const tileClass = live ? 'tile live' : isWarn ? 'tile warn' : 'tile'
  const dotClass = `mc-dot ${live ? 'live' : ''} ${
    isWarn ? 'warn' : isIdle ? 'idle' : 'ok'
  }`.trim()

  const lastTurn = useMemo(
    () => formatRel(agent.lastTurnAt ?? null),
    [agent.lastTurnAt],
  )

  return (
    <article
      className={tileClass}
      onClick={() => props.onSelect?.(agent.name)}
      data-testid="mission-agent-tile"
      data-agent={agent.name}
      data-status={status}
      data-live={live ? 'true' : 'false'}
      role={props.onSelect ? 'button' : undefined}
      tabIndex={props.onSelect ? 0 : undefined}
    >
      <div className="tile-head">
        <div className="tile-name">
          <span className={dotClass} />
          <h3>{agent.name}</h3>
        </div>
        {model && <span className="tile-model">{model}</span>}
      </div>

      <div className="tile-metrics">
        <div className={`metric ${p50ColorClass}`}>
          <div className="lbl">first_token p50</div>
          <div className="val">
            {p50Display === null ? '—' : p50Display.toLocaleString()}
            {p50Display !== null && <span className="unit">ms</span>}
          </div>
        </div>
        <div className="metric">
          <div className="lbl">turns 24h</div>
          <div className="val">{turns24h.toLocaleString()}</div>
        </div>
      </div>

      <div className="tile-meter-row">
        <span className="lbl">tier 1</span>
        <div className="track">
          <div className={`fill ${meterClass}`} style={{ width: `${tier1}%` }} />
        </div>
        <span
          className="pct"
          style={{
            color:
              meterClass === 'ok'
                ? 'hsl(var(--primary))'
                : meterClass === 'warn'
                  ? 'hsl(var(--warn))'
                  : 'hsl(var(--danger))',
          }}
        >
          {tier1}%
        </span>
      </div>

      <div className="tile-foot">
        <Sparkline data={spark} variant={isWarn ? 'warn' : 'ok'} />
        <span className="last">
          {live && <span className="live-tag">●</span>}
          {lastTurn}
        </span>
      </div>
    </article>
  )
}

export default MissionAgentTile
