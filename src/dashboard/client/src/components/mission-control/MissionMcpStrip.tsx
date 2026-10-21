/**
 * dash-redesign (Mission Control) — MCP fleet strip (footer).
 *
 * Ported from kit's `McpStrip` + `McpChip`. Reads
 * `useFleetStats().mcpFleet` (verified shape in
 * src/dashboard/types.ts:205 — { pattern, count, rssMB, runtime? }).
 * Renders one chip per pattern. Returns null if no MCP fleet data
 * present (matches existing McpOverviewStrip behaviour in
 * FleetLayout.tsx).
 */
import type { JSX } from 'react'
import { useFleetStats } from '@/hooks/useApi'

type FleetStatsPayload = {
  readonly mcpFleet?: ReadonlyArray<{
    readonly pattern: string
    readonly count: number
    readonly rssMB: number
    readonly runtime?: string
  }>
}

function McpChip(props: {
  readonly chip: { readonly pattern: string; readonly count: number; readonly rssMB: number; readonly runtime?: string }
}): JSX.Element {
  const { chip } = props
  return (
    <span
      className="mcp-chip"
      title={chip.runtime ? `runtime: ${chip.runtime}` : undefined}
      data-testid="mission-mcp-chip"
    >
      <span className="pill" />
      <span className="pattern">{chip.pattern}</span>
      <span className="num">
        {chip.count}× · {Math.round(chip.rssMB)}MB
      </span>
    </span>
  )
}

export function MissionMcpStrip(): JSX.Element | null {
  const q = useFleetStats()
  const fleet = q.data as FleetStatsPayload | undefined
  const mcp = fleet?.mcpFleet ?? []
  if (mcp.length === 0) return null

  const totalProcs = mcp.reduce((s, m) => s + m.count, 0)
  const totalRss = Math.round(mcp.reduce((s, m) => s + m.rssMB, 0))

  return (
    <footer className="mcp-strip" data-testid="mission-mcp-strip">
      <div className="row">
        <h2>MCP fleet</h2>
        <span className="sub">
          {totalProcs} processes · {totalRss} MB RSS
        </span>
      </div>
      <div className="mcp-chips">
        {mcp.map((m) => (
          <McpChip key={m.pattern} chip={m} />
        ))}
      </div>
    </footer>
  )
}

export default MissionMcpStrip
