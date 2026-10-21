// @vitest-environment jsdom
/**
 * dash-redesign — MissionAgentTile component tests.
 *
 * Coverage:
 *   - Pure helpers: `formatRel`, `deriveMissionStatus`
 *   - Render smokes: live agent → pulse rail + tile.live class;
 *                    warn agent → tile.warn class; idle agent → neither;
 *                    tier-1 meter color thresholds (≥70 warn, ≥85 danger);
 *                    sparkline empty-state hides the bars.
 *
 * Hook mocking: vi.hoisted() holds per-test fixtures so the mock
 * factory can read fresh values. Each test mutates `STATE.…` before
 * rendering and the mocked hooks reflect that state on the next call.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import {
  formatRel,
  deriveMissionStatus,
  MissionAgentTile,
} from './MissionAgentTile'

afterEach(() => {
  cleanup()
})

// ---------------------------------------------------------------------------
// formatRel — pure
// ---------------------------------------------------------------------------

describe('formatRel', () => {
  it('returns "—" for null/undefined/NaN inputs', () => {
    expect(formatRel(null)).toBe('—')
    expect(formatRel(undefined)).toBe('—')
    expect(formatRel('not-a-date')).toBe('—')
  })

  it('returns "just now" when the timestamp is in the future (clock skew)', () => {
    expect(formatRel(Date.now() + 5000)).toBe('just now')
  })

  it('returns seconds, minutes, hours, days as the gap grows', () => {
    const now = Date.now()
    expect(formatRel(now - 5_000)).toMatch(/^\d+s ago$/)
    expect(formatRel(now - 5 * 60_000)).toMatch(/^\d+m ago$/)
    expect(formatRel(now - 5 * 3_600_000)).toMatch(/^\d+h ago$/)
    expect(formatRel(now - 5 * 86_400_000)).toMatch(/^\d+d ago$/)
  })
})

// ---------------------------------------------------------------------------
// deriveMissionStatus — pure
// ---------------------------------------------------------------------------

describe('deriveMissionStatus', () => {
  it('marks errored/crashed agents as warn regardless of recency', () => {
    const fresh = Date.now()
    expect(
      deriveMissionStatus({
        rawStatus: 'errored',
        lastTurnAt: fresh,
        p50Ms: 100,
        p50Threshold: 1000,
      }),
    ).toEqual({ status: 'warn', live: false })

    expect(
      deriveMissionStatus({
        rawStatus: 'crashed',
        lastTurnAt: fresh,
        p50Ms: null,
        p50Threshold: null,
      }),
    ).toEqual({ status: 'warn', live: false })
  })

  it('marks SLO-breached agents as warn (p50 > threshold) even when running', () => {
    expect(
      deriveMissionStatus({
        rawStatus: 'running',
        lastTurnAt: Date.now(),
        p50Ms: 2500,
        p50Threshold: 1000,
      }),
    ).toEqual({ status: 'warn', live: false })
  })

  it('marks running + recently-active agents as live', () => {
    expect(
      deriveMissionStatus({
        rawStatus: 'running',
        lastTurnAt: Date.now() - 30_000,
        p50Ms: 500,
        p50Threshold: 1000,
      }),
    ).toEqual({ status: 'live', live: true })

    // `active` is accepted as a live raw status as well.
    expect(
      deriveMissionStatus({
        rawStatus: 'active',
        lastTurnAt: Date.now() - 10_000,
        p50Ms: null,
        p50Threshold: null,
      }),
    ).toEqual({ status: 'live', live: true })
  })

  it('marks running-but-stale agents as idle (calm, not warn)', () => {
    // 10 minutes ago — past the 5-min live window.
    expect(
      deriveMissionStatus({
        rawStatus: 'running',
        lastTurnAt: Date.now() - 10 * 60_000,
        p50Ms: 500,
        p50Threshold: 1000,
      }),
    ).toEqual({ status: 'idle', live: false })
  })

  it('marks stopped / undefined agents as idle', () => {
    expect(
      deriveMissionStatus({
        rawStatus: 'stopped',
        lastTurnAt: null,
        p50Ms: null,
        p50Threshold: null,
      }),
    ).toEqual({ status: 'idle', live: false })

    expect(
      deriveMissionStatus({
        rawStatus: undefined,
        lastTurnAt: null,
        p50Ms: null,
        p50Threshold: null,
      }),
    ).toEqual({ status: 'idle', live: false })
  })

  it('treats null p50 as "no SLO data" — does not warn', () => {
    expect(
      deriveMissionStatus({
        rawStatus: 'running',
        lastTurnAt: Date.now(),
        p50Ms: null,
        p50Threshold: 1000,
      }),
    ).toEqual({ status: 'live', live: true })
  })
})

// ---------------------------------------------------------------------------
// Render smokes — hooks mocked.
// ---------------------------------------------------------------------------

const STATE = vi.hoisted(() => ({
  cache: {} as Record<string, unknown>,
  latency: {} as Record<string, unknown>,
  activity: {} as Record<string, unknown>,
}))

vi.mock('../../hooks/useApi', () => ({
  useAgentCache: (name: string) => ({ data: STATE.cache[name] }),
  useAgentLatency: (name: string) => ({ data: STATE.latency[name] }),
  useAgentActivity: (name: string) => ({ data: STATE.activity[name] }),
}))

beforeEach(() => {
  STATE.cache = {}
  STATE.latency = {}
  STATE.activity = {}
})

describe('<MissionAgentTile />', () => {
  it('renders a live agent with tile.live class and live pulse dot', () => {
    STATE.cache['alpha'] = {
      slos: { first_token_p50_ms: 1000, model: 'sonnet' },
      tier1_budget_pct: 0.45,
    }
    STATE.latency['alpha'] = {
      first_token_headline: { p50: 600, count: 50 },
    }
    STATE.activity['alpha'] = {
      buckets: Array.from({ length: 24 }, (_, i) => ({ turn_count: i + 1 })),
    }

    const { container } = render(
      <MissionAgentTile
        agent={{
          name: 'alpha',
          status: 'running',
          lastTurnAt: Date.now() - 10_000,
        }}
      />,
    )

    const tile = container.querySelector('.tile')
    expect(tile?.className).toContain('live')

    const dot = container.querySelector('.mc-dot')
    expect(dot?.className).toContain('live')
    expect(dot?.className).toContain('ok')
  })

  it('renders a warn agent (errored) with tile.warn class', () => {
    STATE.cache['bravo'] = {
      slos: { first_token_p50_ms: 1000 },
      tier1_budget_pct: 0.3,
    }
    STATE.latency['bravo'] = { first_token_headline: { p50: null, count: 0 } }
    STATE.activity['bravo'] = { buckets: [] }

    const { container } = render(
      <MissionAgentTile agent={{ name: 'bravo', status: 'errored' }} />,
    )

    const tile = container.querySelector('.tile')
    expect(tile?.className).toContain('warn')
    expect(tile?.className).not.toContain('live')

    const dot = container.querySelector('.mc-dot')
    expect(dot?.className).toContain('warn')
    expect(dot?.className).not.toContain('live')
  })

  it('renders an idle agent with neither live nor warn classes', () => {
    STATE.cache['charlie'] = { slos: {}, tier1_budget_pct: 0.1 }
    STATE.latency['charlie'] = {
      first_token_headline: { p50: null, count: 0 },
    }
    STATE.activity['charlie'] = { buckets: [] }

    const { container } = render(
      <MissionAgentTile
        agent={{ name: 'charlie', status: 'stopped', lastTurnAt: null }}
      />,
    )

    const tile = container.querySelector('.tile')
    expect(tile?.className).not.toContain('live')
    expect(tile?.className).not.toContain('warn')

    const dot = container.querySelector('.mc-dot')
    expect(dot?.className).toContain('idle')
  })

  it('derives tier-1 meter color: <70 ok, ≥70 warn, ≥85 danger', () => {
    const renderWithTier1 = (tier1Pct: number, name: string) => {
      STATE.cache[name] = {
        slos: { first_token_p50_ms: 1000 },
        tier1_budget_pct: tier1Pct,
      }
      STATE.latency[name] = {
        first_token_headline: { p50: 500, count: 10 },
      }
      STATE.activity[name] = { buckets: [] }
      return render(
        <MissionAgentTile
          agent={{ name, status: 'running', lastTurnAt: Date.now() }}
        />,
      )
    }

    // Component accepts both 0..1 and 0..100 — pass percentages.
    // Tier-1 meter element: <div class="fill ${color}"> inside .tile-meter-row.
    const ok = renderWithTier1(50, 'd1')
    expect(ok.container.querySelector('.tile-meter-row .fill')?.className).toContain('ok')
    cleanup()

    const warn = renderWithTier1(75, 'd2')
    expect(warn.container.querySelector('.tile-meter-row .fill')?.className).toContain('warn')
    cleanup()

    const danger = renderWithTier1(90, 'd3')
    expect(danger.container.querySelector('.tile-meter-row .fill')?.className).toContain('danger')
  })

  it('hides the sparkline bars when no activity buckets are available', () => {
    STATE.cache['empty'] = {
      slos: { first_token_p50_ms: 1000 },
      tier1_budget_pct: 0.1,
    }
    STATE.latency['empty'] = {
      first_token_headline: { p50: null, count: 0 },
    }
    STATE.activity['empty'] = { buckets: [] }

    const { container } = render(
      <MissionAgentTile agent={{ name: 'empty', status: 'stopped' }} />,
    )

    // Empty buckets → the mono "no turns 24h" placeholder span is
    // rendered (data-testid="mission-sparkline-empty") and no `.spark`
    // wrapper is mounted. Assert both: positive on placeholder,
    // negative on the bar container.
    expect(container.querySelector('[data-testid="mission-sparkline-empty"]')).toBeInTheDocument()
    expect(container.querySelector('.spark')).not.toBeInTheDocument()
  })

  it('exposes the agent name in the tile and fires onSelect on click', () => {
    STATE.cache['delta'] = { slos: {}, tier1_budget_pct: 0 }
    STATE.latency['delta'] = {
      first_token_headline: { p50: null, count: 0 },
    }
    STATE.activity['delta'] = { buckets: [] }

    const onSelect = vi.fn()
    render(
      <MissionAgentTile
        agent={{ name: 'delta', status: 'running' }}
        onSelect={onSelect}
      />,
    )

    expect(screen.getByText('delta')).toBeInTheDocument()
    screen.getByText('delta').closest('.tile')?.dispatchEvent(
      new MouseEvent('click', { bubbles: true }),
    )
    expect(onSelect).toHaveBeenCalledWith('delta')
  })
})
