/**
 * dash-redesign (Mission Control) — flexbox-bar sparkline.
 *
 * Ported verbatim from the design-system kit's `components.jsx`
 * `Sparkline`. No Recharts dependency — the kit uses 4px-wide flex
 * children with percentage heights so the chart paints in one box-
 * model pass. Empty / no-data renders the kit's "no turns 24h" mono
 * fallback (matches the AgentTile empty-state behaviour).
 *
 * Heights are expected as 0..100 percentages. The minimum-visible
 * floor of 8 (kit: `Math.max(8, h)`) keeps zero-bucket bars from
 * disappearing entirely.
 */
import type { JSX } from 'react'

export type SparklineVariant = 'ok' | 'warn'

export type SparklineProps = {
  readonly data: ReadonlyArray<number>
  readonly variant?: SparklineVariant
}

export function Sparkline(props: SparklineProps): JSX.Element {
  const { data, variant = 'ok' } = props
  if (!data || data.length === 0) {
    return (
      <span
        style={{
          fontFamily: 'var(--font-mono, "JetBrains Mono")',
          fontSize: 10.5,
          color: 'rgb(var(--fg-3))',
        }}
        data-testid="mission-sparkline-empty"
      >
        no turns 24h
      </span>
    )
  }
  return (
    <div className={`spark ${variant}`} data-testid="mission-sparkline">
      {data.map((h, i) => (
        <span key={i} style={{ height: `${Math.max(8, h)}%` }} />
      ))}
    </div>
  )
}
