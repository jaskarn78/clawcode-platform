/**
 * dash-redesign (Mission Control) — home-view layout.
 *
 * The Dashboard tab (view === 'dashboard' in App.tsx) renders this
 * layout as its body. The top chrome (brand + nav + heartbeat +
 * icon cluster) is mounted ONCE at the App level via <MissionHeader>
 * so every route picks it up — see App.tsx wiring (T15).
 *
 * Composition (top-to-bottom):
 *   1. <MissionHero>       — fleet headline + 4 stat tiles
 *   2. <div class="mc-main"> — 2-column grid (fluid 1fr / 360px)
 *        - <section>: <MissionFleetGrid onSelect={onSelectAgent}>
 *        - <MissionRail>: Live activity + Tasks
 *   3. <MissionMcpStrip>   — MCP fleet roll-up footer (auto-hides
 *                            when no MCP data present)
 *
 * The route-scoped stylesheet `mission-control.css` is imported by
 * App.tsx (T15) so the `.mc-header` styles also reach MissionHeader
 * (which lives outside this layout). This file keeps the import
 * here too — defensive: if a downstream consumer ever renders this
 * layout in isolation (Storybook, a one-off route preview) the
 * styles still load. Vite dedupes the CSS module by path so the
 * double-import is free.
 */
import type { JSX } from 'react'
import { MissionHero } from '@/components/mission-control/MissionHero'
import { MissionFleetGrid } from '@/components/mission-control/MissionFleetGrid'
import { MissionRail } from '@/components/mission-control/MissionRail'
import { MissionMcpStrip } from '@/components/mission-control/MissionMcpStrip'
import './mission-control.css'

export type MissionControlLayoutProps = {
  /**
   * Agent-tile click handler. Fires with the agent name; App.tsx
   * opens the existing AgentDetailDrawer in response (config edit
   * + restart + history all live inside that drawer).
   */
  readonly onSelectAgent?: (name: string) => void
}

export function MissionControlLayout(
  props: MissionControlLayoutProps,
): JSX.Element {
  return (
    <div
      className="mission-control-shell"
      data-testid="mission-control-layout"
    >
      <MissionHero />
      <div className="mc-main">
        <section data-testid="mission-fleet-section">
          <MissionFleetGrid onSelect={props.onSelectAgent} />
        </section>
        <MissionRail />
      </div>
      <MissionMcpStrip />
    </div>
  )
}

export default MissionControlLayout
