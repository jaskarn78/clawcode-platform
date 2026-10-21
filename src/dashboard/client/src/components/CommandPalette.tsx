/**
 * Phase 116 Plan 02 T01 — F06 Command palette (Cmd+K / Ctrl+K).
 *
 * shadcn <Command> primitive (cmdk-based) inside a <Dialog> on desktop,
 * inside a bottom <Sheet>-style overlay on mobile (<768px viewport).
 *
 * Keyboard shortcut: Cmd+K on Mac, Ctrl+K elsewhere. Toggles open/close.
 * Escape closes (cmdk default).
 *
 * Command groups:
 *   1. Jump to agent      — agentsQuery → CommandItem per agent. Selecting
 *                            calls props.onSelectAgent (no-op today; 116-04
 *                            drawer wires the real navigation).
 *   2. Quick actions      — Toggle theme (light/dark), Restart Discord bot,
 *                            Run health check, View perf comparison.
 *                            (IPC handlers wire up in 116-02 follow-up /
 *                            116-06 settings; theme persistence is a
 *                            localStorage flag.)
 *   3. Recent SLO breaches — last 5 from the live useAgentLatency + cache
 *                            data already in the cache (no new fetch).
 *   4. Recent tool errors  — placeholder until 116-04 surfaces the trace error
 *                            feed.
 *   5. Search memory       — placeholder; opens nothing today. F27.
 *   6. Search transcript   — placeholder; opens nothing today. F27.
 *
 * Mobile bottom-sheet: when viewport.innerWidth < 768, the Dialog content
 * is positioned at the bottom (Tailwind classes override the default
 * center positioning).
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Command,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandSeparator,
} from '@/components/ui/command'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { useAgents, useAgentCache, useAgentLatency } from '@/hooks/useApi'
import {
  runHealthCheckAction,
  restartDaemonAction,
} from './quickActions'

// Tailwind md breakpoint = 768 (116-00 T06 locks `md: '768px'`).
const MOBILE_BREAKPOINT_PX = 768

// ---------------------------------------------------------------------------
// Viewport detection — re-renders on resize so the mobile/desktop variant
// flips live. SSR-safe (returns false on the server).
// ---------------------------------------------------------------------------

function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = useState(() => {
    if (typeof window === 'undefined') return false
    return window.innerWidth < MOBILE_BREAKPOINT_PX
  })
  useEffect(() => {
    if (typeof window === 'undefined') return
    const onResize = () =>
      setIsMobile(window.innerWidth < MOBILE_BREAKPOINT_PX)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])
  return isMobile
}

// ---------------------------------------------------------------------------
// Theme toggle — DELEGATES to ThemeToggle's canonical helpers.
//
// Phase 116-postdeploy fix 2026-05-11: CommandPalette previously had its
// own theme persistence — localStorage key `dashboard.theme` + a
// `data-theme` attribute. ThemeToggle (the header dropdown) uses
// `clawcode:theme` + the `.dark` class. Two sources of truth meant Cmd+K
// "toggle theme" wrote to a different key from the header toggle and
// flipped a different DOM marker — light mode "doesn't work great from
// page to page" because the two systems desynced. This module now
// delegates to ThemeToggle's exported helpers so there is ONE source of
// truth: localStorage `clawcode:theme` (values 'system'|'light'|'dark')
// + the `.dark` class on <html> (set by ThemeToggle.applyTheme() which
// also respects the FOUC-guard in index.html).
// ---------------------------------------------------------------------------

import {
  getStoredThemePref,
  setStoredThemePref,
  applyThemePref,
  resolveEffectiveTheme,
  type ThemePref,
} from './ThemeToggle'

function toggleStoredTheme(): 'light' | 'dark' {
  // Resolve the current effective theme (handles 'system' → OS preference)
  // and flip to the explicit opposite. Cmd+K is a quick toggle — it always
  // produces an explicit 'light' or 'dark' (never leaves it on 'system'),
  // matching the operator's reasonable expectation that pressing it twice
  // returns to the original.
  const current = resolveEffectiveTheme(getStoredThemePref())
  const next: ThemePref = current === 'dark' ? 'light' : 'dark'
  setStoredThemePref(next)
  applyThemePref(next)
  return next
}

// ---------------------------------------------------------------------------
// SLO breach probe — same pattern as SloBreachBanner. We can't reuse the
// banner's internal state, so we re-probe via lightweight per-agent
// AgentBreachItem components that each subscribe to the query cache
// (which is shared via TanStack — no double-fetch).
// ---------------------------------------------------------------------------

type Breach = {
  readonly agent: string
  readonly observedP50Ms: number
  readonly thresholdMs: number
}

function AgentBreachItem(props: {
  readonly agent: string
  readonly onResult: (agent: string, breach: Breach | null) => void
}): null {
  const cacheQ = useAgentCache(props.agent)
  const latencyQ = useAgentLatency(props.agent)
  const { onResult, agent } = props

  useEffect(() => {
    const cache = cacheQ.data as
      | { slos?: { first_token_p50_ms?: number } }
      | undefined
    const latency = latencyQ.data as
      | {
          first_token_headline?: {
            p50?: number | null
            count?: number
            slo_status?: string
          }
        }
      | undefined
    const threshold = cache?.slos?.first_token_p50_ms ?? null
    const observed = latency?.first_token_headline?.p50 ?? null
    const count = latency?.first_token_headline?.count ?? 0
    const status = latency?.first_token_headline?.slo_status ?? null
    if (
      threshold === null ||
      observed === null ||
      count < 5 ||
      status === 'no_data' ||
      observed <= threshold
    ) {
      onResult(agent, null)
      return
    }
    onResult(agent, {
      agent,
      observedP50Ms: observed,
      thresholdMs: threshold,
    })
  }, [cacheQ.data, latencyQ.data, agent, onResult])

  return null
}

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

export type CommandPaletteProps = {
  /** Callback when the user picks "Jump to agent". 116-04 wires the drawer. */
  readonly onSelectAgent?: (agent: string) => void
  /**
   * Callback when the operator picks "Edit config <agent>". App.tsx wires
   * this to navigate to the full-page config route (/agents/<name>). Optional
   * so older callers (tests) compile unchanged.
   */
  readonly onOpenConfig?: (agent: string) => void
  /**
   * Phase 116-postdeploy 2026-05-12 — navigate to a top-level dashboard
   * view (used by the new "Settings" + cascaded "Open fleet" actions).
   * Threaded down from App's pushState-aware navigate().
   */
  readonly onNavigate?: (view: string) => void
  /** Optional uncontrolled open state hint — defaults to internal state. */
  readonly defaultOpen?: boolean
}

export function CommandPalette(props: CommandPaletteProps): JSX.Element {
  const [open, setOpen] = useState(props.defaultOpen ?? false)
  const isMobile = useIsMobile()
  const agentsQ = useAgents()
  const payload = agentsQ.data as
    | { agents?: ReadonlyArray<{ name: string; model?: string }> }
    | undefined
  const agents = useMemo(
    () => (payload?.agents ?? []).slice().sort((a, b) => a.name.localeCompare(b.name)),
    [payload],
  )
  const agentNames = useMemo(() => agents.map((a) => a.name), [agents])

  // Breach aggregation. Stored in a Map for cheap dedup; map → array sort.
  const [breaches, setBreaches] = useState<Record<string, Breach | null>>({})
  const handleBreach = useCallback(
    (agent: string, breach: Breach | null) => {
      setBreaches((curr) => {
        const prev = curr[agent]
        // Phase 116-postdeploy 2026-05-12: same null-AND-undefined guard
        // fix as SloBreachBanner. TS Record<K,V> returns V|undefined on
        // missing keys; `prev !== null` let undefined through, crashing
        // the SPA shell on first read of an unseen agent. `prev != null`
        // excludes both null and undefined.
        if (
          prev === breach ||
          (prev != null &&
            breach !== null &&
            prev.observedP50Ms === breach.observedP50Ms)
        )
          return curr
        return { ...curr, [agent]: breach }
      })
    },
    [],
  )
  const recentBreaches = useMemo(() => {
    const list: Breach[] = []
    for (const b of Object.values(breaches)) if (b) list.push(b)
    list.sort(
      (a, b) =>
        b.observedP50Ms / b.thresholdMs - a.observedP50Ms / a.thresholdMs,
    )
    return list.slice(0, 5)
  }, [breaches])

  // Phase 116-postdeploy 2026-05-11: previously this re-applied the theme
  // on Cmd+K mount via local helpers; ThemeToggle now owns theme application
  // on its own mount + on the FOUC-guard inline script in index.html. The
  // Cmd+K palette has no business reapplying — doing so would race the
  // canonical ThemeToggle hook on a multi-mount scenario. (No-op intentional;
  // keeping the effect body removed instead of leaving the orphan call.)

  // Global keyboard shortcut: Cmd+K (Mac) / Ctrl+K (others). Toggles open.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'k' && e.key !== 'K') return
      if (!e.metaKey && !e.ctrlKey) return
      e.preventDefault()
      setOpen((v) => !v)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const close = useCallback(() => setOpen(false), [])

  const onSelectAgent = useCallback(
    (name: string) => {
      close()
      props.onSelectAgent?.(name)
    },
    [close, props],
  )

  const onToggleTheme = useCallback(() => {
    const next = toggleStoredTheme()
    close()
    // eslint-disable-next-line no-console
    console.info(
      `[clawcode-dashboard] theme toggled → ${next} (full light-palette swap ships in 116-06)`,
    )
  }, [close])

  const placeholderAction = useCallback(
    (label: string) => () => {
      close()
      // eslint-disable-next-line no-console
      console.info(
        `[clawcode-dashboard] command palette: '${label}' — placeholder; IPC handler ships in a follow-up plan.`,
      )
    },
    [close],
  )

  // Mobile vs desktop DialogContent class: mobile pins to bottom (sheet-like)
  // with full width and rounded-top corners; desktop uses the default center
  // float from shadcn's DialogContent.
  const contentClass = isMobile
    ? 'bg-bg-elevated border border-bg-s3 text-fg-1 left-0 right-0 top-auto bottom-0 translate-x-0 translate-y-0 max-w-none w-screen rounded-t-2xl rounded-b-none p-0 data-[state=closed]:slide-out-to-bottom data-[state=open]:slide-in-from-bottom'
    : 'bg-bg-elevated border border-bg-s3 text-fg-1 p-0 max-w-xl overflow-hidden'

  return (
    <>
      {/* SLO breach probes (mount only while palette open to save query
          subscriptions when closed). Each probe is a sibling that
          subscribes to the shared TanStack cache. */}
      {open &&
        agentNames.map((name) => (
          <AgentBreachItem key={name} agent={name} onResult={handleBreach} />
        ))}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          className={contentClass}
          data-testid="command-palette"
          data-mobile={isMobile ? 'true' : 'false'}
        >
          {/* Required by Radix for a11y; visually hidden via sr-only. */}
          <DialogTitle className="sr-only">Command palette</DialogTitle>
          <Command className="bg-transparent">
            <CommandInput
              placeholder="Type a command or search…"
              autoFocus
              className="bg-transparent"
              data-testid="command-palette-input"
            />
            <CommandList className="max-h-[60vh]">
              <CommandEmpty>No results.</CommandEmpty>

              {agents.length > 0 && (
                <CommandGroup heading="Jump to agent">
                  {agents.map((a) => (
                    <CommandItem
                      key={a.name}
                      value={`agent ${a.name} ${a.model ?? ''}`}
                      onSelect={() => onSelectAgent(a.name)}
                    >
                      <span className="font-mono">{a.name}</span>
                      {a.model && (
                        <span className="ml-auto text-xs text-fg-3 font-mono">
                          {a.model}
                        </span>
                      )}
                    </CommandItem>
                  ))}
                </CommandGroup>
              )}

              {/* Phase 116-03 F26 — quick-open the config editor for any agent. */}
              {agents.length > 0 && props.onOpenConfig && (
                <CommandGroup heading="Edit config">
                  {agents.map((a) => (
                    <CommandItem
                      key={`config-${a.name}`}
                      value={`config edit ${a.name}`}
                      onSelect={() => {
                        close()
                        props.onOpenConfig?.(a.name)
                      }}
                    >
                      <span className="font-mono">{a.name}</span>
                      <span className="ml-auto text-[10px] text-fg-3 font-mono">
                        F26 editor
                      </span>
                    </CommandItem>
                  ))}
                </CommandGroup>
              )}

              <CommandSeparator />

              <CommandGroup heading="Quick actions">
                <CommandItem
                  value="toggle theme dark light"
                  onSelect={onToggleTheme}
                >
                  <span>Toggle theme (light / dark)</span>
                  <span className="ml-auto text-[10px] text-fg-3 font-mono">
                    persists in localStorage
                  </span>
                </CommandItem>
                <CommandItem
                  value="restart daemon"
                  onSelect={() => {
                    close()
                    void restartDaemonAction()
                  }}
                >
                  <span>Restart daemon</span>
                  <span className="ml-auto text-[10px] text-fg-3 font-mono">
                    SIGHUP → systemd restart
                  </span>
                </CommandItem>
                <CommandItem
                  value="run health check"
                  onSelect={() => {
                    close()
                    void runHealthCheckAction({
                      onNavigateToFleet: props.onNavigate
                        ? () => props.onNavigate?.('fleet')
                        : undefined,
                    })
                  }}
                >
                  <span>Run health check</span>
                  <span className="ml-auto text-[10px] text-fg-3 font-mono">
                    GET /api/health → toast
                  </span>
                </CommandItem>
                {props.onNavigate && (
                  <CommandItem
                    value="settings"
                    onSelect={() => {
                      close()
                      props.onNavigate?.('settings')
                    }}
                  >
                    <span>Open settings</span>
                    <span className="ml-auto text-[10px] text-fg-3 font-mono">
                      /settings
                    </span>
                  </CommandItem>
                )}
                <CommandItem
                  value="view perf comparison"
                  onSelect={placeholderAction('View perf comparison')}
                >
                  <span>View perf comparison</span>
                  <span className="ml-auto text-[10px] text-fg-3 font-mono">
                    drawer/view — 116-04
                  </span>
                </CommandItem>
              </CommandGroup>

              {recentBreaches.length > 0 && (
                <>
                  <CommandSeparator />
                  <CommandGroup heading="Recent SLO breaches">
                    {recentBreaches.map((b) => (
                      <CommandItem
                        key={`breach-${b.agent}`}
                        value={`breach ${b.agent}`}
                        onSelect={() => onSelectAgent(b.agent)}
                      >
                        <span className="font-mono text-fg-1">{b.agent}</span>
                        <span className="ml-auto text-xs text-danger font-mono data">
                          {Math.round(b.observedP50Ms)}ms
                          <span className="text-fg-3 ml-1">
                            / {Math.round(b.thresholdMs)}ms
                          </span>
                        </span>
                      </CommandItem>
                    ))}
                  </CommandGroup>
                </>
              )}

              <CommandSeparator />

              <CommandGroup heading="Recent tool errors">
                <CommandItem
                  value="recent tool errors placeholder"
                  onSelect={placeholderAction('Recent tool errors')}
                  disabled
                >
                  <span className="text-fg-3">
                    (No source endpoint yet — surfaces with the 116-04 trace
                    feed)
                  </span>
                </CommandItem>
              </CommandGroup>

              <CommandSeparator />

              <CommandGroup heading="Search">
                <CommandItem
                  value="search memory"
                  onSelect={placeholderAction('Search memory')}
                  disabled
                >
                  <span>Search memory…</span>
                  <span className="ml-auto text-[10px] text-fg-3 font-mono">
                    F27 in 116-03
                  </span>
                </CommandItem>
                <CommandItem
                  value="search transcript"
                  onSelect={placeholderAction('Search transcript')}
                  disabled
                >
                  <span>Search transcript…</span>
                  <span className="ml-auto text-[10px] text-fg-3 font-mono">
                    F27 in 116-03
                  </span>
                </CommandItem>
              </CommandGroup>
            </CommandList>
          </Command>
        </DialogContent>
      </Dialog>
    </>
  )
}

export default CommandPalette
