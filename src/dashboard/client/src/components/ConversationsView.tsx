/**
 * Phase 116-UI redesign (2026-05) — Conversations view.
 *
 * "Transcript-first reading experience". Hierarchy from top to bottom:
 *
 *   ┌─────────────────────────────────────────────────────────────┐
 *   │ HEADER                                                       │
 *   │  • Page title (Cabinet Grotesk display) + live-status pip   │
 *   │  • Live tape (horizontal mono ticker, last 8 fleet turns)   │
 *   │  • "Press / to search" hint + Cmd+K affordance              │
 *   └─────────────────────────────────────────────────────────────┘
 *   ┌──────────┬─────────────────────┬──────────────────────────┐
 *   │ LEFT     │ MIDDLE              │ RIGHT (transcript)        │
 *   │ Agent    │ Session cards for   │ Reading-experience pane   │
 *   │ picker   │ selected agent      │ (only when a session is   │
 *   │ (chips)  │ (status / count /   │  pinned). Max ~70ch       │
 *   │          │  first-msg preview) │ measure, role-distinguished│
 *   └──────────┴─────────────────────┴──────────────────────────┘
 *
 * Key design moves vs the 116-03 / 116-postdeploy version:
 *
 *  - Live tape moved OUT of the sidebar into the page header — became a
 *    horizontal ticker, mono-font, scroll-on-overflow. No more vertical
 *    stacking competing with agents + sessions for the same eyebrow
 *    column.
 *  - Search dialog (`/` to open) instead of a permanent input chrome.
 *    Cleaner default view, search is summoned not always present.
 *  - Session rows became cards with status pill, turn-count, timestamps,
 *    and a first-message preview. Click pins to the transcript.
 *  - Transcript pane gained typographic care: max-measure ~70ch, line-
 *    height generous, role differentiation via left-rail accent
 *    (emerald for assistant, info-blue for user, pink for active
 *    streaming turn), hover-revealed token footer.
 *  - Active-streaming animation: when an SSE conversation-turn lands
 *    on the pinned session, the newest turn gets the pink #ff3366 left
 *    rail for 4 seconds then settles back.
 *  - Empty states: designed not "no results" plain text.
 *
 * Tape ring buffer trimmed from 30 to a header-friendly 8 entries.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import {
  subscribeConversationTurns,
  type ConversationTurnEvent,
} from '@/hooks/useSse'
import {
  useAgents,
  useConversationSearch,
  useRecentConversations,
  useSessionTurns,
  SESSION_TURNS_QUERY_KEY,
  type ConversationSessionRow,
  type RecentTurnRow,
} from '@/hooks/useApi'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from '@/components/ui/sheet'

const TAPE_MAX = 8
const STREAMING_FLASH_MS = 4000

// Tailwind `lg` breakpoint (1024px). Matches the lg: utility on the grid
// + the right-column aside's `hidden lg:block`.
const LG_BREAKPOINT_PX = 1024

/**
 * Viewport hook — returns true when the window is below the lg breakpoint.
 * Pattern lifted from CommandPalette's `useIsMobile` (md=768). SSR-safe.
 *
 * 116-postdeploy 2026-05-12 — needed so the mobile transcript Sheet's
 * `open` prop is FALSE on desktop. Without this gate Radix renders the
 * SheetOverlay (sibling of SheetContent) even when SheetContent has
 * `lg:hidden`, dimming the entire desktop view behind a transparent
 * panel when a session is pinned.
 */
function useIsBelowLg(): boolean {
  const [below, setBelow] = useState(() => {
    if (typeof window === 'undefined') return false
    return window.innerWidth < LG_BREAKPOINT_PX
  })
  useEffect(() => {
    if (typeof window === 'undefined') return
    const onResize = () => setBelow(window.innerWidth < LG_BREAKPOINT_PX)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])
  return below
}

function relativeTime(iso: string): string {
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return iso
  const dms = Date.now() - t
  if (dms < 0) return 'now'
  if (dms < 60_000) return `${Math.round(dms / 1000)}s ago`
  if (dms < 3_600_000) return `${Math.round(dms / 60_000)}m ago`
  if (dms < 86_400_000) return `${Math.round(dms / 3_600_000)}h ago`
  return new Date(t).toLocaleString()
}

export function ConversationsView() {
  const agentsQ = useAgents()
  const allAgents = useMemo(() => {
    const payload = agentsQ.data as
      | { agents?: ReadonlyArray<{ name: string }> }
      | undefined
    return (payload?.agents ?? []).map((a) => a.name).sort()
  }, [agentsQ.data])

  const [selectedAgent, setSelectedAgent] = useState<string | null>(null)
  const [pinnedAgent, setPinnedAgent] = useState<string | null>(null)
  const [pinnedSessionId, setPinnedSessionId] = useState<string | null>(null)
  const queryClient = useQueryClient()
  const isBelowLg = useIsBelowLg()

  // Search dialog state
  const [searchOpen, setSearchOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [searchAgent, setSearchAgent] = useState<string>('')
  const [searchEnabled, setSearchEnabled] = useState(false)

  // Live tape — ring buffer
  const [tape, setTape] = useState<ConversationTurnEvent[]>([])
  // Track most recent streaming turn for transient pink highlight
  const [streamingTurnId, setStreamingTurnId] = useState<string | null>(null)
  const streamingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    const unsub = subscribeConversationTurns((evt) => {
      setTape((curr) => [evt, ...curr].slice(0, TAPE_MAX))
      if (pinnedAgent && evt.agent === pinnedAgent) {
        queryClient.invalidateQueries({
          queryKey: [SESSION_TURNS_QUERY_KEY, pinnedAgent, pinnedSessionId],
        })
        setStreamingTurnId(evt.turnId)
        if (streamingTimerRef.current) clearTimeout(streamingTimerRef.current)
        streamingTimerRef.current = setTimeout(
          () => setStreamingTurnId(null),
          STREAMING_FLASH_MS,
        )
      }
    })
    return () => {
      unsub()
      if (streamingTimerRef.current) clearTimeout(streamingTimerRef.current)
    }
  }, [pinnedAgent, pinnedSessionId, queryClient])

  // Keyboard shortcut: "/" opens search (when no input focused)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== '/') return
      const tgt = e.target as HTMLElement | null
      if (
        tgt &&
        (tgt.tagName === 'INPUT' ||
          tgt.tagName === 'TEXTAREA' ||
          tgt.isContentEditable)
      ) {
        return
      }
      e.preventDefault()
      setSearchOpen(true)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const recentQ = useRecentConversations(selectedAgent)
  const searchQ = useConversationSearch(
    query,
    searchAgent === '' ? null : searchAgent,
    searchEnabled && query.length > 0,
  )
  const transcriptQ = useSessionTurns(pinnedAgent, pinnedSessionId)

  // Streaming = a turn landed within last 10s for any agent
  const isLiveActivity = tape.length > 0 &&
    Date.now() - Date.parse(tape[0].ts) < 10_000

  return (
    <div className="mx-auto max-w-[1600px] px-7 py-6">
      {/* dash-redesign sweep — section-head pattern. The
          StatusPip live indicator anchors inline next to the title;
          subtitle gives operator context. Search button stays right-
          aligned in the same header row. */}
      <header className="mb-5 space-y-4">
        <div className="section-head">
          <div className="flex items-center gap-3">
            <h2>Conversations</h2>
            <StatusPip live={isLiveActivity} />
            <span className="sub">cross-agent live transcript tape</span>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setSearchOpen(true)}
              className="group flex items-center gap-2 rounded-md border border-border bg-bg-elevated px-3 py-1.5 text-xs text-fg-3 transition-colors hover:border-primary/40 hover:text-fg-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-bg-base"
              aria-label="Search conversations"
            >
              <span aria-hidden>⌕</span>
              <span className="hidden sm:inline">Search transcripts</span>
              <kbd className="rounded border border-border bg-bg-muted px-1.5 py-0.5 font-mono text-[10px] text-fg-2">
                /
              </kbd>
            </button>
          </div>
        </div>

        {/* Live tape — horizontal ticker */}
        <LiveTape tape={tape} onAgentClick={(name) => setSelectedAgent(name)} />
      </header>

      {/* THREE-COLUMN BODY ================================================ */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[200px_1fr_minmax(0,560px)]">
        {/* LEFT — Agent picker (chips) */}
        <aside className="lg:sticky lg:top-6 lg:self-start">
          <div className="mb-2 px-1 text-[10px] font-medium uppercase tracking-wider text-fg-3">
            Agents · {allAgents.length}
          </div>
          {allAgents.length === 0 ? (
            <p className="px-1 text-xs text-fg-3">No agents.</p>
          ) : (
            <ul
              role="listbox"
              aria-label="Agent picker"
              className="space-y-0.5"
            >
              {allAgents.map((name) => {
                const selected = selectedAgent === name
                const tapeHit = tape.find((t) => t.agent === name)
                return (
                  <li key={name}>
                    <button
                      type="button"
                      role="option"
                      aria-selected={selected}
                      onClick={() => setSelectedAgent(name)}
                      className={
                        'group flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ' +
                        (selected
                          ? 'bg-bg-elevated text-fg-1 shadow-sm ring-1 ring-primary/40'
                          : 'text-fg-2 hover:bg-bg-elevated/60 hover:text-fg-1')
                      }
                    >
                      <span
                        aria-hidden
                        className={
                          'h-1.5 w-1.5 rounded-full ' +
                          (tapeHit ? 'bg-primary animate-pulse' : 'bg-fg-3/40')
                        }
                      />
                      <span className="truncate font-mono text-xs">{name}</span>
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
        </aside>

        {/* MIDDLE — Session cards */}
        <section className="min-w-0">
          {!selectedAgent ? (
            <EmptyState
              title="Pick an agent to read"
              body="Select an agent from the left rail to see their recent sessions. Or press / to search across the fleet."
            />
          ) : recentQ.isLoading ? (
            <SessionsSkeleton />
          ) : recentQ.data && recentQ.data.sessions.length === 0 ? (
            <EmptyState
              title="No conversations yet"
              body={`${selectedAgent} hasn't had a session recorded. Once a turn lands it'll appear here.`}
            />
          ) : (
            <div className="space-y-3">
              <div className="mb-1 flex items-baseline justify-between">
                <h2 className="font-display text-sm font-medium uppercase tracking-wider text-fg-3">
                  {selectedAgent} · sessions
                </h2>
                <span className="font-mono text-[10px] text-fg-3">
                  {recentQ.data?.sessions.length ?? 0} total
                </span>
              </div>
              <ul className="space-y-2">
                {recentQ.data?.sessions.map((s) => (
                  <SessionCard
                    key={s.id}
                    session={s}
                    pinned={
                      pinnedAgent === selectedAgent && pinnedSessionId === s.id
                    }
                    onClick={() => {
                      setPinnedAgent(selectedAgent)
                      setPinnedSessionId(s.id)
                    }}
                  />
                ))}
              </ul>
            </div>
          )}
        </section>

        {/* RIGHT — Transcript.
            116-postdeploy 2026-05-12 fix: `hidden lg:block` hides the
            right-column aside on phones/tablets. On <lg the transcript
            previously rendered BELOW the session list (single-column
            grid stack) and went off-screen — operator clicked a session,
            saw nothing happen. Sheet variant below takes over on <lg
            using the same pinned-session truth (`pinnedSessionId`). */}
        <aside className="hidden min-w-0 lg:block">
          {pinnedAgent && pinnedSessionId ? (
            <TranscriptPane
              agent={pinnedAgent}
              sessionId={pinnedSessionId}
              isLoading={transcriptQ.isLoading}
              error={transcriptQ.error as Error | null | undefined}
              turns={transcriptQ.data?.turns ?? null}
              streamingTurnId={streamingTurnId}
              onClose={() => {
                setPinnedAgent(null)
                setPinnedSessionId(null)
              }}
            />
          ) : (
            <div className="rounded-lg border border-dashed border-border bg-bg-elevated/40 p-8 text-center">
              <p className="font-display text-sm font-medium text-fg-2">
                No session selected
              </p>
              <p className="mt-1 text-xs text-fg-3">
                Click a session card to read the full transcript.
              </p>
            </div>
          )}
        </aside>
      </div>

      {/* MOBILE / TABLET — transcript Sheet ================================ */}
      {/* 116-postdeploy 2026-05-12 fix: on <lg the right-column aside is
          hidden; instead, opening a session triggers a full-screen Sheet
          containing the same TranscriptPane.

          Verification-pass fix (same day): the `open` prop is gated by
          `isBelowLg && pinnedSessionId !== null`. Without the viewport
          gate Radix renders SheetOverlay (a sibling of SheetContent
          inside the portal), which dims the entire screen on desktop
          even when SheetContent has `lg:hidden`. `lg:hidden` on the
          content is kept as defense-in-depth; the open-gate is the real
          fix. */}
      <Sheet
        open={isBelowLg && pinnedSessionId !== null}
        onOpenChange={(open) => {
          if (!open) {
            setPinnedAgent(null)
            setPinnedSessionId(null)
          }
        }}
      >
        <SheetContent
          side="right"
          className="flex flex-col p-0 lg:hidden w-full max-w-full md:w-3/4 md:max-w-2xl"
          data-testid="conversations-transcript-sheet"
        >
          <SheetHeader className="border-b border-border bg-bg-muted/50 px-4 py-3 text-left">
            <SheetTitle className="font-display text-sm font-medium text-fg-1">
              Transcript
            </SheetTitle>
            <SheetDescription className="truncate font-mono text-[10px] text-fg-3">
              {pinnedAgent ?? ''}
              {pinnedSessionId ? ` · ${pinnedSessionId.slice(0, 12)}` : ''}
            </SheetDescription>
          </SheetHeader>
          <div className="flex-1 overflow-y-auto">
            {pinnedAgent && pinnedSessionId && (
              <TranscriptPane
                agent={pinnedAgent}
                sessionId={pinnedSessionId}
                isLoading={transcriptQ.isLoading}
                error={transcriptQ.error as Error | null | undefined}
                turns={transcriptQ.data?.turns ?? null}
                streamingTurnId={streamingTurnId}
                onClose={() => {
                  setPinnedAgent(null)
                  setPinnedSessionId(null)
                }}
                /* The Sheet provides its own header; ask the pane to drop
                   its own internal header on mobile so we don't double up. */
                hideInternalHeader
              />
            )}
          </div>
        </SheetContent>
      </Sheet>

      {/* SEARCH DIALOG ==================================================== */}
      <Dialog open={searchOpen} onOpenChange={setSearchOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle className="font-display">
              Search transcripts
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="flex gap-2">
              <input
                autoFocus
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value)
                  setSearchEnabled(false)
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && query.length > 0) {
                    setSearchEnabled(true)
                  }
                }}
                placeholder="FTS5 query across all turns…"
                className="min-w-0 flex-1 rounded-md border border-border bg-bg-base px-3 py-2 font-mono text-sm text-fg-1 placeholder:text-fg-3 focus:border-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
              <select
                value={searchAgent}
                onChange={(e) => setSearchAgent(e.target.value)}
                className="rounded-md border border-border bg-bg-base px-2 py-2 text-sm text-fg-1"
              >
                <option value="">all agents</option>
                {allAgents.map((a) => (
                  <option key={a} value={a}>
                    {a}
                  </option>
                ))}
              </select>
              <Button
                size="sm"
                disabled={query.length === 0}
                onClick={() => setSearchEnabled(true)}
              >
                Search
              </Button>
            </div>
            {searchQ.isLoading && (
              <p className="text-xs text-fg-3">searching…</p>
            )}
            {searchQ.error && (
              <p className="text-xs text-destructive">
                {(searchQ.error as Error).message}
              </p>
            )}
            {searchQ.data && (
              <>
                <p className="text-xs text-fg-3">
                  {searchQ.data.hits.length} hits ·{' '}
                  {searchQ.data.totalMatches} total across{' '}
                  {searchQ.data.agentsQueried.length} agent
                  {searchQ.data.agentsQueried.length === 1 ? '' : 's'}
                </p>
                {searchQ.data.hits.length === 0 ? (
                  <p className="rounded-md border border-dashed border-border p-4 text-center text-xs text-fg-3">
                    No matches. Try a broader query.
                  </p>
                ) : (
                  <ul className="max-h-[50vh] space-y-2 overflow-y-auto pr-2">
                    {searchQ.data.hits.map((hit) => (
                      <li
                        key={hit.turnId}
                        className="cursor-pointer rounded-md border border-border bg-bg-elevated p-3 text-sm transition-colors hover:border-primary/40"
                        onClick={() => {
                          // For now, just close — wiring jump-to-session
                          // would require the backend to return sessionId
                          // in search hits.
                          setSelectedAgent(hit.agent)
                          setSearchOpen(false)
                        }}
                      >
                        <div className="mb-1 flex items-center gap-2 text-[10px] text-fg-3">
                          <RoleBadge role={hit.role} />
                          <span className="font-mono">{hit.agent}</span>
                          <span>{relativeTime(hit.createdAt)}</span>
                          <span className="ml-auto font-mono">
                            bm25 {hit.bm25Score.toFixed(2)}
                          </span>
                        </div>
                        <p className="line-clamp-3 whitespace-pre-wrap break-words text-xs leading-relaxed text-fg-2">
                          {hit.content}
                        </p>
                      </li>
                    ))}
                  </ul>
                )}
              </>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}

/* ====================================================================== */
/* SUB-COMPONENTS                                                          */
/* ====================================================================== */

function StatusPip(props: { readonly live: boolean }) {
  return (
    <span
      className={
        'inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider ' +
        (props.live
          ? 'bg-primary/10 text-primary'
          : 'bg-bg-muted text-fg-3')
      }
      aria-live="polite"
    >
      <span
        className={
          'h-1.5 w-1.5 rounded-full ' +
          (props.live ? 'bg-primary animate-pulse' : 'bg-fg-3')
        }
        aria-hidden
      />
      {props.live ? 'Live' : 'Idle'}
    </span>
  )
}

function LiveTape(props: {
  readonly tape: readonly ConversationTurnEvent[]
  readonly onAgentClick: (agent: string) => void
}) {
  const { tape, onAgentClick } = props
  if (tape.length === 0) {
    return (
      <div className="rounded-md border border-dashed border-border bg-bg-elevated/40 px-3 py-2">
        <p className="font-mono text-[11px] text-fg-3">
          Waiting for live conversation-turn events…
        </p>
      </div>
    )
  }
  return (
    <div className="overflow-hidden rounded-md border border-border bg-bg-elevated">
      <div className="flex items-stretch divide-x divide-border overflow-x-auto">
        <div className="flex shrink-0 items-center gap-2 bg-bg-muted px-3 py-2">
          <span className="h-1.5 w-1.5 rounded-full bg-primary animate-pulse" />
          <span className="font-display text-[10px] font-medium uppercase tracking-wider text-fg-3">
            Live
          </span>
        </div>
        {tape.map((evt) => (
          <button
            key={evt.turnId}
            onClick={() => onAgentClick(evt.agent)}
            className="flex shrink-0 items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-bg-muted focus-visible:bg-bg-muted focus-visible:outline-none"
            title={`${evt.agent} · ${evt.role} · ${evt.ts}`}
          >
            <RoleBadge role={evt.role} compact />
            <span className="font-mono text-[11px] text-fg-1">
              {evt.agent}
            </span>
            <span className="font-mono text-[10px] text-fg-3">
              {relativeTime(evt.ts)}
            </span>
          </button>
        ))}
      </div>
    </div>
  )
}

function RoleBadge(props: {
  readonly role: 'user' | 'assistant' | 'system' | string
  readonly compact?: boolean
}) {
  const role = props.role
  const compact = props.compact
  const cls =
    role === 'user'
      ? 'bg-info/15 text-info'
      : role === 'assistant'
      ? 'bg-primary/15 text-primary'
      : 'bg-bg-muted text-fg-3'
  return (
    <span
      className={
        'rounded font-mono font-medium uppercase tracking-wider ' +
        cls +
        ' ' +
        (compact ? 'px-1 py-0 text-[9px]' : 'px-1.5 py-0.5 text-[10px]')
      }
    >
      {role}
    </span>
  )
}

function SessionCard(props: {
  readonly session: ConversationSessionRow
  readonly pinned: boolean
  readonly onClick: () => void
}) {
  const { session, pinned, onClick } = props
  const statusCls =
    session.status === 'active'
      ? 'bg-primary/15 text-primary'
      : session.status === 'failed' || session.status === 'errored'
      ? 'bg-destructive/15 text-destructive'
      : 'bg-bg-muted text-fg-2'
  return (
    <li>
      <button
        type="button"
        onClick={onClick}
        aria-pressed={pinned}
        className={
          'block w-full rounded-lg border bg-bg-elevated p-4 text-left transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ' +
          (pinned
            ? 'border-primary/60 shadow-md ring-1 ring-primary/20'
            : 'border-border hover:-translate-y-px hover:border-primary/30 hover:shadow-sm')
        }
      >
        <div className="mb-2 flex items-center gap-2 text-[10px] text-fg-3">
          <span
            className={
              'rounded-full px-2 py-0.5 font-medium uppercase tracking-wider ' +
              statusCls
            }
          >
            {session.status}
          </span>
          <span className="font-mono">{session.id.slice(0, 8)}</span>
          <span className="ml-auto font-mono">
            {relativeTime(session.startedAt)}
          </span>
        </div>
        <div className="flex items-baseline gap-3 text-sm">
          <span className="font-display font-medium text-fg-1">
            {session.turnCount} turn{session.turnCount === 1 ? '' : 's'}
          </span>
          {session.totalTokens !== null && (
            <span className="font-mono text-xs text-fg-3">
              {session.totalTokens.toLocaleString()} tokens
            </span>
          )}
        </div>
      </button>
    </li>
  )
}

function SessionsSkeleton() {
  return (
    <div className="space-y-2">
      {[0, 1, 2].map((i) => (
        <div
          key={i}
          className="h-[88px] animate-pulse rounded-lg border border-border bg-bg-elevated/40"
        />
      ))}
    </div>
  )
}

function EmptyState(props: {
  readonly title: string
  readonly body: string
}) {
  // dash-redesign sweep — align with MissionRail's calm-mono empty
  // voice via .feed-empty. Title and body fold into a single line.
  return (
    <div className="feed-empty">
      <strong className="text-fg-2">{props.title}.</strong> {props.body}
    </div>
  )
}

/* ====================================================================== */
/* TRANSCRIPT PANE — the reading experience                                */
/* ====================================================================== */

function TranscriptPane(props: {
  readonly agent: string
  readonly sessionId: string
  readonly isLoading: boolean
  readonly error: Error | null | undefined
  readonly turns: readonly RecentTurnRow[] | null
  readonly streamingTurnId: string | null
  readonly onClose: () => void
  /**
   * 116-postdeploy 2026-05-12: when the pane is rendered inside the mobile
   * Sheet, the Sheet supplies its own SheetHeader (with its own close
   * affordance from the SheetContent overlay). Set this to suppress the
   * pane's own internal header to avoid double-chrome.
   */
  readonly hideInternalHeader?: boolean
}) {
  const {
    agent,
    sessionId,
    isLoading,
    error,
    turns,
    streamingTurnId,
    onClose,
    hideInternalHeader,
  } = props
  return (
    <div
      className={
        hideInternalHeader
          ? ''
          : 'overflow-hidden rounded-lg border border-border bg-bg-elevated lg:sticky lg:top-6'
      }
    >
      {!hideInternalHeader && (
        <header className="flex items-center justify-between gap-3 border-b border-border bg-bg-muted/50 px-4 py-3">
          <div className="min-w-0">
            <div className="font-display text-sm font-medium text-fg-1">
              Transcript
            </div>
            <div className="mt-0.5 truncate font-mono text-[10px] text-fg-3">
              {agent} · {sessionId.slice(0, 12)}
              {turns && (
                <> · {turns.length} turn{turns.length === 1 ? '' : 's'}</>
              )}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-2 py-1 text-fg-3 transition-colors hover:bg-bg-base hover:text-fg-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            aria-label="Close transcript"
          >
            ✕
          </button>
        </header>
      )}

      <div
        className={
          hideInternalHeader
            ? 'overflow-y-auto px-4 py-4'
            : 'max-h-[calc(100vh-220px)] overflow-y-auto px-4 py-4'
        }
      >
        {isLoading && <TranscriptSkeleton />}
        {error && (
          <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-xs text-destructive">
            {error.message}
          </div>
        )}
        {turns && turns.length === 0 && !isLoading && (
          <p className="text-center text-xs text-fg-3">
            No turns recorded for this session.
          </p>
        )}
        {turns && turns.length > 0 && (
          <ol className="space-y-4">
            {turns.map((t) => (
              <TranscriptTurn
                key={t.turnId}
                turn={t}
                streaming={streamingTurnId === t.turnId}
              />
            ))}
          </ol>
        )}
      </div>
    </div>
  )
}

function TranscriptTurn(props: {
  readonly turn: RecentTurnRow
  readonly streaming: boolean
}) {
  const t = props.turn
  const streaming = props.streaming
  const railCls = streaming
    ? 'bg-pink'
    : t.role === 'user'
    ? 'bg-info'
    : t.role === 'assistant'
    ? 'bg-primary'
    : 'bg-fg-3'
  return (
    <li
      className={
        'group relative rounded-md border bg-bg-base px-4 py-3 transition-colors ' +
        (streaming
          ? 'border-pink/50 shadow-[0_0_0_1px_rgba(255,51,102,0.15)]'
          : 'border-border')
      }
      data-role={t.role}
    >
      <span
        aria-hidden
        className={
          'absolute inset-y-2 left-0 w-0.5 rounded-r-full transition-colors ' +
          railCls
        }
      />
      <div className="mb-1.5 flex items-center gap-2 text-[10px]">
        <RoleBadge role={t.role} />
        <span className="font-mono text-fg-3">#{t.turnIndex}</span>
        <span className="ml-auto font-mono text-fg-3" title={t.createdAt}>
          {relativeTime(t.createdAt)}
        </span>
      </div>
      <p
        className="whitespace-pre-wrap break-words font-sans text-sm leading-7 text-fg-1"
        style={{ maxWidth: '70ch' }}
      >
        {t.content}
      </p>
      {t.tokenCount !== null && (
        <div className="mt-2 hidden font-mono text-[10px] text-fg-3 group-hover:block">
          {t.tokenCount.toLocaleString()} tokens
          {t.origin ? ` · ${t.origin}` : ''}
        </div>
      )}
    </li>
  )
}

function TranscriptSkeleton() {
  return (
    <div className="space-y-4">
      {[0, 1, 2].map((i) => (
        <div
          key={i}
          className="animate-pulse rounded-md border border-border bg-bg-base px-4 py-3"
        >
          <div className="mb-2 h-3 w-1/3 rounded bg-bg-muted" />
          <div className="space-y-1.5">
            <div className="h-3 w-full rounded bg-bg-muted" />
            <div className="h-3 w-11/12 rounded bg-bg-muted" />
            <div className="h-3 w-4/5 rounded bg-bg-muted" />
          </div>
        </div>
      ))}
    </div>
  )
}
