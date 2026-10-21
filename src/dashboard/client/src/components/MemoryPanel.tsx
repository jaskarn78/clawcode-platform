/**
 * Phase 116-04 F14 — memory subsystem panel (READ-ONLY in v1).
 *
 * Per operator decision (.planning/phases/116-.../116-DEFERRED.md), the
 * in-UI editor for SOUL.md / IDENTITY.md / MEMORY.md / USER.md is
 * DEFERRED. This panel surfaces:
 *
 *   - Tier counts (hot / warm / cold) as a small horizontal bar
 *   - First 1000 chars of each Tier-1 file (collapsed by default)
 *   - vec_memories vs vec_memories_v2 row counts (migration delta)
 *   - Last 5 consolidation files from <memoryRoot>/dreams/
 *
 * The "Edit" affordance per file shows a tooltip with the CLI command
 * (per the deferred-decision rationale: file-locking + atomic write
 * already exist via the CLI path; the UI editor needs a coordinated
 * write surface that's a separate plan).
 */
import { useState } from 'react'
import { useMemorySnapshot, type MemoryFilePreview } from '@/hooks/useApi'

function fmtBytes(n: number): string {
  if (n < 1024) return `${n}B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`
  return `${(n / 1024 / 1024).toFixed(1)}MB`
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
  return `${Math.floor(hr / 24)}d ago`
}

type MemoryPanelProps = {
  readonly agentName: string
}

export function MemoryPanel(props: MemoryPanelProps): JSX.Element {
  const q = useMemorySnapshot(props.agentName)
  const data = q.data
  return (
    <section
      className="space-y-3 border border-bg-s3 rounded-md bg-bg-elevated p-3"
      data-testid="memory-panel"
      data-agent={props.agentName}
    >
      <header className="flex items-baseline justify-between">
        <h3 className="font-display text-sm font-bold text-fg-1">Memory</h3>
        <span className="text-[10px] uppercase tracking-wide text-fg-3 font-sans">
          read-only
        </span>
      </header>

      {q.isLoading && <p className="text-fg-2 text-sm">Loading…</p>}
      {q.isError && (
        <p className="text-danger text-xs">
          Failed to load memory snapshot: {(q.error as Error).message}
        </p>
      )}

      {data && (
        <>
          <TierBar data={data.tierCounts} />
          <MigrationRow data={data.migrationDelta} />
          <FilePreviews files={data.files} hint={data.editAffordance.hint} />
          <ConsolidationList items={data.consolidations} />
        </>
      )}
    </section>
  )
}

function TierBar(props: {
  readonly data: {
    readonly hot: number
    readonly warm: number
    readonly cold: number
    readonly total: number
  }
}): JSX.Element {
  const { hot, warm, cold, total } = props.data
  const max = Math.max(1, total)
  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between text-[11px] font-mono">
        <span className="text-fg-3">Memory tiers</span>
        <span className="text-fg-2 data">{total} entries</span>
      </div>
      <div className="flex h-2 rounded overflow-hidden bg-bg-muted">
        <div
          className="bg-primary"
          style={{ width: `${(hot / max) * 100}%` }}
          title={`hot: ${hot}`}
        />
        <div
          className="bg-warn"
          style={{ width: `${(warm / max) * 100}%` }}
          title={`warm: ${warm}`}
        />
        <div
          className="bg-fg-3"
          style={{ width: `${(cold / max) * 100}%` }}
          title={`cold: ${cold}`}
        />
      </div>
      <div className="text-[10px] font-mono text-fg-3 flex gap-3">
        <span>
          <span className="inline-block w-2 h-2 bg-primary mr-1 rounded-sm" />
          hot {hot}
        </span>
        <span>
          <span className="inline-block w-2 h-2 bg-warn mr-1 rounded-sm" />
          warm {warm}
        </span>
        <span>
          <span className="inline-block w-2 h-2 bg-fg-3 mr-1 rounded-sm" />
          cold {cold}
        </span>
      </div>
    </div>
  )
}

function MigrationRow(props: {
  readonly data: {
    readonly vecMemoriesRows: number | null
    readonly vecMemoriesV2Rows: number | null
  }
}): JSX.Element | null {
  const v1 = props.data.vecMemoriesRows
  const v2 = props.data.vecMemoriesV2Rows
  if (v1 === null && v2 === null) {
    return (
      <p className="text-[10px] text-fg-3 font-mono">
        vec_memories tables not present.
      </p>
    )
  }
  const pct =
    v1 !== null && v1 > 0 && v2 !== null
      ? Math.min(100, Math.round((v2 / v1) * 100))
      : null
  return (
    <div className="text-xs font-mono text-fg-2 data flex items-baseline gap-3">
      <span className="text-fg-3 text-[10px] uppercase tracking-wide">
        embed migration
      </span>
      <span>
        v1: <span className="text-fg-1">{v1 ?? '—'}</span>
      </span>
      <span>
        v2: <span className="text-fg-1">{v2 ?? '—'}</span>
      </span>
      {pct !== null && (
        <span className={pct >= 99 ? 'text-primary' : 'text-warn'}>
          {pct}% migrated
        </span>
      )}
    </div>
  )
}

function FilePreviews(props: {
  readonly files: readonly MemoryFilePreview[]
  readonly hint: string
}): JSX.Element {
  return (
    <div className="space-y-1">
      <h4 className="text-[10px] uppercase tracking-wide text-fg-3 font-sans">
        Tier-1 files
      </h4>
      <ul className="space-y-1">
        {props.files.map((f) => (
          <FilePreviewRow key={f.name} file={f} hint={props.hint} />
        ))}
      </ul>
    </div>
  )
}

function FilePreviewRow(props: {
  readonly file: MemoryFilePreview
  readonly hint: string
}): JSX.Element {
  const { file } = props
  const [open, setOpen] = useState(false)
  if (file.totalChars === 0 && file.preview === null && !file.error) {
    return (
      <li className="text-[11px] font-mono text-fg-3 flex justify-between">
        <span>{file.name}</span>
        <span className="data">— not present</span>
      </li>
    )
  }
  return (
    <li className="border border-bg-s3/60 rounded p-2 text-[11px] font-mono">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex justify-between items-center text-left hover:bg-bg-muted/40"
      >
        <span className="text-fg-1">
          {open ? '▾' : '▸'} {file.name}
        </span>
        <span className="text-fg-3 data">
          {file.totalChars} chars · {relTime(file.lastModified)}
        </span>
      </button>
      {open && (
        <div className="mt-2 space-y-2">
          <pre
            className="bg-bg-base/60 p-2 rounded text-fg-2 whitespace-pre-wrap text-[10px] max-h-48 overflow-y-auto"
            data-testid="memory-file-preview"
          >
            {file.preview ?? '<empty>'}
          </pre>
          {file.totalChars > 1000 && file.preview && (
            <p className="text-[10px] text-fg-3">
              Showing first 1000 chars of {file.totalChars} total.
            </p>
          )}
          <p
            className="text-[10px] text-fg-3 italic"
            title={props.hint}
          >
            Edit via CLI: <code className="data">{`clawcode memory edit <agent> ${file.name}`}</code>
          </p>
        </div>
      )}
      {file.error && (
        <p className="text-danger text-[10px] mt-1">{file.error}</p>
      )}
    </li>
  )
}

function ConsolidationList(props: {
  readonly items: readonly {
    readonly file: string
    readonly lastModified: string
    readonly sizeBytes: number
  }[]
}): JSX.Element {
  if (props.items.length === 0) {
    return (
      <p className="text-[10px] text-fg-3 font-mono">
        No dream-pass log entries yet.
      </p>
    )
  }
  return (
    <div className="space-y-1">
      <h4 className="text-[10px] uppercase tracking-wide text-fg-3 font-sans">
        Recent consolidations
      </h4>
      <ul className="space-y-1 text-[11px] font-mono">
        {props.items.map((c) => (
          <li
            key={c.file}
            className="flex items-baseline justify-between text-fg-2"
          >
            <span>{c.file}</span>
            <span className="data text-fg-3">
              {fmtBytes(c.sizeBytes)} · {relTime(c.lastModified)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}

export default MemoryPanel
