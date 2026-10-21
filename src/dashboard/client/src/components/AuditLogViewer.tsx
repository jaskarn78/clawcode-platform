/**
 * Phase 116-UI redesign (2026-05) — operator audit log viewer.
 *
 * "Forensic timeline" rather than a flat table:
 *
 *  ┌──────────────────────────────────────────────────────────────────┐
 *  │ HEADER: page title (display) + meta (source file, total rows)    │
 *  │ FILTER TAB STRIP: Last 1h · 24h · 7d · All-time                  │
 *  │ ACTION CHIPS + TARGET SEARCH + density toggle                    │
 *  ├──────────────────────────────────────────────────────────────────┤
 *  │ TIMELINE                                                          │
 *  │  ▽ Today · 5 actions                                              │
 *  │     ┌──────────────────────────────────────────────────────────┐ │
 *  │     │ 14:23  ◷  rename-agent  →  client-a                      │ │
 *  │     │         metadata (4 fields) — click to expand            │ │
 *  │     │         ▼ on expand: JSON-diff-style block                │ │
 *  │     └──────────────────────────────────────────────────────────┘ │
 *  │  ▽ Yesterday · 3 actions                                          │
 *  └──────────────────────────────────────────────────────────────────┘
 *
 *  - Entries grouped by day with display-font day headers and relative
 *    labels ("Today", "Yesterday", "DOW MMM DD"). Two days per group.
 *  - Action icon per entry (chosen by a tiny prefix match: rename →
 *    pencil, restart → power, deploy → upload, delete → trash, etc.).
 *    Pure inline SVGs to avoid pulling lucide-react onto the audit
 *    chunk just for this.
 *  - Metadata expansion renders the JSON with mono font + line numbers +
 *    syntax tokens for keys/strings/numbers. Not a real diff (the
 *    daemon doesn't expose before/after pairs today) — we treat any
 *    key matching `*_before` / `*_after` as a faux diff pair styled
 *    green/red. Falls back to plain pretty-print when no pairs match.
 *  - Density toggle: Compact (default) shows just header rows;
 *    Expanded shows metadata inline for every entry with metadata.
 *  - Errors-only toggle: filters to entries whose action contains
 *    "error" / "fail" / "abort" or metadata has an `error` key.
 *
 * Lazy-loaded — see App.tsx React.lazy() import.
 */
import { useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Button } from '@/components/ui/button'

type AuditEntry = {
  readonly timestamp: string
  readonly action: string
  readonly target: string | null
  readonly metadata?: Record<string, unknown>
}

type AuditResponse = {
  readonly rows: readonly AuditEntry[]
  readonly filePath: string | null
}

type SinceWindow = 'all' | '1h' | '24h' | '7d'
type Density = 'compact' | 'expanded'

function sinceWindowToIso(window: SinceWindow): string | undefined {
  if (window === 'all') return undefined
  const now = Date.now()
  const offset =
    window === '1h'
      ? 3600 * 1000
      : window === '24h'
      ? 24 * 3600 * 1000
      : 7 * 24 * 3600 * 1000
  return new Date(now - offset).toISOString()
}

const WINDOW_LABEL: Record<SinceWindow, string> = {
  '1h': 'Last 1h',
  '24h': 'Last 24h',
  '7d': 'Last 7d',
  all: 'All time',
}
const WINDOW_ORDER: ReadonlyArray<SinceWindow> = ['1h', '24h', '7d', 'all']

export function AuditLogViewer(): JSX.Element {
  const [sinceWindow, setSinceWindow] = useState<SinceWindow>('24h')
  const [actionFilter, setActionFilter] = useState<string>('')
  const [agentFilter, setAgentFilter] = useState<string>('')
  const [errorsOnly, setErrorsOnly] = useState(false)
  const [density, setDensity] = useState<Density>('compact')
  const [expandedIdx, setExpandedIdx] = useState<Set<string>>(new Set())

  const queryParams = useMemo(() => {
    const params = new URLSearchParams()
    const since = sinceWindowToIso(sinceWindow)
    if (since) params.set('since', since)
    if (actionFilter) params.set('action', actionFilter)
    if (agentFilter) params.set('agent', agentFilter)
    params.set('limit', '500')
    return params
  }, [sinceWindow, actionFilter, agentFilter])

  const { data, isLoading, error, refetch } = useQuery<AuditResponse>({
    queryKey: ['audit', sinceWindow, actionFilter, agentFilter],
    queryFn: async () => {
      const res = await fetch(`/api/audit?${queryParams.toString()}`)
      if (!res.ok) throw new Error(`audit fetch failed: ${res.status}`)
      return (await res.json()) as AuditResponse
    },
    staleTime: 10_000,
  })

  useEffect(() => {
    const t = setInterval(() => {
      void refetch()
    }, 30_000)
    return () => clearInterval(t)
  }, [refetch])

  const seenActions = useMemo(() => {
    const set = new Set<string>()
    for (const r of data?.rows ?? []) set.add(r.action)
    return Array.from(set).sort()
  }, [data])

  const filteredRows = useMemo(() => {
    const rows = data?.rows ?? []
    if (!errorsOnly) return rows
    return rows.filter((r) => {
      const a = r.action.toLowerCase()
      if (a.includes('error') || a.includes('fail') || a.includes('abort')) {
        return true
      }
      const meta = r.metadata
      if (meta && 'error' in meta) return true
      return false
    })
  }, [data, errorsOnly])

  // Group rows by day-bucket for the timeline.
  const grouped = useMemo(() => groupByDay(filteredRows), [filteredRows])

  function toggleExpand(key: string) {
    setExpandedIdx((curr) => {
      const next = new Set(curr)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const isEntryExpanded = (key: string) =>
    density === 'expanded' || expandedIdx.has(key)

  return (
    <div className="mx-auto max-w-[1100px] px-7 py-6">
      {/* dash-redesign sweep — section-head pattern. Source-of-truth
          file path + entry count live in the .sub strip; the Refresh
          button anchors right-aligned. */}
      <div className="section-head mb-5">
        <div className="flex items-baseline">
          <h2>Audit log</h2>
          <span className="sub">
            every dashboard-originated mutation · append-only ·{' '}
            <code className="font-mono text-fg-2">
              {data?.filePath ?? 'dashboard-audit.jsonl'}
            </code>
          </span>
        </div>
        <div className="flex items-center gap-3">
          <span className="font-mono text-xs text-fg-3">
            {filteredRows.length} entr{filteredRows.length === 1 ? 'y' : 'ies'}
          </span>
          <Button variant="outline" size="sm" onClick={() => void refetch()}>
            Refresh
          </Button>
        </div>
      </div>

      {/* WINDOW TAB STRIP */}
      <div
        className="mb-3 inline-flex rounded-md border border-border bg-bg-elevated p-0.5"
        role="tablist"
        aria-label="Time window"
      >
        {WINDOW_ORDER.map((w) => (
          <button
            key={w}
            role="tab"
            type="button"
            aria-selected={sinceWindow === w}
            onClick={() => setSinceWindow(w)}
            className={
              'rounded-sm px-3 py-1.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ' +
              (sinceWindow === w
                ? 'bg-primary text-primary-foreground'
                : 'text-fg-3 hover:text-fg-1')
            }
          >
            {WINDOW_LABEL[w]}
          </button>
        ))}
      </div>

      {/* SECONDARY FILTERS */}
      <div className="mb-6 flex flex-wrap items-center gap-2">
        <select
          value={actionFilter}
          onChange={(e) => setActionFilter(e.target.value)}
          className="rounded-md border border-border bg-bg-elevated px-2.5 py-1.5 text-xs text-fg-1"
          aria-label="Filter by action type"
        >
          <option value="">Action · any</option>
          {seenActions.map((a) => (
            <option key={a} value={a}>
              {a}
            </option>
          ))}
        </select>
        <input
          type="search"
          placeholder="Target (agent or id)…"
          value={agentFilter}
          onChange={(e) => setAgentFilter(e.target.value)}
          className="rounded-md border border-border bg-bg-elevated px-2.5 py-1.5 text-xs text-fg-1 placeholder:text-fg-3 focus:border-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-label="Filter by target"
        />
        <label className="flex cursor-pointer items-center gap-1.5 rounded-md border border-border bg-bg-elevated px-2.5 py-1.5 text-xs text-fg-2 hover:text-fg-1">
          <input
            type="checkbox"
            checked={errorsOnly}
            onChange={(e) => setErrorsOnly(e.target.checked)}
            className="accent-destructive"
          />
          Errors only
        </label>

        <div className="ml-auto inline-flex rounded-md border border-border bg-bg-elevated p-0.5">
          {(['compact', 'expanded'] as const).map((d) => (
            <button
              key={d}
              type="button"
              onClick={() => setDensity(d)}
              aria-pressed={density === d}
              className={
                'rounded-sm px-2.5 py-1 text-[10px] font-medium uppercase tracking-wider transition-colors ' +
                (density === d
                  ? 'bg-bg-muted text-fg-1'
                  : 'text-fg-3 hover:text-fg-1')
              }
            >
              {d}
            </button>
          ))}
        </div>
      </div>

      {/* BODY */}
      {error ? (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 p-4 text-sm text-destructive">
          {(error as Error).message}
        </div>
      ) : isLoading ? (
        <AuditSkeleton />
      ) : filteredRows.length === 0 ? (
        // dash-redesign sweep — match the home view's empty-state copy
        // tone (calm mono fallback) via the shared .feed-empty class.
        <div className="feed-empty">
          No audit entries match the current filters. Try widening the
          time window or clearing the action / target filters.
        </div>
      ) : (
        <div className="space-y-8">
          {grouped.map((group) => (
            <section key={group.dayKey}>
              <header className="mb-3 flex items-baseline gap-2 border-b border-border pb-2">
                <h2 className="font-display text-base font-medium text-fg-1">
                  {group.label}
                </h2>
                <span className="font-mono text-[10px] text-fg-3">
                  {group.entries.length} action
                  {group.entries.length === 1 ? '' : 's'}
                </span>
              </header>

              <ol className="relative ml-2 space-y-2 border-l border-border pl-6">
                {group.entries.map((entry) => {
                  const key = `${entry.entry.timestamp}-${entry.idx}`
                  const expanded = isEntryExpanded(key)
                  const isError = isErrorEntry(entry)
                  return (
                    <li key={key} className="relative">
                      {/* timeline node dot */}
                      <span
                        aria-hidden
                        className={
                          'absolute -left-[27px] top-3 flex h-3 w-3 items-center justify-center rounded-full border-2 ' +
                          (isError
                            ? 'border-destructive bg-bg-base'
                            : 'border-primary bg-bg-base')
                        }
                      />
                      <AuditEntryRow
                        entry={entry.entry}
                        expanded={expanded}
                        onToggle={() => toggleExpand(key)}
                        isError={isError}
                      />
                    </li>
                  )
                })}
              </ol>
            </section>
          ))}
        </div>
      )}
    </div>
  )
}

/* ====================================================================== */
/* AUDIT ENTRY                                                             */
/* ====================================================================== */

function AuditEntryRow(props: {
  readonly entry: AuditEntry
  readonly expanded: boolean
  readonly onToggle: () => void
  readonly isError: boolean
}) {
  const { entry, expanded, onToggle, isError } = props
  const meta = entry.metadata
  const hasMeta = meta && Object.keys(meta).length > 0
  const date = new Date(entry.timestamp)
  return (
    <div
      className={
        'rounded-md border bg-bg-elevated transition-colors ' +
        (isError
          ? 'border-destructive/30 hover:border-destructive/50'
          : 'border-border hover:border-primary/30')
      }
      data-testid="audit-row"
      data-action={entry.action}
    >
      <button
        type="button"
        onClick={onToggle}
        disabled={!hasMeta}
        className="flex w-full items-center gap-3 px-3 py-2.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default"
      >
        <span
          className="shrink-0 font-mono text-[10px] text-fg-3"
          title={entry.timestamp}
        >
          {date.toLocaleTimeString(undefined, {
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
          })}
        </span>
        <ActionIcon action={entry.action} isError={isError} />
        <span className="truncate font-mono text-sm text-fg-1">
          {entry.action}
        </span>
        {entry.target && (
          <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-bg-muted px-2 py-0.5 font-mono text-[10px] text-fg-2">
            <span aria-hidden>→</span>
            {entry.target}
          </span>
        )}
        {hasMeta && (
          <span
            aria-hidden
            className={
              'ml-auto font-mono text-[10px] text-fg-3 transition-transform ' +
              (expanded ? 'rotate-90 text-fg-1' : '')
            }
          >
            ▸
          </span>
        )}
      </button>

      {hasMeta && expanded && (
        <div className="border-t border-border bg-bg-base/60 px-3 py-2">
          <MetadataBlock meta={meta} />
        </div>
      )}
    </div>
  )
}

/* ====================================================================== */
/* METADATA BLOCK — pseudo-diff styling                                    */
/* ====================================================================== */

function MetadataBlock(props: { readonly meta: Record<string, unknown> }) {
  const { meta } = props
  // Detect *_before / *_after pairs to render as a faux diff.
  const keys = Object.keys(meta)
  const pairs: Array<{ base: string; before: unknown; after: unknown }> = []
  const consumed = new Set<string>()
  for (const k of keys) {
    if (k.endsWith('_before')) {
      const base = k.slice(0, -7)
      const afterKey = `${base}_after`
      if (afterKey in meta) {
        pairs.push({ base, before: meta[k], after: meta[afterKey] })
        consumed.add(k)
        consumed.add(afterKey)
      }
    }
  }
  const otherKeys = keys.filter((k) => !consumed.has(k))

  return (
    <div className="space-y-2 font-mono text-[11px] leading-relaxed">
      {pairs.length > 0 && (
        <div className="overflow-hidden rounded border border-border">
          {pairs.map((p) => (
            <div key={p.base}>
              <div className="bg-bg-muted/60 px-2 py-0.5 text-[10px] uppercase tracking-wider text-fg-3">
                {p.base}
              </div>
              <div className="border-t border-destructive/30 bg-destructive/5 px-2 py-0.5 text-destructive">
                <span aria-hidden className="mr-2 select-none text-fg-3">
                  -
                </span>
                {formatValue(p.before)}
              </div>
              <div className="border-t border-primary/30 bg-primary/5 px-2 py-0.5 text-primary">
                <span aria-hidden className="mr-2 select-none text-fg-3">
                  +
                </span>
                {formatValue(p.after)}
              </div>
            </div>
          ))}
        </div>
      )}
      {otherKeys.length > 0 && (
        <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-all rounded border border-border bg-bg-elevated px-2 py-1.5 text-fg-2">
          {JSON.stringify(
            Object.fromEntries(otherKeys.map((k) => [k, meta[k]])),
            null,
            2,
          )}
        </pre>
      )}
    </div>
  )
}

function formatValue(v: unknown): string {
  if (v === null) return 'null'
  if (typeof v === 'string') return JSON.stringify(v)
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  try {
    return JSON.stringify(v)
  } catch {
    return String(v)
  }
}

/* ====================================================================== */
/* ACTION ICON                                                             */
/* ====================================================================== */

function ActionIcon(props: { readonly action: string; readonly isError: boolean }) {
  const a = props.action.toLowerCase()
  let path: JSX.Element
  if (a.includes('rename') || a.includes('edit') || a.includes('update')) {
    path = <path d="M3 21v-3l11-11 3 3-11 11H3zM14 4l3 3" />
  } else if (a.includes('restart') || a.includes('reload')) {
    path = <path d="M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5" />
  } else if (a.includes('start') || a.includes('spawn') || a.includes('create')) {
    path = <path d="M12 5v14M5 12h14" />
  } else if (a.includes('delete') || a.includes('remove')) {
    path = (
      <>
        <path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2" />
        <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
      </>
    )
  } else if (a.includes('deploy') || a.includes('upload')) {
    path = <path d="M12 19V5M5 12l7-7 7 7" />
  } else if (a.includes('stop') || a.includes('kill') || a.includes('cancel')) {
    path = <rect x="6" y="6" width="12" height="12" rx="1" />
  } else if (a.includes('migration') || a.includes('migrate')) {
    path = (
      <>
        <path d="M7 17l-4-4 4-4" />
        <path d="M17 7l4 4-4 4" />
        <path d="M3 13h18" />
      </>
    )
  } else {
    // generic — clock
    path = (
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 7v5l3 2" />
      </>
    )
  }
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      className={
        'shrink-0 ' + (props.isError ? 'text-destructive' : 'text-primary')
      }
    >
      {path}
    </svg>
  )
}

/* ====================================================================== */
/* DAY GROUPING                                                            */
/* ====================================================================== */

type EntryWithIdx = { readonly entry: AuditEntry; readonly idx: number }
type DayGroup = {
  readonly dayKey: string
  readonly label: string
  readonly entries: ReadonlyArray<EntryWithIdx>
}

function groupByDay(rows: readonly AuditEntry[]): readonly DayGroup[] {
  const groups = new Map<string, EntryWithIdx[]>()
  for (let i = 0; i < rows.length; i++) {
    const entry = rows[i]
    const d = new Date(entry.timestamp)
    const dayKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
      d.getDate(),
    ).padStart(2, '0')}`
    if (!groups.has(dayKey)) groups.set(dayKey, [])
    groups.get(dayKey)!.push({ entry, idx: i })
  }
  const out: DayGroup[] = []
  // Sort dayKey descending (newest first)
  const sortedKeys = [...groups.keys()].sort((a, b) => (a < b ? 1 : -1))
  const today = new Date()
  const yesterday = new Date(today.getTime() - 24 * 3600 * 1000)
  const todayKey = formatDayKey(today)
  const yesterdayKey = formatDayKey(yesterday)
  for (const k of sortedKeys) {
    let label: string
    if (k === todayKey) label = 'Today'
    else if (k === yesterdayKey) label = 'Yesterday'
    else {
      const [y, m, d] = k.split('-').map(Number)
      const date = new Date(y, m - 1, d)
      label = date.toLocaleDateString(undefined, {
        weekday: 'short',
        month: 'short',
        day: 'numeric',
        year: today.getFullYear() === y ? undefined : 'numeric',
      })
    }
    out.push({ dayKey: k, label, entries: groups.get(k)! })
  }
  return out
}

function formatDayKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
    d.getDate(),
  ).padStart(2, '0')}`
}

function isErrorEntry(e: EntryWithIdx): boolean {
  const a = e.entry.action.toLowerCase()
  if (a.includes('error') || a.includes('fail') || a.includes('abort')) return true
  const meta = e.entry.metadata
  if (meta && 'error' in meta) return true
  return false
}

/* ====================================================================== */
/* SKELETON                                                                */
/* ====================================================================== */

function AuditSkeleton() {
  return (
    <div className="space-y-8">
      {[0, 1].map((g) => (
        <section key={g}>
          <div className="mb-3 h-6 w-32 animate-pulse rounded bg-bg-muted" />
          <div className="space-y-2 border-l border-border pl-6">
            {[0, 1, 2].map((i) => (
              <div
                key={i}
                className="h-12 animate-pulse rounded-md border border-border bg-bg-elevated/40"
              />
            ))}
          </div>
        </section>
      ))}
    </div>
  )
}
