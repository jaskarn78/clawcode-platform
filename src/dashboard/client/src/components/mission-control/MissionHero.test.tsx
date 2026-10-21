// @vitest-environment jsdom
/**
 * dash-redesign — MissionHero component tests.
 *
 * Coverage:
 *   - Pure helpers: `medianFinite`, `meanFinite`
 *   - Render smokes: fleet count + p50 (median across live agents) +
 *     tier1 avg (mean across reporting agents) computed from supplied
 *     hook data; "endpoint pending" copy when /api/advisor-budget
 *     returns 404; placeholder ("—") on empty / awaiting samples.
 *
 * Hooks `useAgentCache` + `useAgentLatency` are mocked synchronously
 * so the PerAgentProbe useEffect fires inside the first render pass.
 * The hero uses setState to aggregate; we wait one microtask after
 * the initial render with `waitFor` so the stats land before
 * assertions.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, waitFor, cleanup } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import {
  medianFinite,
  meanFinite,
  MissionHero,
} from './MissionHero'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe('medianFinite', () => {
  it('returns null for empty input', () => {
    expect(medianFinite([])).toBeNull()
  })

  it('drops non-finite values before computing', () => {
    expect(medianFinite([1, 2, Infinity, NaN, 3])).toBe(2)
  })

  it('returns the middle value for odd-length arrays', () => {
    expect(medianFinite([100, 200, 300])).toBe(200)
  })

  it('averages the two middle values for even-length arrays', () => {
    expect(medianFinite([100, 200, 300, 400])).toBe(250)
  })
})

describe('meanFinite', () => {
  it('returns null for empty input', () => {
    expect(meanFinite([])).toBeNull()
  })

  it('drops non-finite values before averaging', () => {
    expect(meanFinite([10, 20, NaN, Infinity])).toBe(15)
  })

  it('rounds the result to an integer', () => {
    // (1 + 2 + 3 + 4) / 4 = 2.5 → 3 (banker's rounding not used; Math.round)
    expect(meanFinite([1, 2, 3, 4])).toBe(3)
  })
})

// ---------------------------------------------------------------------------
// Render smokes — mock useAgents + per-agent probes
// ---------------------------------------------------------------------------

const STATE = vi.hoisted(() => ({
  agents: [] as Array<{
    readonly name: string
    readonly status?: string
    readonly lastTurnAt?: string | number | null
  }>,
  cache: {} as Record<string, unknown>,
  latency: {} as Record<string, unknown>,
}))

vi.mock('../../hooks/useApi', () => ({
  useAgents: () => ({
    data: { agents: STATE.agents },
    isLoading: false,
    isError: false,
  }),
  useAgentCache: (name: string) => ({ data: STATE.cache[name] }),
  useAgentLatency: (name: string) => ({ data: STATE.latency[name] }),
}))

beforeEach(() => {
  STATE.agents = []
  STATE.cache = {}
  STATE.latency = {}
  // Stub the advisor-budget probe — default is "endpoint not present".
  // Tests that need a successful budget override this in-place.
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(null, { status: 404 })) as unknown as typeof fetch,
  )
})

describe('<MissionHero />', () => {
  it('shows "No agents." when the fleet is empty', () => {
    render(<MissionHero />)
    expect(screen.getByText(/No agents\./i)).toBeInTheDocument()
  })

  it('renders fleet count, live count, p50 median, tier-1 mean', async () => {
    const now = Date.now()
    STATE.agents = [
      { name: 'alpha', status: 'running', lastTurnAt: now - 5_000 },
      { name: 'bravo', status: 'running', lastTurnAt: now - 5_000 },
      { name: 'charlie', status: 'stopped', lastTurnAt: null },
    ]
    STATE.cache = {
      alpha: { slos: { first_token_p50_ms: 1000 }, tier1_budget_pct: 0.4 },
      bravo: { slos: { first_token_p50_ms: 1000 }, tier1_budget_pct: 0.6 },
      charlie: { slos: { first_token_p50_ms: 1000 }, tier1_budget_pct: 0.2 },
    }
    STATE.latency = {
      alpha: { first_token_headline: { p50: 500, count: 100 } },
      bravo: { first_token_headline: { p50: 700, count: 100 } },
      charlie: { first_token_headline: { p50: null, count: 0 } },
    }

    render(<MissionHero />)

    // Headline: "3 agents." once probes have reported.
    expect(await screen.findByRole('heading')).toHaveTextContent(/3 agents\./)

    // Live agents tile: 2 / 3 (alpha + bravo running and recently
    // active; charlie stopped). The tile's children read
    // "Live agents | 2 / 3"; assert both fragments are present.
    await waitFor(() => {
      const tile = screen.getByTestId('mission-stat-live-agents')
      expect(tile.querySelector('.val')?.textContent).toMatch(/^2/)
      expect(tile).toHaveTextContent('/ 3')
    })

    // p50 stat — median of [500, 700] = 600
    await waitFor(() => {
      expect(
        screen.getByTestId('mission-stat-p50-across-fleet'),
      ).toHaveTextContent(/600/)
    })

    // Tier-1 avg — mean of [40, 60, 20] = 40
    await waitFor(() => {
      expect(screen.getByTestId('mission-stat-tier-1-avg')).toHaveTextContent(
        /40/,
      )
    })
  })

  it('falls back to "—" placeholder when no probes have reported samples', async () => {
    STATE.agents = [{ name: 'alpha', status: 'running' }]
    STATE.cache = {
      alpha: { slos: { first_token_p50_ms: 1000 }, tier1_budget_pct: null },
    }
    STATE.latency = {
      alpha: { first_token_headline: { p50: null, count: 0 } },
    }

    render(<MissionHero />)

    await waitFor(() => {
      expect(screen.getByTestId('mission-stat-p50-across-fleet')).toHaveTextContent('—')
    })
    expect(screen.getByTestId('mission-stat-tier-1-avg')).toHaveTextContent('—')
  })

  it('renders "endpoint pending" copy on the Advisor budget tile when /api/advisor-budget 404s', async () => {
    STATE.agents = [{ name: 'alpha', status: 'running' }]

    render(<MissionHero />)

    await waitFor(() => {
      expect(screen.getByTestId('mission-stat-advisor-budget')).toHaveTextContent(
        /endpoint pending/i,
      )
    })
  })

  it('uses the live advisor-budget figures when the endpoint returns 200', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ calls_used: 7, max_calls: 60 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ) as unknown as typeof fetch,
    )

    STATE.agents = [{ name: 'alpha', status: 'running' }]
    STATE.cache = {
      alpha: { slos: { first_token_p50_ms: 1000 }, tier1_budget_pct: null },
    }
    STATE.latency = {
      alpha: { first_token_headline: { p50: null, count: 0 } },
    }

    render(<MissionHero />)

    await waitFor(() => {
      expect(screen.getByTestId('mission-stat-advisor-budget')).toHaveTextContent('7')
    })
    expect(screen.getByTestId('mission-stat-advisor-budget')).toHaveTextContent(
      /\/ 60/,
    )
  })
})
