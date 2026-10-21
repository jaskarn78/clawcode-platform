/**
 * dashboard-rework P3 — Marketplace (skills), per-agent.
 *
 * Browse the catalog for a selected agent (available = catalog − already
 * installed), install a skill onto it, or remove one. Install/remove POST to
 * /api/marketplace/* → the daemon's marketplace IPC, which runs the secret-scan
 * + scope-tag trust gates server-side (refusals surface as outcomes). The
 * actions are admin-token-gated (a 401 raises the AdminAuthBanner). "Enable /
 * disable per agent" IS install/remove here — installed skills are also visible
 * + editable in the agent's config (Agents → Tools).
 *
 * MCP-server plugins (marketplace-*-plugin IPC) are a parallel surface; this
 * view covers skills. Per-agent MCP attach/detach lives in the config hub.
 */
import { useEffect, useMemo, useState, type JSX, type ReactNode } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import {
  useAgents,
  useMarketplace,
  usePluginMarketplaces,
  installSkill,
  removeSkill,
  installPluginRef,
  uninstallPluginRef,
  addPluginMarketplace,
  type MarketplaceEntry,
  type MarketplaceSource,
  type PluginCatalogEntry,
} from '@/hooks/useApi'
import { Button } from '@/components/ui/button'
import { NavIcon } from './shell/nav-icons'

// ---- top-level: two tabs (Anthropic-verified plugins · ClawCode skills) ----

type MktTab = 'plugins' | 'skills'

export function MarketplaceView(): JSX.Element {
  const [tab, setTab] = useState<MktTab>('plugins')
  const TABS: ReadonlyArray<{ id: MktTab; label: string }> = [
    { id: 'plugins', label: 'Plugins · Anthropic-verified' },
    { id: 'skills', label: 'Skills · ClawCode' },
  ]
  return (
    <div className="mx-auto w-full max-w-[1100px] px-4 py-5 sm:px-6">
      <div
        className="mb-5 inline-flex items-center gap-1 rounded-[var(--mc-radius)] border border-[var(--mc-bg-line)] bg-bg-elevated p-1"
        role="tablist"
        aria-label="Marketplace sources"
      >
        {TABS.map((t) => {
          const active = tab === t.id
          return (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={active}
              data-testid={`mkt-tab-${t.id}`}
              onClick={() => setTab(t.id)}
              className={[
                'rounded-[var(--mc-radius-sm)] px-4 py-1.5 text-sm font-medium transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-[rgb(var(--primary))]',
                active ? 'bg-[var(--mc-primary-soft)] text-primary' : 'text-fg-2 hover:bg-bg-s3 hover:text-fg-1',
              ].join(' ')}
            >
              {t.label}
            </button>
          )
        })}
      </div>
      {tab === 'plugins' ? <PluginsTab /> : <SkillsTab />}
    </div>
  )
}

function VerifiedBadge(): JSX.Element {
  return (
    <span
      className="inline-flex items-center gap-1 rounded-[var(--mc-radius-pill)] bg-[var(--mc-primary-soft)] px-2 py-0.5 text-[0.65rem] font-semibold uppercase tracking-wide text-primary"
      title="Published by Anthropic's verified marketplace"
    >
      <NavIcon name="benchmarks" size={11} />
      verified
    </span>
  )
}

// ---- Plugins tab: browse the native Claude Code marketplaces ----------------

function PluginsTab(): JSX.Element {
  const q = usePluginMarketplaces()
  const qc = useQueryClient()
  const marketplaces = q.data?.marketplaces ?? []
  const plugins = q.data?.plugins ?? []
  const [busy, setBusy] = useState<string | null>(null)
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)
  const [mktDraft, setMktDraft] = useState('')

  const refresh = (): void => {
    void qc.invalidateQueries({ queryKey: ['plugin-marketplaces'] })
  }
  const act = async (kind: 'install' | 'uninstall', ref: string): Promise<void> => {
    setBusy(`${kind}:${ref}`)
    setMsg(null)
    const r = kind === 'install' ? await installPluginRef(ref) : await uninstallPluginRef(ref)
    setBusy(null)
    setMsg({
      kind: r.ok ? 'ok' : 'err',
      text: r.ok ? `${ref}: ${kind}ed` : (r.stderr || `${kind} failed`).slice(0, 300),
    })
    if (r.ok) refresh()
  }
  const addMkt = async (): Promise<void> => {
    const source = mktDraft.trim()
    if (!source) return
    setBusy('add-mkt')
    setMsg(null)
    const r = await addPluginMarketplace(source)
    setBusy(null)
    setMsg({ kind: r.ok ? 'ok' : 'err', text: r.ok ? `added ${source}` : (r.stderr || 'add failed').slice(0, 300) })
    if (r.ok) {
      setMktDraft('')
      refresh()
    }
  }

  return (
    <div>
      <p className="mb-4 max-w-2xl text-sm text-fg-2">
        Plugins from the native Claude Code marketplaces registered on the daemon —
        the official <code className="font-mono">anthropics/claude-plugins-official</code>{' '}
        directory is marked verified. Install adds the plugin to the fleet plugin store;
        enable it on specific agents from <strong className="text-fg-1">Agents → Plugins</strong>.
      </p>

      {/* Add a marketplace (owner/repo or https git url) */}
      <div className="mb-4 flex flex-wrap items-end gap-2">
        <label className="flex-1">
          <span className="mb-1 block text-sm font-medium text-fg-1">Add a marketplace</span>
          <input
            className="w-full rounded-[var(--mc-radius-sm)] border border-[var(--mc-bg-line)] bg-bg-base px-2 py-1.5 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-[rgb(var(--primary))]"
            placeholder="owner/repo or https://github.com/owner/repo.git"
            value={mktDraft}
            aria-label="marketplace source"
            data-testid="add-marketplace-input"
            onChange={(e) => setMktDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void addMkt()
            }}
          />
        </label>
        <Button
          variant="outline"
          onClick={() => void addMkt()}
          disabled={!mktDraft.trim() || busy === 'add-mkt'}
          data-testid="add-marketplace-btn"
        >
          <NavIcon name="plus" size={14} />
          {busy === 'add-mkt' ? 'Adding…' : 'Add'}
        </Button>
      </div>

      {msg && (
        <div
          className={[
            'mb-4 rounded-[var(--mc-radius-sm)] border p-2 text-xs',
            msg.kind === 'ok'
              ? 'border-[var(--mc-primary-ring)] bg-[var(--mc-primary-soft)] text-fg-1'
              : 'border-danger/40 bg-danger/10 text-danger',
          ].join(' ')}
          role="status"
          aria-live="polite"
          data-testid="plugin-msg"
        >
          {msg.text}
        </div>
      )}

      {marketplaces.length > 0 && (
        <div className="mb-4 flex flex-wrap gap-2">
          {marketplaces.map((m) => (
            <span
              key={m.name}
              className="inline-flex items-center gap-1.5 rounded-[var(--mc-radius-sm)] border border-[var(--mc-bg-line)] bg-bg-elevated px-2.5 py-1 text-xs text-fg-2"
              title={m.source}
            >
              <span className="font-mono text-fg-1">{m.name}</span>
              {m.verified && <VerifiedBadge />}
              <span className="text-fg-2">· {m.pluginCount}</span>
            </span>
          ))}
        </div>
      )}

      {q.isLoading && (
        <div className="rounded-[var(--mc-radius)] border border-dashed border-[var(--mc-bg-line)] p-4 text-sm text-fg-2">
          Loading marketplaces…
        </div>
      )}
      {q.error && (
        <div className="rounded-[var(--mc-radius)] border border-danger/40 bg-danger/10 p-4 text-sm text-danger">
          Couldn’t load marketplaces: {(q.error as Error).message}
        </div>
      )}

      {q.data && plugins.length === 0 && (
        <div className="rounded-[var(--mc-radius)] border border-dashed border-[var(--mc-bg-line)] p-4 text-sm text-fg-2">
          No marketplaces registered on the daemon yet. Add one above (e.g.{' '}
          <code className="font-mono">anthropics/claude-plugins-official</code>).
        </div>
      )}

      <ul className="flex flex-col gap-2" data-testid="plugin-list">
        {plugins.map((p: PluginCatalogEntry) => (
          <li
            key={p.ref}
            className="rounded-[var(--mc-radius)] border border-[var(--mc-bg-line)] bg-bg-elevated p-3"
          >
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-sm font-medium text-fg-1">{p.name}</span>
              {p.verified && <VerifiedBadge />}
              {p.firstParty && (
                <span className="rounded-[var(--mc-radius-pill)] bg-[var(--mc-accent-soft)] px-2 py-0.5 text-[0.65rem] font-medium uppercase tracking-wide text-fg-2">
                  1st-party
                </span>
              )}
              {p.category && (
                <span className="rounded-[var(--mc-radius-pill)] bg-bg-muted px-2 py-0.5 text-[0.65rem] uppercase tracking-wide text-fg-2">
                  {p.category}
                </span>
              )}
              <span className="ml-auto flex items-center gap-2">
                {p.installed && (
                  <span className="inline-flex items-center gap-1 text-xs text-primary">
                    <NavIcon name="benchmarks" size={12} />
                    installed
                  </span>
                )}
                <button
                  type="button"
                  className="rounded-[var(--mc-radius-sm)] border border-[var(--mc-bg-line)] bg-bg-base px-2.5 py-1 text-xs font-medium text-fg-1 transition-colors hover:bg-bg-s3 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[rgb(var(--primary))] disabled:opacity-50"
                  disabled={busy === `install:${p.ref}` || busy === `uninstall:${p.ref}`}
                  data-testid={`plugin-${p.installed ? 'uninstall' : 'install'}-${p.ref}`}
                  onClick={() => act(p.installed ? 'uninstall' : 'install', p.ref)}
                >
                  {busy === `install:${p.ref}`
                    ? 'Installing…'
                    : busy === `uninstall:${p.ref}`
                      ? 'Removing…'
                      : p.installed
                        ? 'Uninstall'
                        : 'Install'}
                </button>
              </span>
            </div>
            {p.description && (
              <p className="mt-1.5 text-sm leading-relaxed text-fg-2">{p.description}</p>
            )}
            <div className="mt-1.5 flex items-center gap-3 text-xs text-fg-2">
              <span className="font-mono">{p.marketplace}</span>
              {p.author && <span>by {p.author}</span>}
              {p.homepage && (
                <a
                  href={p.homepage}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="text-primary hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-[rgb(var(--primary))]"
                >
                  homepage →
                </a>
              )}
            </div>
          </li>
        ))}
      </ul>
    </div>
  )
}

// ---- Skills tab: ClawCode internal per-agent skill catalog (unchanged) ------

function sourceLabel(s: MarketplaceSource): string {
  if (s === 'local') return 'local'
  if ('kind' in s && s.kind === 'clawhub') return 'ClawHub'
  return 'library'
}

function Badge(props: { readonly children: ReactNode; readonly tone?: 'neutral' | 'accent' }): JSX.Element {
  const accent = props.tone === 'accent'
  return (
    <span
      className={[
        'rounded-[var(--mc-radius-pill)] px-2 py-0.5 text-[0.65rem] font-medium uppercase tracking-wide',
        accent
          ? 'bg-[var(--mc-accent-soft)] text-fg-2'
          : 'bg-bg-muted text-fg-2',
      ].join(' ')}
    >
      {props.children}
    </span>
  )
}

function SkillsTab(): JSX.Element {
  const agentsQ = useAgents()
  const agents = useMemo(
    () => [...(agentsQ.data?.agents ?? [])].sort((a, b) => a.name.localeCompare(b.name)),
    [agentsQ.data?.agents],
  )
  const [agent, setAgent] = useState<string>('')
  useEffect(() => {
    if (!agent && agents.length > 0) setAgent(agents[0]!.name)
  }, [agents, agent])

  const mkt = useMarketplace(agent || null)
  const qc = useQueryClient()
  const [busy, setBusy] = useState<string | null>(null)
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)

  const act = async (kind: 'install' | 'remove', skill: string): Promise<void> => {
    setBusy(`${kind}:${skill}`)
    setMsg(null)
    try {
      const r = kind === 'install' ? await installSkill(agent, skill) : await removeSkill(agent, skill)
      setMsg({ kind: 'ok', text: `${skill}: ${r.outcome ?? 'done'}` })
      void qc.invalidateQueries({ queryKey: ['marketplace', agent] })
      void qc.invalidateQueries({ queryKey: ['agent-config', agent] })
    } catch (err) {
      setMsg({ kind: 'err', text: err instanceof Error ? err.message : 'failed' })
    } finally {
      setBusy(null)
    }
  }

  const installed = mkt.data?.installed ?? []
  const available = mkt.data?.available ?? []

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <p className="text-sm text-fg-2">
          Install skills onto an agent from trusted sources. Installs run the
          secret-scan + scope gates server-side.
        </p>
        <label className="ml-auto flex items-center gap-2 text-sm text-fg-2">
          Agent
          <select
            className="rounded-[var(--mc-radius-sm)] border border-[var(--mc-bg-line)] bg-bg-base px-2 py-1.5 text-sm text-fg-1 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[rgb(var(--primary))]"
            value={agent}
            aria-label="marketplace agent"
            data-testid="marketplace-agent"
            onChange={(e) => {
              setAgent(e.target.value)
              setMsg(null)
            }}
          >
            {agents.map((a) => (
              <option key={a.name} value={a.name}>
                {a.name}
              </option>
            ))}
          </select>
        </label>
      </div>

      {msg && (
        <div
          className={[
            'mb-4 rounded-[var(--mc-radius-sm)] border p-2 text-xs',
            msg.kind === 'ok'
              ? 'border-[var(--mc-primary-ring)] bg-[var(--mc-primary-soft)] text-fg-1'
              : 'border-danger/40 bg-danger/10 text-danger',
          ].join(' ')}
          role="status"
          aria-live="polite"
          data-testid="marketplace-msg"
        >
          {msg.text}
        </div>
      )}

      {mkt.isLoading && (
        <div className="rounded-[var(--mc-radius)] border border-dashed border-[var(--mc-bg-line)] p-4 text-sm text-fg-2">
          Loading catalog…
        </div>
      )}
      {mkt.error && (
        <div className="rounded-[var(--mc-radius)] border border-danger/40 bg-danger/10 p-4 text-sm text-danger">
          Couldn’t load the catalog: {(mkt.error as Error).message}
        </div>
      )}

      {mkt.data && (
        <div className="grid gap-6 lg:grid-cols-[1fr_1.4fr]">
          {/* Installed */}
          <section>
            <h3 className="mb-2 font-display text-base font-medium text-fg-1">
              Installed on {agent}{' '}
              <span className="font-mono text-sm text-fg-2">({installed.length})</span>
            </h3>
            {installed.length === 0 ? (
              <div className="rounded-[var(--mc-radius)] border border-dashed border-[var(--mc-bg-line)] p-4 text-sm text-fg-2">
                No skills installed.
              </div>
            ) : (
              <ul className="flex flex-col gap-1.5">
                {installed.map((s) => (
                  <li
                    key={s}
                    className="flex items-center gap-2 rounded-[var(--mc-radius-sm)] border border-[var(--mc-bg-line)] bg-bg-elevated px-3 py-2"
                  >
                    <span className="font-mono text-sm text-fg-1">{s}</span>
                    <button
                      type="button"
                      className="ml-auto rounded-[var(--mc-radius-sm)] px-2.5 py-1.5 text-xs font-medium text-fg-2 transition-colors hover:bg-danger/10 hover:text-danger focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[rgb(var(--primary))] disabled:opacity-50"
                      disabled={busy === `remove:${s}`}
                      data-testid={`mkt-remove-${s}`}
                      onClick={() => act('remove', s)}
                    >
                      {busy === `remove:${s}` ? 'Removing…' : 'Remove'}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {/* Available */}
          <section>
            <h3 className="mb-2 font-display text-base font-medium text-fg-1">
              Available{' '}
              <span className="font-mono text-sm text-fg-2">({available.length})</span>
            </h3>
            {available.length === 0 ? (
              <div className="rounded-[var(--mc-radius)] border border-dashed border-[var(--mc-bg-line)] p-4 text-sm text-fg-2">
                Nothing new to install — the catalog is fully installed or empty.
              </div>
            ) : (
              <ul className="flex flex-col gap-2">
                {available.map((e: MarketplaceEntry) => (
                  <li
                    key={e.name}
                    className="rounded-[var(--mc-radius)] border border-[var(--mc-bg-line)] bg-bg-elevated p-3"
                  >
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-sm font-medium text-fg-1">{e.name}</span>
                      <Badge>{e.category}</Badge>
                      <Badge tone="accent">{sourceLabel(e.source)}</Badge>
                      <Button
                        className="ml-auto"
                        variant="outline"
                        disabled={busy === `install:${e.name}`}
                        data-testid={`mkt-install-${e.name}`}
                        onClick={() => act('install', e.name)}
                      >
                        <NavIcon name="plus" size={13} />
                        {busy === `install:${e.name}` ? 'Installing…' : 'Install'}
                      </Button>
                    </div>
                    {e.description && (
                      <p className="mt-1.5 text-sm leading-relaxed text-fg-2">{e.description}</p>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      )}
    </div>
  )
}

export default MarketplaceView
