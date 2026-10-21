/**
 * dashboard-rework P4 — create a new agent (admin-gated).
 *
 * Collects name / soul / model / parent Discord channel and POSTs to
 * /api/agents (→ IPC agent-create). On success it surfaces the new channel URL
 * and the reminder that the agent boots on `clawcode start <name>` or the next
 * daemon restart (agent-add is not hot-reloadable). The POST is gated by the
 * admin token; a 401 raises the AdminAuthBanner.
 */
import { useState, type JSX } from 'react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { createAgent, type CreateAgentResult } from '@/hooks/useApi'

const MODELS = ['', 'sonnet', 'opus', 'haiku'] as const
const NAME_RE = /^[a-z][a-z0-9-]{1,31}$/

type Status =
  | { kind: 'idle' }
  | { kind: 'creating' }
  | { kind: 'done'; result: CreateAgentResult }
  | { kind: 'error'; message: string }

export type NewAgentModalProps = {
  readonly open: boolean
  readonly onOpenChange: (open: boolean) => void
}

const inputCls =
  'w-full rounded-[var(--mc-radius-sm)] border border-[var(--mc-bg-line)] bg-bg-base px-2 py-1.5 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-[rgb(var(--primary))]'

export function NewAgentModal({ open, onOpenChange }: NewAgentModalProps): JSX.Element {
  const [name, setName] = useState('')
  const [soul, setSoul] = useState('')
  const [model, setModel] = useState('')
  const [parentChannelId, setParentChannelId] = useState('')
  const [status, setStatus] = useState<Status>({ kind: 'idle' })

  const nameValid = NAME_RE.test(name)
  const canSubmit =
    nameValid && soul.trim().length > 0 && parentChannelId.trim().length > 0 && status.kind !== 'creating'

  const submit = async (): Promise<void> => {
    if (!canSubmit) return
    setStatus({ kind: 'creating' })
    try {
      const result = await createAgent({
        name: name.trim(),
        soul: soul.trim(),
        model: model || undefined,
        parentChannelId: parentChannelId.trim(),
      })
      setStatus({ kind: 'done', result })
    } catch (err) {
      setStatus({ kind: 'error', message: err instanceof Error ? err.message : 'unknown error' })
    }
  }

  const close = (): void => {
    onOpenChange(false)
    // reset after the close animation
    setTimeout(() => {
      setName('')
      setSoul('')
      setModel('')
      setParentChannelId('')
      setStatus({ kind: 'idle' })
    }, 200)
  }

  return (
    <Dialog open={open} onOpenChange={(o) => (o ? onOpenChange(true) : close())}>
      <DialogContent className="max-w-lg bg-bg-elevated">
        <DialogHeader>
          <DialogTitle>New agent</DialogTitle>
          <DialogDescription>
            Provisions a Discord channel + scaffolds the workspace. The agent boots on{' '}
            <code className="rounded bg-bg-muted px-1 text-xs">clawcode start {name || '<name>'}</code>{' '}
            or the next daemon restart.
          </DialogDescription>
        </DialogHeader>

        {status.kind === 'done' ? (
          <div
            className="space-y-2 rounded-[var(--mc-radius)] border border-[var(--mc-primary-ring)] bg-[var(--mc-primary-soft)] p-3 text-sm text-fg-1"
            role="status"
            aria-live="polite"
          >
            <div className="font-display font-medium">Created “{status.result.name}”.</div>
            {status.result.channelUrl && (
              <a
                href={status.result.channelUrl}
                target="_blank"
                rel="noreferrer noopener"
                className="font-mono text-xs text-primary hover:underline"
              >
                {status.result.channelUrl}
              </a>
            )}
            <div className="text-xs text-fg-2">
              Run <code className="font-mono">clawcode start {status.result.name}</code> (or restart
              the daemon) to bring it online.
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            <label className="block">
              <span className="mb-1 block text-sm font-medium text-fg-1">name</span>
              <input
                className={inputCls}
                value={name}
                placeholder="lowercase-with-hyphens"
                aria-label="agent name"
                aria-invalid={name.length > 0 && !nameValid}
                aria-describedby={name.length > 0 && !nameValid ? 'new-agent-name-err' : undefined}
                data-testid="new-agent-name"
                onChange={(e) => setName(e.target.value)}
              />
              {name.length > 0 && !nameValid && (
                <span id="new-agent-name-err" className="mt-1 block text-xs text-danger">
                  2–32 chars, lowercase letter first, then letters/digits/hyphens.
                </span>
              )}
            </label>
            <label className="block">
              <span className="mb-1 block text-sm font-medium text-fg-1">soul / personality</span>
              <textarea
                className={inputCls + ' h-24'}
                value={soul}
                placeholder="Who is this agent? Tone, role, how it should behave."
                aria-label="agent soul"
                data-testid="new-agent-soul"
                onChange={(e) => setSoul(e.target.value)}
              />
            </label>
            <div className="flex gap-3">
              <label className="block">
                <span className="mb-1 block text-sm font-medium text-fg-1">model</span>
                <select
                  className={inputCls + ' w-36'}
                  value={model}
                  aria-label="agent model"
                  onChange={(e) => setModel(e.target.value)}
                >
                  {MODELS.map((m) => (
                    <option key={m || 'default'} value={m}>
                      {m || '(fleet default)'}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block flex-1">
                <span className="mb-1 block text-sm font-medium text-fg-1">parent channel ID</span>
                <input
                  className={inputCls + ' font-mono'}
                  value={parentChannelId}
                  placeholder="Discord channel ID"
                  aria-label="parent Discord channel id"
                  data-testid="new-agent-parent"
                  onChange={(e) => setParentChannelId(e.target.value)}
                />
              </label>
            </div>
            <p className="text-xs text-fg-2">
              The new channel is created in the same category as the parent channel. Copy a
              channel ID from Discord (right-click → Copy Channel ID, with Developer Mode on).
            </p>
            {status.kind === 'error' && (
              <div
                className="rounded border border-danger/40 bg-danger/10 p-2 text-xs text-danger"
                role="alert"
              >
                {status.message}
              </div>
            )}
          </div>
        )}

        <DialogFooter>
          {status.kind === 'done' ? (
            <Button onClick={close} data-testid="new-agent-close">
              Done
            </Button>
          ) : (
            <>
              <Button variant="outline" onClick={close}>
                Cancel
              </Button>
              <Button onClick={submit} disabled={!canSubmit} data-testid="new-agent-submit">
                {status.kind === 'creating' ? 'Creating…' : 'Create agent'}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export default NewAgentModal
