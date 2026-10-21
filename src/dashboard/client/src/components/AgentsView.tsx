/**
 * dashboard-rework — Agents hub (Phase 1 landing).
 *
 * Surfaces the existing per-agent config into the new IA: a responsive grid of
 * agent cards (live status + model + channel/skill/MCP counts). "Configure"
 * "Configure" navigates to the full-page config route (/agents/<name>,
 * AgentConfigPanel); clicking a card opens the AgentDetailDrawer. Agent
 * creation is the remaining piece (lands with the admin/auth controls).
 */
import { useState, type JSX } from 'react'
import { useAgents, useAgentConfig, type AgentStatusEntry } from '@/hooks/useApi'
import { Button } from '@/components/ui/button'
import { NavIcon } from './shell/nav-icons'
import { NewAgentModal } from './NewAgentModal'

function asArray(v: unknown): readonly unknown[] {
  return Array.isArray(v) ? v : []
}

function StatusDot(props: { readonly status?: string }): JSX.Element {
  const s = props.status ?? 'unknown'
  const color =
    s === 'running' || s === 'active'
      ? 'rgb(var(--primary))'
      : s === 'errored'
        ? 'rgb(var(--danger))'
        : s === 'starting'
          ? 'rgb(var(--warn))'
          : 'rgb(var(--fg-3))'
  return (
    <span
      title={s}
      style={{
        width: 8,
        height: 8,
        borderRadius: '50%',
        background: color,
        flex: '0 0 auto',
        display: 'inline-block',
      }}
    />
  )
}

function CountChip(props: { readonly icon: 'conversations' | 'tasks' | 'network'; readonly n: number; readonly label: string }): JSX.Element {
  return (
    <span
      className="inline-flex items-center gap-1 rounded-[var(--mc-radius-sm)] bg-bg-muted px-2 py-1 text-xs text-fg-2"
      title={`${props.n} ${props.label}`}
    >
      <NavIcon name={props.icon} size={13} />
      <span className="font-mono">{props.n}</span>
    </span>
  )
}

function AgentCard(props: {
  readonly agent: AgentStatusEntry
  readonly onConfigure: (name: string) => void
  readonly onOpen: (name: string) => void
}): JSX.Element {
  const { agent, onConfigure, onOpen } = props
  const cfgQ = useAgentConfig(agent.name)
  const resolved = cfgQ.data?.resolved ?? {}
  const channels = asArray(resolved.channels).length
  const skills = asArray(resolved.skills).length
  const mcps = asArray(resolved.mcpServers).length
  const model = (resolved.model as string | undefined) ?? agent.model ?? '—'

  // Non-interactive container: the agent name and the "Details" button are the
  // two distinct controls (no interactive-in-interactive nesting — WCAG 4.1.2).
  return (
    <div
      className="group flex flex-col gap-3 rounded-[var(--mc-radius)] border border-[var(--mc-bg-line)] bg-bg-elevated p-4 transition-shadow hover:shadow-[var(--mc-shadow-2)]"
      data-testid={`agent-card-${agent.name}`}
    >
      <div className="flex items-center gap-2">
        <StatusDot status={agent.status} />
        <button
          type="button"
          className="truncate rounded-[var(--mc-radius-xs)] text-left font-display text-base font-medium text-fg-1 transition-colors hover:text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[rgb(var(--primary))]"
          data-testid={`agent-open-${agent.name}`}
          title={`Open ${agent.name} details`}
          onClick={() => onOpen(agent.name)}
        >
          {agent.name}
        </button>
        <span className="ml-auto rounded-[var(--mc-radius-pill)] bg-[var(--mc-accent-soft)] px-2 py-0.5 font-mono text-[0.7rem] uppercase tracking-wide text-fg-2">
          {String(model)}
        </span>
      </div>

      <div className="flex flex-wrap gap-1.5">
        <CountChip icon="conversations" n={channels} label="channels" />
        <CountChip icon="tasks" n={skills} label="skills" />
        <CountChip icon="network" n={mcps} label="MCP servers" />
      </div>

      <div className="mt-auto flex items-center gap-2 pt-1">
        <button
          type="button"
          className="inline-flex items-center gap-1.5 rounded-[var(--mc-radius-sm)] border border-[var(--mc-bg-line)] bg-bg-base px-3 py-1.5 text-xs font-medium text-fg-1 transition-colors hover:bg-bg-s3"
          data-testid={`agent-configure-${agent.name}`}
          onClick={() => onConfigure(agent.name)}
        >
          <NavIcon name="settings" size={14} />
          Configure
        </button>
        <button
          type="button"
          className="ml-auto rounded-[var(--mc-radius-sm)] px-2 py-1.5 text-xs font-medium text-fg-2 transition-colors hover:text-fg-1"
          data-testid={`agent-details-${agent.name}`}
          onClick={() => onOpen(agent.name)}
        >
          Details →
        </button>
      </div>
    </div>
  )
}

export type AgentsViewProps = {
  readonly onConfigure: (name: string) => void
  readonly onOpen: (name: string) => void
}

export function AgentsView(props: AgentsViewProps): JSX.Element {
  const agentsQ = useAgents()
  const agents = [...(agentsQ.data?.agents ?? [])].sort((a, b) =>
    a.name.localeCompare(b.name),
  )
  const [createOpen, setCreateOpen] = useState(false)

  return (
    <div className="mx-auto w-full max-w-[1400px] px-4 py-5 sm:px-6">
      {/* No in-content <h1> — the topbar already names the view ("Agents"). */}
      <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <p className="max-w-2xl text-sm text-fg-2">
          Configure any agent below — model, skills, MCP servers, schedules,
          dreams, and the optimizer. Adding/removing MCP servers and most identity
          fields take effect after an agent restart.
        </p>
        <Button onClick={() => setCreateOpen(true)} data-testid="new-agent-open">
          <NavIcon name="plus" size={14} />
          New agent
        </Button>
      </div>

      <NewAgentModal open={createOpen} onOpenChange={setCreateOpen} />

      {agents.length === 0 ? (
        <div className="rounded-[var(--mc-radius)] border border-dashed border-[var(--mc-bg-line)] bg-bg-elevated p-10 text-center text-sm text-fg-2">
          No agents reported by the daemon.
        </div>
      ) : (
        <div
          className="grid gap-3"
          style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))' }}
          data-testid="agents-grid"
        >
          {agents.map((a) => (
            <AgentCard
              key={a.name}
              agent={a}
              onConfigure={props.onConfigure}
              onOpen={props.onOpen}
            />
          ))}
        </div>
      )}
    </div>
  )
}

export default AgentsView
