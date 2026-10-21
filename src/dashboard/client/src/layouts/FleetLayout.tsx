/**
 * Phase 116 Plan 01 T06 — Basic / Advanced layout split.
 *
 * Reads `useViewMode()` (116-00 T09 hook). Mobile default (<1024px) → Basic;
 * desktop default → Advanced. Operator can toggle anytime via the header
 * button (the toggle persists via localStorage in the underlying hook).
 *
 * Basic mode (answer "which agents need attention?"):
 *   - SloBreachBanner (always visible if breaches exist)
 *   - AgentList — stacked rows, no tile grid
 *   - 3 quick-action buttons (Restart Discord bot / Run health check / Settings)
 *   - Settings cog inline in the header
 *
 * Advanced mode (full Tier 1 surface):
 *   - SloBreachBanner
 *   - AgentTileGrid (responsive 1/2/3/4-col)
 *   - MCP server overview strip at the bottom (fleet-wide rollup from
 *     /api/fleet-stats — mcpFleet patterns + count + rssMB by runtime)
 *
 * Quick actions are NO-OP placeholders today — the IPC handlers they'd call
 * (restart-discord-bot, run-health-check, open-settings) are 116-02/116-03
 * scope. Tooltips spell out the deferral so operators aren't surprised.
 */
import { useCallback, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { useViewMode } from '@/hooks/useViewMode'
import { useAgents, useFleetStats } from '@/hooks/useApi'
import { useSseStatus } from '@/hooks/useSse'
import { SloBreachBanner } from '@/components/SloBreachBanner'
import { AgentTileGrid } from '@/components/AgentTileGrid'
import { AgentTile } from '@/components/AgentTile'
import { ToolLatencySplit } from '@/components/ToolLatencySplit'
import { MigrationTracker } from '@/components/MigrationTracker'
import { McpHealthPanel } from '@/components/McpHealthPanel'
import {
  runHealthCheckAction,
  restartDaemonAction,
} from '@/components/quickActions'

// Avoid importing DashboardView type from @/App — that creates a circular
// dependency (App imports FleetLayout). The string set is small; keep a
// local string-literal alias here. App's stricter DashboardView is a
// strict subset of these strings, so the narrowing at the call site
// (navigate(view as DashboardView)) is safe.
type NavigateView = string

// ---------------------------------------------------------------------------
// Header — connection dot, branding, view-mode toggle, settings cog.
// ---------------------------------------------------------------------------

function statusDotClass(status: string): string {
  switch (status) {
    case 'open':
      return 'bg-primary'
    case 'connecting':
      return 'bg-warn'
    case 'error':
    case 'closed':
      return 'bg-danger'
    default:
      return 'bg-fg-3'
  }
}

function Header(props: {
  readonly agentCount: number
  readonly sseStatus: string
  readonly onNavigate?: (view: NavigateView) => void
}): JSX.Element {
  const { mode, toggle } = useViewMode()
  return (
    <header className="border-b border-bg-s3 px-4 sm:px-6 py-3 sm:py-4 flex items-center justify-between gap-3">
      <div className="flex items-center gap-3 min-w-0">
        <span
          className={`inline-block w-2.5 h-2.5 rounded-full ${statusDotClass(props.sseStatus)} shrink-0`}
          aria-label={`SSE ${props.sseStatus}`}
          title={`SSE: ${props.sseStatus}`}
        />
        <h1 className="font-display text-lg sm:text-xl font-bold tracking-tight truncate">
          ClawCode <span className="text-primary">v2</span>
        </h1>
        <span className="font-mono text-xs text-fg-3 data hidden sm:inline">
          {props.agentCount} agent{props.agentCount === 1 ? '' : 's'}
        </span>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        <Button
          variant="outline"
          size="sm"
          onClick={toggle}
          aria-pressed={mode === 'advanced'}
          className="font-mono uppercase text-xs"
          data-testid="view-mode-toggle"
        >
          {mode}
        </Button>
        <TooltipProvider delayDuration={200}>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                aria-label="Settings"
                onClick={() => props.onNavigate?.('settings')}
                className="text-fg-2 hover:text-fg-1"
              >
                {/* Inline gear glyph — keeps the bundle from pulling lucide
                    in just for one icon. Phase 116-postdeploy 2026-05-12
                    wired this to the Settings route (was: no onClick). */}
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <circle cx="12" cy="12" r="3" />
                  <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h0a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h0a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v0a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
                </svg>
              </Button>
            </TooltipTrigger>
            <TooltipContent
              side="bottom"
              className="bg-bg-elevated text-fg-1 border border-bg-s3 font-sans text-xs"
            >
              Open dashboard settings (theme + about)
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </div>
    </header>
  )
}

// ---------------------------------------------------------------------------
// Basic mode — agent list row + 3 quick actions. Designed for 375px wide.
// ---------------------------------------------------------------------------

function BasicAgentRow(props: {
  readonly agent: { readonly name: string; readonly model?: string; readonly status?: string }
  readonly onSelect?: (agent: string) => void
}): JSX.Element {
  // Reuse AgentTile but in a single-column container. The card already has
  // mobile-friendly padding and the responsive sub-components handle small
  // widths. The grid wrapper above already enforces 1-col on Basic.
  return <AgentTile agent={props.agent} onSelect={props.onSelect} />
}

function QuickActions(props: {
  readonly onNavigate?: (view: NavigateView) => void
}): JSX.Element {
  // Phase 116-postdeploy 2026-05-12 — buttons are now wired to real IPC
  // calls (was: noop placeholders with "wires up in 116-02" tooltips).
  // Tooltips updated to describe what they actually do, not what they
  // would do.
  const [confirmRestart, setConfirmRestart] = useState(false)
  const [busy, setBusy] = useState(false)

  const onHealthCheck = useCallback(() => {
    void runHealthCheckAction({
      onNavigateToFleet: props.onNavigate
        ? () => props.onNavigate?.('fleet')
        : undefined,
    })
  }, [props])

  const onSettings = useCallback(() => {
    props.onNavigate?.('settings')
  }, [props])

  const onConfirmRestart = useCallback(async () => {
    setBusy(true)
    try {
      await restartDaemonAction()
    } finally {
      setBusy(false)
      setConfirmRestart(false)
    }
  }, [])

  return (
    <TooltipProvider delayDuration={200}>
      <section
        className="px-4 py-4 border-t border-bg-s3 grid grid-cols-1 sm:grid-cols-3 gap-2"
        data-testid="quick-actions"
      >
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="outline"
              onClick={() => setConfirmRestart(true)}
              className="border-bg-s3 text-fg-1 hover:border-primary/40 font-sans"
            >
              Restart daemon
            </Button>
          </TooltipTrigger>
          <TooltipContent
            side="top"
            className="bg-bg-elevated text-fg-1 border border-bg-s3 font-sans text-xs"
          >
            Sends SIGHUP; systemd rebuilds the process. Running agents are
            preserved via Phase 999.6 snapshot.
          </TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="outline"
              onClick={onHealthCheck}
              className="border-bg-s3 text-fg-1 hover:border-primary/40 font-sans"
            >
              Run health check
            </Button>
          </TooltipTrigger>
          <TooltipContent
            side="top"
            className="bg-bg-elevated text-fg-1 border border-bg-s3 font-sans text-xs"
          >
            Polls daemon heartbeat-status; toast summarises healthy / failing
            agents.
          </TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="outline"
              onClick={onSettings}
              className="border-bg-s3 text-fg-1 hover:border-primary/40 font-sans"
            >
              Settings
            </Button>
          </TooltipTrigger>
          <TooltipContent
            side="top"
            className="bg-bg-elevated text-fg-1 border border-bg-s3 font-sans text-xs"
          >
            Theme + about (dashboard-side). Daemon config still via{' '}
            <code>clawcode config</code>.
          </TooltipContent>
        </Tooltip>

        {/* Restart confirmation modal — operator opt-in. */}
        <Dialog
          open={confirmRestart}
          onOpenChange={(open) => {
            if (!busy) setConfirmRestart(open)
          }}
        >
          <DialogContent>
            <DialogHeader>
              <DialogTitle className="font-display">
                Restart daemon?
              </DialogTitle>
              <DialogDescription className="text-fg-3">
                This sends SIGHUP to the ClawCode daemon; systemd will
                rebuild the process (RestartForceExitStatus=129). The
                running agent fleet is preserved across the restart via
                the Phase 999.6 pre-deploy snapshot. The dashboard will
                briefly disconnect — refresh in ~3-5 seconds.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter className="gap-2">
              <Button
                variant="outline"
                onClick={() => setConfirmRestart(false)}
                disabled={busy}
              >
                Cancel
              </Button>
              <Button onClick={onConfirmRestart} disabled={busy}>
                {busy ? 'Restarting…' : 'Restart daemon'}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </section>
    </TooltipProvider>
  )
}

function BasicMode(props: {
  readonly onSelectAgent?: (agent: string) => void
  readonly onNavigate?: (view: NavigateView) => void
}): JSX.Element {
  const agentsQuery = useAgents()
  const payload = agentsQuery.data as
    | { agents?: ReadonlyArray<{ name: string; model?: string; status?: string }> }
    | undefined
  const agents = payload?.agents ?? []
  return (
    <>
      <main className="px-4 py-4 space-y-3" data-testid="basic-mode">
        {agentsQuery.isLoading && (
          <p className="text-fg-2 font-sans">Loading fleet…</p>
        )}
        {agentsQuery.isError && (
          <p className="text-danger font-sans">
            Failed to load fleet — daemon unreachable.
          </p>
        )}
        {!agentsQuery.isLoading &&
          !agentsQuery.isError &&
          agents.length === 0 && (
            <p className="text-fg-2 font-sans">No agents reported.</p>
          )}
        {agents.map((a) => (
          <BasicAgentRow
            key={a.name}
            agent={a}
            onSelect={props.onSelectAgent}
          />
        ))}
      </main>
      <QuickActions onNavigate={props.onNavigate} />
    </>
  )
}

// ---------------------------------------------------------------------------
// MCP overview strip — Advanced-mode footer reading /api/fleet-stats.
// ---------------------------------------------------------------------------

type FleetStatsPayload = {
  readonly mcpFleet?: ReadonlyArray<{
    readonly pattern: string
    readonly count: number
    readonly rssMB: number
    readonly runtime: string
  }>
  readonly claudeProcDrift?: number | null
  readonly cgroup?: {
    readonly memoryCurrentBytes?: number
    readonly memoryMaxBytes?: number
    readonly memoryPercent?: number | null
  } | null
}

function McpOverviewStrip(): JSX.Element | null {
  const fleetQ = useFleetStats()
  const fleet = fleetQ.data as FleetStatsPayload | undefined
  const mcp = fleet?.mcpFleet ?? []
  if (mcp.length === 0) return null

  const totalProcs = mcp.reduce((acc, m) => acc + m.count, 0)
  const totalRss = mcp.reduce((acc, m) => acc + m.rssMB, 0)

  return (
    <footer
      className="border-t border-bg-s3 px-4 sm:px-6 py-4"
      data-testid="mcp-overview-strip"
    >
      <div className="flex flex-wrap items-baseline gap-3 mb-2">
        <h3 className="font-display text-sm font-bold text-fg-1">
          MCP fleet
        </h3>
        <span className="font-mono text-xs text-fg-3 data">
          {totalProcs} procs · {totalRss.toFixed(1)} MB RSS
        </span>
      </div>
      <ul className="flex flex-wrap gap-2">
        {mcp.map((m) => (
          <li key={m.pattern}>
            <Badge
              variant="outline"
              className="font-mono text-[11px] border-bg-s3 text-fg-2"
              title={`runtime: ${m.runtime}`}
            >
              <span className="text-fg-1 mr-1">{m.pattern}</span>
              <span className="text-fg-3">
                {m.count}× · {m.rssMB.toFixed(0)} MB
              </span>
            </Badge>
          </li>
        ))}
      </ul>
    </footer>
  )
}

function AdvancedMode(props: {
  readonly onSelectAgent?: (agent: string) => void
}): JSX.Element {
  return (
    <>
      <main className="px-4 sm:px-6 py-6 space-y-6" data-testid="advanced-mode">
        <AgentTileGrid onSelectAgent={props.onSelectAgent} />
        {/* Phase 116-02 — F07 tool latency split. Surfaces the per-turn
            exec vs roundtrip gap across the fleet. Per-tool depth lives in
            the 116-04 drawer. */}
        <ToolLatencySplit />
        {/* Phase 116-02 — F09 migration tracker + F10 MCP health. Two-column
            grid on wide viewports so operators can scan both surfaces. */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <MigrationTracker />
          <McpHealthPanel />
        </div>
      </main>
      <McpOverviewStrip />
    </>
  )
}

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

export type FleetLayoutProps = {
  /**
   * Phase 116-03 — optional callback that opens the F26 config editor for
   * the named agent. Currently routed through the Cmd+K palette; future
   * plans may surface a per-tile "Edit config" button that consumes this
   * callback. Optional so older callers compile unchanged.
   */
  readonly onEditAgent?: (agent: string) => void
  /**
   * Phase 116-04 — opens the F11 agent detail drawer for the named agent.
   * Threaded through to AgentTileGrid/AgentTile + SloBreachBanner so all
   * three entry points unify on the single App-level drawer state setter.
   */
  readonly onSelectAgent?: (agent: string) => void
  /**
   * Phase 116-postdeploy 2026-05-12 — operator-driven view navigation
   * (Basic-mode "Settings" quick action; Cmd+K "Run health check" can
   * cascade into a fleet-view jump). Threaded down to QuickActions so
   * the buttons can call back into App's pushState-aware navigate().
   */
  readonly onNavigate?: (view: NavigateView) => void
}

export function FleetLayout(props: FleetLayoutProps = {}): JSX.Element {
  const { mode } = useViewMode()
  const sseStatus = useSseStatus()
  const agentsQuery = useAgents()
  const payload = agentsQuery.data as
    | { agents?: ReadonlyArray<{ name: string }> }
    | undefined
  const agentCount = payload?.agents?.length ?? 0

  return (
    <div className="min-h-screen bg-bg-base text-fg-1 font-sans">
      <Header
        agentCount={agentCount}
        sseStatus={sseStatus}
        onNavigate={props.onNavigate}
      />
      <SloBreachBanner
        openAgentDrawer={(name) => {
          // Phase 116-04 — routes to the App-level drawer state setter.
          // No more console-placeholder; falls back to a console.info ONLY
          // when the caller forgot to thread onSelectAgent through.
          if (props.onSelectAgent) {
            props.onSelectAgent(name)
          } else {
            // eslint-disable-next-line no-console
            console.info(
              `[clawcode-dashboard] openAgentDrawer fallback — agent=${name}; pass onSelectAgent to FleetLayout to wire the drawer.`,
            )
          }
        }}
      />
      {mode === 'basic' ? (
        <BasicMode
          onSelectAgent={props.onSelectAgent}
          onNavigate={props.onNavigate}
        />
      ) : (
        <AdvancedMode onSelectAgent={props.onSelectAgent} />
      )}
    </div>
  )
}

export default FleetLayout
