/**
 * Unit coverage for the v2 graph-redesign pure modules (client/src/lib).
 * Pins the tier→colour CONTRACT (must match the legacy graph-color.js hexes
 * that graph-color.test.ts + the legend depend on) and the edge-thinning
 * invariants that keep the canvas legible without orphaning connected nodes.
 */
import { describe, it, expect } from 'vitest'
import {
  nodeColor,
  tierColors,
  TIER_COLORS_DARK,
  TIER_COLORS_LIGHT,
} from '../client/src/lib/graph-colors.js'
import { thinEdges, degreeMap } from '../client/src/lib/thin-edges.js'

describe('nodeColor (theme-aware tier contract)', () => {
  it('maps each linked tier to the active theme hex', () => {
    expect(nodeColor({ tier: 'hot', linkCount: 3 }, true)).toBe(TIER_COLORS_DARK.hot)
    expect(nodeColor({ tier: 'warm', linkCount: 3 }, true)).toBe(TIER_COLORS_DARK.warm)
    expect(nodeColor({ tier: 'cold', linkCount: 3 }, true)).toBe(TIER_COLORS_DARK.cold)
    expect(nodeColor({ tier: 'hot', linkCount: 3 }, false)).toBe(TIER_COLORS_LIGHT.hot)
    expect(nodeColor({ tier: 'warm', linkCount: 3 }, false)).toBe(TIER_COLORS_LIGHT.warm)
  })
  it('orphans (no links) dominate tier in both themes', () => {
    expect(nodeColor({ tier: 'hot', linkCount: 0 }, true)).toBe(TIER_COLORS_DARK.orphan)
    expect(nodeColor({ linkCount: 0 }, false)).toBe(TIER_COLORS_LIGHT.orphan)
  })
  it('missing/unknown tier falls back to warm (the field colour)', () => {
    expect(nodeColor({ linkCount: 2 }, true)).toBe(TIER_COLORS_DARK.warm)
    expect(nodeColor({ tier: 'unknown', linkCount: 2 }, true)).toBe(TIER_COLORS_DARK.warm)
  })
  it('defaults to the dark theme when the flag is omitted', () => {
    expect(nodeColor({ tier: 'hot', linkCount: 1 })).toBe(TIER_COLORS_DARK.hot)
  })
  it('keeps warm and cold visually distinct hues (legible tiers)', () => {
    expect(TIER_COLORS_DARK.warm).not.toBe(TIER_COLORS_DARK.cold)
    expect(TIER_COLORS_LIGHT.warm).not.toBe(TIER_COLORS_LIGHT.cold)
  })
  it('tierColors returns the active-theme map', () => {
    expect(tierColors(true)).toBe(TIER_COLORS_DARK)
    expect(tierColors(false)).toBe(TIER_COLORS_LIGHT)
  })
})

describe('thinEdges', () => {
  const star = (center: string, leaves: string[]) =>
    leaves.map((l) => ({ source: center, target: l }))

  it('reduces a DENSE graph and dedups undirected pairs', () => {
    // 12-node near-clique: each node linked to the next 6 (ring) → dense, so
    // thinning to a small perNode genuinely drops edges.
    const N = 12
    const links: Array<{ source: string; target: string }> = []
    for (let i = 0; i < N; i++)
      for (let d = 1; d <= 6; d++) links.push({ source: `n${i}`, target: `n${(i + d) % N}` })
    const out = thinEdges(links, 3)
    // every surviving edge is unique (undirected)
    const keys = out.map((l: { source: string; target: string }) => [l.source, l.target].sort().join('|'))
    expect(new Set(keys).size).toBe(keys.length)
    // genuinely thinned vs the dense input
    expect(out.length).toBeLessThan(links.length)
    expect(out.length).toBeGreaterThan(0)
  })

  it('keeps an edge if it is top-K for EITHER endpoint (no silent orphaning)', () => {
    // a leaf's single edge must survive even if the hub is over budget
    const links = star('hub', Array.from({ length: 30 }, (_, i) => `n${i}`))
    const out = thinEdges(links, 3)
    const nodesWithEdges = new Set(out.flatMap((l: { source: string; target: string }) => [l.source, l.target]))
    // all 30 leaves still connected (their lone edge is top-1 for them)
    for (let i = 0; i < 30; i++) expect(nodesWithEdges.has(`n${i}`)).toBe(true)
  })

  it('returns a copy and leaves input untouched; no-op when perNode<=0', () => {
    const links = [{ source: 'a', target: 'b' }]
    const out = thinEdges(links, 0)
    expect(out).toEqual(links)
    expect(out).not.toBe(links)
  })
})

describe('degreeMap', () => {
  it('counts undirected degree over the full link set', () => {
    const d = degreeMap([
      { source: 'a', target: 'b' },
      { source: 'a', target: 'c' },
      { source: 'b', target: 'c' },
    ])
    expect(d.get('a')).toBe(2)
    expect(d.get('b')).toBe(2)
    expect(d.get('c')).toBe(2)
  })
})
