/**
 * Phase 116-04 F12 — per-turn trace waterfall.
 *
 * Custom SVG (no chart library). The trace_spans schema has no parent
 * pointer — spans are flat with `(turn_id, name, started_at, duration_ms,
 * metadata_json)`. Nesting in the waterfall is by NAME CONVENTION:
 *   - `context_assemble`         (turn root segment)
 *   - `first_token`              (turn root segment)
 *   - `first_visible_token`      (turn root segment)
 *   - `tool_call.<name>`         (one or many; rendered as children of turn)
 *   - `typing_indicator`         (turn root segment)
 *   - `end_to_end`               (turn root, full duration)
 *
 * Color band per SLO threshold:
 *   green  — span ≤ 1× threshold (or no threshold)
 *   amber  — span > 1× threshold
 *   red    — span > 2× threshold
 *
 * Hover tooltip: span name + raw ms + relative time from turn start.
 * (Percentile rank against the 24h aggregate is a forward-pointer; the
 * data exists on the latency endpoint but per-span percentile lookup
 * costs an extra round-trip per hover. Documented as deferred.)
 *
 * Lazy-loaded by AgentDetailDrawer via React.lazy() (bundle hygiene —
 * keeps the heavy SVG renderer out of the eager drawer chunk).
 */
import { useMemo } from 'react'
import {
  useTurnTrace,
  type TraceSpan,
  type TurnTraceResponse,
} from '@/hooks/useApi'

// SLO thresholds (ms) for color bands. Sonnet baseline — Opus rows render
// against the same threshold here; the per-tile color uses the cache.slos
// surface but the drawer F12 is for one specific turn so we use the
// canonical Sonnet thresholds for color hints. Operator can read the raw
// ms on hover regardless.
const SLO_THRESHOLDS_MS: Record<string, number> = {
  context_assemble: 800,
  first_token: 2000,
  first_visible_token: 2200,
  typing_indicator: 500,
  // tool_call.* uses the generic threshold; per-tool budgets land later.
  tool_call: 1500,
  end_to_end: 6000,
}

function thresholdFor(name: string): number | null {
  if (name in SLO_THRESHOLDS_MS) return SLO_THRESHOLDS_MS[name]!
  if (name.startsWith('tool_call')) return SLO_THRESHOLDS_MS['tool_call']!
  return null
}

function colorClassFor(durationMs: number, name: string): string {
  const t = thresholdFor(name)
  if (t === null) return 'fill-fg-3'
  if (durationMs > t * 2) return 'fill-danger'
  if (durationMs > t) return 'fill-warn'
  return 'fill-primary'
}

function isToolCall(name: string): boolean {
  return name.startsWith('tool_call')
}

function indentFor(name: string): number {
  // tool_call.* spans render indented to suggest the "nested under turn"
  // mental model. typing_indicator + the segment spans get zero indent.
  return isToolCall(name) ? 1 : 0
}

type WaterfallProps = {
  readonly agentName: string
  readonly turnId: string
  readonly onClose?: () => void
}

export function TraceWaterfall(props: WaterfallProps): JSX.Element {
  const traceQ = useTurnTrace(props.agentName, props.turnId)
  return (
    <div
      className="border border-bg-s3 rounded-md bg-bg-elevated p-4 space-y-3"
      data-testid="trace-waterfall"
    >
      <div className="flex items-center justify-between">
        <h3 className="font-display text-sm font-bold text-fg-1">
          Trace waterfall
        </h3>
        {props.onClose && (
          <button
            type="button"
            onClick={props.onClose}
            className="text-xs text-fg-3 hover:text-fg-1 font-mono"
          >
            close ✕
          </button>
        )}
      </div>
      <div className="text-xs font-mono text-fg-3 data">
        agent={props.agentName} · turn={props.turnId.slice(0, 12)}…
      </div>
      {traceQ.isLoading && (
        <p className="text-fg-2 font-sans text-sm">Loading trace…</p>
      )}
      {traceQ.isError && (
        <p className="text-danger font-sans text-sm">
          Failed to load trace: {(traceQ.error as Error).message}
        </p>
      )}
      {traceQ.data && <WaterfallSvg data={traceQ.data} />}
    </div>
  )
}

function WaterfallSvg(props: { readonly data: TurnTraceResponse }): JSX.Element {
  const { turn, spans } = props.data

  // Compute geometry. The end_to_end span IS the turn duration; clamp
  // anything beyond to the turn's total_ms so a stray clock-skew span
  // doesn't blow the scale.
  const computed = useMemo(() => {
    if (spans.length === 0) {
      return { sortedSpans: spans, turnStartMs: 0, scaleMs: turn.totalMs || 1 }
    }
    const turnStartMs = new Date(turn.startedAt).getTime()
    // Order: segments first, tool_call.* next; within each group by start.
    const ordering: ReadonlyArray<TraceSpan> = [...spans].sort((a, b) => {
      const aTool = isToolCall(a.name)
      const bTool = isToolCall(b.name)
      if (aTool && !bTool) return 1
      if (!aTool && bTool) return -1
      return (
        new Date(a.startedAt).getTime() - new Date(b.startedAt).getTime()
      )
    })
    const scaleMs = Math.max(
      turn.totalMs,
      ...spans.map((s) => {
        const startOffset = new Date(s.startedAt).getTime() - turnStartMs
        return startOffset + s.durationMs
      }),
    )
    return { sortedSpans: ordering, turnStartMs, scaleMs }
  }, [spans, turn.startedAt, turn.totalMs])

  if (computed.sortedSpans.length === 0) {
    return (
      <p className="text-fg-3 font-sans text-sm">
        No trace_spans recorded for this turn.
      </p>
    )
  }

  const ROW_HEIGHT = 22
  const ROW_GAP = 4
  const LEFT_LABEL_WIDTH = 180
  const RIGHT_DURATION_WIDTH = 80
  const TIMELINE_WIDTH = 380
  const TOTAL_WIDTH =
    LEFT_LABEL_WIDTH + TIMELINE_WIDTH + RIGHT_DURATION_WIDTH + 16
  const TOTAL_HEIGHT =
    computed.sortedSpans.length * (ROW_HEIGHT + ROW_GAP) + 8

  return (
    <div className="overflow-x-auto" data-testid="trace-waterfall-svg-wrap">
      <svg
        width={TOTAL_WIDTH}
        height={TOTAL_HEIGHT}
        role="img"
        aria-label={`Trace waterfall for turn ${turn.id}`}
        className="font-mono"
      >
        {/* Header strip — turn metadata */}
        <text
          x={0}
          y={12}
          className="fill-fg-3 text-[10px]"
        >
          0ms
        </text>
        <text
          x={LEFT_LABEL_WIDTH + TIMELINE_WIDTH}
          y={12}
          textAnchor="end"
          className="fill-fg-3 text-[10px]"
        >
          {computed.scaleMs}ms
        </text>
        {computed.sortedSpans.map((span, idx) => {
          const startOffset =
            new Date(span.startedAt).getTime() - computed.turnStartMs
          const startFrac = Math.max(0, startOffset) / computed.scaleMs
          const widthFrac = Math.max(0.005, span.durationMs / computed.scaleMs)
          const indent = indentFor(span.name) * 12
          const y = 18 + idx * (ROW_HEIGHT + ROW_GAP)
          const barX = LEFT_LABEL_WIDTH + startFrac * TIMELINE_WIDTH
          const barW = Math.max(2, widthFrac * TIMELINE_WIDTH)
          return (
            <g key={`${span.name}-${idx}`}>
              {/* Label column (left). Truncated via title element. */}
              <text
                x={indent}
                y={y + ROW_HEIGHT / 2 + 4}
                className="fill-fg-2 text-[11px]"
              >
                {span.name.length > 26
                  ? `${span.name.slice(0, 24)}…`
                  : span.name}
                <title>{span.name}</title>
              </text>
              {/* Timeline track (light grey) */}
              <rect
                x={LEFT_LABEL_WIDTH}
                y={y + 4}
                width={TIMELINE_WIDTH}
                height={ROW_HEIGHT - 8}
                className="fill-bg-muted"
                opacity={0.4}
              />
              {/* Span bar */}
              <rect
                x={barX}
                y={y + 4}
                width={barW}
                height={ROW_HEIGHT - 8}
                className={colorClassFor(span.durationMs, span.name)}
                rx={2}
                ry={2}
              >
                <title>
                  {span.name} · {span.durationMs}ms · started +
                  {Math.max(0, startOffset)}ms
                </title>
              </rect>
              {/* Duration label (right) */}
              <text
                x={LEFT_LABEL_WIDTH + TIMELINE_WIDTH + 8}
                y={y + ROW_HEIGHT / 2 + 4}
                className="fill-fg-2 text-[11px] data"
              >
                {span.durationMs}ms
              </text>
            </g>
          )
        })}
      </svg>
      {turn.cacheEvictionExpected && (
        <p className="text-warn text-xs font-mono mt-2">
          ⚠ cache_eviction_expected — this turn likely paid a cold-cache
          first-token tax.
        </p>
      )}
      <p className="text-fg-3 text-[10px] font-sans mt-2">
        Hover a bar for the raw duration. SLO color bands use Sonnet
        thresholds; Opus turns may show amber/red even when within
        model-tier expectations.
      </p>
    </div>
  )
}

export default TraceWaterfall
