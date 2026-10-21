/**
 * dashboard-rework — single source of truth for the new information
 * architecture: the sidebar nav tree, the view↔path maps, and per-view
 * titles for the topbar. App.tsx and Sidebar.tsx both consume this.
 *
 * Operator's locked IA (2026-06-15): the never-used-standalone tabs the
 * operator named (Fleet/Usage/Benchmarks/Memory/Audit) are nested under one
 * "Insights" umbrella; OpenAI moves under Settings → API keys. Graph stays a distinct top-level item.
 */
import type { NavIconName } from './nav-icons'

export type ShellView =
  | 'overview'
  | 'agents'
  | 'conversations'
  | 'tasks'
  | 'marketplace'
  | 'fleet'
  | 'usage'
  | 'benchmarks'
  | 'memory'
  | 'audit'
  | 'graph'
  | 'settings'
  | 'api-keys'

export type NavLeaf = {
  readonly kind: 'leaf'
  readonly view: ShellView
  readonly label: string
  readonly icon: NavIconName
}

export type NavGroup = {
  readonly kind: 'group'
  readonly id: string
  readonly label: string
  readonly icon: NavIconName
  readonly children: ReadonlyArray<NavLeaf>
}

export type NavNode = NavLeaf | NavGroup

// Primary sidebar nav (top section). Settings + API keys live in the footer.
export const NAV_SECTIONS: ReadonlyArray<NavNode> = [
  { kind: 'leaf', view: 'overview', label: 'Overview', icon: 'overview' },
  { kind: 'leaf', view: 'agents', label: 'Agents', icon: 'agents' },
  { kind: 'leaf', view: 'conversations', label: 'Conversations', icon: 'conversations' },
  { kind: 'leaf', view: 'tasks', label: 'Tasks', icon: 'tasks' },
  { kind: 'leaf', view: 'marketplace', label: 'Marketplace', icon: 'marketplace' },
  {
    kind: 'group',
    id: 'insights',
    label: 'Insights',
    icon: 'insights',
    children: [
      { kind: 'leaf', view: 'fleet', label: 'Fleet', icon: 'fleet' },
      { kind: 'leaf', view: 'usage', label: 'Usage', icon: 'usage' },
      { kind: 'leaf', view: 'benchmarks', label: 'Benchmarks', icon: 'benchmarks' },
      { kind: 'leaf', view: 'memory', label: 'Memory', icon: 'memory' },
      { kind: 'leaf', view: 'audit', label: 'Audit', icon: 'audit' },
    ],
  },
  { kind: 'leaf', view: 'graph', label: 'Graph', icon: 'graph' },
]

// Footer (admin) section — gated by the minimal auth token once it ships.
export const NAV_FOOTER: ReadonlyArray<NavLeaf> = [
  { kind: 'leaf', view: 'settings', label: 'Settings', icon: 'settings' },
]

// --- view ↔ path (base '/'; dashboard-rework decision 4 retires /dashboard/v2) ---

export const VIEW_TO_PATH: Record<ShellView, string> = {
  overview: '/',
  agents: '/agents',
  conversations: '/conversations',
  tasks: '/tasks',
  marketplace: '/marketplace',
  fleet: '/insights/fleet',
  usage: '/insights/usage',
  benchmarks: '/insights/benchmarks',
  memory: '/insights/memory',
  audit: '/insights/audit',
  graph: '/graph',
  settings: '/settings',
  'api-keys': '/settings/api-keys',
}

// Reverse map + legacy aliases. Legacy '/dashboard/v2/*' paths are 301'd to
// '/*' by the daemon in prod; these aliases also let old SPA deep-links and the
// pre-rework flat paths resolve client-side without a hard 404.
const LEGACY_ALIASES: Record<string, ShellView> = {
  '/dashboard': 'overview',
  '/dashboard/v2': 'overview',
  '/fleet': 'fleet',
  '/usage': 'usage',
  '/costs': 'usage',
  '/benchmarks': 'benchmarks',
  '/memory': 'memory',
  '/audit': 'audit',
  '/openai': 'api-keys',
}

const PATH_TO_VIEW: Record<string, ShellView> = (() => {
  const m: Record<string, ShellView> = { ...LEGACY_ALIASES }
  for (const [view, path] of Object.entries(VIEW_TO_PATH)) {
    m[path] = view as ShellView
  }
  return m
})()

export function pathToView(rawPath: string): ShellView {
  const path = rawPath.replace(/\/+$/, '') || '/'
  // P2: `/agents/<name>` is the full-page config route — prefix-match it to the
  // 'agents' view (pathToView is otherwise exact-match). The agent name is read
  // separately via agentParam().
  if (path === '/agents' || path.startsWith('/agents/')) return 'agents'
  return PATH_TO_VIEW[path] ?? PATH_TO_VIEW[rawPath] ?? 'overview'
}

/** P2: extract the agent name from `/agents/<name>` (null on the bare grid). */
export function agentParam(rawPath: string): string | null {
  const m = rawPath.match(/^\/agents\/([^/?#]+)/)
  return m && m[1] ? decodeURIComponent(m[1]) : null
}

/** P2: canonical path to one agent's config page. */
export function agentConfigPath(name: string): string {
  return `/agents/${encodeURIComponent(name)}`
}

export const VIEW_TITLE: Record<ShellView, string> = {
  overview: 'Overview',
  agents: 'Agents',
  conversations: 'Conversations',
  tasks: 'Tasks',
  marketplace: 'Marketplace',
  fleet: 'Fleet',
  usage: 'Usage',
  benchmarks: 'Benchmarks',
  memory: 'Memory',
  audit: 'Audit',
  graph: 'Knowledge graph',
  settings: 'Settings',
  'api-keys': 'API keys',
}

// For breadcrumb context in the topbar: which umbrella a view sits under.
export const VIEW_SECTION: Partial<Record<ShellView, string>> = {
  fleet: 'Insights',
  usage: 'Insights',
  benchmarks: 'Insights',
  memory: 'Insights',
  audit: 'Insights',
  'api-keys': 'Settings',
}
