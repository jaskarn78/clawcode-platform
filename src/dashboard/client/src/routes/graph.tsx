/**
 * Knowledge graph — v2 redesign (Obsidian-style, native canvas).
 *
 * Replaces the prior iframe-over-legacy-D3 wrapper with a first-class React
 * route: a canvas force-graph (src/components/graph/ForceGraphCanvas) flanked by
 * a themed agent rail and a slide-in node detail panel, all on the v2 design
 * tokens (auto dark/light). The graph engine + its physics + hover/zoom/label
 * behaviour live in ForceGraphCanvas; this route owns data, layout, and detail.
 *
 * Data: /api/graph/:agent (useGraph). Edges are thinned to each node's
 * strongest few for legibility + frame rate (thinEdges); the FULL link set is
 * kept for node sizing (degree) and the detail panel's connection list.
 */
import { useEffect, useMemo, useState } from 'react'
import { useAgents, useGraph, type GraphNode } from '@/hooks/useApi'
import {
  ForceGraphCanvas,
  DEFAULT_CONTROLS,
  type GraphControls,
} from '@/components/graph/ForceGraphCanvas'
import { tierColors, palette as makePalette } from '@/lib/graph-colors'
import { thinEdges, degreeMap } from '@/lib/thin-edges'
import { cn } from '@/lib/utils'
import './graph.css'

/** Track the `.dark` class on <html> so the canvas palette follows the theme. */
function useIsDark(): boolean {
  const [dark, setDark] = useState(
    () => typeof document !== 'undefined' && document.documentElement.classList.contains('dark'),
  )
  useEffect(() => {
    const el = document.documentElement
    const obs = new MutationObserver(() => setDark(el.classList.contains('dark')))
    obs.observe(el, { attributes: true, attributeFilter: ['class'] })
    return () => obs.disconnect()
  }, [])
  return dark
}

// Default rendered edges per node. 1 = each node keeps only its single
// strongest link → the dense web collapses to a hub-and-spoke "skeleton"
// (clean Obsidian-style radial clusters). The Links slider lets the operator
// dial up toward the fully-connected web. Node size + tier + the detail
// panel's connection list always use the FULL graph, so thinning is purely a
// rendering choice.
const DEFAULT_EDGES_PER_NODE = 1

export function GraphRoute(): JSX.Element {
  const { data: agentsData } = useAgents()
  const agents = useMemo(
    () =>
      ((agentsData?.agents ?? []) as ReadonlyArray<{ name: string }>)
        .map((a) => a.name)
        .filter((n) => !n.includes('-thread-') && !n.includes('-sub-')),
    [agentsData],
  )

  const [agent, setAgent] = useState<string | null>(null)
  // Default to the first real agent once the list arrives.
  useEffect(() => {
    if (!agent && agents.length) setAgent(agents[0])
  }, [agent, agents])

  const { data: graph, isLoading, isError } = useGraph(agent)
  const [selected, setSelected] = useState<GraphNode | null>(null)
  const [controls, setControls] = useState<GraphControls>(DEFAULT_CONTROLS)
  const [edgesPerNode, setEdgesPerNode] = useState(DEFAULT_EDGES_PER_NODE)
  const dark = useIsDark()
  const pal = useMemo(() => makePalette(dark), [dark])

  // Selecting a different agent clears the open detail.
  useEffect(() => setSelected(null), [agent])

  // Degree (full graph) → linkCount on each node (drives size + tier colour).
  const { nodes, fullDegrees, tierCounts } = useMemo(() => {
    const rawNodes = graph?.nodes ?? []
    const rawLinks = graph?.links ?? []
    const deg = degreeMap(rawLinks)
    const ns: GraphNode[] = rawNodes.map((n) => ({ ...n, linkCount: deg.get(n.id) ?? 0 }))
    const counts = { hot: 0, warm: 0, cold: 0, orphan: 0 }
    for (const n of ns) {
      if ((n.linkCount ?? 0) === 0) counts.orphan++
      else if (n.tier === 'hot') counts.hot++
      else if (n.tier === 'cold') counts.cold++
      else counts.warm++
    }
    return { nodes: ns, fullDegrees: deg, tierCounts: counts }
  }, [graph])

  // Thinned render set — recomputed only when the graph or the Links density
  // changes (kept separate from the degree/tier pass above).
  const thinnedLinks = useMemo(
    () => thinEdges(graph?.links ?? [], edgesPerNode),
    [graph, edgesPerNode],
  )

  // Connections for the open node, from the FULL link set (not thinned).
  const connections = useMemo(() => {
    if (!selected || !graph) return [] as GraphNode[]
    const out: GraphNode[] = []
    const seen = new Set<string>()
    for (const l of graph.links) {
      const other = l.source === selected.id ? l.target : l.target === selected.id ? l.source : null
      if (!other || seen.has(other)) continue
      seen.add(other)
      const n = graph.nodes.find((x) => x.id === other)
      if (n) out.push(n)
    }
    return out
  }, [selected, graph])

  return (
    <div className="mx-auto max-w-[1600px] px-3 py-4 lg:px-7 lg:py-6">
      {/* Header — stacks on mobile so the title + controls never collide. */}
      <div className="mb-3 flex flex-col gap-2 lg:mb-4 lg:flex-row lg:items-baseline lg:justify-between">
        <div className="flex min-w-0 items-baseline gap-2">
          <h2 className="shrink-0 font-display text-lg font-bold tracking-tight text-fg-1 lg:text-xl">
            Knowledge graph
          </h2>
          <span className="truncate text-xs text-fg-3">
            {agent ? `${nodes.length} memories · ${tierCounts.orphan} orphans` : 'select an agent'}
            <span className="hidden md:inline"> · drag · scroll to zoom · hover to focus</span>
          </span>
        </div>
        <ForceControls
          value={controls}
          onChange={setControls}
          edgesPerNode={edgesPerNode}
          onEdgesChange={setEdgesPerNode}
        />
      </div>

      <div className="relative flex h-[calc(100vh-200px)] min-h-[440px] flex-col overflow-hidden rounded-xl border border-border bg-bg-elevated lg:h-[calc(100vh-180px)] lg:min-h-[520px] lg:flex-row">
        {/* Agent selector — horizontal chip strip on mobile (top). */}
        <div className="flex shrink-0 items-center gap-1.5 overflow-x-auto border-b border-border bg-bg-muted/40 px-3 py-2 lg:hidden">
          {agents.map((a) => (
            <button
              key={a}
              onClick={() => setAgent(a)}
              className={cn(
                'shrink-0 whitespace-nowrap rounded-full px-3 py-1 text-xs transition-colors',
                a === agent
                  ? 'bg-primary/15 text-primary'
                  : 'bg-bg-muted text-fg-2 active:bg-bg-muted/60',
              )}
            >
              {a}
            </button>
          ))}
        </div>

        {/* Agent rail — vertical list on desktop (left). */}
        <aside className="hidden w-52 shrink-0 overflow-y-auto border-r border-border bg-bg-muted/40 lg:block">
          <div className="px-3 py-2 font-mono text-[0.6rem] uppercase tracking-[0.12em] text-fg-3">
            Agents
          </div>
          {agents.map((a) => (
            <button
              key={a}
              onClick={() => setAgent(a)}
              className={cn(
                'flex w-full items-center gap-2 px-3 py-1.5 text-left text-[0.8rem] transition-colors',
                a === agent
                  ? 'bg-primary/10 text-primary'
                  : 'text-fg-2 hover:bg-bg-muted hover:text-fg-1',
              )}
            >
              <span
                className="h-1.5 w-1.5 shrink-0 rounded-full"
                style={{ background: a === agent ? 'hsl(var(--primary))' : 'rgb(var(--fg-3))' }}
              />
              <span className="truncate">{a}</span>
            </button>
          ))}
        </aside>

        {/* Canvas */}
        <div className="relative min-w-0 flex-1">
          {isLoading && (
            <div className="absolute inset-0 z-10 flex items-center justify-center text-sm text-fg-3">
              Loading graph…
            </div>
          )}
          {isError && (
            <div className="absolute inset-0 z-10 flex items-center justify-center text-sm text-danger">
              Failed to load graph for {agent}.
            </div>
          )}
          {!isLoading && !isError && nodes.length === 0 && agent && (
            <div className="absolute inset-0 z-10 flex items-center justify-center text-sm text-fg-3">
              No memories for {agent} yet.
            </div>
          )}
          {nodes.length > 0 && (
            <ForceGraphCanvas
              nodes={nodes}
              links={thinnedLinks}
              palette={pal}
              controls={controls}
              selectedId={selected?.id ?? null}
              onSelect={setSelected}
            />
          )}

          <TierLegend counts={tierCounts} colors={tierColors(dark)} />
        </div>

        {/* Detail panel — inline column on desktop, bottom sheet on mobile.
            The backdrop only exists on mobile (tap to dismiss the sheet). */}
        {selected && (
          <>
            <div
              onClick={() => setSelected(null)}
              className="graph-backdrop-in fixed inset-0 z-40 bg-black/40 lg:hidden"
              aria-hidden
            />
            <NodeDetail
              node={selected}
              degree={fullDegrees.get(selected.id) ?? 0}
              connections={connections}
              onClose={() => setSelected(null)}
              onNavigate={setSelected}
            />
          </>
        )}
      </div>
    </div>
  )
}

// ── Force controls (compact, raw inputs styled to theme) ──────────────────
function ForceControls({
  value,
  onChange,
  edgesPerNode,
  onEdgesChange,
}: {
  value: GraphControls
  onChange: (c: GraphControls) => void
  edgesPerNode: number
  onEdgesChange: (n: number) => void
}): JSX.Element {
  const slider = (key: keyof GraphControls, label: string, min: number, max: number, step = 1) => (
    <label className="flex shrink-0 items-center gap-1.5 text-[0.7rem] text-fg-3">
      {label}
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value[key]}
        onChange={(e) => onChange({ ...value, [key]: Number(e.target.value) })}
        className="w-16"
        style={{ accentColor: 'hsl(var(--primary))' }}
      />
    </label>
  )
  return (
    <div className="-mb-1 flex items-center gap-3 overflow-x-auto pb-1 lg:mb-0 lg:overflow-visible lg:pb-0">
      {/* Links = rendered edges per node. Low → clean radial clusters; high →
          the fully-connected web. */}
      <label className="flex shrink-0 items-center gap-1.5 text-[0.7rem] text-fg-3">
        Links
        <input
          type="range"
          min={1}
          max={8}
          step={1}
          value={edgesPerNode}
          onChange={(e) => onEdgesChange(Number(e.target.value))}
          className="w-16"
          style={{ accentColor: 'hsl(var(--primary))' }}
        />
      </label>
      {slider('repel', 'Spread', 40, 400)}
      {slider('linkDistance', 'Distance', 16, 140)}
      {slider('nodeScale', 'Size', 0.5, 2.5, 0.1)}
    </div>
  )
}

// ── Tier legend overlay ───────────────────────────────────────────────────
function TierLegend({
  counts,
  colors,
}: {
  counts: { hot: number; warm: number; cold: number; orphan: number }
  colors: { hot: string; warm: string; cold: string; orphan: string }
}): JSX.Element {
  const rows: Array<[keyof typeof counts, string, string]> = [
    ['hot', 'Hot', colors.hot],
    ['warm', 'Warm', colors.warm],
    ['cold', 'Cold', colors.cold],
    ['orphan', 'Orphan', colors.orphan],
  ]
  return (
    <div className="absolute right-3 top-3 rounded-lg border border-border bg-bg-elevated/70 px-3 py-2 shadow-lg backdrop-blur-md">
      <div className="mb-1 font-mono text-[0.55rem] uppercase tracking-[0.1em] text-fg-3">Tiers</div>
      <div className="space-y-0.5">
        {rows.map(([key, label, color]) => (
          <div key={key} className="flex items-center gap-2 text-[0.68rem] text-fg-2">
            <span className="h-2 w-2 rounded-full" style={{ background: color }} />
            <span>{label}</span>
            <span className="ml-auto font-mono text-fg-3">{counts[key]}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

// ── Node detail panel ─────────────────────────────────────────────────────
function NodeDetail({
  node,
  degree,
  connections,
  onClose,
  onNavigate,
}: {
  node: GraphNode
  degree: number
  connections: readonly GraphNode[]
  onClose: () => void
  onNavigate: (n: GraphNode) => void
}): JSX.Element {
  const preview = (n: GraphNode) =>
    n.content ? (n.content.length > 64 ? n.content.slice(0, 64) + '…' : n.content) : n.id
  return (
    <aside
      className={cn(
        // Entrance — gentle fade + rise (slide-up sheet on mobile, soft reveal
        // on desktop). See graph.css.
        'graph-rise-in',
        // Mobile: bottom sheet anchored to the VIEWPORT (not the container,
        // which is taller than the screen — anchoring there would push the
        // sheet's lower edge below the fold and clip the last rows).
        'fixed inset-x-0 bottom-0 z-50 flex max-h-[78dvh] flex-col rounded-t-2xl border-t border-border bg-bg-elevated shadow-2xl',
        // Desktop: inline column docked to the right.
        'lg:static lg:inset-auto lg:z-auto lg:max-h-none lg:h-full lg:w-[34%] lg:min-w-[320px] lg:max-w-[480px] lg:shrink-0 lg:rounded-none lg:border-l lg:border-t-0 lg:shadow-none',
      )}
    >
      {/* Grab-handle affordance (mobile only). */}
      <div className="mx-auto mt-2 h-1 w-10 shrink-0 rounded-full bg-fg-3/30 lg:hidden" />
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <div className="flex items-center gap-2">
          <span
            className="rounded-full px-2 py-0.5 font-mono text-[0.58rem] uppercase tracking-wide"
            style={{ background: 'hsl(var(--primary) / 0.12)', color: 'hsl(var(--primary))' }}
          >
            {node.tier || 'warm'}
          </span>
          <span className="font-mono text-[0.65rem] text-fg-3">{node.createdAt?.slice(0, 10)}</span>
        </div>
        <button onClick={onClose} className="text-lg leading-none text-fg-3 hover:text-fg-1">
          ×
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-4">
        <div className="whitespace-pre-wrap text-[0.84rem] leading-relaxed text-fg-1">
          {node.content || <span className="text-fg-3">(no content)</span>}
        </div>

        <div className="mt-5 grid grid-cols-4 gap-1.5">
          {(
            [
              [node.importance?.toFixed(2) ?? '—', 'Import'],
              [String(node.accessCount ?? 0), 'Reads'],
              [node.source || '—', 'Source'],
              [String(degree), 'Links'],
            ] as Array<[string, string]>
          ).map(([val, key]) => (
            <div key={key} className="rounded-md bg-bg-muted px-2 py-1.5 text-center">
              <div className="truncate font-mono text-[0.78rem] font-semibold text-fg-1">{val}</div>
              <div className="text-[0.55rem] uppercase tracking-wide text-fg-3">{key}</div>
            </div>
          ))}
        </div>

        {node.tags && node.tags.length > 0 && (
          <div className="mt-4 flex flex-wrap gap-1.5">
            {node.tags.map((t) => (
              <span
                key={t}
                className="rounded font-mono text-[0.62rem]"
                style={{ background: 'rgb(72 199 116 / 0.12)', color: '#48c774', padding: '2px 7px' }}
              >
                {t}
              </span>
            ))}
          </div>
        )}

        <div className="mb-2 mt-5 font-mono text-[0.58rem] uppercase tracking-[0.1em] text-fg-3">
          Connections · {connections.length}
        </div>
        <div className="space-y-0.5">
          {connections.length === 0 && (
            <div className="text-[0.72rem] text-fg-3">No connections</div>
          )}
          {connections.map((c) => (
            <button
              key={c.id}
              onClick={() => onNavigate({ ...c })}
              className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[0.73rem] text-fg-2 transition-colors hover:bg-bg-muted"
            >
              <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-primary/60" />
              <span className="truncate">{preview(c)}</span>
            </button>
          ))}
        </div>
      </div>
    </aside>
  )
}
