/**
 * dashboard-rework P2 — pure form-state ↔ config-partial logic for the agent
 * config panel. Kept React-free so it can be unit-tested against the daemon's
 * real `agentSchema.partial()` (the read-only dev loop can't exercise the write
 * round-trip, so validating the emitted PATCH SHAPE here is the key backstop).
 *
 * Increment 2 adds mcpServers (restart-required), schedules (hot), and dream
 * (hot) to the editable surface.
 */

/** A per-agent MCP entry: a string ref into the top-level registry, or inline. */
export type McpEntry = string | Record<string, unknown>

export type ScheduleRow = {
  /** Stable client-only id for React keys; stripped before the patch is sent. */
  id: string
  name: string
  cron: string
  prompt: string
  enabled: boolean
}

function rid(): string {
  return globalThis.crypto?.randomUUID
    ? globalThis.crypto.randomUUID()
    : `s-${Date.now().toString(36)}-${(scheduleSeq++).toString(36)}`
}
let scheduleSeq = 0

export function newScheduleRow(): ScheduleRow {
  return { id: rid(), name: '', cron: '', prompt: '', enabled: true }
}

export type FormState = {
  workspace: string
  memoryPath: string
  model: string
  effort: string
  channels: string // newline-separated for the textarea
  allowedModels: string[]
  skills: string // newline-separated
  plugins: string // newline-separated `<plugin>@<marketplace>` refs
  memoryAutoLoad: boolean
  memoryRetrievalTopK: number | ''
  mcpServers: McpEntry[]
  schedules: ScheduleRow[]
  dreamEnabled: boolean
  dreamIdleMinutes: number | ''
  dreamModel: string // '' | 'haiku' | 'sonnet' | 'opus'
  dreamRetentionDays: number | ''
  optimizerEnabled: boolean
  optimizerEvalSet: string
  /** The full resolved optimizer block, preserved so a toggle/evalSet edit
   *  doesn't clobber the optimizer's other knobs (model, maxActionsPerRun…). */
  optimizerRaw: Record<string, unknown>
}

function num(v: unknown): number | '' {
  return typeof v === 'number' ? v : ''
}

export function formStateFromRaw(raw: Record<string, unknown> | null): FormState {
  const r = raw ?? {}
  const dream = (r['dream'] ?? {}) as Record<string, unknown>
  const opt = (r['optimizer'] ?? {}) as Record<string, unknown>
  return {
    workspace: String(r['workspace'] ?? ''),
    memoryPath: String(r['memoryPath'] ?? ''),
    model: String(r['model'] ?? ''),
    effort: String(r['effort'] ?? ''),
    channels: Array.isArray(r['channels']) ? (r['channels'] as string[]).join('\n') : '',
    allowedModels: Array.isArray(r['allowedModels']) ? (r['allowedModels'] as string[]) : [],
    skills: Array.isArray(r['skills']) ? (r['skills'] as string[]).join('\n') : '',
    plugins: Array.isArray(r['plugins']) ? (r['plugins'] as string[]).join('\n') : '',
    memoryAutoLoad: Boolean(r['memoryAutoLoad']),
    memoryRetrievalTopK: num(r['memoryRetrievalTopK']),
    mcpServers: Array.isArray(r['mcpServers']) ? (r['mcpServers'] as McpEntry[]) : [],
    schedules: Array.isArray(r['schedules'])
      ? (r['schedules'] as Array<Record<string, unknown>>).map((s) => ({
          id: rid(),
          name: String(s?.['name'] ?? ''),
          cron: String(s?.['cron'] ?? ''),
          prompt: String(s?.['prompt'] ?? ''),
          enabled: s?.['enabled'] !== false,
        }))
      : [],
    dreamEnabled: Boolean(dream['enabled']),
    dreamIdleMinutes: num(dream['idleMinutes']),
    dreamModel: String(dream['model'] ?? ''),
    dreamRetentionDays: num(dream['retentionDays']),
    optimizerEnabled: Boolean(opt['enabled']),
    optimizerEvalSet: String(opt['evalSet'] ?? ''),
    optimizerRaw: opt,
  }
}

/** Display name for an MCP entry (string ref or inline {name}). */
export function mcpEntryName(e: McpEntry): string {
  if (typeof e === 'string') return e
  const n = (e as { name?: unknown }).name
  return typeof n === 'string' ? n : JSON.stringify(e)
}

/** True for the inline-object form (carries command/args/env). */
export function mcpEntryIsInline(e: McpEntry): boolean {
  return typeof e !== 'string'
}

/**
 * Diff the form against its loaded original → the minimal partial sent to
 * `PUT /api/config/agents/:name`. Only changed fields are included so the
 * daemon's hot-reload-vs-restart classification is accurate. Unit-tested
 * against `agentSchema.partial()`.
 */
export function buildAgentPartial(
  current: FormState,
  original: FormState,
): Record<string, unknown> {
  const patch: Record<string, unknown> = {}
  if (current.workspace !== original.workspace) patch.workspace = current.workspace
  if (current.memoryPath !== original.memoryPath) {
    patch.memoryPath = current.memoryPath || undefined
  }
  if (current.model !== original.model && current.model.length > 0) {
    patch.model = current.model
  }
  if (current.effort !== original.effort && current.effort.length > 0) {
    patch.effort = current.effort
  }
  if (current.channels !== original.channels) {
    patch.channels = current.channels.split('\n').map((s) => s.trim()).filter(Boolean)
  }
  if (current.skills !== original.skills) {
    patch.skills = current.skills.split('\n').map((s) => s.trim()).filter(Boolean)
  }
  // plugins — RESTART-required (spawn-captured). Emit the trimmed ref list.
  if (current.plugins !== original.plugins) {
    patch.plugins = current.plugins.split('\n').map((s) => s.trim()).filter(Boolean)
  }
  if (
    JSON.stringify([...current.allowedModels].sort()) !==
    JSON.stringify([...original.allowedModels].sort())
  ) {
    patch.allowedModels = current.allowedModels
  }
  if (current.memoryAutoLoad !== original.memoryAutoLoad) {
    patch.memoryAutoLoad = current.memoryAutoLoad
  }
  if (current.memoryRetrievalTopK !== original.memoryRetrievalTopK) {
    patch.memoryRetrievalTopK =
      current.memoryRetrievalTopK === '' ? undefined : current.memoryRetrievalTopK
  }

  // mcpServers — RESTART-required. Emit the whole array when it changed.
  if (JSON.stringify(current.mcpServers) !== JSON.stringify(original.mcpServers)) {
    patch.mcpServers = current.mcpServers
  }

  // schedules — HOT. Only complete rows (name+cron+prompt) are valid per
  // scheduleEntrySchema; drop half-filled rows so a save never 400s.
  // Drop half-filled rows AND strip the client-only `id` (not in
  // scheduleEntrySchema) so the emitted patch is the clean wire shape.
  const completeSchedules = (rows: ScheduleRow[]): Array<Omit<ScheduleRow, 'id'>> =>
    rows
      .filter((s) => s.name.trim() && s.cron.trim() && s.prompt.trim())
      .map((s) => ({ name: s.name, cron: s.cron, prompt: s.prompt, enabled: s.enabled }))
  const curSched = completeSchedules(current.schedules)
  const origSched = completeSchedules(original.schedules)
  if (JSON.stringify(curSched) !== JSON.stringify(origSched)) {
    patch.schedules = curSched
  }

  // dream — HOT. Emit the object when any dream field changed.
  const dreamChanged =
    current.dreamEnabled !== original.dreamEnabled ||
    current.dreamIdleMinutes !== original.dreamIdleMinutes ||
    current.dreamModel !== original.dreamModel ||
    current.dreamRetentionDays !== original.dreamRetentionDays
  if (dreamChanged) {
    const dream: Record<string, unknown> = { enabled: current.dreamEnabled }
    if (current.dreamIdleMinutes !== '') dream.idleMinutes = current.dreamIdleMinutes
    if (current.dreamModel) dream.model = current.dreamModel
    if (current.dreamRetentionDays !== '') dream.retentionDays = current.dreamRetentionDays
    patch.dream = dream
  }

  // optimizer — RESTART-required. Merge over the resolved block so toggling
  // enabled / editing evalSet never clobbers the other knobs (model,
  // maxActionsPerRun, eligibleSkills, evalMcpServers, cadence…).
  if (
    current.optimizerEnabled !== original.optimizerEnabled ||
    current.optimizerEvalSet !== original.optimizerEvalSet
  ) {
    const opt: Record<string, unknown> = {
      ...current.optimizerRaw,
      enabled: current.optimizerEnabled,
    }
    if (current.optimizerEvalSet.trim()) opt.evalSet = current.optimizerEvalSet.trim()
    else delete opt.evalSet
    patch.optimizer = opt
  }

  return patch
}
