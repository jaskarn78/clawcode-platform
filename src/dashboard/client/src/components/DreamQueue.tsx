/**
 * Phase 116-04 F15 — dream-pass queue + D-10 veto window viewer.
 *
 * Surfaces three things:
 *   1. Schedule status — agent's dream config (enabled / idleMinutes /
 *      model / retentionDays). The actual cron isn't a string in our
 *      schema; the scheduler fires when the agent is idle >= idleMinutes.
 *      The UI renders "fires when idle ≥ Xm" rather than a wall-clock
 *      countdown.
 *   2. Last 7 dream events — files in <memoryRoot>/dreams/*.md with
 *      mtime + header count (each file may carry multiple passes).
 *   3. Pending D-10 veto windows — rows from createDreamVetoStore.list()
 *      filtered to this agent + status='pending'. Each row gets a
 *      countdown to deadline + a Veto button that opens a rationale
 *      modal. POST hits the IPC handler which wraps VetoStore.vetoRun.
 */
import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import {
  useDreamQueue,
  vetoDreamRun,
  type DreamVetoWindow,
} from '@/hooks/useApi'

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

function deadlineCountdown(deadlineMs: number): string {
  const delta = deadlineMs - Date.now()
  if (delta <= 0) return 'overdue'
  const sec = Math.floor(delta / 1000)
  if (sec < 60) return `${sec}s left`
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}m left`
  const hr = Math.floor(min / 60)
  return `${hr}h left`
}

type DreamQueueProps = {
  readonly agentName: string
}

export function DreamQueue(props: DreamQueueProps): JSX.Element {
  const q = useDreamQueue(props.agentName)
  const data = q.data
  return (
    <section
      className="space-y-3 border border-bg-s3 rounded-md bg-bg-elevated p-3"
      data-testid="dream-queue"
      data-agent={props.agentName}
    >
      <header className="flex items-baseline justify-between">
        <h3 className="font-display text-sm font-bold text-fg-1">
          Dream queue
        </h3>
        <span className="text-[10px] uppercase tracking-wide text-fg-3 font-sans">
          {q.isLoading
            ? 'loading…'
            : q.isError
              ? 'unavailable'
              : data?.events.length === 0
                ? 'no events'
                : `${data?.events.length} events`}
        </span>
      </header>

      {q.isError && (
        <p className="text-danger text-xs">
          {(q.error as Error).message}
        </p>
      )}

      {data?.dreamConfig && (
        <div className="text-xs font-mono text-fg-2 data flex items-baseline gap-3 flex-wrap">
          <span className="text-fg-3 text-[10px] uppercase tracking-wide">
            schedule
          </span>
          <span>
            {data.dreamConfig.enabled ? (
              <span className="text-primary">enabled</span>
            ) : (
              <span className="text-fg-3">disabled</span>
            )}
          </span>
          <span>
            fires when idle ≥{' '}
            <span className="text-fg-1">{data.dreamConfig.idleMinutes}m</span>
          </span>
          <span>
            model:{' '}
            <span className="text-fg-1">{data.dreamConfig.model}</span>
          </span>
          {data.dreamConfig.retentionDays !== null && (
            <span>
              retain:{' '}
              <span className="text-fg-1">
                {data.dreamConfig.retentionDays}d
              </span>
            </span>
          )}
        </div>
      )}

      {data && data.events.length > 0 && (
        <div className="space-y-1">
          <h4 className="text-[10px] uppercase tracking-wide text-fg-3 font-sans">
            Recent dream files
          </h4>
          <ul className="space-y-1 text-[11px] font-mono">
            {data.events.map((e) => (
              <li
                key={e.file}
                className="flex items-baseline justify-between text-fg-2"
              >
                <span>{e.file}</span>
                <span className="data text-fg-3">
                  {e.headerCount} pass{e.headerCount === 1 ? '' : 'es'} ·{' '}
                  {relTime(e.lastModified)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {data && data.pendingVetoWindows.length > 0 && (
        <div className="space-y-2 border-t border-bg-s3 pt-3">
          <h4 className="text-[10px] uppercase tracking-wide text-warn font-sans">
            Pending D-10 veto windows
          </h4>
          {data.pendingVetoWindows.map((w) => (
            <VetoWindowRow
              key={w.runId}
              agentName={props.agentName}
              window={w}
            />
          ))}
        </div>
      )}

      {data && data.pendingVetoWindows.length === 0 && (
        <p className="text-[10px] text-fg-3 font-mono">
          No pending veto windows.
        </p>
      )}
    </section>
  )
}

function VetoWindowRow(props: {
  readonly agentName: string
  readonly window: DreamVetoWindow
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const qc = useQueryClient()

  const onVeto = async () => {
    if (reason.trim().length === 0) {
      setError('rationale is required')
      return
    }
    setBusy(true)
    setError(null)
    try {
      await vetoDreamRun(props.agentName, props.window.runId, reason.trim())
      // Optimistic-ish: invalidate the queue so the row drops out on next
      // refetch.
      qc.invalidateQueries({ queryKey: ['dream-queue', props.agentName] })
      setOpen(false)
      setReason('')
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="border border-bg-s3/80 rounded p-2 text-[11px] font-mono">
      <div className="flex items-baseline justify-between">
        <div>
          <span className="text-fg-1">
            {props.window.runId.slice(0, 12)}…
          </span>
          {props.window.isPriorityPass && (
            <span className="ml-2 text-warn">priority</span>
          )}
        </div>
        <span className="text-fg-3 data">
          {props.window.candidateCount} candidates ·{' '}
          {deadlineCountdown(props.window.deadline)}
        </span>
      </div>
      {!open ? (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="mt-1 text-[10px] text-warn hover:text-fg-1 underline"
        >
          Veto…
        </button>
      ) : (
        <div className="mt-2 space-y-1">
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Rationale (required, ≤200 chars)"
            maxLength={200}
            rows={2}
            className="w-full text-[11px] p-1 bg-bg-base border border-bg-s3 rounded text-fg-1 font-mono"
          />
          {error && <p className="text-danger text-[10px]">{error}</p>}
          <div className="flex gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={onVeto}
              className="text-[10px] px-2 py-1 bg-warn/20 hover:bg-warn/40 text-warn rounded disabled:opacity-50"
            >
              {busy ? 'Vetoing…' : 'Confirm veto'}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setOpen(false)
                setReason('')
                setError(null)
              }}
              className="text-[10px] px-2 py-1 text-fg-3 hover:text-fg-1"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

export default DreamQueue
