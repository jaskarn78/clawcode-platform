/**
 * Phase 116 Plan 01 T01 — F01 SLO breach banner.
 *
 * Reads `useAgents()` for the fleet roster, then `useAgentCache(name)` (F02
 * threshold) + `useAgentLatency(name)` (observed first_token p50) per agent
 * and computes breaches client-side: observed > threshold.
 *
 * Dismissal is keyed by `{agent, threshold_bucket}` where threshold_bucket is
 * the observed p50 rounded to the nearest 500ms — that way jitter inside the
 * same degradation doesn't count as a "new" breach and re-show the banner,
 * but a genuine spike to a wider bucket does. Dismissal lives 1 hour.
 *
 * Click on agent name → calls the `openAgentDrawer` prop (no-op placeholder
 * today; 116-04 wires the real drawer).
 */
import { useMemo, useState, useCallback, useEffect } from 'react'
import { Button } from '@/components/ui/button'
import { useAgents, useAgentCache, useAgentLatency } from '@/hooks/useApi'

const DISMISS_STORAGE_KEY = 'dashboard.sloBreaches.dismissed'
const DISMISS_TTL_MS = 60 * 60 * 1000 // 1 hour
const BUCKET_MS = 500 // round observed p50 to nearest 500ms for dismissal key

// ---------------------------------------------------------------------------
// Types — narrow the loose `unknown` payloads from useApi.ts at the boundary.
// Defensive: every field is optional so a partial daemon response degrades to
// "no breach" rather than throwing.
// ---------------------------------------------------------------------------

type AgentName = string

type CachePayload = {
  readonly slos?: {
    readonly first_token_p50_ms?: number
    readonly source?: string
    readonly model?: string
  }
}

type LatencyPayload = {
  readonly first_token_headline?: {
    readonly p50?: number | null
    readonly p95?: number | null
    readonly count?: number
    readonly slo_status?: string
  }
}

type Breach = {
  readonly agent: AgentName
  readonly observedP50Ms: number
  readonly thresholdMs: number
  readonly dismissKey: string
}

// ---------------------------------------------------------------------------
// LocalStorage dismissal — { [dismissKey]: expiresAtMs }. Reads guarded
// against quota / private-mode failures.
// ---------------------------------------------------------------------------

function readDismissed(): Record<string, number> {
  try {
    const raw = window.localStorage.getItem(DISMISS_STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object') return {}
    const now = Date.now()
    const out: Record<string, number> = {}
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === 'number' && v > now) out[k] = v
    }
    return out
  } catch {
    return {}
  }
}

function writeDismissed(map: Record<string, number>): void {
  try {
    window.localStorage.setItem(DISMISS_STORAGE_KEY, JSON.stringify(map))
  } catch {
    // private-mode / quota — silent degrade; user sees the banner persist
    // across reloads, which is acceptable.
  }
}

function bucketDismissKey(agent: string, observedP50Ms: number): string {
  const bucket = Math.round(observedP50Ms / BUCKET_MS) * BUCKET_MS
  return `${agent}::${bucket}`
}

// ---------------------------------------------------------------------------
// Per-agent breach probe — one component per agent so each can drive its own
// useAgentCache + useAgentLatency without violating hook rules. Returns the
// breach (or null) up to the parent via a callback. The parent aggregates.
// ---------------------------------------------------------------------------

function AgentBreachProbe(props: {
  readonly agent: AgentName
  readonly onResult: (agent: AgentName, breach: Breach | null) => void
}): null {
  const cacheQ = useAgentCache(props.agent)
  const latencyQ = useAgentLatency(props.agent)
  const { onResult, agent } = props

  // Compute breach synchronously and report up via effect — keeps the parent
  // re-render cycle clean (no setState during render).
  useEffect(() => {
    const cache = cacheQ.data as CachePayload | undefined
    const latency = latencyQ.data as LatencyPayload | undefined
    const threshold = cache?.slos?.first_token_p50_ms ?? null
    const observed = latency?.first_token_headline?.p50 ?? null
    const count = latency?.first_token_headline?.count ?? 0
    const status = latency?.first_token_headline?.slo_status ?? null

    // Cold-start guard mirrors the daemon's evaluateFirstTokenHeadline: < 5
    // samples → no_data → no breach. We also defensively skip when threshold
    // is missing (unknown agent / config error).
    if (
      threshold === null ||
      observed === null ||
      count < 5 ||
      status === 'no_data' ||
      observed <= threshold
    ) {
      onResult(agent, null)
      return
    }

    onResult(agent, {
      agent,
      observedP50Ms: observed,
      thresholdMs: threshold,
      dismissKey: bucketDismissKey(agent, observed),
    })
  }, [cacheQ.data, latencyQ.data, agent, onResult])

  return null
}

// ---------------------------------------------------------------------------
// Banner — aggregates breaches across the fleet, filters dismissed, renders.
// ---------------------------------------------------------------------------

export type SloBreachBannerProps = {
  /**
   * Click handler for the per-agent drill-in link. 116-04 wires the real
   * drawer; today this is a no-op placeholder for forward compatibility.
   */
  readonly openAgentDrawer?: (agent: string) => void
}

export function SloBreachBanner(props: SloBreachBannerProps): JSX.Element | null {
  const agentsQuery = useAgents()
  const payload = agentsQuery.data as
    | { agents?: ReadonlyArray<{ name: string }> }
    | undefined
  const agentNames = useMemo(
    () => (payload?.agents ?? []).map((a) => a.name).filter((n) => n.length > 0),
    [payload],
  )

  const [breaches, setBreaches] = useState<Record<AgentName, Breach | null>>({})
  const handleResult = useCallback(
    (agent: AgentName, breach: Breach | null) => {
      setBreaches((curr) => {
        const prev = curr[agent]
        // Cheap equality — skip re-render when nothing changed.
        // Phase 116-postdeploy 2026-05-12: `prev` is typed `Breach | null` but
        // a TS `Record<K, V>` actually returns `V | undefined` on missing
        // keys. The previous `prev !== null` guard let `undefined` through,
        // and `undefined.dismissKey` threw — that crashed the SPA shell with
        // the "Cannot read properties of null (reading useEffect)"-style
        // trace operators kept reporting. `prev != null` excludes BOTH
        // null and undefined.
        if (
          prev === breach ||
          (prev != null &&
            breach !== null &&
            prev.dismissKey === breach.dismissKey &&
            prev.observedP50Ms === breach.observedP50Ms)
        ) {
          return curr
        }
        return { ...curr, [agent]: breach }
      })
    },
    [],
  )

  const [dismissed, setDismissed] = useState<Record<string, number>>(() =>
    readDismissed(),
  )

  // Refresh dismissed map every minute to drop expired entries.
  useEffect(() => {
    const id = setInterval(() => setDismissed(readDismissed()), 60_000)
    return () => clearInterval(id)
  }, [])

  const activeBreaches = useMemo(() => {
    const now = Date.now()
    const out: Breach[] = []
    for (const agent of agentNames) {
      const b = breaches[agent]
      if (!b) continue
      const exp = dismissed[b.dismissKey]
      if (exp && exp > now) continue
      out.push(b)
    }
    return out
  }, [agentNames, breaches, dismissed])

  const dismissAll = useCallback(() => {
    const exp = Date.now() + DISMISS_TTL_MS
    const next = { ...dismissed }
    for (const b of activeBreaches) next[b.dismissKey] = exp
    setDismissed(next)
    writeDismissed(next)
  }, [activeBreaches, dismissed])

  return (
    <>
      {/* Per-agent probes — mounted unconditionally so each maintains its own
          query subscription. Rendering `null` keeps the DOM clean. */}
      {agentNames.map((name) => (
        <AgentBreachProbe key={name} agent={name} onResult={handleResult} />
      ))}

      {activeBreaches.length === 0 ? null : (
        <div
          role="alert"
          aria-live="polite"
          className="border-b border-danger/30 bg-danger/10 px-4 py-3 sm:px-6 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3"
          data-testid="slo-breach-banner"
        >
          <div className="flex items-start gap-3 text-fg-1">
            <span
              aria-hidden="true"
              className="inline-flex shrink-0 items-center justify-center w-6 h-6 rounded-full bg-danger/20 text-danger font-bold"
            >
              !
            </span>
            <div className="text-sm leading-snug">
              <span className="font-display font-bold text-fg-1">
                {activeBreaches.length} SLO breach
                {activeBreaches.length === 1 ? '' : 'es'} active
              </span>
              <span className="text-fg-2">: </span>
              {activeBreaches.map((b, idx) => (
                <span key={b.agent}>
                  {idx > 0 && <span className="text-fg-3">, </span>}
                  <button
                    type="button"
                    onClick={() => props.openAgentDrawer?.(b.agent)}
                    className="font-mono text-fg-1 underline decoration-danger underline-offset-4 hover:text-danger focus:outline-none focus-visible:ring-2 focus-visible:ring-danger rounded-sm"
                  >
                    {b.agent}
                  </button>
                  <span className="font-mono text-fg-2 data ml-1">
                    first_token p50 {Math.round(b.observedP50Ms)}ms
                  </span>
                  <span className="text-fg-3 ml-1">
                    (target ≤ {Math.round(b.thresholdMs)}ms)
                  </span>
                </span>
              ))}
            </div>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={dismissAll}
            className="self-end sm:self-auto text-fg-2 hover:text-fg-1 font-mono uppercase text-xs"
            data-testid="slo-breach-banner-dismiss"
          >
            Dismiss
          </Button>
        </div>
      )}
    </>
  )
}

export default SloBreachBanner
