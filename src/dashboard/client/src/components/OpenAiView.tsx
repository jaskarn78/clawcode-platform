/**
 * Phase 116-postdeploy 2026-05-12 — OpenAI endpoint config page.
 *
 * Operator asked: "a page to configure the OpenAI-style endpoint we set up
 * for this project." The endpoint (Phase 69, port 3101 by default, served
 * out-of-process by the daemon) has lived as CLI-only key management for
 * the better part of a year. This page wraps the existing IPC surface so
 * keys can be created, listed, and revoked from the dashboard.
 *
 * Layout:
 *   1. Endpoint card — base URL, curl example, status.
 *   2. API keys table — list + revoke (with confirm) + filter.
 *   3. Create-key form — name + scope (all / per-agent).
 *   4. One-time key reveal panel — shown after create, dismissible.
 *
 * Operator threat model: the plaintext key is returned exactly once by the
 * daemon. The reveal panel is intentionally modal-ish (warning copy + copy
 * button + "I've saved it" dismiss). After dismiss the SPA cache forgets
 * it.
 */
import { useQueryClient } from '@tanstack/react-query'
import { useMemo, useState } from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import {
  createOpenAiKey,
  revokeOpenAiKey,
  useAgents,
  useOpenAiInfo,
  useOpenAiKeys,
  type OpenAiKeyCreateResponse,
  type OpenAiKeyRow,
} from '@/hooks/useApi'

function fmtUnix(ts: number | null): string {
  if (!ts) return '—'
  return new Date(ts * 1000).toLocaleString()
}

function fmtRel(ts: number | null): string {
  if (!ts) return 'never'
  const d = Date.now() - ts * 1000
  if (d < 60_000) return `${Math.round(d / 1000)}s ago`
  if (d < 3_600_000) return `${Math.round(d / 60_000)}m ago`
  if (d < 86_400_000) return `${Math.round(d / 3_600_000)}h ago`
  return `${Math.round(d / 86_400_000)}d ago`
}

function deriveBaseUrl(
  info:
    | { enabled: false }
    | { enabled: true; host: string | null; port: number | null }
    | undefined,
): string | null {
  if (!info || !info.enabled) return null
  // Host is usually "0.0.0.0" or "::" daemon-side. Surface the dashboard's
  // own hostname so the operator sees a URL they can actually curl.
  const port = info.port
  if (!port) return null
  const hostname =
    typeof window !== 'undefined' ? window.location.hostname : 'localhost'
  return `http://${hostname}:${port}/v1`
}

export function OpenAiView(): JSX.Element {
  const queryClient = useQueryClient()
  const infoQ = useOpenAiInfo()
  const enabled = infoQ.data?.enabled === true
  const keysQ = useOpenAiKeys(enabled)
  const agentsQ = useAgents()

  // Create form state
  const [keyLabel, setKeyLabel] = useState('')
  const [scope, setScope] = useState<'all' | 'agent'>('all')
  const [agentName, setAgentName] = useState('')
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)

  // Reveal state — non-empty when a key was just created and not yet
  // dismissed. The plaintext is intentionally kept ONLY in this component's
  // state — never put back into the keys list cache.
  const [revealed, setRevealed] = useState<OpenAiKeyCreateResponse | null>(null)

  // Confirm-revoke modal target
  const [revokeTarget, setRevokeTarget] = useState<OpenAiKeyRow | null>(null)
  const [revoking, setRevoking] = useState(false)

  const baseUrl = deriveBaseUrl(infoQ.data)
  const curlExample = useMemo(() => {
    if (!baseUrl) return null
    return [
      `curl -X POST ${baseUrl}/chat/completions \\`,
      `  -H "Authorization: Bearer <YOUR_KEY>" \\`,
      `  -H "Content-Type: application/json" \\`,
      `  -d '{`,
      `    "model": "claude-opus-4-7",`,
      `    "messages": [{"role": "user", "content": "Hello"}]`,
      `  }'`,
    ].join('\n')
  }, [baseUrl])

  async function handleCreate(e: React.FormEvent): Promise<void> {
    e.preventDefault()
    setCreateError(null)
    setCreating(true)
    try {
      const body =
        scope === 'all'
          ? {
              all: true as const,
              ...(keyLabel.trim() ? { label: keyLabel.trim() } : {}),
            }
          : {
              agent: agentName,
              ...(keyLabel.trim() ? { label: keyLabel.trim() } : {}),
            }
      if (scope === 'agent' && !agentName) {
        throw new Error('Pick an agent for per-agent scope')
      }
      const out = await createOpenAiKey(body)
      setRevealed(out)
      setKeyLabel('')
      setAgentName('')
      setScope('all')
      void queryClient.invalidateQueries({ queryKey: ['openai-keys'] })
    } catch (err) {
      setCreateError((err as Error).message)
    } finally {
      setCreating(false)
    }
  }

  async function handleRevoke(): Promise<void> {
    if (!revokeTarget) return
    setRevoking(true)
    try {
      // Pass the full key_hash — ApiKeysStore.revokeKey accepts hex prefix
      // ≥8 chars OR the full hash (cf. src/openai/keys.ts:revokeKey). Full
      // hash is the safe path: no chance of collision-driven mis-resolution
      // if the operator has many keys.
      await revokeOpenAiKey(revokeTarget.key_hash)
      setRevokeTarget(null)
      void queryClient.invalidateQueries({ queryKey: ['openai-keys'] })
    } catch (err) {
      setCreateError((err as Error).message)
    } finally {
      setRevoking(false)
    }
  }

  const agents =
    agentsQ.data?.agents
      ?.map((a) => a.name)
      .filter((n) => !n.includes('-sub-') && !n.includes('-thread-')) ?? []

  return (
    <div
      className="mx-auto max-w-4xl px-7 py-6"
      data-testid="openai-view"
    >
      {/* dash-redesign sweep — section-head pattern. Endpoint-purpose
          copy folds into .sub so the page opens with the same scan
          rhythm as every other tab. */}
      <div className="section-head mb-5">
        <div className="flex items-baseline">
          <h2>OpenAI endpoint</h2>
          <span className="sub">
            OpenAI-compatible chat-completions backed by Claude · keys
            scoped per-agent or fleet-wide
          </span>
        </div>
      </div>

      {/* ENDPOINT CARD */}
      <section className="tile mb-4">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="font-display text-lg font-medium text-fg-1">
            Endpoint
          </h2>
          <span className="inline-flex items-center gap-2 font-mono text-[11px] uppercase tracking-wider text-fg-2">
            {/* dash-redesign sweep — .mc-dot semantics. Active endpoint
                pulses emerald (live ok); disabled is calm warn amber. */}
            <span className={enabled ? 'mc-dot live ok' : 'mc-dot warn'} />
            {enabled ? 'active' : 'disabled'}
          </span>
        </div>

        {infoQ.isLoading && (
          <p className="text-sm text-fg-3">Loading endpoint info…</p>
        )}
        {infoQ.error && (
          <p className="text-sm text-destructive">
            {(infoQ.error as Error).message}
          </p>
        )}

        {!enabled && infoQ.data && !infoQ.isLoading && (
          <div className="rounded-md border border-dashed border-border bg-bg-base p-4 text-sm">
            <p className="text-fg-2">
              Endpoint is disabled. Enable it by setting{' '}
              <code className="font-mono text-fg-1">
                defaults.openai.enabled = true
              </code>{' '}
              in <code className="font-mono">~/.clawcode/config.yaml</code>, or
              set the <code className="font-mono">CLAWCODE_OPENAI_PORT</code> env
              var to a free port and restart the daemon.
            </p>
          </div>
        )}

        {enabled && baseUrl && (
          <>
            <dl className="mb-4 space-y-2 text-sm">
              <div className="flex items-center gap-3">
                <dt className="w-20 text-fg-3">Base URL</dt>
                <dd className="flex flex-1 items-center gap-2">
                  <code className="flex-1 rounded-md border border-border bg-bg-base px-2 py-1 font-mono text-xs text-fg-1">
                    {baseUrl}
                  </code>
                  <CopyButton text={baseUrl} label="Copy URL" />
                </dd>
              </div>
              <div className="flex items-center gap-3">
                <dt className="w-20 text-fg-3">Compat</dt>
                <dd className="text-xs text-fg-2">
                  OpenAI SDK, LangChain, any{' '}
                  <code className="font-mono">/v1/chat/completions</code> client
                </dd>
              </div>
            </dl>

            {curlExample && (
              <details className="rounded-md border border-border bg-bg-base">
                <summary className="cursor-pointer px-3 py-2 text-xs font-medium text-fg-2">
                  curl example
                </summary>
                <pre className="overflow-x-auto border-t border-border bg-bg-base px-3 py-2 font-mono text-[11px] leading-relaxed text-fg-1">
                  {curlExample}
                </pre>
                <div className="border-t border-border px-3 py-2">
                  <CopyButton text={curlExample} label="Copy command" />
                </div>
              </details>
            )}
          </>
        )}
      </section>

      {/* KEYS TABLE */}
      {enabled && (
        <section className="tile mb-4">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="font-display text-lg font-medium text-fg-1">
              API keys
            </h2>
            {keysQ.data && (
              <span className="font-mono text-xs text-fg-3">
                {keysQ.data.rows.length} total
              </span>
            )}
          </div>

          {keysQ.isLoading && (
            <p className="text-sm text-fg-3">Loading keys…</p>
          )}
          {keysQ.error && (
            <p className="text-sm text-destructive">
              {(keysQ.error as Error).message}
            </p>
          )}

          {keysQ.data && keysQ.data.rows.length === 0 && (
            <div className="rounded-md border border-dashed border-border bg-bg-base p-6 text-center text-sm text-fg-3">
              No keys yet. Create one below to start using the endpoint.
            </div>
          )}

          {keysQ.data && keysQ.data.rows.length > 0 && (
            <div className="overflow-hidden rounded-md border border-border">
              <table className="w-full text-sm">
                <thead className="bg-bg-base">
                  <tr className="border-b border-border text-left">
                    <th className="px-3 py-2 font-mono text-[10px] font-medium uppercase tracking-wider text-fg-3">
                      Label
                    </th>
                    <th className="px-3 py-2 font-mono text-[10px] font-medium uppercase tracking-wider text-fg-3">
                      Scope
                    </th>
                    <th className="px-3 py-2 font-mono text-[10px] font-medium uppercase tracking-wider text-fg-3">
                      Created
                    </th>
                    <th className="px-3 py-2 font-mono text-[10px] font-medium uppercase tracking-wider text-fg-3">
                      Last used
                    </th>
                    <th className="px-3 py-2 font-mono text-[10px] font-medium uppercase tracking-wider text-fg-3">
                      Status
                    </th>
                    <th className="px-3 py-2"></th>
                  </tr>
                </thead>
                <tbody>
                  {keysQ.data.rows.map((row) => {
                    const isAll =
                      row.scope === 'all' || row.agent_name === '*'
                    const status = row.disabled_at ? 'revoked' : 'active'
                    return (
                      <tr
                        key={row.key_hash}
                        className="border-b border-border last:border-b-0"
                      >
                        <td className="px-3 py-2 text-fg-1">
                          {row.label ?? (
                            <span className="font-mono text-xs text-fg-3">
                              {row.key_hash.slice(0, 12)}…
                            </span>
                          )}
                        </td>
                        <td className="px-3 py-2 font-mono text-xs text-fg-2">
                          {isAll ? (
                            <span className="rounded-full bg-primary/10 px-2 py-0.5 text-primary">
                              all agents
                            </span>
                          ) : (
                            row.agent_name
                          )}
                        </td>
                        <td className="px-3 py-2 font-mono text-xs text-fg-2">
                          {fmtUnix(row.created_at)}
                        </td>
                        <td className="px-3 py-2 font-mono text-xs text-fg-2">
                          {fmtRel(row.last_used_at)}
                        </td>
                        <td className="px-3 py-2">
                          <span
                            className={
                              'rounded-full px-2 py-0.5 font-mono text-[10px] font-medium uppercase tracking-wider ' +
                              (status === 'active'
                                ? 'bg-primary/15 text-primary'
                                : 'bg-fg-3/15 text-fg-3')
                            }
                          >
                            {status}
                          </span>
                        </td>
                        <td className="px-3 py-2 text-right">
                          {status === 'active' && (
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => setRevokeTarget(row)}
                            >
                              Revoke
                            </Button>
                          )}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      {/* CREATE FORM */}
      {enabled && (
        <section className="tile mb-4">
          <h2 className="mb-3 font-display text-lg font-medium text-fg-1">
            Create key
          </h2>
          <form onSubmit={handleCreate} className="space-y-3">
            <div>
              <label className="mb-1 block text-xs font-medium text-fg-2">
                Name (optional label)
              </label>
              <input
                type="text"
                value={keyLabel}
                onChange={(e) => setKeyLabel(e.target.value)}
                placeholder="e.g. langchain-prod"
                className="w-full rounded-md border border-border bg-bg-base px-3 py-1.5 text-sm text-fg-1 placeholder:text-fg-3 focus:border-primary focus:outline-none"
              />
            </div>

            <fieldset>
              <legend className="mb-1 block text-xs font-medium text-fg-2">
                Scope
              </legend>
              <div className="flex flex-col gap-2">
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="radio"
                    checked={scope === 'all'}
                    onChange={() => setScope('all')}
                  />
                  <span className="text-fg-1">All agents</span>
                  <span className="text-xs text-fg-3">
                    — single key accepted on every configured agent
                  </span>
                </label>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="radio"
                    checked={scope === 'agent'}
                    onChange={() => setScope('agent')}
                  />
                  <span className="text-fg-1">Specific agent</span>
                </label>
                {scope === 'agent' && (
                  <select
                    value={agentName}
                    onChange={(e) => setAgentName(e.target.value)}
                    className="ml-6 max-w-xs rounded-md border border-border bg-bg-base px-2 py-1.5 text-sm text-fg-1"
                    required
                  >
                    <option value="">Pick an agent…</option>
                    {agents.map((a) => (
                      <option key={a} value={a}>
                        {a}
                      </option>
                    ))}
                  </select>
                )}
              </div>
            </fieldset>

            {createError && (
              <p className="rounded-md border border-destructive/40 bg-destructive/5 p-2 text-xs text-destructive">
                {createError}
              </p>
            )}

            <Button type="submit" disabled={creating} size="sm">
              {creating ? 'Creating…' : 'Create key'}
            </Button>
          </form>
        </section>
      )}

      {/* ONE-TIME REVEAL DIALOG */}
      <Dialog
        open={revealed !== null}
        onOpenChange={(open) => {
          if (!open) setRevealed(null)
        }}
      >
        <DialogContent>
          {revealed && (
            <>
              <DialogHeader>
                <DialogTitle className="font-display text-xl">
                  Save this key — it won't be shown again
                </DialogTitle>
                <DialogDescription className="text-fg-3">
                  Copy this plaintext value now. The daemon stores only the
                  hash; if you lose it, revoke and create a new one.
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-3">
                <pre className="overflow-x-auto break-all rounded-md border border-border bg-bg-base p-3 font-mono text-xs text-fg-1">
                  {revealed.key}
                </pre>
                <CopyButton text={revealed.key} label="Copy key" />
                <dl className="space-y-1 text-xs">
                  <div className="flex gap-2">
                    <dt className="text-fg-3">Scope:</dt>
                    <dd className="font-mono text-fg-1">{revealed.agent}</dd>
                  </div>
                  {revealed.label && (
                    <div className="flex gap-2">
                      <dt className="text-fg-3">Label:</dt>
                      <dd className="font-mono text-fg-1">{revealed.label}</dd>
                    </div>
                  )}
                </dl>
              </div>
              <DialogFooter>
                <Button onClick={() => setRevealed(null)}>I've saved it</Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>

      {/* REVOKE CONFIRM DIALOG */}
      <Dialog
        open={revokeTarget !== null}
        onOpenChange={(open) => {
          if (!open) setRevokeTarget(null)
        }}
      >
        <DialogContent>
          {revokeTarget && (
            <>
              <DialogHeader>
                <DialogTitle>
                  Revoke {revokeTarget.label ?? 'this key'}?
                </DialogTitle>
                <DialogDescription>
                  Any client using this key will receive 401 immediately.
                  This action cannot be undone — create a new key if you need
                  to re-grant access.
                </DialogDescription>
              </DialogHeader>
              <dl className="space-y-1 text-xs">
                <div className="flex gap-2">
                  <dt className="text-fg-3">Hash:</dt>
                  <dd className="break-all font-mono text-fg-1">
                    {revokeTarget.key_hash}
                  </dd>
                </div>
                <div className="flex gap-2">
                  <dt className="text-fg-3">Scope:</dt>
                  <dd className="font-mono text-fg-1">
                    {revokeTarget.scope === 'all'
                      ? 'all agents'
                      : revokeTarget.agent_name}
                  </dd>
                </div>
              </dl>
              <DialogFooter>
                <Button
                  variant="outline"
                  onClick={() => setRevokeTarget(null)}
                  disabled={revoking}
                >
                  Cancel
                </Button>
                <Button
                  variant="destructive"
                  onClick={handleRevoke}
                  disabled={revoking}
                >
                  {revoking ? 'Revoking…' : 'Revoke'}
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}

function CopyButton(props: {
  readonly text: string
  readonly label: string
}): JSX.Element {
  const { text, label } = props
  const [copied, setCopied] = useState(false)
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      onClick={() => {
        void navigator.clipboard
          ?.writeText(text)
          .then(() => {
            setCopied(true)
            window.setTimeout(() => setCopied(false), 1500)
          })
          .catch(() => {
            /* clipboard blocked — copy via fallback selection on the
               source element would be ideal, but skip silently to keep
               the bundle tight. The pre/code block is already selectable. */
          })
      }}
    >
      {copied ? 'Copied!' : label}
    </Button>
  )
}
