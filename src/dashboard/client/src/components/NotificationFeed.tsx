/**
 * Phase 116-06 F20 — notification feed.
 *
 * Bell icon in the header with a badge count; click opens a slide-over
 * `<Sheet>` from the right with a chronological list of fleet-wide
 * notifications.
 *
 * SOURCES (all derived client-side; NO new backend endpoint — every
 * signal already streams via SSE or polls via the existing query layer):
 *
 *   1. SLO breach           — per-agent fan-out via useAgentCache(name) +
 *                             useAgentLatency(name) probe components.
 *                             slos.first_token_p50_ms observed > threshold.
 *                             SAME PATTERN as SloBreachBanner.tsx (AgentBreachProbe).
 *   2. Budget exceeded      — useBudgets(). Any row.pct >= 0.9.
 *   3. Discord delivery     — useDeliveryQueue().stats.failed > 0.
 *
 * SOURCES INTENTIONALLY OMITTED (advisor-triaged 2026-05-11):
 *
 *   - MCP degradation       — useMcpServers() is per-agent; no fleet-wide
 *                             rollup IPC exists today. The F10 MCP health
 *                             panel inside the drawer is the existing
 *                             affordance. Documented in 116-06-SUMMARY.
 *   - Dream priority trigger — no SSE event fires today; F15 dream queue
 *                             panel in the drawer is the existing
 *                             affordance. Documented in 116-06-SUMMARY.
 *   - Per-agent IPC inbox failures — DROPPED on advisor review. The
 *                             IpcInboxesResponse shape is { inboxes: [{agent,
 *                             pending, lastModified, ...}], deliveryStats,
 *                             recentFailures } — there's no `failed` count
 *                             per inbox row. Fleet-wide Discord delivery
 *                             failures are already surfaced via
 *                             useDeliveryQueue (the recentFailures field
 *                             carries the per-message breakdown for the
 *                             F13 panel). Adding it twice would double-fire.
 *
 * AUTO-DISMISS: notifications with `firstSeen` older than 24h are
 * filtered out at render time. Operator-dismissed entries persist in
 * `clawcode:dismissed-notifications` until the underlying signal
 * clears (so a once-dismissed SLO breach doesn't re-pop on every poll).
 *
 * The header badge shows the UNDISMISSED count. Zero = no badge.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  useAgents,
  useAgentCache,
  useAgentLatency,
  useBudgets,
  useDeliveryQueue,
} from '@/hooks/useApi'

type NotificationLevel = 'info' | 'warn' | 'danger'

export type Notification = {
  readonly id: string // stable across re-renders so dismissal persists
  readonly level: NotificationLevel
  readonly title: string
  readonly detail: string
  readonly firstSeen: number // epoch ms
  readonly source: 'slo' | 'budget' | 'delivery'
}

const DISMISSED_KEY = 'clawcode:dismissed-notifications'
const AUTO_DISMISS_MS = 24 * 3600 * 1000

function readDismissed(): ReadonlySet<string> {
  try {
    const raw = localStorage.getItem(DISMISSED_KEY)
    if (!raw) return new Set()
    const parsed = JSON.parse(raw) as unknown
    if (Array.isArray(parsed)) return new Set(parsed.filter((x) => typeof x === 'string'))
  } catch {
    /* fall through */
  }
  return new Set()
}

function writeDismissed(set: ReadonlySet<string>): void {
  try {
    localStorage.setItem(DISMISSED_KEY, JSON.stringify(Array.from(set)))
  } catch {
    /* private mode — dismissals are session-scope only */
  }
}

function BellIcon(): JSX.Element {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
      <path d="M13.73 21a2 2 0 0 1-3.46 0" />
    </svg>
  )
}

type SloBreach = {
  readonly agent: string
  readonly observedMs: number
  readonly thresholdMs: number
}

// Per-agent SLO probe — one component per agent so each can drive its own
// useAgentCache + useAgentLatency without violating hook rules. Reports the
// breach (or null) up to the parent via a callback. Same shape as the
// AgentBreachProbe in SloBreachBanner.tsx; we INTENTIONALLY re-implement it
// inline rather than extract a shared module because the two surfaces want
// different result shapes (banner: dismissKey for jitter-bucket dismissal;
// feed: simple {observed, threshold}).
function AgentSloProbe(props: {
  readonly agent: string
  readonly onResult: (agent: string, breach: SloBreach | null) => void
}): null {
  const cacheQ = useAgentCache(props.agent)
  const latencyQ = useAgentLatency(props.agent)
  const { onResult, agent } = props
  useEffect(() => {
    type CachePayload = { readonly slos?: { readonly first_token_p50_ms?: number | null } }
    type LatencyPayload = {
      readonly first_token_headline?: {
        readonly p50?: number | null
        readonly count?: number
        readonly slo_status?: string | null
      }
    }
    const cache = cacheQ.data as CachePayload | undefined
    const latency = latencyQ.data as LatencyPayload | undefined
    const threshold = cache?.slos?.first_token_p50_ms ?? null
    const observed = latency?.first_token_headline?.p50 ?? null
    const count = latency?.first_token_headline?.count ?? 0
    const status = latency?.first_token_headline?.slo_status ?? null
    // Cold-start guard: < 5 samples → no breach (matches daemon's
    // evaluateFirstTokenHeadline + SloBreachBanner pattern).
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
    onResult(agent, { agent, observedMs: observed, thresholdMs: threshold })
  }, [cacheQ.data, latencyQ.data, agent, onResult])
  return null
}

export function NotificationFeed(): JSX.Element {
  const agentsQuery = useAgents()
  const budgetsQuery = useBudgets()
  const deliveryQuery = useDeliveryQueue()

  // Per-agent SLO breach map driven by AgentSloProbe children.
  const [sloMap, setSloMap] = useState<Record<string, SloBreach | null>>({})
  const handleSloResult = useCallback(
    (agent: string, breach: SloBreach | null) => {
      setSloMap((curr) => {
        const prev = curr[agent]
        // Cheap equality — skip re-render when nothing changed.
        if (
          prev === breach ||
          (prev !== null &&
            prev !== undefined &&
            breach !== null &&
            prev.observedMs === breach.observedMs &&
            prev.thresholdMs === breach.thresholdMs)
        ) {
          return curr
        }
        return { ...curr, [agent]: breach }
      })
    },
    [],
  )

  const agentsPayload = agentsQuery.data as
    | { agents?: ReadonlyArray<{ name: string }> }
    | undefined
  const agentNames = useMemo(
    () => (agentsPayload?.agents ?? []).map((a) => a.name).filter((n) => n.length > 0),
    [agentsPayload],
  )

  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(() =>
    readDismissed(),
  )
  // Stable `firstSeen` map keyed by notification id.
  const [firstSeenMap, setFirstSeenMap] = useState<ReadonlyMap<string, number>>(
    () => new Map(),
  )

  // Aggregate raw signals into notification objects.
  const rawNotifications = useMemo<readonly Omit<Notification, 'firstSeen'>[]>(() => {
    const out: Omit<Notification, 'firstSeen'>[] = []

    // 1) Budget exceeded — useBudgets().rows where pct >= 0.9.
    const budgetData = budgetsQuery.data as
      | { readonly rows?: readonly { readonly agent: string; readonly model: string; readonly period: string; readonly pct: number; readonly status: string }[] }
      | undefined
    if (budgetData?.rows) {
      for (const row of budgetData.rows) {
        if (row.pct < 0.9) continue
        out.push({
          id: `budget:${row.agent}:${row.model}:${row.period}`,
          level: row.status === 'exceeded' ? 'danger' : 'warn',
          title: `${row.agent} budget ${Math.round(row.pct * 100)}% (${row.period}, ${row.model})`,
          detail:
            row.status === 'exceeded'
              ? 'Limit reached — escalation calls are blocked until the next period.'
              : 'Approaching limit; review usage or raise the budget if needed.',
          source: 'budget',
        })
      }
    }

    // 2) Discord delivery failures — useDeliveryQueue().stats.failed > 0.
    const deliveryData = deliveryQuery.data as
      | { readonly stats?: { readonly failed?: number; readonly delivered?: number } }
      | undefined
    if (
      deliveryData?.stats &&
      typeof deliveryData.stats.failed === 'number' &&
      deliveryData.stats.failed > 0
    ) {
      out.push({
        id: `delivery:failed`,
        level: 'warn',
        title: `Discord delivery: ${deliveryData.stats.failed} failed`,
        detail:
          'Fleet-wide outbound queue has unresolved failures. Inspect via the F13 IPC inbox panel or operator CLI.',
        source: 'delivery',
      })
    }

    // 3) SLO breaches — per-agent fan-out via AgentSloProbe children.
    //    Cold-start agents (< 5 samples) and absent-threshold agents
    //    don't fire. Severity bumps to danger when observed > 2× threshold
    //    (matches SloBreachBanner's color magnitude split).
    for (const [agent, breach] of Object.entries(sloMap)) {
      if (!breach) continue
      const overage = breach.observedMs / breach.thresholdMs
      const level: NotificationLevel = overage >= 2 ? 'danger' : 'warn'
      out.push({
        id: `slo:${agent}`,
        level,
        title: `${agent} SLO breach: first_token p50 ${Math.round(breach.observedMs)}ms`,
        detail: `Observed ${Math.round(breach.observedMs)}ms vs threshold ${Math.round(breach.thresholdMs)}ms (${(overage).toFixed(1)}× over). Drill into the F11 drawer for the per-segment breakdown.`,
        source: 'slo',
      })
    }

    return out
  }, [budgetsQuery.data, deliveryQuery.data, sloMap])

  // Update firstSeenMap: new ids get `now`, existing keep their original
  // timestamp. Stale ids (signal cleared) DON'T get pruned — keeping
  // them lets a re-appearing signal re-use the older firstSeen, so the
  // 24h timer remains meaningful for flapping breaches.
  useEffect(() => {
    const now = Date.now()
    setFirstSeenMap((prev) => {
      const next = new Map(prev)
      for (const n of rawNotifications) {
        if (!next.has(n.id)) next.set(n.id, now)
      }
      return next
    })
  }, [rawNotifications])

  // Compose final notification list — apply firstSeen + auto-dismiss
  // window. Sort by level then firstSeen DESC (newest first).
  const notifications = useMemo<readonly Notification[]>(() => {
    const now = Date.now()
    return rawNotifications
      .map((n) => ({
        ...n,
        firstSeen: firstSeenMap.get(n.id) ?? now,
      }))
      .filter((n) => now - n.firstSeen < AUTO_DISMISS_MS)
      .sort((a, b) => {
        const order = { danger: 0, warn: 1, info: 2 }
        if (order[a.level] !== order[b.level]) {
          return order[a.level] - order[b.level]
        }
        return b.firstSeen - a.firstSeen
      })
  }, [rawNotifications, firstSeenMap])

  const undismissed = notifications.filter((n) => !dismissed.has(n.id))

  const dismiss = (id: string): void => {
    setDismissed((prev) => {
      const next = new Set(prev)
      next.add(id)
      writeDismissed(next)
      return next
    })
  }

  const restoreAll = (): void => {
    setDismissed(() => {
      const empty = new Set<string>()
      writeDismissed(empty)
      return empty
    })
  }

  const badgeCount = undismissed.length
  // Pick the highest level for the badge color.
  const badgeLevel: NotificationLevel = undismissed.some((n) => n.level === 'danger')
    ? 'danger'
    : undismissed.some((n) => n.level === 'warn')
      ? 'warn'
      : 'info'

  return (
    <>
      {/* Hidden per-agent SLO probes — each renders null but drives
          useAgentCache + useAgentLatency for its agent and reports the
          breach (or null) up to the parent via handleSloResult. Mounted
          OUTSIDE the Sheet so they keep polling while the slide-over is
          closed (otherwise the badge would only update on open). */}
      {agentNames.map((agent) => (
        <AgentSloProbe key={agent} agent={agent} onResult={handleSloResult} />
      ))}
    <Sheet>
      <SheetTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="relative gap-1.5"
          aria-label={`Notifications (${badgeCount})`}
          data-testid="notification-bell"
        >
          <BellIcon />
          {badgeCount > 0 && (
            <span
              className={`absolute -top-1 -right-1 rounded-full text-[10px] font-bold min-w-[18px] h-[18px] flex items-center justify-center px-1 ${
                badgeLevel === 'danger'
                  ? 'bg-destructive text-destructive-foreground'
                  : badgeLevel === 'warn'
                    ? 'bg-amber-500 text-black'
                    : 'bg-primary text-primary-foreground'
              }`}
              data-testid="notification-badge"
            >
              {badgeCount > 99 ? '99+' : badgeCount}
            </span>
          )}
        </Button>
      </SheetTrigger>
      <SheetContent side="right" className="w-full sm:max-w-md overflow-y-auto">
        <SheetHeader>
          <SheetTitle>Notifications</SheetTitle>
          <p className="text-xs text-fg-3">
            Auto-dismissed after 24h. Operator-dismissed entries return when
            the underlying signal clears and re-appears.
          </p>
        </SheetHeader>

        <div className="mt-4 space-y-2">
          {notifications.length === 0 && (
            <div className="text-sm text-fg-3 py-8 text-center">
              All systems nominal — nothing to report.
            </div>
          )}
          {notifications.map((n) => {
            const isDismissed = dismissed.has(n.id)
            return (
              <div
                key={n.id}
                className={`rounded-md border p-3 transition-opacity ${
                  isDismissed ? 'opacity-50' : 'opacity-100'
                }`}
                data-testid="notification-card"
                data-level={n.level}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 text-sm font-medium">
                      <Badge
                        variant={
                          n.level === 'danger'
                            ? 'destructive'
                            : n.level === 'warn'
                              ? 'secondary'
                              : 'default'
                        }
                      >
                        {n.level}
                      </Badge>
                      <span className="truncate">{n.title}</span>
                    </div>
                    <p className="mt-1 text-xs text-fg-3">{n.detail}</p>
                    <p className="mt-1 text-[10px] text-fg-3 font-mono">
                      {new Date(n.firstSeen).toLocaleString()}
                    </p>
                  </div>
                  {!isDismissed && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-xs h-7"
                      onClick={() => dismiss(n.id)}
                    >
                      Dismiss
                    </Button>
                  )}
                </div>
              </div>
            )
          })}
          {dismissed.size > 0 && (
            <div className="pt-2 text-right">
              <Button variant="ghost" size="sm" onClick={restoreAll}>
                Restore dismissed
              </Button>
            </div>
          )}
        </div>
      </SheetContent>
    </Sheet>
    </>
  )
}
