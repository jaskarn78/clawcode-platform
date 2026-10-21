/**
 * Phase 116 Plan 01 T03 — F04 Tier-1 budget meter.
 *
 * Wraps shadcn <Progress> with the per-tier-1 inject budget (16,000 chars).
 * Color band:
 *   - < 70%  → primary (emerald)
 *   - 70-85% → warn (amber)
 *   - > 85%  → danger (red)
 *
 * Inputs come from `useAgentCache(name)` which carries `tier1_inject_chars`
 * and `tier1_budget_pct` (Plan 115-09 T04 daemon surface, see daemon.ts:3514).
 *
 * Hover/tap tooltip shows the raw chars/cap and percentage. The 7d sparkline
 * is a Skeleton placeholder — the drawer that hosts the historical view
 * ships in Plan 116-04, and there's no daily-rollup endpoint yet.
 */
import { Progress } from '@/components/ui/progress'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'

// Tier 1 inject budget cap — locked at 16,000 chars per 115-09 / 116-CONTEXT.
export const TIER1_BUDGET_CHARS = 16_000

export type ContextMeterProps = {
  /** Raw inject chars over the report window. Null = no data yet. */
  readonly tier1InjectChars: number | null
  /**
   * Server-precomputed percentage (0-100). When provided we prefer it over a
   * client-side division so the band logic matches what the daemon reports
   * elsewhere. Null = derive from chars + budget cap.
   */
  readonly tier1BudgetPct: number | null
  /**
   * Toggle the 7d sparkline placeholder. Tile mode hides it (vertical room is
   * tight); a future drawer mode shows it. Default false.
   */
  readonly showSparkline?: boolean
}

// Translate a 0-100 percentage to a Tailwind color band. Matches the locked
// 70 / 85 thresholds in 116-CONTEXT.md.
function bandClass(pct: number): {
  readonly bar: string
  readonly text: string
  readonly label: string
} {
  if (pct >= 85) {
    return { bar: 'bg-danger', text: 'text-danger', label: 'danger' }
  }
  if (pct >= 70) {
    return { bar: 'bg-warn', text: 'text-warn', label: 'warn' }
  }
  return { bar: 'bg-primary', text: 'text-primary', label: 'ok' }
}

export function ContextMeter(props: ContextMeterProps): JSX.Element {
  const chars = props.tier1InjectChars
  // Prefer server-precomputed pct; fall back to client-side derive when only
  // chars are present. Clamp to [0, 100] either way so a momentarily-stale
  // budget cap doesn't blow the Progress component out.
  const rawPct =
    typeof props.tier1BudgetPct === 'number'
      ? props.tier1BudgetPct
      : chars !== null
        ? (chars / TIER1_BUDGET_CHARS) * 100
        : null

  if (rawPct === null) {
    // No telemetry yet — render a neutral skeleton row so layout doesn't
    // collapse but the operator gets a clear "no data" cue.
    return (
      <div className="space-y-1.5" data-testid="context-meter-empty">
        <div className="flex items-center justify-between text-xs text-fg-3 font-sans">
          <span>Tier 1 budget</span>
          <span className="font-mono data">—</span>
        </div>
        <Skeleton className="h-2 w-full rounded-full" />
        {props.showSparkline && (
          <Skeleton className="h-6 w-full rounded-md mt-2" />
        )}
      </div>
    )
  }

  const pct = Math.max(0, Math.min(100, rawPct))
  const band = bandClass(pct)
  const displayChars =
    chars !== null ? chars.toLocaleString('en-US') : Math.round((pct / 100) * TIER1_BUDGET_CHARS).toLocaleString('en-US')
  const tooltipText = `${displayChars} / ${TIER1_BUDGET_CHARS.toLocaleString('en-US')} chars (${pct.toFixed(1)}%)`

  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>
          <div
            className="space-y-1.5 w-full cursor-default"
            data-testid="context-meter"
            data-band={band.label}
          >
            <div className="flex items-center justify-between text-xs font-sans">
              <span className="text-fg-3">Tier 1 budget</span>
              <span className={`font-mono data ${band.text}`}>
                {pct.toFixed(0)}%
              </span>
            </div>
            {/*
              shadcn Progress applies `[&>*]:bg-primary` by default. We force
              the band color via an explicit indicator class so the bar tracks
              the color band logic — and we keep the track muted so the empty
              portion doesn't pop.
            */}
            <Progress
              value={pct}
              className="h-2 bg-bg-muted"
              indicatorClassName={band.bar}
              aria-label={`Tier 1 inject budget at ${pct.toFixed(1)}%`}
            />
            {props.showSparkline && (
              <div className="mt-2" aria-label="7-day budget trend placeholder">
                <Skeleton className="h-6 w-full rounded-md" />
              </div>
            )}
          </div>
        </TooltipTrigger>
        <TooltipContent
          side="top"
          className="bg-bg-elevated text-fg-1 border border-bg-s3 font-mono text-xs"
        >
          {tooltipText}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}

export default ContextMeter
