/**
 * Phase 116-04 F13 — cross-agent IPC inbox + fleet delivery snapshot.
 *
 * Two surfaces stacked vertically:
 *   1. Per-agent inbox table — pending message count + last-modified time
 *      for every agent's inbox dir (memoryPath/inbox). The "heartbeat"
 *      column is derived from lastModified; if > 24h the row gets an
 *      amber tint suggesting the agent hasn't picked up messages.
 *   2. Fleet delivery snapshot — counts from DeliveryQueue.getStats()
 *      (pending / inFlight / failed / delivered) + last 50 permanently
 *      failed entries for the operator to triage.
 *
 * NOTE on the cross-agent vs Discord-outbound distinction: cross-agent
 * IPC (send_to_agent / ask_agent) writes JSON files into the recipient's
 * inbox dir and is picked up by InboxSource — there's no per-call row
 * in any queue. The Discord delivery queue tracks agent → Discord
 * channel sends, which IS a useful operator surface but distinct from
 * the inbox pickup path. We surface BOTH and label each clearly.
 *
 * The drawer (F11) uses a compact mode (`scope="agent"`) showing only
 * the selected agent's inbox row. The fleet view mounts the full table.
 */
import { useIpcInboxes } from '@/hooks/useApi'

function rowHeartbeatTint(lastModified: string | null): string {
  if (!lastModified) return ''
  const age = Date.now() - new Date(lastModified).getTime()
  const day = 24 * 60 * 60 * 1000
  if (age > day) return 'bg-warn/10'
  return ''
}

function relTime(ts: string | null): string {
  if (!ts) return '—'
  const age = Date.now() - new Date(ts).getTime()
  if (age < 0) return 'just now'
  const sec = Math.floor(age / 1000)
  if (sec < 60) return `${sec}s ago`
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}m ago`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h ago`
  const d = Math.floor(hr / 24)
  return `${d}d ago`
}

type IpcInboxProps = {
  /** When set, only that agent's inbox row renders (drawer mode). */
  readonly scope?: string
}

export function IpcInbox(props: IpcInboxProps = {}): JSX.Element {
  const q = useIpcInboxes()
  const data = q.data
  const inboxes = data?.inboxes ?? []
  const filtered = props.scope
    ? inboxes.filter((i) => i.agent === props.scope)
    : inboxes

  return (
    <section
      className="space-y-3 border border-bg-s3 rounded-md bg-bg-elevated p-3"
      data-testid="ipc-inbox"
      data-scope={props.scope ?? 'fleet'}
    >
      <header className="flex items-baseline justify-between">
        <h3 className="font-display text-sm font-bold text-fg-1">
          {props.scope ? 'IPC inbox' : 'Cross-agent IPC inbox'}
        </h3>
        <span className="text-[10px] uppercase tracking-wide text-fg-3 font-sans">
          {q.isLoading
            ? 'loading…'
            : q.isError
              ? 'unavailable'
              : `${filtered.length} agent${filtered.length === 1 ? '' : 's'}`}
        </span>
      </header>

      {q.isError && (
        <p className="text-danger text-xs">
          Failed to load IPC inbox state: {(q.error as Error).message}
        </p>
      )}

      {filtered.length > 0 && (
        <table
          className="w-full text-xs font-mono"
          data-testid="ipc-inbox-table"
        >
          <thead>
            <tr className="text-fg-3 text-left border-b border-bg-s3">
              <th className="py-1 pr-2">Agent</th>
              <th className="py-1 pr-2">Pending</th>
              <th className="py-1 pr-2">Last write</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((row) => (
              <tr
                key={row.agent}
                className={`border-b border-bg-s3/40 ${rowHeartbeatTint(row.lastModified)}`}
              >
                <td className="py-1 pr-2 text-fg-1">{row.agent}</td>
                <td
                  className={`py-1 pr-2 data ${row.pending > 0 ? 'text-warn' : 'text-fg-2'}`}
                >
                  {row.pending}
                </td>
                <td className="py-1 pr-2 text-fg-2 data">
                  {relTime(row.lastModified)}
                  {row.error && (
                    <span className="text-danger ml-2" title={row.error}>
                      err
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {!props.scope && data?.deliveryStats && (
        <div className="border-t border-bg-s3 pt-3 space-y-1">
          <h4 className="text-[11px] uppercase tracking-wide text-fg-3 font-sans">
            Discord delivery queue (24h)
          </h4>
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 font-mono text-xs">
            <Stat
              label="pending"
              value={data.deliveryStats.pending}
              tone={data.deliveryStats.pending > 0 ? 'warn' : 'default'}
            />
            <Stat
              label="in-flight"
              value={data.deliveryStats.inFlight}
              tone="default"
            />
            <Stat
              label="failed"
              value={data.deliveryStats.failed}
              tone={data.deliveryStats.failed > 0 ? 'danger' : 'default'}
            />
            <Stat
              label="delivered"
              value={data.deliveryStats.delivered}
              tone="default"
            />
            <Stat
              label="total"
              value={data.deliveryStats.totalEnqueued}
              tone="default"
            />
          </div>
          {data.recentFailures.length > 0 && (
            <details className="mt-2">
              <summary className="text-xs text-fg-3 cursor-pointer hover:text-fg-1">
                Recent failures ({data.recentFailures.length})
              </summary>
              <ul className="mt-2 space-y-1 text-[11px] font-mono text-fg-2">
                {data.recentFailures.slice(0, 10).map((f, i) => (
                  <li
                    key={`${f.id}-${i}`}
                    className="border-l-2 border-danger/40 pl-2"
                  >
                    {f.agentName ?? '<unknown>'} →{' '}
                    {(f.channelId ?? '<no-channel>').slice(0, 14)}
                    {f.errorMessage && (
                      <span className="text-danger ml-2">
                        {String(f.errorMessage).slice(0, 80)}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}

      <p className="text-[10px] text-fg-3 font-sans">
        Inbox pending counts come from chokidar-watched directories at
        memoryPath/inbox. Cross-agent send/ask traffic is file-based (not
        queue-tracked); the Discord delivery queue table tracks
        agent → channel sends only.
      </p>
    </section>
  )
}

function Stat(props: {
  readonly label: string
  readonly value: number
  readonly tone: 'default' | 'warn' | 'danger'
}): JSX.Element {
  const toneClass =
    props.tone === 'danger'
      ? 'text-danger'
      : props.tone === 'warn'
        ? 'text-warn'
        : 'text-fg-1'
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wide text-fg-3">
        {props.label}
      </div>
      <div className={`${toneClass} data text-sm`}>{props.value}</div>
    </div>
  )
}

export default IpcInbox
