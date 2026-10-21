/**
 * Phase 116-postdeploy 2026-05-12 — Memory + dreams page.
 *
 * Operator asked: "a view to see and trigger agent dreaming and memory
 * consolidation, etc." Reuses the existing F14 MemoryPanel and F15
 * DreamQueue components (Phase 116-04, already scoped per-agent) — those
 * give us tier counts, file previews, migration delta, and the D-10 veto
 * window UI for free. The new surface is:
 *
 *   - Per-agent operator-trigger card (Run dream pass + Consolidate)
 *   - Recent dream-artifact previews (list-dream-artifacts IPC)
 *   - Fleet-wide "Consolidate all" button
 *
 * Layout: agent picker on the left (sticky), selected agent's stack on
 * the right (panels + actions + artefacts). Keeps the page focused: an
 * operator typically reasons about one agent at a time during a memory
 * triage session.
 */
import { useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  runCleanupOrphans,
  runDreamPass,
  runTierMaintenance,
  triggerHotReload,
  updateAgentConfig,
  useAgentConfig,
  useAgents,
  useDreamArtifacts,
  type CleanupOrphansResponse,
  type DreamArtifact,
  type RunDreamPassResponse,
  type TierMaintenanceResponse,
} from '@/hooks/useApi'
import { MemoryPanel } from './MemoryPanel'
import { DreamQueue } from './DreamQueue'
import { MigrationTracker } from './MigrationTracker'

type ModelChoice = 'haiku' | 'sonnet' | 'opus'

/**
 * 116-postdeploy 2026-05-12 — defaults used when seeding a fresh
 * `dream:` block onto an agent that doesn't have one. Mirrors the schema
 * defaults in src/config/schema.ts dreamConfigSchema (idleMinutes 30,
 * model haiku) and adds retentionDays so dream artefacts roll over.
 *
 * The schema accepts idleMinutes in [5, 360]; the operator UI clamps to
 * [5, 180] because beyond 3h the consolidation cadence stops being
 * meaningful — by then the agent has likely been restarted.
 */
const DEFAULT_DREAM_IDLE_MINUTES = 30
const DREAM_IDLE_MIN = 5
const DREAM_IDLE_MAX = 180

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

function fmtRel(iso: string | null): string {
  if (!iso) return '—'
  const ts = Date.parse(iso)
  if (!Number.isFinite(ts)) return iso
  const d = Date.now() - ts
  if (d < 60_000) return `${Math.round(d / 1000)}s ago`
  if (d < 3_600_000) return `${Math.round(d / 60_000)}m ago`
  if (d < 86_400_000) return `${Math.round(d / 3_600_000)}h ago`
  return `${Math.round(d / 86_400_000)}d ago`
}

export function MemoryView(): JSX.Element {
  const queryClient = useQueryClient()
  const agentsQ = useAgents()
  const topLevelAgents = useMemo(
    () =>
      agentsQ.data?.agents
        ?.map((a) => a.name)
        .filter((n) => !n.includes('-sub-') && !n.includes('-thread-'))
        .sort() ?? [],
    [agentsQ.data],
  )
  const [selected, setSelected] = useState<string | null>(null)
  useEffect(() => {
    if (!selected && topLevelAgents.length > 0) {
      setSelected(topLevelAgents[0] ?? null)
    }
  }, [selected, topLevelAgents])

  // Dream-run modal state
  const [runDreamOpen, setRunDreamOpen] = useState(false)
  const [model, setModel] = useState<ModelChoice>('haiku')
  const [force, setForce] = useState(false)
  const [idleBypass, setIdleBypass] = useState(false)
  const [running, setRunning] = useState(false)
  const [runOutcome, setRunOutcome] = useState<RunDreamPassResponse | null>(null)
  const [runError, setRunError] = useState<string | null>(null)

  // Consolidate state
  const [consolidating, setConsolidating] = useState(false)
  const [consolidateResult, setConsolidateResult] =
    useState<TierMaintenanceResponse | null>(null)
  const [consolidateError, setConsolidateError] = useState<string | null>(null)

  // 116-postdeploy 2026-05-12 — orphan cleanup state. Fleet-wide button at
  // the top of the page invalidates every agent's migration card afterwards
  // so the v1/v2 numbers refresh. Per-agent cleanup happens inside
  // MigrationTracker (its own modal); this state covers the fleet path.
  const [cleaningOrphans, setCleaningOrphans] = useState(false)
  const [cleanupResult, setCleanupResult] =
    useState<CleanupOrphansResponse | null>(null)
  const [cleanupError, setCleanupError] = useState<string | null>(null)
  const [cleanupConfirmOpen, setCleanupConfirmOpen] = useState(false)

  // Bulk "Enable consolidation on all" state
  const [bulkEnableOpen, setBulkEnableOpen] = useState(false)
  const [bulkEnableBusy, setBulkEnableBusy] = useState(false)
  const [bulkEnableOutcome, setBulkEnableOutcome] = useState<
    | { readonly succeeded: readonly string[]; readonly failed: readonly { agent: string; error: string }[] }
    | null
  >(null)

  async function handleRunDream(): Promise<void> {
    if (!selected) return
    setRunning(true)
    setRunError(null)
    setRunOutcome(null)
    try {
      const out = await runDreamPass(selected, {
        modelOverride: model,
        force,
        idleBypass,
      })
      setRunOutcome(out)
      // Invalidate caches: dream-queue (events), dream-artifacts (new file),
      // memory-snapshot (tier counts may have shifted).
      void queryClient.invalidateQueries({ queryKey: ['dream-queue', selected] })
      void queryClient.invalidateQueries({
        queryKey: ['dream-artifacts', selected],
      })
      void queryClient.invalidateQueries({
        queryKey: ['memory-snapshot', selected],
      })
    } catch (err) {
      setRunError((err as Error).message)
    } finally {
      setRunning(false)
    }
  }

  async function handleBulkEnableConsolidation(): Promise<void> {
    setBulkEnableBusy(true)
    setBulkEnableOutcome(null)
    const succeeded: string[] = []
    const failed: { agent: string; error: string }[] = []
    // Sequential to avoid hammering the daemon yaml-patch path — patcher
    // does an atomic temp+rename per call; parallel writes would queue at
    // the same fs.rename() barrier anyway.
    for (const agent of topLevelAgents) {
      try {
        await updateAgentConfig(agent, {
          dream: {
            enabled: true,
            idleMinutes: DEFAULT_DREAM_IDLE_MINUTES,
            model: 'haiku',
            retentionDays: 90,
          },
        })
        succeeded.push(agent)
      } catch (err) {
        failed.push({
          agent,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }
    // Force chokidar to re-read once at the end (debounce bypass) so the
    // daemon picks up every config change without a 500ms wait per file.
    try {
      await triggerHotReload()
    } catch {
      /* best-effort */
    }
    // Refresh agent-config caches so the toggles reflect the new state.
    for (const a of topLevelAgents) {
      void queryClient.invalidateQueries({ queryKey: ['agent-config', a] })
    }
    setBulkEnableOutcome({ succeeded, failed })
    setBulkEnableBusy(false)
  }

  async function handleCleanupOrphansFleet(): Promise<void> {
    setCleaningOrphans(true)
    setCleanupError(null)
    setCleanupResult(null)
    try {
      const out = await runCleanupOrphans(null)
      setCleanupResult(out)
      // Invalidate the migrations query so the v1/v2 numbers + percentage
      // refresh on every agent card. Also touch each per-agent memory
      // snapshot since vec_memories counts surface there too.
      void queryClient.invalidateQueries({ queryKey: ['migrations'] })
      for (const a of topLevelAgents) {
        void queryClient.invalidateQueries({
          queryKey: ['memory-snapshot', a],
        })
      }
    } catch (err) {
      setCleanupError((err as Error).message)
    } finally {
      setCleaningOrphans(false)
    }
  }

  async function handleConsolidate(scope: 'agent' | 'fleet'): Promise<void> {
    setConsolidating(true)
    setConsolidateError(null)
    setConsolidateResult(null)
    try {
      const out = await runTierMaintenance(
        scope === 'fleet' ? null : selected,
      )
      setConsolidateResult(out)
      // Refresh the affected agents' memory snapshots.
      if (scope === 'fleet') {
        for (const a of topLevelAgents) {
          void queryClient.invalidateQueries({
            queryKey: ['memory-snapshot', a],
          })
        }
      } else if (selected) {
        void queryClient.invalidateQueries({
          queryKey: ['memory-snapshot', selected],
        })
      }
    } catch (err) {
      setConsolidateError((err as Error).message)
    } finally {
      setConsolidating(false)
    }
  }

  return (
    <div
      className="mx-auto max-w-[1400px] px-7 py-6"
      data-testid="memory-view"
    >
      {/* dash-redesign sweep — section-head pattern. The dense
          consolidation/dream copy moves into .sub so the buttons
          edge-snap right at the same baseline. */}
      <header className="mb-5">
        <div className="section-head">
          <div className="flex items-baseline">
            <h2>Memory &amp; dreams</h2>
            <span className="sub">
              per-agent memory tiers + dream-pass orchestration ·
              consolidation runs promote / demote / archive
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setBulkEnableOutcome(null)
                setBulkEnableOpen(true)
              }}
              disabled={topLevelAgents.length === 0}
              data-testid="bulk-enable-consolidation"
            >
              Enable consolidation on all
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => handleConsolidate('fleet')}
              disabled={consolidating}
            >
              {consolidating ? 'Consolidating…' : 'Consolidate fleet'}
            </Button>
            {/* 116-postdeploy 2026-05-12 — fleet-wide orphan cleanup. The
                cron now auto-cleans on re-embed-complete (Fix 1) but a
                manual fleet trigger still has value for clearing the
                pre-cascade residue across every running agent in one
                shot. */}
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setCleanupResult(null)
                setCleanupError(null)
                setCleanupConfirmOpen(true)
              }}
              disabled={cleaningOrphans || topLevelAgents.length === 0}
              data-testid="cleanup-orphans-fleet"
            >
              {cleaningOrphans ? 'Cleaning…' : 'Clean orphans (all agents)'}
            </Button>
          </div>
        </div>
      </header>

      {/* 116-postdeploy 2026-05-12 — fleet-wide embedding-v2 migration
          tracker. Mounted here on the Memory page so operators can drive
          the migration state machine alongside per-agent memory triage.
          The same component is also rendered on the dashboard home (Fleet
          layout) for at-a-glance visibility. */}
      <div className="mb-6">
        <MigrationTracker />
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[220px_1fr]">
        {/* Agent picker */}
        <aside className="lg:sticky lg:top-4 lg:self-start">
          <h2 className="mb-2 font-mono text-[10px] font-medium uppercase tracking-wider text-fg-3">
            Agents
          </h2>
          {agentsQ.isLoading && (
            <p className="text-xs text-fg-3">Loading…</p>
          )}
          {topLevelAgents.length === 0 && !agentsQ.isLoading && (
            <p className="text-xs text-fg-3">No agents configured.</p>
          )}
          <nav className="flex flex-col gap-1">
            {topLevelAgents.map((name) => (
              <button
                key={name}
                type="button"
                onClick={() => setSelected(name)}
                className={
                  'rounded-md border px-3 py-1.5 text-left text-sm transition-colors ' +
                  (name === selected
                    ? 'border-primary bg-primary/10 text-primary'
                    : 'border-transparent text-fg-2 hover:bg-bg-elevated hover:text-fg-1')
                }
              >
                {name}
              </button>
            ))}
          </nav>
        </aside>

        {/* Per-agent stack */}
        <div className="space-y-6">
          {!selected && (
            <div className="rounded-md border border-dashed border-border bg-bg-elevated/50 p-6 text-center text-sm text-fg-3">
              Pick an agent to view its memory tiers + dream history.
            </div>
          )}

          {selected && (
            <>
              {/* Actions card */}
              <section className="rounded-lg border border-border bg-bg-elevated p-4">
                <div className="mb-3 flex items-baseline justify-between">
                  <h3 className="font-display text-lg font-medium text-fg-1">
                    Actions
                  </h3>
                  <span className="font-mono text-[10px] text-fg-3">
                    {selected}
                  </span>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" onClick={() => setRunDreamOpen(true)}>
                    Run dream pass…
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => handleConsolidate('agent')}
                    disabled={consolidating}
                  >
                    {consolidating
                      ? 'Consolidating…'
                      : 'Consolidate memory'}
                  </Button>
                </div>
                {consolidateError && (
                  <p className="mt-2 rounded-md border border-destructive/40 bg-destructive/5 p-2 text-xs text-destructive">
                    {consolidateError}
                  </p>
                )}
                {consolidateResult && (
                  <ConsolidateResultBlock result={consolidateResult} />
                )}
              </section>

              {/* 116-postdeploy 2026-05-12 — consolidation toggle. The
                  per-agent `dream:` block in clawcode.yaml gates auto
                  consolidation; today only 2 of 10 agents have it set.
                  Surfaces a toggle + idleMinutes knob so operator-edits
                  no longer require YAML hand-editing. */}
              <ConsolidationConfigCard agentName={selected} />

              {/* MemoryPanel — reused from F14 (116-04) */}
              <MemoryPanel agentName={selected} />

              {/* DreamQueue — reused from F15 (116-04). Active D-10 windows
                  + recent events + veto UI. */}
              <DreamQueue agentName={selected} />

              {/* Recent dream artefacts */}
              <DreamArtifactsList agentName={selected} />
            </>
          )}
        </div>
      </div>

      {/* RUN DREAM PASS MODAL */}
      <Dialog
        open={runDreamOpen}
        onOpenChange={(open) => {
          if (!open) {
            setRunDreamOpen(false)
            setRunOutcome(null)
            setRunError(null)
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="font-display text-xl">
              Run dream pass — {selected}
            </DialogTitle>
            <DialogDescription>
              Synthesises a themed reflection over recent memories and
              proposes promotions / consolidations. Heavy operation — model
              picks the synthesis cost ladder.
            </DialogDescription>
          </DialogHeader>

          {!runOutcome && (
            <div className="space-y-3">
              <div>
                <label className="mb-1 block text-xs font-medium text-fg-2">
                  Model
                </label>
                <div className="flex gap-2">
                  {(['haiku', 'sonnet', 'opus'] as ModelChoice[]).map((m) => (
                    <button
                      key={m}
                      type="button"
                      onClick={() => setModel(m)}
                      className={
                        'rounded-full px-3 py-1 font-mono text-xs uppercase tracking-wider transition-all ' +
                        (model === m
                          ? 'bg-primary/15 text-primary ring-1 ring-primary/30'
                          : 'text-fg-3 hover:bg-bg-elevated hover:text-fg-1')
                      }
                    >
                      {m}
                    </button>
                  ))}
                </div>
                <p className="mt-1 text-[11px] text-fg-3">
                  Default is haiku — cheap + fast. Sonnet/opus for deeper
                  reflections on backlogs.
                </p>
              </div>

              <label className="flex items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={force}
                  onChange={(e) => setForce(e.target.checked)}
                  className="mt-1"
                />
                <span>
                  <span className="text-fg-1">Force</span>
                  <span className="ml-2 text-xs text-fg-3">
                    bypass the <code className="font-mono">dream.enabled=false</code>{' '}
                    config gate
                  </span>
                </span>
              </label>

              <label className="flex items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={idleBypass}
                  onChange={(e) => setIdleBypass(e.target.checked)}
                  className="mt-1"
                />
                <span>
                  <span className="text-fg-1">Idle bypass</span>
                  <span className="ml-2 text-xs text-fg-3">
                    fire even if the agent isn't idle
                  </span>
                </span>
              </label>

              {runError && (
                <p className="rounded-md border border-destructive/40 bg-destructive/5 p-2 text-xs text-destructive">
                  {runError}
                </p>
              )}
            </div>
          )}

          {runOutcome && (
            <div className="space-y-3 rounded-md border border-border bg-bg-base p-3 text-sm">
              <div className="flex gap-2">
                <span className="font-mono text-fg-3">Outcome:</span>
                <span className="font-mono text-fg-1">
                  {runOutcome.outcome.kind}
                </span>
                {runOutcome.outcome.reason && (
                  <span className="text-fg-3">
                    — {runOutcome.outcome.reason}
                  </span>
                )}
              </div>
              <div className="flex gap-2">
                <span className="font-mono text-fg-3">Applied:</span>
                <span className="font-mono text-fg-1">
                  {runOutcome.applied.kind}
                </span>
                {runOutcome.applied.reason && (
                  <span className="text-fg-3">
                    — {runOutcome.applied.reason}
                  </span>
                )}
              </div>
              <p className="text-xs text-fg-3">
                Run dispatched at {runOutcome.startedAt}. The newly-written
                artefact will appear in the list below on the next refresh.
              </p>
            </div>
          )}

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setRunDreamOpen(false)
                setRunOutcome(null)
                setRunError(null)
              }}
            >
              {runOutcome ? 'Close' : 'Cancel'}
            </Button>
            {!runOutcome && (
              <Button onClick={handleRunDream} disabled={running}>
                {running ? 'Running…' : 'Run'}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* BULK ENABLE CONSOLIDATION MODAL — 116-postdeploy 2026-05-12 */}
      <Dialog
        open={bulkEnableOpen}
        onOpenChange={(open) => {
          if (!open && !bulkEnableBusy) {
            setBulkEnableOpen(false)
            setBulkEnableOutcome(null)
          }
        }}
      >
        <DialogContent data-testid="bulk-enable-consolidation-modal">
          <DialogHeader>
            <DialogTitle className="font-display text-xl">
              Enable consolidation on {topLevelAgents.length} agent
              {topLevelAgents.length === 1 ? '' : 's'}?
            </DialogTitle>
            <DialogDescription>
              Writes a default <code className="font-mono">dream:</code> block
              (<code className="font-mono">enabled: true</code>, idleMinutes
              {' '}{DEFAULT_DREAM_IDLE_MINUTES}, model haiku, retentionDays 90)
              to every top-level agent. Existing dream blocks have their{' '}
              <code className="font-mono">enabled</code> flag flipped on (other
              keys preserved by the YAML patcher). Hot-reloadable — no
              restarts required.
            </DialogDescription>
          </DialogHeader>

          {!bulkEnableOutcome && (
            <ul className="rounded-md border border-border bg-bg-base p-3 max-h-48 overflow-y-auto text-xs font-mono space-y-1">
              {topLevelAgents.map((a) => (
                <li key={a} className="text-fg-2">
                  {a}
                </li>
              ))}
            </ul>
          )}

          {bulkEnableOutcome && (
            <div className="space-y-2 text-xs font-mono">
              <p className="text-fg-2">
                Updated:{' '}
                <span className="text-primary">
                  {bulkEnableOutcome.succeeded.length}
                </span>
                {bulkEnableOutcome.failed.length > 0 && (
                  <>
                    {' · '}
                    Failed:{' '}
                    <span className="text-destructive">
                      {bulkEnableOutcome.failed.length}
                    </span>
                  </>
                )}
              </p>
              {bulkEnableOutcome.failed.length > 0 && (
                <ul className="rounded-md border border-destructive/40 bg-destructive/5 p-2 max-h-32 overflow-y-auto space-y-0.5">
                  {bulkEnableOutcome.failed.map((f) => (
                    <li
                      key={f.agent}
                      className="text-destructive text-[11px]"
                    >
                      <span className="font-bold">{f.agent}</span>: {f.error}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setBulkEnableOpen(false)
                setBulkEnableOutcome(null)
              }}
              disabled={bulkEnableBusy}
            >
              {bulkEnableOutcome ? 'Close' : 'Cancel'}
            </Button>
            {!bulkEnableOutcome && (
              <Button
                onClick={handleBulkEnableConsolidation}
                disabled={bulkEnableBusy || topLevelAgents.length === 0}
              >
                {bulkEnableBusy
                  ? 'Working…'
                  : `Enable ${topLevelAgents.length}`}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* CLEANUP ORPHANS FLEET MODAL — 116-postdeploy 2026-05-12.
          Pre-cascade residue: 940 orphans fleet-wide, 757 on one agent at
          time of writing. Fix 1 prevents new orphans on future
          re-embed-complete transitions; this trigger clears existing
          residue across every running agent in one IPC call. */}
      <Dialog
        open={cleanupConfirmOpen}
        onOpenChange={(open) => {
          if (!open && !cleaningOrphans) {
            setCleanupConfirmOpen(false)
            setCleanupResult(null)
            setCleanupError(null)
          }
        }}
      >
        <DialogContent data-testid="cleanup-orphans-fleet-modal">
          <DialogHeader>
            <DialogTitle className="font-display text-xl">
              Clean orphan vec rows across {topLevelAgents.length} agent
              {topLevelAgents.length === 1 ? '' : 's'}?
            </DialogTitle>
            <DialogDescription>
              For every running agent, scans{' '}
              <code className="font-mono">vec_memories</code> +{' '}
              <code className="font-mono">vec_memories_v2</code> for rows
              whose <code className="font-mono">memory_id</code> no longer
              exists in <code className="font-mono">memories</code>, and
              removes them. Orphans accumulate as pre-cascade residue and
              inflate the v1/v2 dashboard denominator (a fully-migrated
              agent may display 59% etc.). Idempotent + safe.
            </DialogDescription>
          </DialogHeader>

          {cleanupError && (
            <p
              className="mt-2 rounded-md border border-destructive/40 bg-destructive/5 p-2 text-xs text-destructive"
              role="alert"
            >
              {cleanupError}
            </p>
          )}

          {cleanupResult && (
            <div className="space-y-2 text-xs font-mono">
              <p className="text-fg-2">
                Cleaned{' '}
                <span className="text-primary">
                  {cleanupResult.results.filter((r) => r.removed > 0).length}
                </span>{' '}
                of <span className="text-fg-2">{cleanupResult.results.length}</span>{' '}
                agents (orphans found).{' '}
                <span className="text-fg-3">
                  Total removed:{' '}
                  {cleanupResult.results.reduce((s, r) => s + r.removed, 0)}
                </span>
              </p>
              <ul className="rounded-md border border-border bg-bg-base p-2 max-h-48 overflow-y-auto space-y-0.5">
                {cleanupResult.results
                  .slice()
                  .sort((a, b) => b.removed - a.removed)
                  .map((r) => (
                    <li
                      key={r.agent}
                      className={
                        r.totalAfter < 0
                          ? 'text-destructive text-[11px]'
                          : r.removed > 0
                            ? 'text-primary text-[11px]'
                            : 'text-fg-3 text-[11px]'
                      }
                    >
                      <span className="font-bold">{r.agent}</span>:{' '}
                      {r.totalAfter < 0
                        ? 'failed'
                        : r.removed === 0
                          ? `no orphans (${r.totalAfter} v1 vecs remain)`
                          : `removed ${r.removed}, ${r.totalAfter} v1 vecs remain`}
                    </li>
                  ))}
              </ul>
            </div>
          )}

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setCleanupConfirmOpen(false)
                setCleanupResult(null)
                setCleanupError(null)
              }}
              disabled={cleaningOrphans}
            >
              {cleanupResult ? 'Close' : 'Cancel'}
            </Button>
            {!cleanupResult && (
              <Button
                onClick={handleCleanupOrphansFleet}
                disabled={cleaningOrphans || topLevelAgents.length === 0}
                data-testid="cleanup-orphans-fleet-confirm"
              >
                {cleaningOrphans
                  ? 'Cleaning…'
                  : `Clean ${topLevelAgents.length}`}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

// ---------------------------------------------------------------------------
// 116-postdeploy 2026-05-12 — ConsolidationConfigCard.
//
// Reads the agent's resolved config from `/api/config/agents/:name`, surfaces
// the `dream.enabled` flag as a toggle and `dream.idleMinutes` as a slider
// + number input. Writes flow through PUT /api/config/agents/:name (F26 path),
// then triggerHotReload() to bypass chokidar's 500ms debounce so the daemon
// applies the change immediately.
//
// For agents with NO `dream:` block in clawcode.yaml today, the writer adds
// the block atomically — YAMLMap.set in src/config/yaml-patcher.ts adds keys
// that aren't already present.
// ---------------------------------------------------------------------------

function ConsolidationConfigCard(props: {
  readonly agentName: string
}): JSX.Element {
  const { agentName } = props
  const queryClient = useQueryClient()
  const cfgQ = useAgentConfig(agentName)

  // Read current dream config from resolved (always present after merge
  // with defaults — even unset agents resolve to `enabled: false`).
  const resolvedDream = useMemo(() => {
    const r = cfgQ.data?.resolved as { dream?: { enabled?: boolean; idleMinutes?: number; model?: string; retentionDays?: number } } | undefined
    return r?.dream ?? { enabled: false, idleMinutes: DEFAULT_DREAM_IDLE_MINUTES, model: 'haiku' }
  }, [cfgQ.data])

  // Locally-controlled pending state so the slider feels responsive — only
  // PUT when the operator releases the slider (onChange handler fires once).
  const [pendingIdleMinutes, setPendingIdleMinutes] = useState<number | null>(
    null,
  )
  const effectiveIdleMinutes =
    pendingIdleMinutes ?? resolvedDream.idleMinutes ?? DEFAULT_DREAM_IDLE_MINUTES

  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [savedAt, setSavedAt] = useState<number | null>(null)

  const writeDream = useCallback(
    async (next: {
      readonly enabled?: boolean
      readonly idleMinutes?: number
    }): Promise<void> => {
      setSaving(true)
      setSaveError(null)
      try {
        // Always write the COMPLETE dream block — for agents without an
        // existing `dream:` key the patcher needs every required field
        // (enabled, idleMinutes, model) to satisfy dreamConfigSchema.
        const enabled = next.enabled ?? resolvedDream.enabled ?? false
        const idleMinutes = Math.max(
          DREAM_IDLE_MIN,
          Math.min(
            DREAM_IDLE_MAX,
            next.idleMinutes ?? resolvedDream.idleMinutes ?? DEFAULT_DREAM_IDLE_MINUTES,
          ),
        )
        await updateAgentConfig(agentName, {
          dream: {
            enabled,
            idleMinutes,
            model: (resolvedDream.model as 'haiku' | 'sonnet' | 'opus') ?? 'haiku',
            retentionDays: resolvedDream.retentionDays ?? 90,
          },
        })
        await triggerHotReload().catch(() => {
          /* best-effort — patch already on disk, watcher catches up in 500ms */
        })
        void queryClient.invalidateQueries({
          queryKey: ['agent-config', agentName],
        })
        setSavedAt(Date.now())
        setPendingIdleMinutes(null)
      } catch (err) {
        setSaveError(err instanceof Error ? err.message : 'Unknown error')
      } finally {
        setSaving(false)
      }
    },
    [agentName, queryClient, resolvedDream],
  )

  // Auto-clear the "saved" indicator after 2s.
  useEffect(() => {
    if (savedAt === null) return
    const handle = setTimeout(() => setSavedAt(null), 2000)
    return () => clearTimeout(handle)
  }, [savedAt])

  const enabled = resolvedDream.enabled ?? false

  return (
    <section
      className="rounded-lg border border-border bg-bg-elevated p-4"
      data-testid="consolidation-config"
    >
      <div className="mb-3 flex items-baseline justify-between">
        <h3 className="font-display text-lg font-medium text-fg-1">
          Auto-consolidation
        </h3>
        <span className="font-mono text-[10px] text-fg-3">
          dream.enabled · dream.idleMinutes
        </span>
      </div>

      {cfgQ.isLoading && (
        <p className="text-sm text-fg-3">Loading config…</p>
      )}
      {cfgQ.error && (
        <p className="text-sm text-destructive">
          {(cfgQ.error as Error).message}
        </p>
      )}

      {cfgQ.data && (
        <div className="space-y-4">
          {/* Toggle */}
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="font-mono text-sm text-fg-1">
                {enabled ? 'Enabled' : 'Disabled'}
              </p>
              <p className="text-[11px] text-fg-3">
                When enabled, the heartbeat runner fires a dream pass after
                the configured idle window. Hot-reloadable — no agent
                restart needed.
              </p>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={enabled}
              data-testid="consolidation-toggle"
              onClick={() => void writeDream({ enabled: !enabled })}
              disabled={saving}
              className={
                'relative h-6 w-11 shrink-0 rounded-full transition-colors ' +
                (enabled ? 'bg-primary' : 'bg-bg-s3') +
                (saving ? ' opacity-60 cursor-wait' : ' cursor-pointer')
              }
            >
              <span
                aria-hidden
                className={
                  'absolute top-0.5 h-5 w-5 rounded-full bg-white shadow-sm transition-transform ' +
                  (enabled ? 'translate-x-5' : 'translate-x-0.5')
                }
              />
            </button>
          </div>

          {/* idleMinutes knob — slider + number input pairing */}
          <div>
            <div className="mb-1 flex items-baseline justify-between">
              <label
                htmlFor={`idle-${agentName}`}
                className="text-xs font-medium text-fg-2"
              >
                Idle window (minutes)
              </label>
              <span className="font-mono text-xs text-fg-1 data">
                {effectiveIdleMinutes}m
              </span>
            </div>
            <div className="flex items-center gap-3">
              <input
                id={`idle-${agentName}`}
                type="range"
                min={DREAM_IDLE_MIN}
                max={DREAM_IDLE_MAX}
                step={5}
                value={effectiveIdleMinutes}
                onChange={(e) => setPendingIdleMinutes(Number(e.target.value))}
                onMouseUp={() => {
                  if (
                    pendingIdleMinutes !== null &&
                    pendingIdleMinutes !== resolvedDream.idleMinutes
                  ) {
                    void writeDream({ idleMinutes: pendingIdleMinutes })
                  }
                }}
                onTouchEnd={() => {
                  if (
                    pendingIdleMinutes !== null &&
                    pendingIdleMinutes !== resolvedDream.idleMinutes
                  ) {
                    void writeDream({ idleMinutes: pendingIdleMinutes })
                  }
                }}
                disabled={saving}
                className="flex-1 accent-primary"
                data-testid="consolidation-idle-slider"
              />
              <input
                type="number"
                min={DREAM_IDLE_MIN}
                max={DREAM_IDLE_MAX}
                step={5}
                value={effectiveIdleMinutes}
                onChange={(e) => setPendingIdleMinutes(Number(e.target.value))}
                onBlur={() => {
                  if (
                    pendingIdleMinutes !== null &&
                    pendingIdleMinutes !== resolvedDream.idleMinutes
                  ) {
                    void writeDream({ idleMinutes: pendingIdleMinutes })
                  }
                }}
                disabled={saving}
                className="w-20 rounded border border-border bg-bg-base px-2 py-1 font-mono text-xs text-fg-1 data"
                data-testid="consolidation-idle-input"
              />
            </div>
            <p className="mt-1 text-[10px] text-fg-3">
              Default {DEFAULT_DREAM_IDLE_MINUTES}m · range {DREAM_IDLE_MIN}–
              {DREAM_IDLE_MAX}m. Slider commits on release; number-input on
              blur.
            </p>
          </div>

          {saving && (
            <p className="text-[11px] text-fg-3 font-mono">Saving…</p>
          )}
          {savedAt !== null && !saving && (
            <p className="text-[11px] text-primary font-mono">
              Saved · hot-reloaded
            </p>
          )}
          {saveError && (
            <p className="rounded-md border border-destructive/40 bg-destructive/5 p-2 text-xs text-destructive">
              {saveError}
            </p>
          )}
        </div>
      )}
    </section>
  )
}

function ConsolidateResultBlock(props: {
  readonly result: TierMaintenanceResponse
}): JSX.Element {
  const { result } = props
  const entries = Object.entries(result.results)
  return (
    <div className="mt-3 rounded-md border border-border bg-bg-base p-3">
      <p className="mb-2 font-mono text-[10px] uppercase tracking-wider text-fg-3">
        Consolidation result
      </p>
      {entries.length === 0 && (
        <p className="text-xs text-fg-3">
          No tier-managed agents — nothing to do.
        </p>
      )}
      {entries.map(([agent, counts]) => (
        <div
          key={agent}
          className="flex items-center justify-between gap-2 border-b border-border/40 py-1 text-xs last:border-b-0"
        >
          <span className="font-mono text-fg-2">{agent}</span>
          <span className="font-mono text-fg-1">
            promoted {counts.promoted} · demoted {counts.demoted} · archived{' '}
            {counts.archived}
          </span>
        </div>
      ))}
      {result.skipped.length > 0 && (
        <p className="mt-2 text-[10px] text-fg-3">
          Skipped (no tier manager): {result.skipped.join(', ')}
        </p>
      )}
    </div>
  )
}

function DreamArtifactsList(props: {
  readonly agentName: string
}): JSX.Element {
  const q = useDreamArtifacts(props.agentName, 20)
  const [expanded, setExpanded] = useState<string | null>(null)

  return (
    <section className="rounded-lg border border-border bg-bg-elevated p-4">
      <div className="mb-3 flex items-baseline justify-between">
        <h3 className="font-display text-lg font-medium text-fg-1">
          Recent dreams
        </h3>
        {q.data && (
          <span className="font-mono text-[10px] text-fg-3">
            {q.data.artifacts.length} artefacts ·{' '}
            {q.data.memoryPath ?? '—'}
          </span>
        )}
      </div>

      {q.isLoading && <p className="text-sm text-fg-3">Loading dreams…</p>}
      {q.error && (
        <p className="text-sm text-destructive">
          {(q.error as Error).message}
        </p>
      )}

      {q.data && q.data.artifacts.length === 0 && (
        <div className="rounded-md border border-dashed border-border bg-bg-base p-4 text-center text-xs text-fg-3">
          No dream artefacts yet — run a dream pass above to generate the
          first reflection.
        </div>
      )}

      {q.data && q.data.artifacts.length > 0 && (
        <ol className="space-y-2">
          {q.data.artifacts.map((a: DreamArtifact) => {
            const isOpen = expanded === a.file
            return (
              <li
                key={a.file}
                className="overflow-hidden rounded-md border border-border bg-bg-base"
              >
                <button
                  type="button"
                  onClick={() => setExpanded(isOpen ? null : a.file)}
                  className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-xs transition-colors hover:bg-bg-muted"
                >
                  <span className="font-display text-sm font-medium text-fg-1">
                    {a.date ?? a.file}
                  </span>
                  <span className="ml-auto font-mono text-[10px] text-fg-3">
                    {fmtBytes(a.sizeBytes)} · {fmtRel(a.mtime)}
                  </span>
                  <span aria-hidden className="text-fg-3">
                    {isOpen ? '−' : '+'}
                  </span>
                </button>
                {isOpen && (
                  <pre className="max-h-96 overflow-auto whitespace-pre-wrap border-t border-border bg-bg-base px-3 py-2 font-mono text-[11px] leading-relaxed text-fg-1">
                    {a.preview}
                  </pre>
                )}
              </li>
            )
          })}
        </ol>
      )}
    </section>
  )
}
