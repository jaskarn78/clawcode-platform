/**
 * Phase 116-06 T07 — cutover instrumentation.
 *
 * Two surfaces:
 *
 *   1. `useDashboardPageViewEmit(view)` — hook called once per view
 *      change in App.tsx. POSTs to `/api/dashboard-telemetry` with
 *      `{ event: "page-view", path }`. Fire-and-forget; errors are
 *      swallowed (telemetry must NEVER break the UI).
 *
 *   2. `<TelemetryBadge />` — small unobtrusive header badge that
 *      reads `/api/dashboard-telemetry/summary` and shows the 24h
 *      page-view + error counts. Refreshes every 30s. Hidden when
 *      both counters are zero so the header stays clean on fresh
 *      installs.
 *
 * Used by the operator to gauge dashboard-v2 traffic during the soak
 * period (post-deploy, pre-cutover). When the operator flips
 * `defaults.dashboardCutoverRedirect` to `true`, the badge counts
 * indicate the canary surface is being exercised before the legacy
 * dashboard is decommissioned.
 */
import { useEffect, useRef } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Badge } from '@/components/ui/badge'

type TelemetrySummary = {
  readonly pageViews24h: number
  readonly errors24h: number
  readonly since: string
}

/**
 * One-shot emit on view change. Uses a ref to dedupe within the same
 * render cycle — a no-op when the path hasn't actually changed (e.g.
 * popstate fires twice during back-button navigation on some browsers).
 */
export function useDashboardPageViewEmit(view: string): void {
  const lastEmittedRef = useRef<string | null>(null)
  useEffect(() => {
    const path = window.location.pathname
    const fingerprint = `${view}:${path}`
    if (lastEmittedRef.current === fingerprint) return
    lastEmittedRef.current = fingerprint
    void fetch('/api/dashboard-telemetry', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ event: 'page-view', view, path }),
    }).catch(() => {
      /* fire-and-forget — telemetry never breaks the UI */
    })
  }, [view])
}

/**
 * Fire a `dashboard_v2_error` telemetry event. Called by the
 * DashboardErrorBoundary on every error boundary catch.
 */
export function emitDashboardError(error: Error, info?: { componentStack?: string | null }): void {
  void fetch('/api/dashboard-telemetry', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      event: 'error',
      message: error.message,
      stack: error.stack ?? null,
      componentStack: info?.componentStack ?? null,
      path: window.location.pathname,
    }),
  }).catch(() => {
    /* fire-and-forget */
  })
}

export function TelemetryBadge(): JSX.Element | null {
  const { data } = useQuery<TelemetrySummary>({
    queryKey: ['dashboard-telemetry-summary'],
    queryFn: async () => {
      const res = await fetch('/api/dashboard-telemetry/summary')
      if (!res.ok) throw new Error(`telemetry-summary failed: ${res.status}`)
      return (await res.json()) as TelemetrySummary
    },
    refetchInterval: 30_000,
    staleTime: 25_000,
  })
  if (!data) return null
  if (data.pageViews24h === 0 && data.errors24h === 0) return null
  return (
    <Badge
      variant={data.errors24h > 0 ? 'destructive' : 'secondary'}
      className="font-mono text-[10px] hidden md:inline-flex"
      title={`Since ${new Date(data.since).toLocaleString()}`}
      data-testid="telemetry-badge"
    >
      v2: {data.pageViews24h} views · {data.errors24h} err (24h)
    </Badge>
  )
}
