/**
 * Phase 116-postdeploy 2026-05-12 — lightweight banner toast for the
 * Basic-mode quick actions ("Run health check", "Restart Discord bot",
 * etc.).
 *
 * Deliberately NOT a full toast provider — adding shadcn Toast would pull
 * a Toaster into App.tsx root and is over-budget for the handful of one-
 * shot status messages these buttons produce. This is a self-contained
 * fixed-position banner that fades after 4s.
 *
 * Module-singleton state: any caller (FleetLayout, CommandPalette, future
 * Settings page) can `showActionToast({ ... })`. Renders into the
 * <ActionToastHost /> mounted once at App root.
 */
import { useEffect, useState } from 'react'

export type ActionToastTone = 'info' | 'success' | 'warn' | 'error'

export type ActionToastPayload = {
  readonly title: string
  readonly body?: string
  /** Default 'info'. */
  readonly tone?: ActionToastTone
  /** ms before auto-dismiss. Default 4000. Set to 0 to disable auto-dismiss. */
  readonly durationMs?: number
}

type InternalPayload = ActionToastPayload & { readonly id: number }

let _id = 0
let _setExternal: ((next: InternalPayload | null) => void) | null = null

export function showActionToast(payload: ActionToastPayload): void {
  if (!_setExternal) {
    // No host mounted — fall back to a console.info so we don't lose the
    // message entirely on routes that haven't rendered the host.
    // eslint-disable-next-line no-console
    console.info('[ActionToast]', payload)
    return
  }
  _setExternal({ ...payload, id: ++_id })
}

/**
 * Mount once at the app root. Reads from the module singleton so any
 * call site can fire a toast without prop-drilling.
 */
export function ActionToastHost(): JSX.Element | null {
  const [payload, setPayload] = useState<InternalPayload | null>(null)

  useEffect(() => {
    _setExternal = setPayload
    return () => {
      _setExternal = null
    }
  }, [])

  useEffect(() => {
    if (!payload) return
    const dur = payload.durationMs ?? 4000
    if (dur <= 0) return
    const id = payload.id
    const t = setTimeout(() => {
      setPayload((curr) => (curr && curr.id === id ? null : curr))
    }, dur)
    return () => clearTimeout(t)
  }, [payload])

  if (!payload) return null

  const tone = payload.tone ?? 'info'
  const toneCls =
    tone === 'success'
      ? 'border-primary/40 bg-primary/10 text-fg-1'
      : tone === 'warn'
      ? 'border-warn/40 bg-warn/10 text-fg-1'
      : tone === 'error'
      ? 'border-destructive/40 bg-destructive/10 text-fg-1'
      : 'border-border bg-bg-elevated text-fg-1'

  return (
    <div
      role="status"
      aria-live="polite"
      className={`fixed bottom-4 right-4 z-[60] max-w-sm rounded-md border px-4 py-3 shadow-lg backdrop-blur-sm ${toneCls}`}
      data-testid="action-toast"
    >
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <p className="font-display text-sm font-medium">{payload.title}</p>
          {payload.body && (
            <p className="mt-0.5 break-words text-xs text-fg-2">
              {payload.body}
            </p>
          )}
        </div>
        <button
          type="button"
          onClick={() => setPayload(null)}
          aria-label="Dismiss"
          className="rounded-md px-1.5 py-0.5 text-fg-3 transition-colors hover:bg-bg-base hover:text-fg-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          ✕
        </button>
      </div>
    </div>
  )
}
