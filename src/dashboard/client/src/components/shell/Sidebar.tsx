/**
 * dashboard-rework — persistent left sidebar (Refined Command Center).
 *
 * Renders the brand cluster, the nested nav tree (NAV_SECTIONS), and the
 * footer (Settings). The "Insights" group expands/collapses; it auto-opens
 * when one of its children is the active view. Collapse state (icon-rail) is
 * owned by AppShell and passed in.
 */
import { useEffect, useState, type JSX } from 'react'
import {
  NAV_SECTIONS,
  NAV_FOOTER,
  type NavGroup,
  type NavLeaf,
  type ShellView,
} from './nav-model'
import { NavIcon } from './nav-icons'

export type SidebarProps = {
  readonly active: ShellView
  readonly collapsed: boolean
  readonly onNavigate: (view: ShellView) => void
  readonly onToggleCollapse: () => void
}

function NavItem(props: {
  readonly leaf: NavLeaf
  readonly active: boolean
  readonly onNavigate: (v: ShellView) => void
}): JSX.Element {
  const { leaf, active, onNavigate } = props
  return (
    <button
      type="button"
      className="sb-item"
      data-active={active ? 'true' : 'false'}
      data-testid={`nav-${leaf.view}`}
      title={leaf.label}
      aria-current={active ? 'page' : undefined}
      onClick={() => onNavigate(leaf.view)}
    >
      <span className="ico">
        <NavIcon name={leaf.icon} size={18} />
      </span>
      <span className="lbl">{leaf.label}</span>
    </button>
  )
}

function NavGroupNode(props: {
  readonly group: NavGroup
  readonly active: ShellView
  readonly onNavigate: (v: ShellView) => void
}): JSX.Element {
  const { group, active, onNavigate } = props
  const containsActive = group.children.some((c) => c.view === active)
  const [open, setOpen] = useState<boolean>(containsActive)
  // Auto-open when navigation lands on one of the group's children (e.g. a
  // deep-link to /insights/usage), but let the operator manually collapse it
  // afterward and have that stick — `isOpen` follows `open` alone, so the
  // toggle, chevron, and aria-expanded all stay truthful.
  useEffect(() => {
    if (containsActive) setOpen(true)
  }, [containsActive])
  const isOpen = open

  return (
    <div className="sb-group" data-open={isOpen ? 'true' : 'false'}>
      <button
        type="button"
        className="sb-item sb-group-toggle"
        data-testid={`nav-group-${group.id}`}
        aria-expanded={isOpen}
        title={group.label}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="ico">
          <NavIcon name={group.icon} size={18} />
        </span>
        <span className="lbl">{group.label}</span>
        <span className="sb-chevron">
          <NavIcon name="chevron" size={14} />
        </span>
      </button>
      <div className="sb-children">
        <div className="sb-children-inner">
          {group.children.map((leaf) => (
            <NavItem
              key={leaf.view}
              leaf={leaf}
              active={active === leaf.view}
              onNavigate={onNavigate}
            />
          ))}
        </div>
      </div>
    </div>
  )
}

export function Sidebar(props: SidebarProps): JSX.Element {
  const { active, collapsed, onNavigate, onToggleCollapse } = props
  return (
    <aside className="sb" data-testid="app-sidebar" aria-label="Primary navigation">
      <div className="sb-brand">
        <img className="mark" src="/assets/clawcode-mark.svg" alt="" width={28} height={28} />
        <span className="wmark">clawcode</span>
        <button
          type="button"
          className="sb-collapse"
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          title={collapsed ? 'Expand' : 'Collapse'}
          onClick={onToggleCollapse}
          data-testid="sidebar-collapse"
        >
          <NavIcon name="collapse" size={16} />
        </button>
      </div>

      <nav className="sb-nav" aria-label="Sections">
        {NAV_SECTIONS.map((node) =>
          node.kind === 'group' ? (
            <NavGroupNode
              key={node.id}
              group={node}
              active={active}
              onNavigate={onNavigate}
            />
          ) : (
            <NavItem
              key={node.view}
              leaf={node}
              active={active === node.view}
              onNavigate={onNavigate}
            />
          ),
        )}
      </nav>

      <div className="sb-footer">
        {NAV_FOOTER.map((leaf) => (
          <NavItem
            key={leaf.view}
            leaf={leaf}
            active={active === leaf.view}
            onNavigate={onNavigate}
          />
        ))}
      </div>
    </aside>
  )
}

export default Sidebar
