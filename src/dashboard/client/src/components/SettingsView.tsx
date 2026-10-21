/**
 * Phase 116-postdeploy 2026-05-12 — Settings route (/dashboard/v2/settings).
 *
 * Wired to the Basic-mode "Settings" quick action and the Cmd+K
 * palette's "Settings" entry. v1 is intentionally lean — Theme + About
 * — so the route stops being a placeholder TODAY. Future surfaces
 * (cutover-redirect toggle, telemetry opt-in, default tier) can be added
 * here without needing another routing pass.
 *
 * dash-redesign sweep — retoned to the Mission Control design language.
 * Structural containers use the kit's `.tile` / `.section-head` /
 * `.tile-head` / `.tile-name` classes; inner typography uses the
 * Tailwind atoms that already map to the design tokens
 * (text-fg-1/-3, font-mono, font-display). mission-control.css is
 * imported globally at App.tsx so these classes resolve on every route.
 */
import { useState, type JSX } from 'react'
import { ThemeToggle } from './ThemeToggle'
import { Button } from './ui/button'
import { getAdminToken, setAdminToken, clearAdminToken } from '@/lib/admin-token'

function AdminAccessSection(): JSX.Element {
  const [draft, setDraft] = useState('')
  const [hasToken, setHasToken] = useState<boolean>(() => getAdminToken() !== null)
  const [saved, setSaved] = useState(false)

  const save = (): void => {
    if (!draft.trim()) return
    setAdminToken(draft)
    setHasToken(true)
    setDraft('')
    setSaved(true)
  }
  const clear = (): void => {
    clearAdminToken()
    setHasToken(false)
    setSaved(false)
  }

  return (
    <section className="tile mb-4">
      <div className="tile-head">
        <div className="tile-name">
          <h3>Admin access</h3>
        </div>
        <span className="tile-model">CLAWCODE_DASHBOARD_TOKEN</span>
      </div>
      <p className="mt-3 mb-4 font-sans text-[13px] leading-relaxed text-fg-2">
        When the daemon is started with a <code className="font-mono">CLAWCODE_DASHBOARD_TOKEN</code>,
        write actions (config edits, key management, agent control, optimizer runs)
        require it. Paste it here once — it's stored in this browser and attached to
        admin requests. Leave unset on a token-less (loopback) install.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="password"
          className="w-64 rounded-[var(--mc-radius-sm)] border border-[var(--mc-bg-line)] bg-bg-base px-2 py-1.5 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-[rgb(var(--primary))]"
          placeholder={hasToken ? '•••••••• (token set — paste to replace)' : 'admin token'}
          value={draft}
          aria-label="admin token"
          data-testid="settings-admin-token"
          onChange={(e) => {
            setDraft(e.target.value)
            setSaved(false)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') save()
          }}
        />
        <Button onClick={save} disabled={!draft.trim()} data-testid="settings-admin-save">
          Save
        </Button>
        {hasToken && (
          <Button variant="outline" onClick={clear} data-testid="settings-admin-clear">
            Clear
          </Button>
        )}
        <span className="text-xs text-fg-2">
          {saved ? 'Saved.' : hasToken ? 'Token set for this browser.' : 'No token set.'}
        </span>
      </div>
    </section>
  )
}

function readBuildInfo(): { readonly version: string; readonly buildId: string } {
  // Vite exposes import.meta.env.MODE; we keep this lean and string-only
  // for v1. When a future build wires a `__APP_VERSION__` define, this
  // function can pick it up — for now we surface the SPA mode + host.
  const mode = import.meta.env?.MODE ?? 'unknown'
  const buildId =
    typeof window !== 'undefined' && typeof window.location !== 'undefined'
      ? window.location.host
      : 'unknown'
  return { version: mode, buildId }
}

export function SettingsView(): JSX.Element {
  const build = readBuildInfo()
  return (
    <div
      className="mx-auto max-w-3xl px-7 py-8"
      data-testid="settings-view"
    >
      <div className="section-head mb-5">
        <div className="flex items-baseline">
          <h2>Settings</h2>
          <span className="sub">
            dashboard preferences · daemon config via{' '}
            <code className="font-mono text-fg-2">clawcode config</code>
          </span>
        </div>
      </div>

      <section className="tile mb-4">
        <div className="tile-head">
          <div className="tile-name">
            <h3>Theme</h3>
          </div>
          <span className="tile-model">clawcode:theme</span>
        </div>
        <p className="mt-3 mb-4 font-sans text-[13px] leading-relaxed text-fg-2">
          System-following, light, or dark. Persisted to local storage so
          the FOUC-guard in{' '}
          <code className="font-mono text-fg-2">index.html</code> paints
          the right palette before React hydrates.
        </p>
        <ThemeToggle />
      </section>

      <AdminAccessSection />

      <section className="tile mb-4">
        <div className="tile-head">
          <div className="tile-name">
            <h3>API keys</h3>
          </div>
          <span className="tile-model">OpenAI-compatible endpoint</span>
        </div>
        <p className="mt-3 mb-3 font-sans text-[13px] leading-relaxed text-fg-2">
          Create and revoke OpenAI-compatible API keys per agent (the former
          “OpenAI” page, now an admin surface). Gated by the admin token.
        </p>
        <a
          href="/settings/api-keys"
          className="inline-flex items-center gap-1 rounded-[var(--mc-radius-sm)] border border-[var(--mc-bg-line)] bg-bg-base px-3 py-1.5 text-sm text-fg-1 transition-colors hover:bg-bg-s3 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[rgb(var(--primary))]"
          data-testid="settings-api-keys-link"
        >
          Open API keys →
        </a>
      </section>

      <section className="tile mb-4">
        <div className="tile-head">
          <div className="tile-name">
            <h3>About</h3>
          </div>
        </div>
        <dl className="mt-3 grid gap-2 font-sans text-[13px]">
          <div className="flex items-baseline justify-between gap-4">
            <dt className="text-fg-3">Version</dt>
            <dd className="m-0 font-mono text-fg-1">{build.version}</dd>
          </div>
          <div className="flex items-baseline justify-between gap-4">
            <dt className="text-fg-3">Host</dt>
            <dd className="m-0 font-mono text-fg-1">{build.buildId}</dd>
          </div>
          <div className="flex items-baseline justify-between gap-4">
            <dt className="text-fg-3">Source</dt>
            <dd className="m-0">
              <a
                href="https://github.com/example-user/clawcode"
                target="_blank"
                rel="noreferrer noopener"
                className="font-mono text-primary no-underline hover:underline"
              >
                github.com/example-user/clawcode
              </a>
            </dd>
          </div>
        </dl>
      </section>

      <section className="tile" style={{ borderStyle: 'dashed', opacity: 0.85 }}>
        <div className="tile-head">
          <div className="tile-name">
            <h3 className="!text-fg-2">Coming soon</h3>
          </div>
        </div>
        <ul className="mt-3 grid gap-1.5 font-sans text-[13px] text-fg-2 list-none p-0">
          <li>· Create new agents (admin-gated)</li>
          <li>· Marketplace — install skills / MCPs / plugins</li>
          <li>· Daemon controls (restart, reload)</li>
          <li>· Notification preferences</li>
        </ul>
        <p className="mt-4 font-sans text-[11.5px] leading-relaxed text-fg-2">
          Per-agent config (model, skills, MCP servers, schedules, dreams, the
          optimizer) is already editable under{' '}
          <a href="/agents" className="text-primary no-underline hover:underline">
            Agents
          </a>
          .
        </p>
      </section>
    </div>
  )
}
