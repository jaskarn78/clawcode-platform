/**
 * dashboard-rework P4 — admin token prompt.
 *
 * Listens for AUTH_REQUIRED_EVENT (dispatched by the fetch wrapper on a 401 from
 * a gated route) and surfaces a bottom prompt for the shared admin token. On
 * save it stores the token and reloads so in-flight queries re-issue with the
 * Authorization header. Invisible until a 401 actually occurs.
 */
import { useEffect, useState, type JSX } from 'react'
import { AUTH_REQUIRED_EVENT, setAdminToken } from '@/lib/admin-token'
import { Button } from '@/components/ui/button'

export function AdminAuthBanner(): JSX.Element | null {
  const [needed, setNeeded] = useState(false)
  const [draft, setDraft] = useState('')

  useEffect(() => {
    const on = (): void => setNeeded(true)
    window.addEventListener(AUTH_REQUIRED_EVENT, on)
    return () => window.removeEventListener(AUTH_REQUIRED_EVENT, on)
  }, [])

  // Escape dismisses the prompt (it's a non-modal region, not a focus trap).
  useEffect(() => {
    if (!needed) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setNeeded(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [needed])

  if (!needed) return null

  const save = (): void => {
    if (!draft.trim()) return
    setAdminToken(draft)
    setNeeded(false)
    setDraft('')
    // Reload so every query re-issues with the Authorization header.
    window.location.reload()
  }

  return (
    <div
      className="fixed inset-x-0 bottom-0 z-[60] border-t border-[var(--mc-bg-line)] bg-bg-elevated/95 px-4 py-3 shadow-[var(--mc-shadow-3)] backdrop-blur"
      role="region"
      aria-label="Admin token required"
      data-testid="admin-auth-banner"
    >
      <div className="mx-auto flex max-w-3xl flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1">
          <div className="font-display text-sm font-medium text-fg-1">Admin token required</div>
          <div className="text-xs text-fg-2">
            This action is gated. Paste the dashboard admin token
            (<code>CLAWCODE_DASHBOARD_TOKEN</code>) to continue.
          </div>
        </div>
        <input
          type="password"
          className="w-56 rounded-[var(--mc-radius-sm)] border border-[var(--mc-bg-line)] bg-bg-base px-2 py-1.5 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-[rgb(var(--primary))]"
          placeholder="admin token"
          value={draft}
          autoFocus
          aria-label="admin token"
          data-testid="admin-token-input"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') save()
          }}
        />
        <Button onClick={save} data-testid="admin-token-save">
          Save &amp; reload
        </Button>
        <button
          type="button"
          className="rounded-[var(--mc-radius-sm)] px-2 py-1.5 text-xs text-fg-2 transition-colors hover:text-fg-1 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[rgb(var(--primary))]"
          onClick={() => setNeeded(false)}
        >
          Dismiss
        </button>
      </div>
    </div>
  )
}

export default AdminAuthBanner
