/**
 * dashboard-rework — operator App shell + router (formerly App.tsx).
 *
 * Lazy-loaded from App.tsx as a separate chunk.
 *
 * Replaces the flat 12-tab MissionHeader strip with the Refined Command Center
 * AppShell (persistent left sidebar + nested nav + slim topbar). Path↔view sync
 * stays pushState-based (no react-router), now keyed off the new IA in
 * components/shell/nav-model.ts at the root URL (base '/', not /dashboard/v2/).
 */
import { lazy, Suspense, useEffect, useState, type JSX } from 'react'
import { useSseBridge } from './hooks/useSse'
import { AppShell } from './components/shell/AppShell'
import {
  pathToView,
  agentParam,
  agentConfigPath,
  VIEW_TO_PATH,
  type ShellView,
} from './components/shell/nav-model'
import { MissionControlLayout } from './layouts/MissionControlLayout'
import { CommandPalette } from './components/CommandPalette'
import { ConversationsView } from './components/ConversationsView'
import { TaskKanban } from './components/TaskKanban'
import { AgentDetailDrawer } from './components/AgentDetailDrawer'
import { SettingsView } from './components/SettingsView'
import { AgentsView } from './components/AgentsView'
import { AgentConfigPanel } from './components/AgentConfigPanel'
import { AdminAuthBanner } from './components/AdminAuthBanner'
import { ActionToastHost } from './components/ActionToast'
import { FleetComparisonTable } from './components/FleetComparisonTable'
import { useDashboardPageViewEmit } from './components/TelemetryBadge'
import { DashboardErrorBoundary } from './components/DashboardErrorBoundary'
// MissionControlLayout (the Overview view) still uses the .tile/.hero/.rail
// classes from this route-scoped stylesheet — keep importing it at the App
// level so those styles reach the layout.
import './layouts/mission-control.css'

const UsageDashboard = lazy(() =>
  import('./components/CostDashboard').then((m) => ({ default: m.UsageDashboard })),
)
const AuditLogViewer = lazy(() =>
  import('./components/AuditLogViewer').then((m) => ({ default: m.AuditLogViewer })),
)
const GraphRoute = lazy(() =>
  import('./routes/graph').then((m) => ({ default: m.GraphRoute })),
)
const ApiKeysView = lazy(() =>
  import('./components/OpenAiView').then((m) => ({ default: m.OpenAiView })),
)
const MemoryView = lazy(() =>
  import('./components/MemoryView').then((m) => ({ default: m.MemoryView })),
)
const BenchmarksView = lazy(() =>
  import('./components/BenchmarksView').then((m) => ({ default: m.BenchmarksView })),
)
const MarketplaceView = lazy(() =>
  import('./components/MarketplaceView').then((m) => ({ default: m.MarketplaceView })),
)

function Loading(props: { readonly label: string }): JSX.Element {
  return (
    <div className="mx-auto max-w-7xl p-6 text-sm text-fg-3">{props.label}</div>
  )
}

function OperatorApp() {
  // Singleton SSE bridge — `/api/events` → TanStack Query cache fan-out.
  useSseBridge()

  // Path is the source of truth; view + selected agent are derived (P2: the
  // config route `/agents/<name>` carries the agent in the path itself).
  const [path, setPath] = useState<string>(() => window.location.pathname)
  const [drawerAgent, setDrawerAgent] = useState<string | null>(null)

  const view = pathToView(path)
  const selectedAgent = agentParam(path)

  useEffect(() => {
    const onPop = (): void => setPath(window.location.pathname)
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])

  useDashboardPageViewEmit(view)

  const navigate = (next: ShellView): void => {
    const targetPath = VIEW_TO_PATH[next]
    if (window.location.pathname !== targetPath) {
      window.history.pushState({}, '', targetPath)
    }
    setPath(targetPath)
  }

  // P2: deep-link to one agent's full-page config (`/agents/<name>`).
  const navigateToAgent = (name: string): void => {
    const targetPath = agentConfigPath(name)
    if (window.location.pathname !== targetPath) {
      window.history.pushState({}, '', targetPath)
    }
    setPath(targetPath)
  }

  return (
    <DashboardErrorBoundary>
      <AppShell active={view} onNavigate={navigate}>
        {view === 'overview' && (
          <MissionControlLayout onSelectAgent={(name) => setDrawerAgent(name)} />
        )}
        {view === 'agents' &&
          (selectedAgent ? (
            <AgentConfigPanel
              key={selectedAgent}
              agentName={selectedAgent}
              onBack={() => navigate('agents')}
            />
          ) : (
            <AgentsView
              onConfigure={(name) => navigateToAgent(name)}
              onOpen={(name) => setDrawerAgent(name)}
            />
          ))}
        {view === 'conversations' && <ConversationsView />}
        {view === 'tasks' && <TaskKanban />}
        {view === 'marketplace' && (
          <Suspense fallback={<Loading label="Loading marketplace…" />}>
            <MarketplaceView />
          </Suspense>
        )}
        {view === 'fleet' && <FleetComparisonTable />}
        {view === 'usage' && (
          <Suspense fallback={<Loading label="Loading usage dashboard…" />}>
            <UsageDashboard />
          </Suspense>
        )}
        {view === 'benchmarks' && (
          <Suspense fallback={<Loading label="Loading benchmarks…" />}>
            <BenchmarksView />
          </Suspense>
        )}
        {view === 'memory' && (
          <Suspense fallback={<Loading label="Loading memory + dreams…" />}>
            <MemoryView />
          </Suspense>
        )}
        {view === 'audit' && (
          <Suspense fallback={<Loading label="Loading audit log…" />}>
            <AuditLogViewer />
          </Suspense>
        )}
        {view === 'graph' && (
          <Suspense fallback={<Loading label="Loading knowledge graph…" />}>
            <GraphRoute />
          </Suspense>
        )}
        {view === 'settings' && <SettingsView />}
        {view === 'api-keys' && (
          <Suspense fallback={<Loading label="Loading API keys…" />}>
            <ApiKeysView />
          </Suspense>
        )}
      </AppShell>

      {/* P2: config is now a ROUTE (/agents/<name>), not a modal. The drawer's
          "edit config" + the palette's "edit config" both navigate there. */}
      <AgentDetailDrawer
        agentName={drawerAgent}
        open={drawerAgent !== null}
        onOpenChange={(open) => {
          if (!open) setDrawerAgent(null)
        }}
        onEditConfig={(name) => {
          setDrawerAgent(null)
          navigateToAgent(name)
        }}
      />

      {/* Cmd+K palette mounted at root. */}
      <CommandPalette
        onSelectAgent={(name) => setDrawerAgent(name)}
        onOpenConfig={(name) => navigateToAgent(name)}
        onNavigate={(v) => {
          // Guard the unchecked string→ShellView cast: ignore unknown views so
          // a future palette action can't blank the main pane.
          if (v in VIEW_TO_PATH) navigate(v as ShellView)
        }}
      />

      <ActionToastHost />
      <AdminAuthBanner />
    </DashboardErrorBoundary>
  )
}

export default OperatorApp
