/**
 * ForceGraphCanvas — the Obsidian-style canvas knowledge graph.
 *
 * Wraps the vendored canvas `force-graph` engine imperatively (it's not a React
 * lib): we mount it once into a ref'd div and push data/theme through effects,
 * keeping per-frame state (hover, selection, palette) in refs so the colour /
 * label accessors read fresh values without tearing down the simulation.
 *
 * Behaviours that make it feel like Obsidian:
 *   - canvas rendering (no SVG-DOM) → smooth at ~2k nodes / ~9k thinned edges
 *   - nodes sized by importance + degree; tier colours preserved
 *   - hover dims the rest of the graph and lights the node + its neighbours
 *   - labels fade in past a zoom threshold (and for hovered/selected nodes)
 *   - drag to reposition, scroll to zoom, drag-background to pan
 *   - the sim settles (~4s) then FREEZES, so interaction stays buttery
 */
import { useEffect, useRef } from 'react'
import ForceGraph, { type ForceGraphInstance } from '@/lib/forceGraph'
import { nodeColor, withAlpha, type GraphPalette } from '@/lib/graph-colors'
import type { GraphNode, GraphLink } from '@/hooks/useApi'

/** force-graph mutates nodes with x/y and links' source/target → node refs. */
type FGNode = GraphNode & { x?: number; y?: number }
type FGLink = { source: string | FGNode; target: string | FGNode; text?: string }

export interface GraphControls {
  /** Charge repulsion strength (higher = more spread). */
  readonly repel: number
  /** Target link distance. */
  readonly linkDistance: number
  /** Node size multiplier. */
  readonly nodeScale: number
}

export const DEFAULT_CONTROLS: GraphControls = {
  repel: 90,
  linkDistance: 34,
  nodeScale: 1,
}

/** Draw/collision radius of a node in graph coords (matches nodeRelSize 4). */
function nodeRadius(n: FGNode, scale: number): number {
  return Math.sqrt(Math.max(0, nodeVal(n, scale))) * 4
}

/**
 * Lightweight collision force — the ingredient that makes the layout read as
 * "organized" (Obsidian) rather than a blob or a tangle of threads: every node
 * claims its own radius + a little padding, so leaves fan out into even,
 * non-overlapping rings around their hub. d3-force isn't on the dep tree (and we
 * won't mutate the shared root node_modules), so this is a self-contained
 * spatial-hash relaxation: bucket nodes into a grid, resolve overlaps against
 * the 8 neighbouring cells only → ~O(n) per tick. The simulation runs only
 * during warmup, so the cost is bounded and never touches steady-state frames.
 */
function collideForce(scale: number): {
  (): void
  initialize: (nodes: FGNode[]) => void
} {
  let nodes: FGNode[] = []
  const pad = 3
  // Cell ≥ the largest possible collision diameter so a 3×3 scan can't miss a
  // pair (hub radius grows with scale; keep generous headroom).
  const cell = Math.max(72, 40 * scale * 2)
  const force = (): void => {
    const grid = new Map<string, number[]>()
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i]
      if (n.x == null || n.y == null) continue
      const k = `${Math.floor(n.x / cell)},${Math.floor(n.y / cell)}`
      const b = grid.get(k)
      if (b) b.push(i)
      else grid.set(k, [i])
    }
    for (let i = 0; i < nodes.length; i++) {
      const a = nodes[i] as FGNode & { vx?: number; vy?: number }
      if (a.x == null || a.y == null) continue
      const gx = Math.floor(a.x / cell)
      const gy = Math.floor(a.y / cell)
      const ra = nodeRadius(a, scale)
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          const b = grid.get(`${gx + dx},${gy + dy}`)
          if (!b) continue
          for (const j of b) {
            if (j <= i) continue
            const c = nodes[j] as FGNode & { vx?: number; vy?: number }
            let x = a.x! + (a.vx ?? 0) - (c.x! + (c.vx ?? 0))
            let y = a.y! + (a.vy ?? 0) - (c.y! + (c.vy ?? 0))
            let dist = Math.sqrt(x * x + y * y) || 1
            const min = ra + nodeRadius(c, scale) + pad
            if (dist < min) {
              const push = ((min - dist) / dist) * 0.5
              const ox = x * push
              const oy = y * push
              a.vx = (a.vx ?? 0) + ox
              a.vy = (a.vy ?? 0) + oy
              c.vx = (c.vx ?? 0) - ox
              c.vy = (c.vy ?? 0) - oy
            }
          }
        }
      }
    }
  }
  force.initialize = (n: FGNode[]): void => {
    nodes = n
  }
  return force
}

/**
 * Degree-aware force tuning → Obsidian-style separated clusters instead of one
 * dense central blob.
 *
 *   - charge: base repulsion PLUS a modest push scaled by a node's degree, so
 *     hubs clear space for clean radial bursts. distanceMax (1200) lets
 *     repulsion reach across the graph — the old 450px cap let far clusters
 *     fall back together — without flinging chains into threads.
 *   - link: a spring at the chosen rest length holds each cluster together;
 *     force-graph's default per-link strength (1/min-degree) loosens hub springs.
 *   - collide: even, non-overlapping spacing (see collideForce).
 */
function applyForces(fg: ForceGraphInstance, c: GraphControls): void {
  fg.d3Force('charge')
    ?.strength((n: FGNode) => -(c.repel + Math.min(n.linkCount || 0, 30) * 4))
    .distanceMax(1200)
  fg.d3Force('link')?.distance(c.linkDistance)
  fg.d3Force('collide', collideForce(c.nodeScale))
}

interface Props {
  readonly nodes: readonly GraphNode[]
  /** Pre-thinned links. */
  readonly links: readonly GraphLink[]
  readonly palette: GraphPalette
  readonly controls?: GraphControls
  readonly selectedId?: string | null
  readonly onSelect: (node: GraphNode | null) => void
}

const LABEL_ZOOM = 1.5

function nodeVal(n: GraphNode, scale: number): number {
  return (1 + (n.importance || 0) * 5 + Math.min(n.linkCount || 0, 24) * 0.7) * scale
}

function endpointId(e: string | FGNode): string {
  return typeof e === 'object' ? e.id : e
}

export function ForceGraphCanvas({
  nodes,
  links,
  palette,
  controls = DEFAULT_CONTROLS,
  selectedId,
  onSelect,
}: Props): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const fgRef = useRef<ForceGraphInstance | null>(null)
  const adjRef = useRef<Map<string, Set<string>>>(new Map())
  const hoverRef = useRef<string | null>(null)
  // Eased focus: `focusRef` ramps 0↔1 each frame so the hover dim/highlight
  // fades in and out instead of snapping; `focusNodeRef` holds the node the
  // focus is centred on and is retained through the fade-OUT (so leaving a node
  // still eases back rather than cutting).
  const focusRef = useRef(0)
  const focusNodeRef = useRef<string | null>(null)
  const paletteRef = useRef(palette)
  const controlsRef = useRef(controls)
  const selectedRef = useRef<string | null>(selectedId ?? null)
  const onSelectRef = useRef(onSelect)
  const didFitRef = useRef(false)

  // Keep refs fresh every render WITHOUT re-mounting the engine.
  paletteRef.current = palette
  controlsRef.current = controls
  selectedRef.current = selectedId ?? null
  onSelectRef.current = onSelect

  // ── Mount the engine ONCE ───────────────────────────────────────────────
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const fg = ForceGraph()(el)
    fgRef.current = fg

    // Touch: force-graph leaves the canvas at `touch-action: auto`, so on a
    // phone a finger-drag would scroll the PAGE and a pinch would zoom the page
    // instead of panning/zooming the graph. Claim the gestures for the canvas
    // (d3-zoom handles them) by pinning touch-action: none on every canvas it
    // mounts (visible + shadow hit-test layer).
    el.querySelectorAll('canvas').forEach((c) => {
      ;(c as HTMLCanvasElement).style.touchAction = 'none'
    })

    // Focus membership is keyed on focusNodeRef (retained through fade-out),
    // not the live hover, so leaving a node eases back instead of cutting.
    const isHi = (id: string): boolean => {
      const f = focusNodeRef.current
      return !!f && (f === id || (adjRef.current.get(f)?.has(id) ?? false))
    }

    fg.nodeId('id')
      .nodeRelSize(4)
      .nodeVal((n: FGNode) => nodeVal(n, controlsRef.current.nodeScale))
      .nodeColor((n: FGNode) => {
        const base = nodeColor(n, paletteRef.current.dark)
        const f = focusRef.current
        if (f < 0.01 || !focusNodeRef.current || isHi(n.id)) return base
        // Ease the dim in/out with the focus ramp.
        return withAlpha(base, 1 - f * (1 - paletteRef.current.dimAlpha))
      })
      .nodeCanvasObjectMode(() => 'after')
      .nodeCanvasObject((n: FGNode, ctx: CanvasRenderingContext2D, scale: number) => {
        if (n.x == null || n.y == null) return
        const f = focusRef.current
        const hi = isHi(n.id)
        const sel = selectedRef.current === n.id
        const r = Math.sqrt(Math.max(0, nodeVal(n, controlsRef.current.nodeScale))) * 4
        // Soft glow halo on the focused node only (single node → cheap; a
        // radial-gradient fill, never shadowBlur, which would hitch the
        // always-on render loop).
        if (focusNodeRef.current === n.id && f > 0.04) {
          const col = nodeColor(n, paletteRef.current.dark)
          const rg = ctx.createRadialGradient(n.x, n.y, r * 0.5, n.x, n.y, r * 4)
          rg.addColorStop(0, withAlpha(col, 0.32 * f))
          rg.addColorStop(1, withAlpha(col, 0))
          ctx.fillStyle = rg
          ctx.beginPath()
          ctx.arc(n.x, n.y, r * 4, 0, 2 * Math.PI)
          ctx.fill()
        }
        // Selection ring — soft accent halo.
        if (sel) {
          ctx.beginPath()
          ctx.arc(n.x, n.y, r + 3 / scale, 0, 2 * Math.PI)
          ctx.strokeStyle = paletteRef.current.linkActive
          ctx.lineWidth = 1.5 / scale
          ctx.stroke()
        }
        // Labels: past the zoom threshold, or for the focused node + neighbours,
        // or the selected node. Hidden otherwise → clean when zoomed out.
        const showLabel = scale >= LABEL_ZOOM || hi || sel
        if (!showLabel) return
        const label =
          (n.tags && n.tags[0]) ||
          (n.content ? n.content.split(/\s+/).slice(0, 3).join(' ') : '') ||
          n.id.slice(0, 8)
        const fontPx = 11 / scale
        ctx.font = `${fontPx}px Geist, system-ui, sans-serif`
        ctx.textAlign = 'center'
        ctx.textBaseline = 'top'
        // Dim non-focused labels with the focus ramp.
        ctx.fillStyle =
          f > 0.01 && focusNodeRef.current && !hi && !sel
            ? withAlpha('#8a90a8', 0.25 * (1 - f))
            : paletteRef.current.label
        ctx.fillText(label, n.x, n.y + r + 1.5 / scale)
      })
      .linkColor((l: FGLink) => {
        const f = focusRef.current
        const fn = focusNodeRef.current
        if (f < 0.01 || !fn) return paletteRef.current.link
        const inc = endpointId(l.source) === fn || endpointId(l.target) === fn
        if (inc) return paletteRef.current.linkActive
        // Non-incident links fade out as focus rises.
        return withAlpha('#8a93b8', 0.1 * (1 - f))
      })
      .linkWidth((l: FGLink) => {
        const fn = focusNodeRef.current
        if (!fn || focusRef.current < 0.01) return 1
        const inc = endpointId(l.source) === fn || endpointId(l.target) === fn
        return inc ? 1.8 : 0.4
      })
      .backgroundColor(palette.background)
      // Per-frame easing driver — runs every frame (autoPauseRedraw is off).
      // Ramps focus toward 1 while hovering, back to 0 on leave; clears the
      // focus node once the fade-out completes.
      .onRenderFramePre(() => {
        const target = hoverRef.current ? 1 : 0
        focusRef.current += (target - focusRef.current) * 0.16
        if (hoverRef.current) {
          focusNodeRef.current = hoverRef.current
        } else if (focusRef.current < 0.012) {
          focusRef.current = 0
          focusNodeRef.current = null
        }
      })
      .onNodeHover((n: FGNode | null) => {
        hoverRef.current = n ? n.id : null
        if (containerRef.current) {
          containerRef.current.style.cursor = n ? 'pointer' : 'grab'
        }
      })
      .onNodeClick((n: FGNode) => onSelectRef.current(n))
      .onBackgroundClick(() => onSelectRef.current(null))
      // Keep the RENDER loop awake after the physics cools. force-graph only
      // repaints when `needsRedraw` is set, and its own hover-change branch
      // (and our ref-driven selection ring) never set it — so on a frozen
      // engine the hover dim / neighbour highlight / selection ring would
      // silently fail to paint. With auto-pause off the canvas redraws every
      // frame, so all pointer-driven visuals stay live (Obsidian behaviour).
      // The simulation itself still freezes via cooldownTime → layout is stable;
      // only the cheap 2k-node canvas blit keeps running (~60fps, measured).
      .autoPauseRedraw(false)
      .cooldownTime(5000)
      .d3VelocityDecay(0.3)
      .onEngineStop(() => {
        if (!didFitRef.current) {
          didFitRef.current = true
          // Tighter padding on narrow (mobile) viewports so the graph fills
          // the screen and node tap-targets stay big enough to hit.
          const w = containerRef.current?.clientWidth ?? 0
          fg.zoomToFit(500, w < 640 ? 24 : 70)
        }
      })

    // Obsidian-ish force tuning (degree-aware; see applyForces).
    applyForces(fg, controls)

    const ro = new ResizeObserver(() => {
      const c = containerRef.current
      if (c) fg.width(c.clientWidth).height(c.clientHeight)
    })
    ro.observe(el)
    fg.width(el.clientWidth).height(el.clientHeight)

    return () => {
      ro.disconnect()
      try {
        fg._destructor?.()
      } catch {
        /* engine already torn down */
      }
      fgRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ── Data → graph (also (re)build adjacency + re-fit) ────────────────────
  useEffect(() => {
    const fg = fgRef.current
    if (!fg) return
    const adj = new Map<string, Set<string>>()
    for (const l of links) {
      if (!adj.has(l.source)) adj.set(l.source, new Set())
      if (!adj.has(l.target)) adj.set(l.target, new Set())
      adj.get(l.source)!.add(l.target)
      adj.get(l.target)!.add(l.source)
    }
    adjRef.current = adj
    didFitRef.current = false
    // Clone — force-graph mutates objects with x/y/index in place.
    fg.graphData({
      nodes: nodes.map((n) => ({ ...n })),
      links: links.map((l) => ({ ...l })),
    })
  }, [nodes, links])

  // ── Theme → background + redraw ─────────────────────────────────────────
  useEffect(() => {
    const fg = fgRef.current
    if (!fg) return
    fg.backgroundColor(palette.background)
    fg.nodeColor(fg.nodeColor()) // re-set accessor → triggers a redraw
  }, [palette])

  // ── Controls → re-tune forces ───────────────────────────────────────────
  useEffect(() => {
    const fg = fgRef.current
    if (!fg) return
    applyForces(fg, controls)
    fg.nodeVal(fg.nodeVal()) // re-set → re-measure radii for nodeScale
    fg.d3ReheatSimulation?.()
  }, [controls])

  return (
    <div
      ref={containerRef}
      className="graph-fade-in h-full w-full"
      data-testid="graph-canvas"
    />
  )
}
