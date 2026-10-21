/**
 * Phase 116 Plan 01 T05 — F08 prompt-bloat + lazy-recall counters.
 *
 * Two compact pill counters rendered inside the agent tile:
 *
 *   - prompt_bloat_warnings_24h → amber when > 0 (operator-actionable)
 *   - lazy_recall_call_count    → neutral (memory-tool usage proxy)
 *
 * Click on prompt-bloat → link to filtered traces view at
 * `/dashboard/v2/traces?agent=X&filter=prompt-bloat`. That route doesn't
 * exist yet (Plan 116-02 wires the traces page); the anchor degrades
 * gracefully to a no-op when the route 404s.
 *
 * Both fields come from `useAgentCache(name)` (Plan 115-09 T04 daemon
 * surface, see daemon.ts:3516-3517).
 */
import { Badge } from '@/components/ui/badge'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'

export type MetricCountersProps = {
  readonly agent: string
  readonly promptBloatWarnings24h: number | null
  readonly lazyRecallCallCount: number | null
}

export function MetricCounters(props: MetricCountersProps): JSX.Element {
  const bloat = props.promptBloatWarnings24h
  const recall = props.lazyRecallCallCount
  const bloatActive = typeof bloat === 'number' && bloat > 0

  const bloatHref = `/traces?agent=${encodeURIComponent(
    props.agent,
  )}&filter=prompt-bloat`

  return (
    <TooltipProvider delayDuration={200}>
      <div
        className="flex flex-wrap items-center gap-1.5"
        data-testid="metric-counters"
      >
        {/* Prompt bloat — amber when > 0, neutral chip when 0/null. */}
        <Tooltip>
          <TooltipTrigger asChild>
            <a
              href={bloatHref}
              className="inline-flex"
              data-testid="metric-counters-prompt-bloat"
              onClick={(e) => {
                // 116-02 ships the traces page. Until then the route 404s.
                // Block the navigation client-side so the dashboard stays put
                // and the operator sees a no-op (the tooltip surfaces intent).
                // When 116-02 lands, remove this guard.
                e.preventDefault()
              }}
            >
              <Badge
                variant="outline"
                className={
                  bloatActive
                    ? 'bg-warn/15 border-warn/40 text-warn font-mono text-[10px] uppercase'
                    : 'bg-bg-muted border-bg-s3 text-fg-3 font-mono text-[10px] uppercase'
                }
              >
                <span aria-hidden="true" className="mr-1">
                  ⚠
                </span>
                bloat {typeof bloat === 'number' ? bloat : '—'}
              </Badge>
            </a>
          </TooltipTrigger>
          <TooltipContent
            side="top"
            className="bg-bg-elevated text-fg-1 border border-bg-s3 max-w-xs font-sans text-xs"
          >
            {bloatActive
              ? `${bloat} prompt-bloat warning${bloat === 1 ? '' : 's'} in last 24h — click for filtered traces (116-02)`
              : 'No prompt-bloat warnings in last 24h'}
          </TooltipContent>
        </Tooltip>

        {/* Lazy recall — neutral display; tooltip explains the metric. */}
        <Tooltip>
          <TooltipTrigger asChild>
            <Badge
              variant="outline"
              className="bg-bg-muted border-bg-s3 text-fg-2 font-mono text-[10px] uppercase cursor-default"
              data-testid="metric-counters-lazy-recall"
            >
              <span aria-hidden="true" className="mr-1">
                ↻
              </span>
              recall {typeof recall === 'number' ? recall : '—'}
            </Badge>
          </TooltipTrigger>
          <TooltipContent
            side="top"
            className="bg-bg-elevated text-fg-1 border border-bg-s3 max-w-xs font-sans text-xs"
          >
            Lazy recall: {typeof recall === 'number' ? recall : 'no data'} —
            times this agent invoked clawcode_memory_* tools in the last 24h
          </TooltipContent>
        </Tooltip>
      </div>
    </TooltipProvider>
  )
}

export default MetricCounters
