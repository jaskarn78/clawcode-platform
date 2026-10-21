/**
 * dashboard-rework — slim topbar.
 *
 * Left: mobile menu trigger (drawer toggle, <lg only) + breadcrumb/title for
 * the active view. Right: fleet heartbeat pill, Cmd+K trigger, notifications,
 * theme toggle, settings. Reuses the existing NotificationFeed / ThemeToggle /
 * TelemetryBadge — the topbar only positions them.
 */
import type { JSX } from 'react'
import { useAgents } from '@/hooks/useApi'
import { NotificationFeed } from '@/components/NotificationFeed'
import { ThemeToggle } from '@/components/ThemeToggle'
import { TelemetryBadge } from '@/components/TelemetryBadge'
import { NavIcon } from './nav-icons'
import { VIEW_TITLE, VIEW_SECTION, type ShellView } from './nav-model'

// Fire a synthetic Cmd+K so the existing window-level CommandPalette opens
// without reaching into its internal state (same trick as the old header).
function triggerCommandPalette(): void {
  window.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'k', code: 'KeyK', metaKey: true, bubbles: true }),
  )
}

export type TopbarProps = {
  readonly active: ShellView
  readonly onOpenMobileNav: () => void
  readonly onNavigate: (view: ShellView) => void
}

export function Topbar(props: TopbarProps): JSX.Element {
  const { active, onOpenMobileNav, onNavigate } = props
  const agentsQ = useAgents()
  const agents = agentsQ.data?.agents ?? []
  const liveCount = agents.reduce((n, a) => (a.status === 'running' ? n + 1 : n), 0)
  const crumb = VIEW_SECTION[active]

  return (
    <header className="topbar" data-testid="app-topbar">
      <button
        type="button"
        className="tb-icon-btn tb-menu"
        aria-label="Open navigation"
        onClick={onOpenMobileNav}
        data-testid="topbar-menu"
      >
        <NavIcon name="menu" size={18} />
      </button>

      <div className="topbar-title">
        {crumb ? <span className="topbar-crumb">{crumb}</span> : null}
        <span className="topbar-h" data-testid="topbar-heading">
          {VIEW_TITLE[active]}
        </span>
      </div>

      <div className="topbar-right">
        <div
          className="tb-heartbeat"
          title="Daemon connected — fleet heartbeat"
          data-testid="topbar-heartbeat"
        >
          <span className="pulse-dot" />
          <span>
            fleet · {liveCount} live
          </span>
        </div>
        <button
          type="button"
          className="tb-icon-btn"
          aria-label="Search (Cmd+K)"
          title="⌘K"
          onClick={triggerCommandPalette}
          data-testid="topbar-cmdk"
        >
          <NavIcon name="search" size={18} />
        </button>
        <TelemetryBadge />
        <NotificationFeed />
        <ThemeToggle />
        <button
          type="button"
          className="tb-icon-btn"
          aria-label="Settings"
          title="Settings"
          onClick={() => onNavigate('settings')}
          data-testid="topbar-settings"
        >
          <NavIcon name="settings" size={18} />
        </button>
      </div>
    </header>
  )
}

export default Topbar
