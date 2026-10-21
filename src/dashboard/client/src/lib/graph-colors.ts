/**
 * Memory-tier colour model for the knowledge-graph canvas.
 *
 * Design (v2 "observatory" pass): the graph is ~97% `warm` nodes, so warm IS
 * the field — it's a refined, near-neutral slate. `hot` is the single
 * saturated accent (warm amber) that pops against that field; `cold` is a
 * distinct cool hue (teal, never the same hue as warm) so tiers stay legible;
 * `orphan` recedes into the gradient background. Colours are theme-aware —
 * a palette tuned for the dark vignette would wash out on the light one.
 *
 * force-graph paints to a raw canvas and can't read CSS variables, so every
 * colour here is an explicit literal recomputed when the `.dark` class flips.
 * These are GRAPH-LOCAL (they intentionally do NOT touch the global design
 * tokens, which drive all 12 dashboard views). The legacy SVG graph keeps its
 * own `static/graph-color.js` palette.
 */

export type Tier = 'hot' | 'warm' | 'cold' | 'orphan' | string

interface TierMap {
  readonly hot: string
  readonly warm: string
  readonly cold: string
  readonly orphan: string
}

/** Dark theme — bright nodes over a deep vignette. */
export const TIER_COLORS_DARK: TierMap = {
  hot: '#f5a35c', // warm amber — the one saturated accent
  warm: '#8b93b8', // refined slate — the calm dominant field
  cold: '#5fb3a6', // muted teal — distinct cool hue, legible vs warm
  orphan: '#474d66', // dim blue-grey — recedes into the background
}

/** Light theme — deeper, more saturated so nodes read on a pale gradient. */
export const TIER_COLORS_LIGHT: TierMap = {
  hot: '#cf7a31',
  warm: '#5b6488',
  cold: '#3a8f80',
  orphan: '#a9afc6',
}

/** The tier→hex map for the active theme. */
export function tierColors(dark: boolean): TierMap {
  return dark ? TIER_COLORS_DARK : TIER_COLORS_LIGHT
}

/** A node only needs its tier + degree to be coloured. */
export interface ColorableNode {
  readonly tier?: string
  readonly linkCount?: number
}

/**
 * Tier → hex for the active theme. Orphans (no edges) dominate tier; a missing
 * tier falls back to warm (the field colour).
 */
export function nodeColor(d: ColorableNode, dark = true): string {
  const t = tierColors(dark)
  if ((d.linkCount ?? 0) === 0) return t.orphan
  switch (d.tier) {
    case 'hot':
      return t.hot
    case 'cold':
      return t.cold
    case 'warm':
      return t.warm
    default:
      return t.warm
  }
}

/** Parse `#rgb`/`#rrggbb` → [r,g,b]. */
function hexToRgb(hex: string): [number, number, number] {
  let h = hex.replace('#', '')
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2]
  const n = parseInt(h, 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

/** `rgba()` string from a hex + alpha — used for dimmed/idle/glow canvas fills. */
export function withAlpha(hex: string, alpha: number): string {
  const [r, g, b] = hexToRgb(hex)
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

/**
 * Theme-dependent canvas palette. `background` is a CSS value (a radial
 * gradient) — force-graph assigns it to `canvas.style.background` and clears
 * each frame with `clearRect`, so the gradient shows through behind the nodes
 * (depth + vignette without a second DOM layer).
 */
export interface GraphPalette {
  readonly dark: boolean
  /** CSS background (radial gradient) painted behind the transparent canvas. */
  readonly background: string
  /** Idle (un-hovered) link colour — faint, Obsidian-style. */
  readonly link: string
  /** Highlighted link colour (focused node's edges). */
  readonly linkActive: string
  /** Node ring/label text colour. */
  readonly label: string
  /** Alpha applied to nodes/links dimmed during focus. */
  readonly dimAlpha: number
}

export function palette(dark: boolean): GraphPalette {
  return dark
    ? {
        dark: true,
        background:
          'radial-gradient(125% 125% at 50% 28%, #1c1e2e 0%, #141622 52%, #0b0c12 100%)',
        link: 'rgba(150, 162, 200, 0.10)',
        linkActive: 'rgba(208, 216, 242, 0.55)',
        label: 'rgba(202, 209, 234, 0.92)',
        dimAlpha: 0.05,
      }
    : {
        dark: false,
        background:
          'radial-gradient(125% 125% at 50% 28%, #ffffff 0%, #f2f4fb 58%, #e6e9f3 100%)',
        link: 'rgba(40, 52, 84, 0.10)',
        linkActive: 'rgba(58, 70, 112, 0.50)',
        label: 'rgba(44, 50, 72, 0.92)',
        dimAlpha: 0.08,
      }
}
