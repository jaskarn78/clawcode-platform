/**
 * Phase 116 Plan 02 T04 — F10 MCP server health panel.
 *
 * Per-agent grouped list of MCP servers sourced from `/api/mcp-servers/:agent`
 * (proxies the daemon `list-mcp-status` IPC, returning the live runtime
 * McpServerState map maintained by the warm-path gate + mcp-reconnect
 * heartbeat).
 *
 * Status badges:
 *   - ready      — emerald
 *   - degraded   — amber
 *   - failed     — red
 *   - reconnecting — animated amber (transient client-side state)
 *   - unknown    — grey
 *
 * Tool count is read from `capabilityProbe.toolCount` when present (the
 * probe writes it on successful tools/list). lastSuccessAt + failureCount
 * surface in a small subtitle.
 *
 * Reconnect button:
 *   - Disabled when the server status is 'ready' (nothing to reconnect)
 *   - Enabled when status is 'degraded' / 'failed' / 'unknown'
 *   - Opens shadcn <Dialog> operator-confirm modal
 *   - On confirm: POST /api/mcp-servers/:agent/:server/reconnect (daemon
 *     proxies to mcp-probe which re-runs the readiness handshake)
 *   - Status flips: ready → reconnecting (optimistic) → ready/failed (next poll)
 */
import { useCallback, useMemo, useState } from 'react'
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
  useAgents,
  useMcpServers,
  type McpAgentSnapshot,
  type McpServerEntry,
} from '@/hooks/useApi'

// ---------------------------------------------------------------------------
// Status palette
// ---------------------------------------------------------------------------

type StatusPalette = {
  readonly bg: string
  readonly text: string
  readonly border: string
  readonly label: string
  readonly animate: boolean
}

function statusPalette(
  status: string,
  reconnecting: boolean,
): StatusPalette {
  if (reconnecting) {
    return {
      bg: 'bg-warn/15',
      text: 'text-warn',
      border: 'border-warn/40',
      label: 'reconnecting',
      animate: true,
    }
  }
  switch (status) {
    case 'ready':
      return {
        bg: 'bg-primary/15',
        text: 'text-primary',
        border: 'border-primary/40',
        label: 'ready',
        animate: false,
      }
    case 'degraded':
      return {
        bg: 'bg-warn/15',
        text: 'text-warn',
        border: 'border-warn/40',
        label: 'degraded',
        animate: false,
      }
    case 'failed':
    case 'offline':
      return {
        bg: 'bg-danger/15',
        text: 'text-danger',
        border: 'border-danger/40',
        label: status,
        animate: false,
      }
    default:
      return {
        bg: 'bg-fg-3/15',
        text: 'text-fg-2',
        border: 'border-fg-3/40',
        label: status || 'unknown',
        animate: false,
      }
  }
}

function relativeTime(input: string | null): string {
  if (!input) return '—'
  const ms = new Date(input).getTime()
  if (!Number.isFinite(ms)) return '—'
  const delta = Date.now() - ms
  if (delta < 0) return 'just now'
  const sec = Math.floor(delta / 1000)
  if (sec < 60) return `${sec}s ago`
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}m ago`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h ago`
  const d = Math.floor(hr / 24)
  return `${d}d ago`
}

// ---------------------------------------------------------------------------
// POST helper
// ---------------------------------------------------------------------------

async function postReconnect(agent: string, server: string): Promise<void> {
  const r = await fetch(
    `/api/mcp-servers/${encodeURIComponent(agent)}/${encodeURIComponent(server)}/reconnect`,
    { method: 'POST', credentials: 'same-origin' },
  )
  if (!r.ok) {
    let detail = ''
    try {
      const body = (await r.json()) as { error?: string }
      detail = body?.error ?? ''
    } catch {
      /* swallow */
    }
    throw new Error(
      `Reconnect failed: ${r.status}${detail ? ` — ${detail}` : ''}`,
    )
  }
}

// ---------------------------------------------------------------------------
// Confirm modal
// ---------------------------------------------------------------------------

function ReconnectModal(props: {
  readonly open: boolean
  readonly agent: string
  readonly server: string
  readonly onClose: () => void
  readonly onConfirmed: () => void
}): JSX.Element {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleConfirm = useCallback(async () => {
    setBusy(true)
    setError(null)
    try {
      await postReconnect(props.agent, props.server)
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
        data-testid="mcp-reconnect-confirm"
      >
        <DialogHeader>
          <DialogTitle className="font-display text-fg-1">
            Reconnect MCP server?
          </DialogTitle>
          <DialogDescription className="text-fg-2 font-sans">
            <span className="font-mono text-primary">{props.agent}</span> →{' '}
            <span className="font-mono text-fg-1">{props.server}</span>
            <br />
            Re-runs the readiness handshake (connect + tools/list capability
            probe) for ALL MCP servers on this agent. Daemon's heartbeat
            continues; this is a one-shot probe.
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
            className="bg-primary text-bg-base hover:bg-primary/90"
          >
            {busy ? 'Reconnecting…' : 'Reconnect'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ---------------------------------------------------------------------------
// Per-server row
// ---------------------------------------------------------------------------

function ServerRow(props: {
  readonly agent: string
  readonly server: McpServerEntry
  readonly reconnecting: boolean
  readonly onReconnect: (agent: string, server: string) => void
}): JSX.Element {
  const s = props.server
  const palette = statusPalette(s.status, props.reconnecting)
  const toolCount = s.capabilityProbe?.toolCount ?? null
  const lastOk = relativeTime(s.lastSuccessAt)
  const canReconnect = s.status !== 'ready'

  return (
    <li
      className="border-t border-bg-s3 py-2 grid grid-cols-[1fr_auto] gap-2 items-center"
      data-testid={`mcp-server-row-${s.name}`}
    >
      <div className="min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-mono text-sm text-fg-1 truncate">
            {s.name}
          </span>
          <Badge
            variant="outline"
            className={`font-mono text-[10px] ${palette.bg} ${palette.text} ${palette.border} ${palette.animate ? 'animate-pulse' : ''}`}
          >
            {palette.label}
          </Badge>
          {s.optional && (
            <Badge
              variant="outline"
              className="font-mono text-[10px] border-fg-3/40 text-fg-3"
            >
              optional
            </Badge>
          )}
          {toolCount !== null && (
            <span className="font-mono text-[10px] text-fg-3 data">
              {toolCount} tool{toolCount === 1 ? '' : 's'}
            </span>
          )}
        </div>
        <div className="flex flex-wrap gap-x-3 text-[11px] font-sans text-fg-3 mt-0.5">
          <span>last ok: {lastOk}</span>
          {s.failureCount > 0 && (
            <span className="text-warn">
              {s.failureCount} failure{s.failureCount === 1 ? '' : 's'}
            </span>
          )}
          {s.lastError && (
            <span className="text-danger font-mono truncate max-w-md">
              {s.lastError}
            </span>
          )}
        </div>
      </div>
      <Button
        size="sm"
        variant="outline"
        onClick={() => props.onReconnect(props.agent, s.name)}
        disabled={!canReconnect || props.reconnecting}
        className="border-bg-s3 text-fg-2 hover:text-fg-1 font-mono text-xs"
        data-testid={`mcp-reconnect-${props.agent}-${s.name}`}
      >
        Reconnect
      </Button>
    </li>
  )
}

// ---------------------------------------------------------------------------
// Per-agent group — fetches its own /api/mcp-servers/:agent payload.
// ---------------------------------------------------------------------------

function AgentMcpGroup(props: {
  readonly agent: string
  readonly reconnectingSet: ReadonlySet<string>
  readonly onReconnect: (agent: string, server: string) => void
}): JSX.Element | null {
  const q = useMcpServers(props.agent)
  const snapshot = q.data as McpAgentSnapshot | undefined
  const servers = snapshot?.servers ?? []
  if (q.isLoading) {
    return (
      <div className="py-2 text-xs text-fg-3 font-sans">
        Loading {props.agent}…
      </div>
    )
  }
  if (q.isError) {
    return (
      <div className="py-2 text-xs text-danger font-sans">
        Failed to load MCP state for {props.agent}.
      </div>
    )
  }
  if (servers.length === 0) {
    // Hide agents with no MCP servers — keeps the panel focused on agents
    // that actually have something to monitor.
    return null
  }
  return (
    <section
      className="space-y-1"
      data-testid={`mcp-agent-group-${props.agent}`}
    >
      <header className="flex items-center justify-between gap-2 pt-2">
        <h3 className="font-display text-sm font-bold text-fg-1">
          {props.agent}
        </h3>
        <span className="font-mono text-[10px] text-fg-3 data">
          {servers.length} server{servers.length === 1 ? '' : 's'}
        </span>
      </header>
      <ul>
        {servers.map((s) => (
          <ServerRow
            key={s.name}
            agent={props.agent}
            server={s}
            reconnecting={props.reconnectingSet.has(`${props.agent}::${s.name}`)}
            onReconnect={props.onReconnect}
          />
        ))}
      </ul>
    </section>
  )
}

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

export function McpHealthPanel(): JSX.Element {
  const agentsQ = useAgents()
  const payload = agentsQ.data as
    | { agents?: ReadonlyArray<{ name: string }> }
    | undefined
  const agentNames = useMemo(
    () => (payload?.agents ?? []).map((a) => a.name),
    [payload],
  )

  const [pending, setPending] = useState<
    { readonly agent: string; readonly server: string } | null
  >(null)
  const [reconnectingSet, setReconnectingSet] = useState<Set<string>>(
    () => new Set(),
  )

  const onReconnect = useCallback((agent: string, server: string) => {
    setPending({ agent, server })
  }, [])

  const onConfirmed = useCallback(() => {
    if (!pending) return
    // Optimistic flip: show 'reconnecting' until the next poll.
    const key = `${pending.agent}::${pending.server}`
    setReconnectingSet((curr) => {
      const next = new Set(curr)
      next.add(key)
      return next
    })
    // Clear the flag after 6s (probe latency budget — well over the
    // daemon's 1.5s readiness handshake timeout per server).
    setTimeout(() => {
      setReconnectingSet((curr) => {
        const next = new Set(curr)
        next.delete(key)
        return next
      })
    }, 6000)
  }, [pending])

  return (
    <Card
      className="bg-bg-elevated border-bg-s3 text-fg-1"
      data-testid="mcp-health-panel"
    >
      <CardHeader className="pb-3">
        <h2 className="font-display text-base font-bold">MCP server health</h2>
        <p className="text-xs text-fg-3 font-sans mt-0.5">
          Per-agent runtime status from the daemon's mcp-reconnect heartbeat.
          Reconnect re-runs the readiness handshake (connect + tools/list).
        </p>
      </CardHeader>
      <CardContent className="pb-4">
        {agentsQ.isLoading && (
          <p className="text-fg-2 font-sans text-sm">Loading fleet…</p>
        )}
        {agentsQ.isError && (
          <p className="text-danger font-sans text-sm">
            Failed to load fleet — daemon unreachable.
          </p>
        )}
        {!agentsQ.isLoading && !agentsQ.isError && agentNames.length === 0 && (
          <p className="text-fg-2 font-sans text-sm">No agents reported.</p>
        )}
        {agentNames.map((name) => (
          <AgentMcpGroup
            key={name}
            agent={name}
            reconnectingSet={reconnectingSet}
            onReconnect={onReconnect}
          />
        ))}
      </CardContent>
      {pending && (
        <ReconnectModal
          open={true}
          agent={pending.agent}
          server={pending.server}
          onClose={() => setPending(null)}
          onConfirmed={onConfirmed}
        />
      )}
    </Card>
  )
}

export default McpHealthPanel
