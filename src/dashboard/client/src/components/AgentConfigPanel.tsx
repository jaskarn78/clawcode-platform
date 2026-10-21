/**
 * dashboard-rework P2 — full-page agent config panel (route-hosted).
 *
 * Replaces the F26 ConfigEditor *modal* with a deep-linkable route
 * (`/agents/<name>`). Same proven save contract:
 *   1. PUT /api/config/agents/:name  — daemon Zod-validates + atomic-writes
 *   2. POST /api/config/hot-reload   — force chokidar re-read (no debounce)
 *   3. Status shows hot-reloaded vs needs-restart breakdown
 *
 * Increment 1 carries the existing tabs (Identity/Model/Channels/Tools/MCP/
 * Memory/Debug); the MCP add/edit + Schedules/Dream/Heartbeat editors land in
 * increment 2. `buildAgentPartial` is exported as a pure function so it can be
 * unit-tested against the real `agentSchema.partial()` (the read-only dev loop
 * can't exercise the write round-trip).
 */
import {
  useEffect,
  useMemo,
  useState,
  type JSX,
  type ReactNode,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import {
  useAgentConfig,
  updateAgentConfig,
  triggerHotReload,
  runAgentOptimization,
  type UpdateAgentConfigResponse,
  type AgentOptimizationResult,
} from '@/hooks/useApi'
import {
  buildAgentPartial,
  formStateFromRaw,
  newScheduleRow,
  mcpEntryName,
  mcpEntryIsInline,
  type FormState,
  type ScheduleRow,
} from '@/lib/agent-config-partial'
import { NavIcon } from './shell/nav-icons'

type TabKey =
  | 'identity'
  | 'model'
  | 'channels'
  | 'tools'
  | 'mcp'
  | 'memory'
  | 'automation'
  | 'optimizer'
  | 'debug'

const TABS: ReadonlyArray<{ key: TabKey; label: string }> = [
  { key: 'identity', label: 'Identity' },
  { key: 'model', label: 'Model' },
  { key: 'channels', label: 'Channels' },
  { key: 'tools', label: 'Tools' },
  { key: 'mcp', label: 'MCP' },
  { key: 'memory', label: 'Memory' },
  { key: 'automation', label: 'Automation' },
  { key: 'optimizer', label: 'Optimizer' },
  { key: 'debug', label: 'Debug' },
]

const DREAM_MODELS = ['haiku', 'sonnet', 'opus'] as const

const MODEL_OPTIONS = ['sonnet', 'opus', 'haiku'] as const
// Quick 260715-j1j (D12) — 'ultracode' appended (8th level, schema order).
// The dashboard has no nativeWorkflow toggle yet, so saving 'ultracode' on
// an agent without `nativeWorkflow: true` in clawcode.yaml is REJECTED by
// the server-side full-config validation on the patch-agent write path
// (yaml-patcher runs configSchema.safeParse pre-write — review CR-02); the
// save surfaces the D7 pairing error instead of writing a YAML the next
// daemon boot would fail on. The live /clawcode-effort gate additionally
// guards runtime activation (ultracode-gate.ts).
const EFFORT_OPTIONS = ['low', 'medium', 'high', 'xhigh', 'max', 'auto', 'off', 'ultracode'] as const

// FormState / formStateFromRaw / buildAgentPartial moved to
// '@/lib/agent-config-partial' (React-free, unit-tested against agentSchema).

type SaveStatus =
  | { kind: 'idle' }
  | { kind: 'saving' }
  | { kind: 'success'; payload: UpdateAgentConfigResponse }
  | { kind: 'error'; message: string }

export type AgentConfigPanelProps = {
  readonly agentName: string
  readonly onBack: () => void
}

export function AgentConfigPanel({ agentName, onBack }: AgentConfigPanelProps): JSX.Element {
  const { data, isLoading, error, refetch } = useAgentConfig(agentName)
  const [tab, setTab] = useState<TabKey>('identity')
  const [form, setForm] = useState<FormState>(formStateFromRaw(null))
  const [original, setOriginal] = useState<FormState>(formStateFromRaw(null))
  const [saveStatus, setSaveStatus] = useState<SaveStatus>({ kind: 'idle' })

  useEffect(() => {
    if (data?.raw) {
      const next = formStateFromRaw(data.raw)
      setForm(next)
      setOriginal(next)
      setSaveStatus({ kind: 'idle' })
    }
  }, [data])

  const dirtyFields = useMemo(
    () => Object.keys(buildAgentPartial(form, original)),
    [form, original],
  )
  const hotReloadable = useMemo(() => new Set(data?.hotReloadableFields ?? []), [data])
  const restartRequired = useMemo(() => new Set(data?.restartRequiredFields ?? []), [data])

  // ARIA tabs: ArrowLeft/Right move between tabs (roving focus).
  const onTabKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
    e.preventDefault()
    const idx = TABS.findIndex((t) => t.key === tab)
    const delta = e.key === 'ArrowRight' ? 1 : -1
    const nextKey = TABS[(idx + delta + TABS.length) % TABS.length]!.key
    setTab(nextKey)
    document.getElementById(`cfg-tab-${nextKey}`)?.focus()
  }

  async function handleSave(): Promise<void> {
    const partial = buildAgentPartial(form, original)
    if (Object.keys(partial).length === 0) {
      setSaveStatus({ kind: 'error', message: 'No changes to save.' })
      return
    }
    setSaveStatus({ kind: 'saving' })
    try {
      const result = await updateAgentConfig(agentName, partial)
      try {
        await triggerHotReload()
      } catch {
        /* best-effort — chokidar debounce picks it up regardless */
      }
      setSaveStatus({ kind: 'success', payload: result })
      void refetch()
    } catch (err) {
      setSaveStatus({ kind: 'error', message: err instanceof Error ? err.message : 'unknown error' })
    }
  }

  return (
    <div className="mx-auto w-full max-w-[1100px] px-4 py-5 sm:px-6">
      <button
        type="button"
        onClick={onBack}
        data-testid="config-back"
        className={
          'mb-3 inline-flex items-center gap-1 rounded-[var(--mc-radius-sm)] py-0.5 text-sm text-fg-2 transition-colors hover:text-fg-1 ' +
          focusRing
        }
      >
        <span className="inline-flex rotate-180">
          <NavIcon name="chevron" size={14} />
        </span>
        Agents
      </button>

      <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-display text-2xl font-bold tracking-tight text-fg-1">
            <span className="font-mono">{agentName}</span>
          </h1>
          <p className="mt-1 max-w-2xl text-sm text-fg-2">
            Hot-reloadable fields apply on the next turn; restart-required fields
            take effect after <code className="rounded bg-bg-muted px-1 text-xs">clawcode restart {agentName}</code>.
          </p>
        </div>
        <Button onClick={handleSave} disabled={saveStatus.kind === 'saving' || dirtyFields.length === 0}>
          {saveStatus.kind === 'saving'
            ? 'Saving…'
            : `Save${dirtyFields.length ? ` (${dirtyFields.length})` : ''}`}
        </Button>
      </div>

      {isLoading && <div className="text-sm text-fg-2">Loading config…</div>}
      {error && (
        <div className="text-sm text-danger">Failed to load: {(error as Error).message}</div>
      )}

      {data && (
        <div className="rounded-[var(--mc-radius)] border border-[var(--mc-bg-line)] bg-bg-elevated">
          <div
            className="flex flex-wrap gap-1 border-b border-[var(--mc-bg-line)] px-2 pt-2"
            role="tablist"
            aria-label="Agent config sections"
            onKeyDown={onTabKeyDown}
          >
            {TABS.map((t) => (
              <button
                key={t.key}
                id={`cfg-tab-${t.key}`}
                role="tab"
                aria-selected={tab === t.key}
                aria-controls="cfg-tabpanel"
                tabIndex={tab === t.key ? 0 : -1}
                data-testid={`config-tab-${t.key}`}
                className={
                  'rounded-t-[var(--mc-radius-sm)] px-3 py-2 text-sm transition-colors ' +
                  focusRing +
                  ' ' +
                  (tab === t.key
                    ? 'border-b-2 border-primary font-medium text-fg-1'
                    : 'text-fg-2 hover:text-fg-1')
                }
                onClick={() => setTab(t.key)}
              >
                {t.label}
              </button>
            ))}
          </div>

          <div className="p-5" role="tabpanel" id="cfg-tabpanel" aria-labelledby={`cfg-tab-${tab}`}>
            {tab === 'identity' && (
              <IdentityTab form={form} setForm={setForm} restartRequired={restartRequired} />
            )}
            {tab === 'model' && (
              <ModelTab form={form} setForm={setForm} restartRequired={restartRequired} />
            )}
            {tab === 'channels' && <ChannelsTab form={form} setForm={setForm} />}
            {tab === 'tools' && <ToolsTab form={form} setForm={setForm} />}
            {tab === 'mcp' && <McpTab form={form} setForm={setForm} />}
            {tab === 'memory' && <MemoryTab form={form} setForm={setForm} hot={hotReloadable} />}
            {tab === 'automation' && <AutomationTab form={form} setForm={setForm} />}
            {tab === 'optimizer' && (
              <OptimizerTab form={form} setForm={setForm} agentName={agentName} />
            )}
            {tab === 'debug' && <DebugTab raw={data.raw} />}
          </div>
        </div>
      )}

      {dirtyFields.length > 0 && (
        <div className="mt-4 rounded-[var(--mc-radius)] border border-[var(--mc-accent)]/40 bg-[var(--mc-accent-soft)] p-3 text-xs">
          <div className="mb-1 font-semibold text-fg-1">Pending changes</div>
          <div className="flex flex-wrap gap-1">
            {dirtyFields.map((f) => (
              <Badge key={f} variant={hotReloadable.has(f) ? 'secondary' : 'destructive'}>
                {f}
                {hotReloadable.has(f) ? ' (hot)' : ' (restart)'}
              </Badge>
            ))}
          </div>
        </div>
      )}

      {saveStatus.kind === 'success' && (
        <div className="mt-4 rounded-[var(--mc-radius)] border border-[var(--mc-primary-ring)] bg-[var(--mc-primary-soft)] p-3 text-xs text-fg-1">
          <div className="font-semibold">Saved.</div>
          {saveStatus.payload.hotReloaded.length > 0 && (
            <div>Hot-reloaded (applies next turn): {saveStatus.payload.hotReloaded.join(', ')}</div>
          )}
          {saveStatus.payload.agentsNeedingRestart.length > 0 && (
            <div>
              Restart required — run <code>clawcode restart {agentName}</code>.
            </div>
          )}
        </div>
      )}
      {saveStatus.kind === 'error' && (
        <div className="mt-4 rounded-[var(--mc-radius)] border border-danger/40 bg-danger/10 p-3 text-xs text-danger">
          {saveStatus.message}
        </div>
      )}
    </div>
  )
}

// --- tabs (route-local; mirror the proven ConfigEditor tab logic) ----------

type TabProps = { form: FormState; setForm: (next: FormState) => void }
type TabPropsWithMeta = TabProps & { restartRequired: Set<string> }
type TabPropsWithHot = TabProps & { hot: Set<string> }

function RestartTip({ children }: { children: ReactNode }): JSX.Element {
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>{children}</TooltipTrigger>
        <TooltipContent>
          Requires an agent restart to take effect — <code>clawcode restart &lt;agent&gt;</code> after save.
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}

function Field({
  label,
  children,
  restart,
  hot,
}: {
  label: string
  children: ReactNode
  restart?: boolean
  hot?: boolean
}): JSX.Element {
  return (
    <div>
      <div className="mb-1 flex items-center gap-2 text-sm font-medium text-fg-1">
        <span>{label}</span>
        {restart && (
          <RestartTip>
            <Badge
              variant="outline"
              className="border-warn/50 text-[10px] text-warn"
            >
              restart
            </Badge>
          </RestartTip>
        )}
        {hot && (
          <Badge variant="secondary" className="text-[10px]">
            hot
          </Badge>
        )}
      </div>
      {children}
    </div>
  )
}

const focusRing =
  'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[rgb(var(--primary))]'
const inputCls =
  'w-full rounded-[var(--mc-radius-sm)] border border-[var(--mc-bg-line)] bg-bg-base px-2 py-1.5 text-sm disabled:cursor-not-allowed disabled:opacity-50 disabled:bg-bg-muted ' +
  focusRing
const removeBtnCls =
  'rounded-[var(--mc-radius-sm)] px-2.5 py-1.5 text-xs font-medium text-fg-2 transition-colors hover:bg-danger/10 hover:text-danger ' +
  focusRing

function IdentityTab({ form, setForm, restartRequired }: TabPropsWithMeta): JSX.Element {
  return (
    <div className="space-y-4">
      <Field label="workspace" restart={restartRequired.has('workspace')}>
        <input
          className={inputCls}
          value={form.workspace}
          onChange={(e) => setForm({ ...form, workspace: e.target.value })}
        />
      </Field>
      <Field label="memoryPath" restart={restartRequired.has('memoryPath')}>
        <input
          className={inputCls}
          value={form.memoryPath}
          onChange={(e) => setForm({ ...form, memoryPath: e.target.value })}
          placeholder="(defaults to workspace if blank)"
        />
      </Field>
    </div>
  )
}

function ModelTab({ form, setForm, restartRequired }: TabPropsWithMeta): JSX.Element {
  return (
    <div className="space-y-4">
      <Field label="model" restart={restartRequired.has('model')}>
        <select
          className={inputCls}
          value={form.model}
          onChange={(e) => setForm({ ...form, model: e.target.value })}
        >
          <option value="">(use default)</option>
          {MODEL_OPTIONS.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
        <p className="mt-1 text-xs text-fg-2">
          Model swap requires <code>clawcode restart</code>. Per-turn /clawcode-model
          overrides still work on the live session.
        </p>
      </Field>
      <Field label="effort">
        <select
          className={inputCls}
          value={form.effort}
          onChange={(e) => setForm({ ...form, effort: e.target.value })}
        >
          <option value="">(use default)</option>
          {EFFORT_OPTIONS.map((ef) => (
            <option key={ef} value={ef}>
              {ef}
            </option>
          ))}
        </select>
      </Field>
      <Field label="allowedModels (per-agent picker scope)">
        <div className="flex flex-wrap gap-2">
          {MODEL_OPTIONS.map((m) => {
            const checked = form.allowedModels.includes(m)
            return (
              <label
                key={m}
                className="flex items-center gap-1 rounded border border-[var(--mc-bg-line)] px-2 py-1 text-xs"
              >
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      allowedModels: e.target.checked
                        ? [...form.allowedModels, m]
                        : form.allowedModels.filter((x) => x !== m),
                    })
                  }
                />
                {m}
              </label>
            )
          })}
        </div>
      </Field>
    </div>
  )
}

function ChannelsTab({ form, setForm }: TabProps): JSX.Element {
  return (
    <Field label="channels (one Discord channel ID per line)">
      <textarea
        className="h-40 w-full rounded border border-[var(--mc-bg-line)] bg-bg-base px-2 py-1 font-mono text-xs"
        value={form.channels}
        onChange={(e) => setForm({ ...form, channels: e.target.value })}
      />
      <p className="mt-1 text-xs text-fg-2">Hot-reloadable — bridge re-routes on the next config tick.</p>
    </Field>
  )
}

function ToolsTab({ form, setForm }: TabProps): JSX.Element {
  return (
    <div className="space-y-4">
      <Field label="skills (one skill ID per line)">
        <textarea
          className="h-32 w-full rounded-[var(--mc-radius-sm)] border border-[var(--mc-bg-line)] bg-bg-base px-2 py-1 font-mono text-xs"
          aria-label="skills"
          value={form.skills}
          onChange={(e) => setForm({ ...form, skills: e.target.value })}
        />
      </Field>
      <Field label="plugins (one <plugin>@<marketplace> per line)" restart>
        <textarea
          className="h-28 w-full rounded-[var(--mc-radius-sm)] border border-[var(--mc-bg-line)] bg-bg-base px-2 py-1 font-mono text-xs"
          aria-label="plugins"
          placeholder="discord@claude-plugins-official"
          value={form.plugins}
          onChange={(e) => setForm({ ...form, plugins: e.target.value })}
        />
        <p className="mt-1 text-xs text-fg-2">
          Native Claude Code plugins enabled for this agent (browse + install them in
          Marketplace → Plugins). Restart-required, and they attach fully on
          channel-backend (v3) agents.
        </p>
      </Field>
    </div>
  )
}

function McpTab({ form, setForm }: TabProps): JSX.Element {
  const [draft, setDraft] = useState('')
  const add = (): void => {
    const name = draft.trim()
    if (!name) return
    if (form.mcpServers.some((e) => mcpEntryName(e) === name)) {
      setDraft('')
      return
    }
    setForm({ ...form, mcpServers: [...form.mcpServers, name] })
    setDraft('')
  }
  const removeAt = (i: number): void =>
    setForm({ ...form, mcpServers: form.mcpServers.filter((_, idx) => idx !== i) })

  return (
    <div className="space-y-3">
      <p className="text-xs text-fg-2">
        MCP servers attached to this agent. Adding/removing is{' '}
        <strong className="text-fg-2">restart-required</strong> (the binding is captured
        into the SDK session at start). Inline-defined servers are shown read-only —
        edit their command/env in <code>clawcode.yaml</code>.
      </p>

      <div className="flex items-end gap-2">
        <div className="flex-1">
          <label className="mb-1 block text-sm font-medium text-fg-1">
            Attach a server (registry name)
          </label>
          <input
            className={inputCls}
            value={draft}
            placeholder="e.g. acme-db"
            data-testid="mcp-add-input"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                add()
              }
            }}
          />
        </div>
        <Button variant="outline" onClick={add} data-testid="mcp-add-btn">
          <NavIcon name="plus" size={14} />
          Attach
        </Button>
      </div>

      <ul className="divide-y divide-[var(--mc-bg-line)] rounded border border-[var(--mc-bg-line)] bg-bg-muted">
        {form.mcpServers.length === 0 && (
          <li className="p-3 text-sm text-fg-2">no MCP servers bound</li>
        )}
        {form.mcpServers.map((e, i) => (
          <li key={`${mcpEntryName(e)}-${i}`} className="flex items-center gap-2 p-2">
            <span className="font-mono text-xs text-fg-1">{mcpEntryName(e)}</span>
            {mcpEntryIsInline(e) && (
              <Badge variant="secondary" className="text-[10px]">
                inline
              </Badge>
            )}
            <button
              type="button"
              className={removeBtnCls + ' ml-auto'}
              data-testid={`mcp-remove-${mcpEntryName(e)}`}
              onClick={() => removeAt(i)}
            >
              Remove
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}

function AutomationTab({ form, setForm }: TabProps): JSX.Element {
  const setSchedule = (i: number, patch: Partial<ScheduleRow>): void =>
    setForm({
      ...form,
      schedules: form.schedules.map((s, idx) => (idx === i ? { ...s, ...patch } : s)),
    })
  const addSchedule = (): void =>
    setForm({ ...form, schedules: [...form.schedules, newScheduleRow()] })
  const removeSchedule = (i: number): void =>
    setForm({ ...form, schedules: form.schedules.filter((_, idx) => idx !== i) })

  return (
    <div className="space-y-6">
      {/* Dream — autonomous reflection (hot-reloadable) */}
      <section className="space-y-3">
        <div className="flex items-center gap-2">
          <h3 className="font-display text-base font-medium text-fg-1">Dream cycle</h3>
          <Badge variant="secondary" className="text-[10px]">
            hot
          </Badge>
        </div>
        <label className="flex items-center gap-2 text-sm text-fg-1">
          <input
            type="checkbox"
            checked={form.dreamEnabled}
            data-testid="dream-enabled"
            onChange={(e) => setForm({ ...form, dreamEnabled: e.target.checked })}
          />
          Enable autonomous reflection when idle
        </label>
        <div className="flex flex-wrap gap-4">
          <Field label="idle minutes (5–360)">
            <input
              type="number"
              min={5}
              max={360}
              aria-label="dream idle minutes"
              className={inputCls + ' w-28'}
              value={form.dreamIdleMinutes}
              disabled={!form.dreamEnabled}
              onChange={(e) =>
                setForm({
                  ...form,
                  dreamIdleMinutes: e.target.value === '' ? '' : Number(e.target.value),
                })
              }
            />
          </Field>
          <Field label="model">
            <select
              aria-label="dream model"
              className={inputCls + ' w-32'}
              value={form.dreamModel}
              disabled={!form.dreamEnabled}
              onChange={(e) => setForm({ ...form, dreamModel: e.target.value })}
            >
              <option value="">(default)</option>
              {DREAM_MODELS.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </Field>
        </div>
      </section>

      {/* Schedules — cron-driven prompts (hot-reloadable) */}
      <section className="space-y-3">
        <div className="flex items-center gap-2">
          <h3 className="font-display text-base font-medium text-fg-1">Schedules</h3>
          <Badge variant="secondary" className="text-[10px]">
            hot
          </Badge>
          <Button
            variant="outline"
            className="ml-auto"
            onClick={addSchedule}
            data-testid="schedule-add"
          >
            <NavIcon name="plus" size={14} />
            Add schedule
          </Button>
        </div>
        <p className="text-xs text-fg-2">
          Each schedule sends <code>prompt</code> to the agent on its <code>cron</code>{' '}
          cadence. Incomplete rows are ignored on save.
        </p>

        {form.schedules.length === 0 && (
          <div className="rounded border border-dashed border-[var(--mc-bg-line)] p-4 text-sm text-fg-2">
            No schedules.
          </div>
        )}

        {form.schedules.map((s, i) => (
          <div
            key={s.id}
            className="grid gap-2 rounded-[var(--mc-radius)] border border-[var(--mc-bg-line)] bg-bg-muted p-3 sm:grid-cols-[1fr_1fr_auto]"
            data-testid={`schedule-row-${i}`}
          >
            <input
              className={inputCls}
              placeholder="name"
              aria-label={`schedule ${i + 1} name`}
              value={s.name}
              onChange={(e) => setSchedule(i, { name: e.target.value })}
            />
            <input
              className={inputCls + ' font-mono'}
              placeholder="cron (e.g. 0 9 * * *)"
              aria-label={`schedule ${i + 1} cron expression`}
              value={s.cron}
              onChange={(e) => setSchedule(i, { cron: e.target.value })}
            />
            <label className="flex items-center gap-1 text-xs text-fg-2">
              <input
                type="checkbox"
                checked={s.enabled}
                onChange={(e) => setSchedule(i, { enabled: e.target.checked })}
              />
              enabled
            </label>
            <textarea
              className="col-span-full h-16 w-full rounded-[var(--mc-radius-sm)] border border-[var(--mc-bg-line)] bg-bg-base px-2 py-1 text-sm"
              placeholder="prompt"
              aria-label={`schedule ${i + 1} prompt`}
              value={s.prompt}
              onChange={(e) => setSchedule(i, { prompt: e.target.value })}
            />
            <button
              type="button"
              className={removeBtnCls + ' col-span-full justify-self-end'}
              data-testid={`schedule-remove-${i}`}
              onClick={() => removeSchedule(i)}
            >
              Remove
            </button>
          </div>
        ))}
      </section>
    </div>
  )
}

function MemoryTab({ form, setForm, hot }: TabPropsWithHot): JSX.Element {
  return (
    <div className="space-y-4">
      <Field label="memoryAutoLoad" hot={hot.has('memoryAutoLoad')}>
        <label className="flex items-center gap-2 text-sm text-fg-1">
          <input
            type="checkbox"
            checked={form.memoryAutoLoad}
            onChange={(e) => setForm({ ...form, memoryAutoLoad: e.target.checked })}
          />
          Auto-inject MEMORY.md at session boot
        </label>
      </Field>
      <Field label="memoryRetrievalTopK (1-50)" hot={hot.has('memoryRetrievalTopK')}>
        <input
          type="number"
          min={1}
          max={50}
          className="w-32 rounded border border-[var(--mc-bg-line)] bg-bg-base px-2 py-1 text-sm"
          value={form.memoryRetrievalTopK}
          onChange={(e) =>
            setForm({ ...form, memoryRetrievalTopK: e.target.value === '' ? '' : Number(e.target.value) })
          }
        />
      </Field>
    </div>
  )
}

function fmtScore(n: number | undefined): string {
  return typeof n === 'number' ? n.toFixed(3) : '—'
}

function OptimizerResultCard({ result }: { result: AgentOptimizationResult }): JSX.Element {
  return (
    <div
      className="mt-3 space-y-1 rounded-[var(--mc-radius-sm)] border border-[var(--mc-primary-ring)] bg-[var(--mc-primary-soft)] p-3 text-xs text-fg-1"
      data-testid="optimizer-result"
    >
      <div>
        <span className="text-fg-2">status:</span> {result.status}
        {result.outcome ? ` · ${result.outcome}` : ''}
      </div>
      {result.reason && (
        <div>
          <span className="text-fg-2">reason:</span> {result.reason}
        </div>
      )}
      {(result.baselineScore != null || result.candidateScore != null) && (
        <div className="font-mono">
          baseline {fmtScore(result.baselineScore)} → candidate {fmtScore(result.candidateScore)}
        </div>
      )}
      {result.stagedDraftCount != null && (
        <div>
          <span className="text-fg-2">staged drafts:</span> {result.stagedDraftCount}
          {result.removeCount ? ` · removals ${result.removeCount}` : ''}
        </div>
      )}
      {result.summary && <div className="text-fg-2">{result.summary}</div>}
    </div>
  )
}

function OptimizerTab({
  form,
  setForm,
  agentName,
}: TabProps & { agentName: string }): JSX.Element {
  const [run, setRun] = useState<
    | { kind: 'idle' }
    | { kind: 'running' }
    | { kind: 'done'; result: AgentOptimizationResult }
    | { kind: 'error'; message: string }
  >({ kind: 'idle' })

  const doRun = async (): Promise<void> => {
    setRun({ kind: 'running' })
    try {
      setRun({ kind: 'done', result: await runAgentOptimization(agentName) })
    } catch (err) {
      setRun({ kind: 'error', message: err instanceof Error ? err.message : 'unknown error' })
    }
  }

  return (
    <div className="space-y-5">
      <p className="text-xs text-fg-2">
        The optimizer measures the agent against its eval set and stages skill
        improvements for operator review — it never auto-applies. Enabling or
        changing the eval set is <strong className="text-fg-2">restart-required</strong>.
      </p>

      <Field label="enabled" restart>
        <label className="flex items-center gap-2 text-sm text-fg-1">
          <input
            type="checkbox"
            checked={form.optimizerEnabled}
            data-testid="optimizer-enabled"
            onChange={(e) => setForm({ ...form, optimizerEnabled: e.target.checked })}
          />
          Optimizer enabled
        </label>
      </Field>

      <Field label="eval set (path relative to memoryPath)" restart>
        <input
          className={inputCls}
          value={form.optimizerEvalSet}
          placeholder="e.g. evals/personal.json"
          data-testid="optimizer-evalset"
          onChange={(e) => setForm({ ...form, optimizerEvalSet: e.target.value })}
        />
      </Field>

      <div className="rounded-[var(--mc-radius)] border border-[var(--mc-bg-line)] bg-bg-muted p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="font-display text-sm font-medium text-fg-1">Run optimizer now</div>
            <div className="text-xs text-fg-2">
              Operator-fired measured run. Improvements are staged for review (results are
              not persisted — this shows the latest run only).
            </div>
          </div>
          <Button
            onClick={doRun}
            disabled={run.kind === 'running' || !form.optimizerEnabled}
            data-testid="optimizer-run"
          >
            <NavIcon name="benchmarks" size={14} />
            {run.kind === 'running' ? 'Running…' : 'Run'}
          </Button>
        </div>

        {!form.optimizerEnabled && (
          <p className="mt-2 text-xs text-fg-2">
            Enable the optimizer (and restart the agent) before running.
          </p>
        )}
        {run.kind === 'done' && <OptimizerResultCard result={run.result} />}
        {run.kind === 'error' && (
          <div className="mt-3 rounded border border-danger/40 bg-danger/10 p-2 text-xs text-danger">
            {run.message}
          </div>
        )}
      </div>
    </div>
  )
}

function DebugTab({ raw }: { raw: Record<string, unknown> | null }): JSX.Element {
  return (
    <pre className="max-h-[50vh] overflow-auto rounded bg-bg-muted p-3 text-xs text-fg-1">
      {JSON.stringify(raw ?? {}, null, 2)}
    </pre>
  )
}

export default AgentConfigPanel
