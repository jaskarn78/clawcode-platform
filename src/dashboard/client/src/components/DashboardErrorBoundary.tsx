/**
 * Phase 116-06 T07 — React error boundary that emits
 * `dashboard_v2_error` telemetry on catch.
 *
 * Wraps the entire SPA shell so an uncaught render exception in any
 * route component sends a telemetry beacon AND surfaces a recovery
 * UI (a small banner) instead of dropping to a blank screen.
 *
 * Recovery UX:
 *   - The boundary stays in the error state until the operator clicks
 *     "Reload" (full-page reload, simplest recovery for a SPA).
 *   - The error message + stack are surfaced for operator inspection
 *     (this is an internal tool — exposing the stack helps the
 *     operator file a useful bug report).
 */
import { Component, type ReactNode } from 'react'
import { emitDashboardError } from './TelemetryBadge'

type Props = { readonly children: ReactNode }
type State = { readonly hasError: boolean; readonly error: Error | null }

export class DashboardErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props)
    this.state = { hasError: false, error: null }
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, info: { componentStack?: string | null }): void {
    emitDashboardError(error, info)
  }

  render(): ReactNode {
    if (!this.state.hasError) return this.props.children
    return (
      <div className="mx-auto max-w-2xl p-6">
        <div className="rounded-md border border-destructive bg-destructive/10 p-4">
          <h2 className="font-display text-lg font-bold text-destructive">
            Dashboard error
          </h2>
          <p className="mt-2 text-sm">
            An uncaught error reached the SPA shell. A telemetry event was
            sent so the operator can review the trace in the audit log.
          </p>
          {this.state.error && (
            <pre className="mt-3 max-h-64 overflow-auto rounded bg-bg-muted p-2 text-xs">
              {this.state.error.stack ?? this.state.error.message}
            </pre>
          )}
          <button
            type="button"
            className="mt-3 rounded bg-primary px-3 py-1.5 text-sm text-primary-foreground"
            onClick={() => window.location.reload()}
          >
            Reload
          </button>
        </div>
      </div>
    )
  }
}
