/**
 * dashboard-rework — AppShell layout wrapper.
 *
 * Grid: [sidebar | content-col]. content-col = [topbar | main scroll]. Owns the
 * sidebar collapse state (persisted) and the mobile drawer open state. The
 * active view content is passed as children.
 */
import { useEffect, useState, type JSX, type ReactNode } from 'react'
import { Sidebar } from './Sidebar'
import { Topbar } from './Topbar'
import type { ShellView } from './nav-model'
import './shell.css'

const COLLAPSE_KEY = 'clawcode:sidebar-collapsed'

export type AppShellProps = {
  readonly active: ShellView
  readonly onNavigate: (view: ShellView) => void
  readonly children: ReactNode
}

export function AppShell(props: AppShellProps): JSX.Element {
  const { active, onNavigate, children } = props
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    try {
      return localStorage.getItem(COLLAPSE_KEY) === '1'
    } catch {
      return false
    }
  })
  const [mobileOpen, setMobileOpen] = useState(false)

  useEffect(() => {
    try {
      localStorage.setItem(COLLAPSE_KEY, collapsed ? '1' : '0')
    } catch {
      /* private mode — ignore */
    }
  }, [collapsed])

  // Close the mobile drawer whenever the active view changes (navigation).
  useEffect(() => {
    setMobileOpen(false)
  }, [active])

  // Mobile drawer a11y: Escape closes it, focus moves into the drawer on open,
  // and returns to the menu trigger on close. (Desktop never opens the drawer.)
  useEffect(() => {
    if (!mobileOpen) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setMobileOpen(false)
    }
    window.addEventListener('keydown', onKey)
    document
      .querySelector<HTMLElement>('.sb-nav .sb-item')
      ?.focus()
    return () => {
      window.removeEventListener('keydown', onKey)
      document
        .querySelector<HTMLElement>('[data-testid="topbar-menu"]')
        ?.focus()
    }
  }, [mobileOpen])

  // Navigation from inside the drawer should also close it.
  const navigate = (view: ShellView): void => {
    setMobileOpen(false)
    onNavigate(view)
  }

  return (
    <div
      className="app-shell"
      data-collapsed={collapsed ? 'true' : 'false'}
      data-mobile-open={mobileOpen ? 'true' : 'false'}
    >
      <div
        className="sb-scrim"
        aria-hidden="true"
        onClick={() => setMobileOpen(false)}
      />
      <Sidebar
        active={active}
        collapsed={collapsed}
        onNavigate={navigate}
        onToggleCollapse={() => setCollapsed((v) => !v)}
      />
      <div className="content-col">
        <Topbar
          active={active}
          onOpenMobileNav={() => setMobileOpen(true)}
          onNavigate={navigate}
        />
        <main className="main-scroll" data-testid="main-content">
          {children}
        </main>
      </div>
    </div>
  )
}

export default AppShell
