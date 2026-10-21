/**
 * Phase 116 Plan 02 T03 + T05 — F09 embedding-v2 migration tracker.
 *
 * Per-agent phase pill (idle / dual-write / re-embedding N% / re-embed-
 * complete / cutover / v1-dropped / rolled-back) sourced from
 * `GET /api/migrations` (proxies the daemon `embedding-migration-status` IPC).
 *
 * Operator actions per agent:
 *   - Pause  -> POST /api/migrations/:agent/pause
 *   - Resume -> POST /api/migrations/:agent/resume
 *   - Rollback -> POST /api/migrations/:agent/rollback  (transition→rolled-back)
 *
 * Each action opens a shadcn <Dialog> confirm modal first. Rollback always
 * requires confirm; Pause/Resume could in principle skip confirm but the
 * plan requires confirm for all three so operators get the same shape every
 * time.
 *
 * ETA: linear projection from current velocity over the last 24h. If we
 * have < 6h of velocity samples, render "calculating…" rather than a
 * misleading number. Since the daemon only surfaces total + processed
 * (not a velocity time series), velocity is approximated client-side from
 * the rate-of-change between consecutive `useMigrations()` polls (10s
 * interval). Insufficient samples → fall back to "calculating…".
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Card, CardContent, CardHeader } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog'
import {
  runCleanupOrphans,
  transitionMigration,
  useMigrations,
  type MigrationRow,
} from '@/hooks/useApi'

// ---------------------------------------------------------------------------
// Phase pill styling
// ---------------------------------------------------------------------------

type PhasePalette = {
  readonly bg: string
  readonly text: string
  readonly border: string
  readonly label: string
}

function phasePalette(phase: string): PhasePalette {
  switch (phase) {
    case 'idle':
      return {
        bg: 'bg-fg-3/15',
        text: 'text-fg-2',
        border: 'border-fg-3/40',
        label: 'idle',
      }
    case 'dual-write':
      return {
        bg: 'bg-primary/15',
        text: 'text-primary',
        border: 'border-primary/40',
        label: 'dual-write',
      }
    case 're-embedding':
      return {
        bg: 'bg-warn/15',
        text: 'text-warn',
        border: 'border-warn/40',
        label: 're-embedding',
      }
    case 're-embed-complete':
      return {
        bg: 'bg-primary/15',
        text: 'text-primary',
        border: 'border-primary/40',
        label: 're-embed complete',
      }
    case 'cutover':
      return {
        bg: 'bg-primary/15',
        text: 'text-primary',
        border: 'border-primary/40',
        label: 'cutover',
      }
    case 'v1-dropped':
      return {
        bg: 'bg-primary/25',
        text: 'text-primary',
        border: 'border-primary/60',
        label: 'v1 dropped',
      }
    case 'rolled-back':
      return {
        bg: 'bg-danger/15',
        text: 'text-danger',
        border: 'border-danger/40',
        label: 'rolled back',
      }
    case 'no-store':
    case 'error':
      return {
        bg: 'bg-danger/15',
        text: 'text-danger',
        border: 'border-danger/40',
        label: phase,
      }
    default:
      return {
        bg: 'bg-fg-3/15',
        text: 'text-fg-2',
        border: 'border-fg-3/40',
        label: phase,
      }
  }
}

// ---------------------------------------------------------------------------
// Velocity / ETA bookkeeping — single in-memory ring of recent samples.
// One bucket per agent. We need ≥ 6h of velocity samples (6 * 60 / 10s
// poll = 2160 samples minimum) BUT we don't want to memory-leak; cap at
// 2880 (8h) per agent. In practice operators see "calculating…" the first
// 6h after a migration starts, then a stable ETA.
// ---------------------------------------------------------------------------

type Sample = { readonly t: number; readonly processed: number }

const MIN_HISTORY_MS = 6 * 60 * 60 * 1000 // 6h
const MAX_HISTORY_SAMPLES = 2880

function useVelocityTracker(rows: readonly MigrationRow[]): Map<
  string,
  { readonly etaMs: number | null; readonly velocityPerSec: number | null }
> {
  const samplesRef = useRef<Map<string, Sample[]>>(new Map())
  const [tick, setTick] = useState(0)

  useEffect(() => {
    const now = Date.now()
    const map = samplesRef.current
    for (const r of rows) {
      if (r.phase !== 're-embedding') {
        // Reset history when not actively re-embedding so a future restart
        // doesn't compute velocity off stale (no-progress) samples.
        if (map.has(r.agent)) map.delete(r.agent)
        continue
      }
      const list = map.get(r.agent) ?? []
      const last = list[list.length - 1]
      if (!last || last.processed !== r.progressProcessed) {
        list.push({ t: now, processed: r.progressProcessed })
        if (list.length > MAX_HISTORY_SAMPLES) list.shift()
      }
      map.set(r.agent, list)
    }
    setTick((v) => v + 1)
  }, [rows])

  return useMemo(() => {
    const out = new Map<
      string,
      { readonly etaMs: number | null; readonly velocityPerSec: number | null }
    >()
    for (const r of rows) {
      if (r.phase !== 're-embedding') {
        out.set(r.agent, { etaMs: null, velocityPerSec: null })
        continue
      }
      const list = samplesRef.current.get(r.agent) ?? []
      if (list.length < 2) {
        out.set(r.agent, { etaMs: null, velocityPerSec: null })
        continue
      }
      const first = list[0]!
      const last = list[list.length - 1]!
      const dtMs = last.t - first.t
      if (dtMs < MIN_HISTORY_MS) {
        out.set(r.agent, { etaMs: null, velocityPerSec: null })
        continue
      }
      const dProc = last.processed - first.processed
      if (dProc <= 0) {
        out.set(r.agent, { etaMs: null, velocityPerSec: 0 })
        continue
      }
      const velPerSec = dProc / (dtMs / 1000)
      const remaining = r.progressTotal - r.progressProcessed
      const etaMs = remaining > 0 ? (remaining / velPerSec) * 1000 : 0
      out.set(r.agent, { etaMs, velocityPerSec: velPerSec })
    }
    return out
    // tick + rows drive recompute
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick, rows])
}

function formatEta(etaMs: number | null): string {
  if (etaMs === null) return 'calculating…'
  if (etaMs <= 0) return 'imminent'
  const sec = Math.round(etaMs / 1000)
  if (sec < 60) return `${sec}s`
  const min = Math.round(sec / 60)
  if (min < 60) return `${min}m`
  const hr = Math.round(min / 60)
  if (hr < 48) return `${hr}h`
  const d = Math.round(hr / 24)
  return `${d}d`
}

function formatProgress(r: MigrationRow): string {
  if (r.progressTotal <= 0) {
    // No work to do, or total not yet known. Surface raw processed count
    // if any — happens transiently during dual-write before the first
    // re-embedding cursor walk has snapshotted the total.
    return r.progressProcessed > 0
      ? `${r.progressProcessed.toLocaleString()} / 0`
      : '0 / 0'
  }
  const processed = r.progressProcessed
  const total = r.progressTotal
  const remaining = Math.max(0, total - processed)
  // Phase 116-postdeploy 2026-05-12 — round-up-to-100 bug fix. Math.round
  // turned 1407/1408 (99.93%) into "100%" which read as "complete" — but
  // 1 entry was still pending and the agent was paused, so it sat there
  // forever looking done. Use floor to avoid the round-up, and explicitly
  // append "N remaining" when the gap is small (≤25) so the operator
  // sees exactly what's left. Only render "(complete)" when processed
  // truly reaches total — defensively tolerate processed > total too.
  if (processed >= total) {
    return `${processed.toLocaleString()} / ${total.toLocaleString()} (complete)`
  }
  const pctFloor = Math.floor((processed / total) * 100)
  // For >=99% with <=25 remaining, show fractional precision so 99.93%
  // doesn't display as just "99%". For everyone else, integer floor.
  const pctStr =
    pctFloor >= 99 && remaining > 0
      ? `${((processed / total) * 100).toFixed(1)}%`
      : `${pctFloor}%`
  const remainingStr = remaining <= 25 ? ` · ${remaining} remaining` : ''
  return `${processed.toLocaleString()} / ${total.toLocaleString()} (${pctStr}${remainingStr})`
}

// ---------------------------------------------------------------------------
// Operator-confirm modal
// ---------------------------------------------------------------------------

type Action =
  | { readonly kind: 'pause' }
  | { readonly kind: 'resume' }
  | { readonly kind: 'rollback' }
  // 116-postdeploy — generic phase advance. Lives alongside rollback because
  // they share the same daemon IPC (`embedding-migration-transition`); the
  // distinction lives in REST routing + operator copy.
  | { readonly kind: 'transition'; readonly toPhase: TransitionTarget }
  // 116-postdeploy 2026-05-12 — manual orphan cleanup. Fires the Phase 107
  // `memory-cleanup-orphans` IPC for one agent. Useful for clearing the
  // pre-cascade orphan residue that's inflating the v1/v2 dashboard
  // denominator on agents that finished re-embedding before Fix 1 landed.
  | { readonly kind: 'cleanup-orphans' }

type TransitionTarget =
  | 'dual-write'
  | 're-embedding'
  | 'cutover'
  | 'v1-dropped'

function actionCopy(action: Action): {
  readonly title: string
  readonly body: string
  readonly cta: string
  readonly variant: 'default' | 'destructive'
} {
  switch (action.kind) {
    case 'pause':
      return {
        title: 'Pause migration?',
        body:
          'The heartbeat runner will skip this agent until resumed. Re-embed progress halts; existing dual-write traffic continues.',
        cta: 'Pause',
        variant: 'default',
      }
    case 'resume':
      return {
        title: 'Resume migration?',
        body:
          'The heartbeat runner resumes re-embedding for this agent at the configured CPU budget + batch size.',
        cta: 'Resume',
        variant: 'default',
      }
    case 'rollback':
      return {
        title: 'Roll back migration?',
        body:
          'Transitions the agent to "rolled-back" phase. Re-embed progress is preserved but reads return to v1. This action is reversible (rolled-back → dual-write is legal).',
        cta: 'Roll back',
        variant: 'destructive',
      }
    case 'cleanup-orphans':
      return {
        title: 'Clean orphan vec rows?',
        body:
          'Scans vec_memories + vec_memories_v2 for rows whose memory_id no longer exists in the `memories` table and removes them. These orphans inflate the v1/v2 dashboard denominator and can make a fully-migrated agent display as e.g. 59%. Idempotent and safe to re-run.',
        cta: 'Clean orphans',
        variant: 'default',
      }
    case 'transition':
      return transitionCopy(action.toPhase)
  }
}

function transitionCopy(toPhase: TransitionTarget): {
  readonly title: string
  readonly body: string
  readonly cta: string
  readonly variant: 'default' | 'destructive'
} {
  switch (toPhase) {
    case 'dual-write':
      return {
        title: 'Start dual-write?',
        body:
          'Both v1 and v2 embeddings will be written for every NEW memory. Existing memories keep their v1-only vectors until re-embedding starts. Reads continue to use v1.',
        cta: 'Start dual-write',
        variant: 'default',
      }
    case 're-embedding':
      return {
        title: 'Start re-embedding?',
        body:
          'The heartbeat runner will backfill v2 embeddings on existing v1-only memories at the configured CPU budget + batch size. Depending on memory store size this takes minutes to hours; you can pause / rollback at any time. Reads still use v1 throughout this phase.',
        cta: 'Start re-embedding',
        variant: 'default',
      }
    case 'cutover':
      return {
        title: 'Cut over to v2 reads?',
        body:
          'Search + relevance scoring switch to the v2 vector column. Re-embed is complete (every memory has a v2 vector) but v1 columns remain on disk as a safety net — rollback is still legal.',
        cta: 'Advance to cutover',
        variant: 'default',
      }
    case 'v1-dropped':
      return {
        title: 'Drop v1 vectors?',
        body:
          'Final step — v1 embedding columns are dropped from disk. This is IRREVERSIBLE; rollback is no longer legal once v1 is gone. Only proceed if the agent has been stable on v2 reads for a meaningful window.',
        cta: 'Drop v1 (irreversible)',
        variant: 'destructive',
      }
  }
}

async function postAction(agent: string, action: Action): Promise<void> {
  if (action.kind === 'transition') {
    await transitionMigration(agent, action.toPhase)
    return
  }
  if (action.kind === 'cleanup-orphans') {
    // Different REST surface — cleanup is /api/agents/:name/memory/...
    // rather than /api/migrations/:agent/... because cleanup is a memory-
    // store operation, not a migration state machine transition. The
    // hook does its own response shape parsing.
    await runCleanupOrphans(agent)
    return
  }
  const r = await fetch(
    `/api/migrations/${encodeURIComponent(agent)}/${action.kind}`,
    {
      method: 'POST',
      credentials: 'same-origin',
    },
  )
  if (!r.ok) {
    let detail = ''
    try {
      const body = (await r.json()) as { error?: string }
      detail = body?.error ?? ''
    } catch {
      /* swallow — non-JSON body */
    }
    throw new Error(
      `POST /api/migrations/${agent}/${action.kind} failed: ${r.status}${detail ? ` — ${detail}` : ''}`,
    )
  }
}

function ConfirmModal(props: {
  readonly open: boolean
  readonly agent: string
  readonly action: Action
  readonly onClose: () => void
  readonly onConfirmed: () => void
}): JSX.Element {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const copy = actionCopy(props.action)
  const testIdSuffix =
    props.action.kind === 'transition'
      ? `transition-${props.action.toPhase}`
      : props.action.kind

  const handleConfirm = useCallback(async () => {
    setBusy(true)
    setError(null)
    try {
      await postAction(props.agent, props.action)
      props.onConfirmed()
      props.onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error')
    } finally {
      setBusy(false)
    }
  }, [props])

  return (
    <Dialog
      open={props.open}
      onOpenChange={(o) => {
        if (!o && !busy) props.onClose()
      }}
    >
      <DialogContent
        className="bg-bg-elevated border border-bg-s3 text-fg-1"
        data-testid={`migration-confirm-${testIdSuffix}`}
      >
        <DialogHeader>
          <DialogTitle className="font-display text-fg-1">
            {copy.title}
          </DialogTitle>
          <DialogDescription className="text-fg-2 font-sans">
            <span className="font-mono text-primary">{props.agent}</span> —{' '}
            {copy.body}
          </DialogDescription>
        </DialogHeader>
        {error && (
          <p className="text-danger font-mono text-xs data" role="alert">
            {error}
          </p>
        )}
        <DialogFooter className="gap-2">
          <Button
            type="button"
            variant="ghost"
            onClick={props.onClose}
            disabled={busy}
          >
            Cancel
          </Button>
          <Button
            type="button"
            onClick={handleConfirm}
            disabled={busy}
            className={
              copy.variant === 'destructive'
                ? 'bg-danger text-white hover:bg-danger/90'
                : 'bg-primary text-bg-base hover:bg-primary/90'
            }
          >
            {busy ? 'Working…' : copy.cta}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ---------------------------------------------------------------------------
// Fleet aggregate bar chart — phase distribution. Stacked horizontal bar.
// ---------------------------------------------------------------------------

const PHASE_ORDER: readonly string[] = [
  'idle',
  'dual-write',
  're-embedding',
  're-embed-complete',
  'cutover',
  'v1-dropped',
  'rolled-back',
]

function FleetAggregate(props: {
  readonly rows: readonly MigrationRow[]
}): JSX.Element {
  const counts = useMemo(() => {
    const c: Record<string, number> = {}
    for (const r of props.rows) {
      c[r.phase] = (c[r.phase] ?? 0) + 1
    }
    return c
  }, [props.rows])
  const total = props.rows.length

  if (total === 0) return <></>

  return (
    <div className="space-y-2" data-testid="migration-fleet-aggregate">
      <div className="flex items-center justify-between">
        <h3 className="text-xs uppercase tracking-wide text-fg-3 font-sans">
          Fleet phase distribution
        </h3>
        <span className="font-mono text-xs text-fg-3 data">
          {total} agent{total === 1 ? '' : 's'}
        </span>
      </div>
      <div className="flex w-full h-6 rounded-md overflow-hidden border border-bg-s3 bg-bg-base">
        {PHASE_ORDER.filter((p) => counts[p] && counts[p]! > 0).map((p) => {
          const palette = phasePalette(p)
          const pct = ((counts[p] ?? 0) / total) * 100
          return (
            <div
              key={p}
              style={{ width: `${pct}%` }}
              className={`${palette.bg} ${palette.border} border-r last:border-r-0 flex items-center justify-center text-[10px] font-mono ${palette.text}`}
              title={`${p}: ${counts[p]} (${pct.toFixed(0)}%)`}
            >
              {pct >= 10 ? counts[p] : ''}
            </div>
          )
        })}
      </div>
      <ul className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] font-sans">
        {PHASE_ORDER.filter((p) => counts[p] && counts[p]! > 0).map((p) => {
          const palette = phasePalette(p)
          return (
            <li key={p} className="flex items-center gap-1.5">
              <span
                className={`w-2 h-2 rounded-sm ${palette.bg} border ${palette.border}`}
                aria-hidden
              />
              <span className="text-fg-2">{palette.label}</span>
              <span className="text-fg-3 data font-mono">
                {counts[p]}
              </span>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Per-agent row
// ---------------------------------------------------------------------------

// 116-postdeploy 2026-05-12 — derives the operator's "next-phase" advance
// button from the current phase, matching LEGAL_TRANSITIONS in
// src/memory/migrations/embedding-v2.ts. Returns null when no forward
// advance applies (re-embedding mid-flight, v1-dropped). The state
// `re-embed-complete` exposes "Advance to cutover" — the heartbeat runner
// flips re-embedding → re-embed-complete when the backfill cursor finishes.
function nextAdvance(r: MigrationRow): {
  readonly label: string
  readonly toPhase: TransitionTarget
} | null {
  switch (r.phase) {
    case 'idle':
      return { label: 'Start dual-write', toPhase: 'dual-write' }
    case 'dual-write':
      return { label: 'Start re-embedding', toPhase: 're-embedding' }
    case 're-embed-complete':
      return { label: 'Advance to cutover', toPhase: 'cutover' }
    case 'cutover':
      return { label: 'Drop v1 (final)', toPhase: 'v1-dropped' }
    case 'rolled-back':
      return { label: 'Restart dual-write', toPhase: 'dual-write' }
    case 're-embedding':
    case 'v1-dropped':
    default:
      return null
  }
}

function AgentRow(props: {
  readonly row: MigrationRow
  readonly etaMs: number | null
  readonly onActionStart: (agent: string, action: Action) => void
}): JSX.Element {
  const r = props.row
  const palette = phasePalette(r.phase)
  const showProgress =
    r.phase === 're-embedding' || r.phase === 're-embed-complete'
  const canPause = r.phase === 're-embedding' && !r.paused
  const canResume = r.phase === 're-embedding' && r.paused
  // Rollback is legal from every phase except v1-dropped (LEGAL_TRANSITIONS).
  // Hide it in idle (nothing to roll back) too.
  const canRollback = r.phase !== 'v1-dropped' && r.phase !== 'idle' && r.phase !== 'rolled-back'
  const advance = nextAdvance(r)

  return (
    <li
      className="border-t border-bg-s3 py-3 grid grid-cols-1 md:grid-cols-[200px_1fr_auto] gap-3 items-center"
      data-testid={`migration-row-${r.agent}`}
    >
      <div className="flex items-center gap-2 min-w-0">
        <span className="font-display font-bold text-sm truncate">
          {r.agent}
        </span>
        {r.paused && (
          <Badge
            variant="outline"
            className="font-mono text-[10px] border-warn/40 text-warn"
          >
            paused
          </Badge>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs font-sans">
        <Badge
          variant="outline"
          className={`font-mono text-[10px] ${palette.bg} ${palette.text} ${palette.border}`}
        >
          {palette.label}
        </Badge>
        {showProgress && (
          <span className="font-mono text-fg-2 data">
            {formatProgress(r)}
          </span>
        )}
        {r.phase === 're-embedding' && (
          <span className="font-mono text-fg-3 data">
            eta {formatEta(props.etaMs)}
          </span>
        )}
        {r.error && (
          <span className="text-danger font-mono text-[10px] truncate max-w-xs">
            {r.error}
          </span>
        )}
      </div>
      <div className="flex items-center gap-2 justify-end flex-wrap">
        {r.phase === 're-embedding' && !r.paused && (
          <span
            className="font-mono text-[10px] text-fg-3 data"
            title="Re-embed in flight — pause or roll back to interrupt."
          >
            Re-embedding: {r.progressProcessed.toLocaleString()} /{' '}
            {r.progressTotal.toLocaleString()}
          </span>
        )}
        {r.phase === 'v1-dropped' && (
          <span
            className="font-mono text-[10px] text-primary"
            title="Terminal state — migration complete."
          >
            Migration complete ✓
          </span>
        )}
        {advance && (
          <Button
            size="sm"
            onClick={() =>
              props.onActionStart(r.agent, {
                kind: 'transition',
                toPhase: advance.toPhase,
              })
            }
            className={
              advance.toPhase === 'v1-dropped'
                ? 'bg-danger text-white hover:bg-danger/90 font-mono text-xs'
                : 'bg-primary text-bg-base hover:bg-primary/90 font-mono text-xs'
            }
            data-testid={`migration-advance-${r.agent}`}
          >
            {advance.label}
          </Button>
        )}
        {canPause && (
          <Button
            size="sm"
            variant="outline"
            onClick={() => props.onActionStart(r.agent, { kind: 'pause' })}
            className="border-bg-s3 text-fg-2 hover:text-fg-1 font-mono text-xs"
          >
            Pause
          </Button>
        )}
        {canResume && (
          <Button
            size="sm"
            variant="outline"
            onClick={() => props.onActionStart(r.agent, { kind: 'resume' })}
            className="border-bg-s3 text-fg-2 hover:text-fg-1 font-mono text-xs"
          >
            Resume
          </Button>
        )}
        {canRollback && (
          <Button
            size="sm"
            variant="outline"
            onClick={() => props.onActionStart(r.agent, { kind: 'rollback' })}
            className="border-danger/40 text-danger hover:bg-danger/10 font-mono text-xs"
          >
            Rollback
          </Button>
        )}
        {/* 116-postdeploy 2026-05-12 — Clean orphans surfaces on every
            non-idle, non-error row. Cleaning is idempotent + safe in any
            phase; we leave it hidden in `idle` only because there's no
            v2 vec table activity to clean before dual-write starts. */}
        {r.phase !== 'idle' && r.phase !== 'error' && r.phase !== 'no-store' && (
          <Button
            size="sm"
            variant="outline"
            onClick={() =>
              props.onActionStart(r.agent, { kind: 'cleanup-orphans' })
            }
            className="border-bg-s3 text-fg-2 hover:text-fg-1 font-mono text-xs"
            data-testid={`migration-cleanup-orphans-${r.agent}`}
            title="Remove vec_memories rows whose memory_id no longer exists in memories"
          >
            Clean orphans
          </Button>
        )}
      </div>
    </li>
  )
}

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

export function MigrationTracker(): JSX.Element {
  const migQ = useMigrations()
  const rows = (migQ.data?.results ?? []) as readonly MigrationRow[]
  const etaMap = useVelocityTracker(rows)

  const [pending, setPending] = useState<
    { readonly agent: string; readonly action: Action } | null
  >(null)
  const [bulkOpen, setBulkOpen] = useState(false)
  const [bulkBusy, setBulkBusy] = useState(false)
  const [bulkOutcome, setBulkOutcome] = useState<
    | { readonly succeeded: readonly string[]; readonly failed: readonly { agent: string; error: string }[] }
    | null
  >(null)

  const onActionStart = useCallback((agent: string, action: Action) => {
    setPending({ agent, action })
  }, [])

  // 116-postdeploy 2026-05-12 — fleet-wide "Start re-embedding on every
  // agent stuck at dual-write". The 8-of-10 cohort from 2026-05-08 is the
  // primary use case; once they all flip to re-embedding the button no
  // longer surfaces any candidates and becomes disabled.
  const eligible = useMemo(
    () => rows.filter((r) => r.phase === 'dual-write').map((r) => r.agent),
    [rows],
  )

  const handleBulkStartReembedding = useCallback(async () => {
    setBulkBusy(true)
    setBulkOutcome(null)
    const succeeded: string[] = []
    const failed: { agent: string; error: string }[] = []
    for (const agent of eligible) {
      try {
        await transitionMigration(agent, 're-embedding')
        succeeded.push(agent)
      } catch (err) {
        failed.push({
          agent,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }
    setBulkOutcome({ succeeded, failed })
    setBulkBusy(false)
    void migQ.refetch()
  }, [eligible, migQ])

  const sorted = useMemo(() => {
    // Active migrations (anything except idle) first; then idle agents.
    const score = (r: MigrationRow): number => {
      if (r.phase === 'idle') return 99
      if (r.phase === 'error' || r.phase === 'no-store') return 0
      if (r.phase === 'rolled-back') return 1
      if (r.phase === 're-embedding') return 2
      if (r.phase === 'dual-write') return 3
      if (r.phase === 're-embed-complete') return 4
      if (r.phase === 'cutover') return 5
      if (r.phase === 'v1-dropped') return 6
      return 50
    }
    return [...rows].sort((a, b) => {
      const sa = score(a)
      const sb = score(b)
      if (sa !== sb) return sa - sb
      return a.agent.localeCompare(b.agent)
    })
  }, [rows])

  return (
    <Card
      className="bg-bg-elevated border-bg-s3 text-fg-1"
      data-testid="migration-tracker"
    >
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <div>
            <h2 className="font-display text-base font-bold">
              Embedding migration
            </h2>
            <p className="text-xs text-fg-3 font-sans mt-0.5">
              Per-agent phase + operator advance / pause / resume / rollback.
              ETA projects linearly from velocity over the trailing 6h+ of
              samples.
            </p>
          </div>
          {eligible.length > 0 && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setBulkOutcome(null)
                setBulkOpen(true)
              }}
              data-testid="migration-bulk-start-reembedding"
              className="border-primary/40 text-primary hover:bg-primary/10 font-mono text-xs"
            >
              Start re-embedding ({eligible.length})
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-4 pb-4">
        {migQ.isLoading && (
          <p className="text-fg-2 font-sans text-sm">Loading migrations…</p>
        )}
        {migQ.isError && (
          <p className="text-danger font-sans text-sm">
            Failed to load migrations — daemon unreachable.
          </p>
        )}
        {!migQ.isLoading && !migQ.isError && rows.length === 0 && (
          <p className="text-fg-2 font-sans text-sm">
            No migration state reported.
          </p>
        )}
        {rows.length > 0 && (
          <>
            <FleetAggregate rows={rows} />
            <ul>
              {sorted.map((r) => (
                <AgentRow
                  key={r.agent}
                  row={r}
                  etaMs={etaMap.get(r.agent)?.etaMs ?? null}
                  onActionStart={onActionStart}
                />
              ))}
            </ul>
          </>
        )}
      </CardContent>
      {pending && (
        <ConfirmModal
          open={true}
          agent={pending.agent}
          action={pending.action}
          onClose={() => setPending(null)}
          onConfirmed={() => {
            // Trigger an immediate refetch so the phase pill flips without
            // waiting for the next 10s poll tick.
            void migQ.refetch()
          }}
        />
      )}
      <Dialog
        open={bulkOpen}
        onOpenChange={(o) => {
          if (!o && !bulkBusy) {
            setBulkOpen(false)
            setBulkOutcome(null)
          }
        }}
      >
        <DialogContent
          className="bg-bg-elevated border border-bg-s3 text-fg-1"
          data-testid="migration-bulk-confirm"
        >
          <DialogHeader>
            <DialogTitle className="font-display text-fg-1">
              Start re-embedding on {eligible.length} agent
              {eligible.length === 1 ? '' : 's'}?
            </DialogTitle>
            <DialogDescription className="text-fg-2 font-sans">
              The heartbeat runner will begin backfilling v2 embeddings for
              every agent currently in <code className="font-mono">dual-write</code>.
              Depending on memory store size each agent takes minutes to
              hours; per-agent pause / rollback remains available throughout.
            </DialogDescription>
          </DialogHeader>
          {!bulkOutcome && (
            <ul className="rounded-md border border-bg-s3 bg-bg-base p-3 max-h-48 overflow-y-auto text-xs font-mono space-y-1">
              {eligible.map((a) => (
                <li key={a} className="text-fg-2">
                  {a}
                </li>
              ))}
            </ul>
          )}
          {bulkOutcome && (
            <div className="space-y-2 text-xs font-mono">
              <p className="text-fg-2">
                Started: <span className="text-primary">{bulkOutcome.succeeded.length}</span>
                {bulkOutcome.failed.length > 0 && (
                  <>
                    {' · '}
                    Failed: <span className="text-danger">{bulkOutcome.failed.length}</span>
                  </>
                )}
              </p>
              {bulkOutcome.failed.length > 0 && (
                <ul className="rounded-md border border-danger/40 bg-danger/5 p-2 max-h-32 overflow-y-auto space-y-0.5">
                  {bulkOutcome.failed.map((f) => (
                    <li key={f.agent} className="text-danger text-[11px]">
                      <span className="font-bold">{f.agent}</span>: {f.error}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
          <DialogFooter className="gap-2">
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                setBulkOpen(false)
                setBulkOutcome(null)
              }}
              disabled={bulkBusy}
            >
              {bulkOutcome ? 'Close' : 'Cancel'}
            </Button>
            {!bulkOutcome && (
              <Button
                type="button"
                onClick={handleBulkStartReembedding}
                disabled={bulkBusy || eligible.length === 0}
                className="bg-primary text-bg-base hover:bg-primary/90"
              >
                {bulkBusy ? 'Working…' : `Start ${eligible.length}`}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  )
}

export default MigrationTracker
