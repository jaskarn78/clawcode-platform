/**
 * Phase 116-04 F11 — three-panel agent detail drawer.
 *
 * Right-side <Sheet> opening at full-screen mobile / 90% tablet /
 * 60% desktop. Three columns on lg+:
 *   - Left   = config snapshot (model/tier/budget summary + "Edit config")
 *   - Center = Discord transcript (last 50 turns, click → opens F12
 *              waterfall in-place; live `conversation-turn` SSE events
 *              push new turns into the head of the list)
 *   - Right  = F08 counters (existing) + F14 MemoryPanel + F13 IpcInbox
 *              (scoped to this agent) + F15 DreamQueue
 *
 * F12 TraceWaterfall is React.lazy()-loaded so the heavy SVG renderer
 * stays out of the eager drawer chunk.
 *
 * Live transcript: subscribes to subscribeConversationTurns (the
 * conversation-turn SSE bus introduced in 116-03). Events carrying
 * matching `agent` prepend a "live" placeholder row to the list; the
 * next refetch (or the user navigating away and back) replaces it with
 * the persisted turn from /api/agents/:name/recent-turns.
 */
import { lazy, Suspense, useEffect, useState } from 'react'
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from '@/components/ui/sheet'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import {
  useAgentConfig,
  useRecentTurns,
  type RecentTurnRow,
} from '@/hooks/useApi'
import {
  subscribeConversationTurns,
  type ConversationTurnEvent,
} from '@/hooks/useSse'
import { MemoryPanel } from './MemoryPanel'
import { DreamQueue } from './DreamQueue'
import { IpcInbox } from './IpcInbox'
// Phase 116-05 — opportunistic drawer enrichments (F02 SLO gauges +
// F17 cost summary). F04 7d sparkline deferred — needs new backend.
import { CostSummaryCard, SloSegmentGauges } from './DrawerExtras'
import { ActivityHeatmap } from './ActivityHeatmap'

// Lazy-load the F12 waterfall. Reason: it's the heaviest content in the
// drawer (custom SVG renderer + percentile math) and only mounts on
// turn click. Splitting it keeps the eager drawer chunk small.
const TraceWaterfall = lazy(() =>
  import('./TraceWaterfall').then((m) => ({ default: m.TraceWaterfall })),
)

function shortRole(role: string): string {
  if (role === 'user') return 'U'
  if (role === 'assistant') return 'A'
  return role.slice(0, 1).toUpperCase()
}

function relTime(ts: string): string {
  const age = Date.now() - new Date(ts).getTime()
  if (age < 0) return 'just now'
  const sec = Math.floor(age / 1000)
  if (sec < 60) return `${sec}s ago`
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}m ago`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h ago`
  return `${Math.floor(hr / 24)}d ago`
}

export type AgentDetailDrawerProps = {
  readonly agentName: string | null
  readonly open: boolean
  readonly onOpenChange: (open: boolean) => void
  /** When clicked, the F26 config editor opens for this agent. */
  readonly onEditConfig?: (agentName: string) => void
}

export function AgentDetailDrawer(
  props: AgentDetailDrawerProps,
): JSX.Element {
  // Subscribe to conversation-turn SSE events while the drawer is open.
  // The bus pattern (116-03 F27) fires per-turn deltas; we maintain a
  // local "live" ring buffer of the last N turn IDs that arrived after
  // the drawer mount, and prepend them as placeholders to the persisted
  // list returned by /api/agents/:name/recent-turns.
  const [liveTurns, setLiveTurns] = useState<readonly ConversationTurnEvent[]>(
    [],
  )

  useEffect(() => {
    if (!props.open || !props.agentName) {
      return
    }
    setLiveTurns([])
    const unsubscribe = subscribeConversationTurns((evt) => {
      if (evt.agent !== props.agentName) return
      setLiveTurns((prev) => [evt, ...prev].slice(0, 20))
    })
    return () => {
      unsubscribe()
    }
  }, [props.open, props.agentName])

  return (
    <Sheet open={props.open} onOpenChange={props.onOpenChange}>
      <SheetContent
        side="right"
        // 116-postdeploy fix-pass — explicit mobile full-screen override.
        // The sheet.tsx primitive's right-variant already declares
        // `w-full md:w-[90%] lg:w-[60%]`, but operator-screenshot evidence
        // showed bleed-through on a real iPhone (likely a stale-build /
        // cache artifact). This duplicates the intent at the component
        // surface so the contract is explicit: phones get the full 100vw
        // (375 → 767), tablets cap at max-w-2xl, desktops at max-w-3xl.
        // Project Tailwind breakpoints (tailwind.config.js): sm=375 (iPhone
        // SE), md=768 (tablet), lg=1024 (laptop). Transition at md, not
        // sm — sm fires at 375px which is the very bug we're fixing.
        // 116-postdeploy 2026-05-12 (round 2) — operator screenshot showed
        // SLO segments + Today's usage right-column elements overlapping the
        // transcript center column. Root cause: the drawer was capped at
        // lg:max-w-3xl (768px) but the internal three-panel grid triggers
        // `lg:grid-cols-3` based on VIEWPORT width, not container width. With
        // 768px ÷ 3 ≈ 256px per column, the panels couldn't fit their content
        // and stacked-overlapped instead. Fix: scale the drawer up to leave
        // each column ~340px+ on desktop. md gets 2 cols (~400px each), xl+
        // gets 3 cols (~480px each).
        className="p-0 overflow-hidden flex flex-col w-full max-w-full md:w-[85vw] md:max-w-3xl lg:max-w-5xl xl:max-w-7xl"
        data-testid="agent-detail-drawer"
      >
        {props.agentName && (
          <DrawerBody
            agentName={props.agentName}
            liveTurns={liveTurns}
            onEditConfig={props.onEditConfig}
          />
        )}
      </SheetContent>
    </Sheet>
  )
}

function DrawerBody(props: {
  readonly agentName: string
  readonly liveTurns: readonly ConversationTurnEvent[]
  readonly onEditConfig?: (agentName: string) => void
}): JSX.Element {
  const configQ = useAgentConfig(props.agentName)
  const turnsQ = useRecentTurns(props.agentName, 50)
  const [selectedTurnId, setSelectedTurnId] = useState<string | null>(null)

  const resolved = (configQ.data?.resolved ?? {}) as Record<string, unknown>
  const model = (resolved.model as string | undefined) ?? '—'
  const tier = (resolved.tier as string | undefined) ?? '—'
  const effort = (resolved.effort as string | undefined) ?? '—'
  const workspacePath =
    (resolved.workspacePath as string | undefined) ??
    (resolved.workspace_path as string | undefined) ??
    '—'
  const memoryPath = (resolved.memoryPath as string | undefined) ?? '—'

  return (
    <div className="flex flex-col h-full bg-bg-base text-fg-1">
      <SheetHeader className="border-b border-bg-s3 px-4 py-3 shrink-0">
        <div className="flex items-center justify-between">
          <div>
            <SheetTitle className="font-display text-lg">
              {props.agentName}
            </SheetTitle>
            <SheetDescription className="text-xs font-mono text-fg-3">
              {model} · {tier} · effort={effort}
            </SheetDescription>
          </div>
          {props.onEditConfig && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => props.onEditConfig?.(props.agentName)}
              className="font-sans text-xs"
            >
              Edit config
            </Button>
          )}
        </div>
      </SheetHeader>

      {/* 116-postdeploy 2026-05-12 — grid scales 1 col → 2 cols at md (768px,
          tablet) → 3 cols at xl (1280px, wide desktop). lg (1024px) is the
          awkward middle: drawer is wide enough at lg:max-w-5xl (1024px) to
          host 2 panels comfortably (~480px each) but 3 squeezes them. xl
          drawer (max-w-7xl = 1280px) hosts 3 cleanly (~410px each). */}
      <div className="flex-1 overflow-y-auto px-4 py-3 grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
        {/* LEFT — config snapshot */}
        <aside
          className="space-y-3 border border-bg-s3 rounded-md bg-bg-elevated p-3"
          data-testid="drawer-config-snapshot"
        >
          <h3 className="font-display text-sm font-bold text-fg-1">
            Config snapshot
          </h3>
          {configQ.isLoading && (
            <p className="text-fg-2 text-sm">Loading config…</p>
          )}
          {configQ.isError && (
            <p className="text-danger text-xs">
              {(configQ.error as Error).message}
            </p>
          )}
          {configQ.data && (
            <dl className="space-y-1 text-xs font-mono">
              <ConfigRow k="model" v={model} />
              <ConfigRow k="tier" v={tier} />
              <ConfigRow k="effort" v={effort} />
              <ConfigRow k="workspace" v={workspacePath} mono />
              <ConfigRow k="memory" v={memoryPath} mono />
            </dl>
          )}
          {configQ.data?.hotReloadableFields && (
            <div className="pt-2 border-t border-bg-s3 text-[10px] font-sans text-fg-3 space-y-1">
              <div>
                <span className="uppercase tracking-wide">hot-reload:</span>{' '}
                {configQ.data.hotReloadableFields.length} fields
              </div>
              <div>
                <span className="uppercase tracking-wide">restart:</span>{' '}
                {configQ.data.restartRequiredFields.length} fields
              </div>
            </div>
          )}
        </aside>

        {/* CENTER — Discord transcript */}
        <main
          className="space-y-3 lg:col-span-1 border border-bg-s3 rounded-md bg-bg-elevated p-3 min-h-[400px]"
          data-testid="drawer-transcript"
        >
          <h3 className="font-display text-sm font-bold text-fg-1">
            Transcript
          </h3>
          {turnsQ.isLoading && (
            <p className="text-fg-2 text-sm">Loading transcript…</p>
          )}
          {turnsQ.isError && (
            <p className="text-danger text-xs">
              {(turnsQ.error as Error).message}
            </p>
          )}

          {/* Live SSE indicator — head of list */}
          {props.liveTurns.length > 0 && (
            <ul className="space-y-1 border-l-2 border-primary/60 pl-2">
              {props.liveTurns.map((evt) => (
                <li
                  key={evt.turnId}
                  className="text-[11px] font-mono text-fg-3"
                  data-testid="drawer-transcript-live"
                >
                  <span className="text-primary mr-1">●</span>
                  {shortRole(evt.role)} · {relTime(evt.ts)} · live
                </li>
              ))}
            </ul>
          )}

          {turnsQ.data && (
            <ul className="space-y-1 max-h-[60vh] overflow-y-auto">
              {turnsQ.data.turns.map((t) => (
                <TurnRow
                  key={t.turnId}
                  turn={t}
                  selected={selectedTurnId === t.turnId}
                  onSelect={() => setSelectedTurnId(t.turnId)}
                />
              ))}
              {turnsQ.data.turns.length === 0 && (
                <li className="text-[11px] text-fg-3 font-mono">
                  No turns recorded yet.
                </li>
              )}
            </ul>
          )}

          {/* Trace waterfall — lazy-loaded, opens in-place when a turn
              is clicked. */}
          {selectedTurnId && (
            <Suspense
              fallback={
                <p className="text-fg-2 text-xs">Loading waterfall…</p>
              }
            >
              <TraceWaterfall
                agentName={props.agentName}
                turnId={selectedTurnId}
                onClose={() => setSelectedTurnId(null)}
              />
            </Suspense>
          )}
        </main>

        {/* RIGHT — memory, IPC inbox, dream queue, SLO + cost (116-05). */}
        <aside
          className="space-y-3"
          data-testid="drawer-right-column"
        >
          {/* 116-05 enrichments — small surfaces; existing panels stay
              below to preserve scroll memory. */}
          <SloSegmentGauges agentName={props.agentName} />
          <CostSummaryCard agentName={props.agentName} />
          {/* 116-06 F18 — per-agent 30-day activity heatmap. Compact mode
              keeps the SVG inside the drawer's right-column width. */}
          <ActivityHeatmap agent={props.agentName ?? undefined} compact />
          <MemoryPanel agentName={props.agentName} />
          <IpcInbox scope={props.agentName} />
          <DreamQueue agentName={props.agentName} />
        </aside>
      </div>
    </div>
  )
}

function ConfigRow(props: {
  readonly k: string
  readonly v: string
  readonly mono?: boolean
}): JSX.Element {
  return (
    <div className="flex justify-between gap-2">
      <dt className="text-fg-3 uppercase tracking-wide text-[10px]">
        {props.k}
      </dt>
      <dd
        className={`${props.mono ? 'data text-[10px]' : 'data'} text-fg-1 truncate`}
        title={props.v}
      >
        {props.v}
      </dd>
    </div>
  )
}

function TurnRow(props: {
  readonly turn: RecentTurnRow
  readonly selected: boolean
  readonly onSelect: () => void
}): JSX.Element {
  const { turn } = props
  const preview = turn.content.length > 120
    ? `${turn.content.slice(0, 120)}…`
    : turn.content
  return (
    <li>
      <button
        type="button"
        onClick={props.onSelect}
        className={`w-full text-left text-[11px] font-mono p-1.5 rounded hover:bg-bg-muted/40 border ${
          props.selected
            ? 'border-primary/60 bg-bg-muted/30'
            : 'border-transparent'
        }`}
      >
        <div className="flex items-baseline justify-between mb-1">
          <span className="flex items-baseline gap-1">
            <Badge
              variant="outline"
              className="text-[9px] py-0 px-1 border-bg-s3 font-mono"
            >
              {shortRole(turn.role)}
            </Badge>
            {!turn.isTrustedChannel && (
              <span className="text-warn text-[9px]" title="untrusted channel">
                ⚠
              </span>
            )}
          </span>
          <span className="text-fg-3 data">{relTime(turn.createdAt)}</span>
        </div>
        <p className="text-fg-2 whitespace-pre-wrap break-words">{preview}</p>
      </button>
    </li>
  )
}

export default AgentDetailDrawer
