/**
 * Phase 116-UI redesign (2026-05) — Task Kanban board.
 *
 * "Trello with point of view." Key moves vs 116-03:
 *
 *  - Collapsed 6 columns to 4 desktop columns:
 *    Backlog · Running · Waiting · Done. The minor states (Scheduled,
 *    Failed, Cancelled, Orphaned, Timed-out) become inline indicators
 *    within the relevant main column — Failed lives inside Done with a
 *    destructive pill; Scheduled lives inside Backlog. This collapses
 *    cognitive load: the operator's mental model is "what's queued, what's
 *    moving, what's stuck, what's finished".
 *  - Filter chips header (agent multi-select / status / search). Counts
 *    on the right ("12 active · N done").
 *  - Card design overhaul:
 *    - Display-font title (target agent, since no title is stored
 *      server-side). Task type as subtitle.
 *    - Priority shown as a colored left-edge bar (NO data today; falls
 *      back to a fg-3 muted rail when priority is absent — wired for the
 *      future when KanbanRow gains a priority field).
 *    - Hover lifts the card (-translate-y-px + shadow).
 *    - Drag scales 1.02 + becomes semi-transparent + drop-shadow grows.
 *  - Column headers: larger weight, status dot, count subscript, dashed-
 *    primary border when a drag is hovering.
 *  - Empty-state for each column: not "empty" plain text.
 *  - Mobile: still grid-cols-1; each column stacks vertically. Touch
 *    drag works via dnd-kit PointerSensor.
 *  - New-task modal got its visual love (display font header, status
 *    landing pill, "lands in Backlog" preview).
 */
import { useMemo, useState } from 'react'
import {
  DndContext,
  useDraggable,
  useDroppable,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core'
import { useQueryClient } from '@tanstack/react-query'
import {
  useKanbanTasks,
  useAgents,
  usePlanningTasks,
  transitionTask,
  createTask,
  type KanbanRow,
  type KanbanColumns,
  type PlanningTask,
} from '@/hooks/useApi'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'

// Display columns (4) → which raw kanban columns they aggregate.
type DisplayColumn = 'Backlog' | 'Running' | 'Waiting' | 'Done'
const DISPLAY_COLUMNS: ReadonlyArray<DisplayColumn> = [
  'Backlog',
  'Running',
  'Waiting',
  'Done',
]
// 116-postdeploy 2026-05-12 — operators were confused by planning artefacts
// (PARTIAL/ACTIVE phases, quick tasks without SUMMARY) appearing under
// "Running" alongside actual live agent execution.
//
// 2026-05-12 (revision) — operator pushed back further ("nothing is
// actually in progress"). Planning metadata is now flattened to `pending`
// at the source (src/manager/planning-tasks.ts) so planning items live in
// Backlog only. The "In Progress" column is reserved for daemon-tracked
// live execution — today that's typically 0, which is the truth.
// The card subtitle still discloses the underlying phase state
// (Partial / Active / Backlog / Planned / Quick-drafted) within Backlog.
const DISPLAY_COLUMN_LABEL: Record<DisplayColumn, string> = {
  Backlog: 'Backlog',
  Running: 'In Progress',
  Waiting: 'Waiting',
  Done: 'Done',
}
const DISPLAY_COLUMN_SOURCES: Record<
  DisplayColumn,
  ReadonlyArray<keyof KanbanColumns>
> = {
  Backlog: ['Backlog', 'Scheduled'],
  Running: ['Running'],
  Waiting: ['Waiting'],
  Done: ['Done', 'Failed'],
}
const DISPLAY_COLUMN_TARGET_STATUS: Record<DisplayColumn, string> = {
  Backlog: 'pending',
  Running: 'running',
  Waiting: 'awaiting_input',
  Done: 'complete',
}

function relTime(ms: number): string {
  const d = Date.now() - ms
  if (d < 60_000) return `${Math.round(d / 1000)}s`
  if (d < 3_600_000) return `${Math.round(d / 60_000)}m`
  if (d < 86_400_000) return `${Math.round(d / 3_600_000)}h`
  return new Date(ms).toLocaleDateString()
}

function statusDotClass(col: DisplayColumn): string {
  // dash-redesign sweep — use the kit's `.mc-dot` tri-state semantics.
  // Running = ok+live (pulsing emerald); Waiting = warn (amber);
  // Done = idle (gray); Backlog = ok (calm emerald, no pulse).
  switch (col) {
    case 'Running':
      return 'mc-dot live ok'
    case 'Waiting':
      return 'mc-dot warn'
    case 'Done':
      return 'mc-dot idle'
    case 'Backlog':
    default:
      return 'mc-dot ok'
  }
}

// Phase 116-postdeploy 2026-05-12 — scope filter chip values.
//   - "all"      (default) interleaves planning tasks with daemon tasks.
//   - "agent"    hides planning rows; shows all daemon-task columns.
//   - "planning" hides daemon rows.
//   - "live"     ONLY daemon rows with status="running" (real agent
//     execution right now). Operator-asked drill-down: "what's actually
//     executing this second?" — strips planning chrome and queued/done
//     daemon tasks alike.
type ScopeFilter = 'all' | 'agent' | 'planning' | 'live'

export function TaskKanban() {
  const queryClient = useQueryClient()
  const kanbanQ = useKanbanTasks()
  const planningQ = usePlanningTasks()
  const [createOpen, setCreateOpen] = useState(false)
  const [transitionError, setTransitionError] = useState<string | null>(null)
  const [agentFilter, setAgentFilter] = useState<string>('')
  const [searchQ, setSearchQ] = useState<string>('')
  const [scope, setScope] = useState<ScopeFilter>('all')
  const [planningDetail, setPlanningDetail] = useState<PlanningTask | null>(
    null,
  )

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
  )

  async function handleDragEnd(evt: DragEndEvent) {
    const { active, over } = evt
    if (!over) return
    const taskId = String(active.id)
    const column = String(over.id) as DisplayColumn
    const status = DISPLAY_COLUMN_TARGET_STATUS[column]
    if (!status) return
    setTransitionError(null)
    try {
      await transitionTask(taskId, status)
      void queryClient.invalidateQueries({ queryKey: ['tasks-kanban'] })
    } catch (err) {
      setTransitionError(
        (err as Error).message + ' — reverting via refetch.',
      )
      void queryClient.invalidateQueries({ queryKey: ['tasks-kanban'] })
    }
  }

  // Build display columns by merging raw columns and applying filters.
  const displayed = useMemo(() => {
    const raw = kanbanQ.data?.columns
    if (!raw) return null
    const q = searchQ.trim().toLowerCase()
    const apply = (rows: readonly KanbanRow[]) =>
      rows.filter((r) => {
        if (agentFilter && r.target_agent !== agentFilter) return false
        if (q) {
          const blob = `${r.target_agent} ${r.task_type} ${r.task_id}`.toLowerCase()
          if (!blob.includes(q)) return false
        }
        return true
      })
    const out: Record<DisplayColumn, readonly KanbanRow[]> = {
      Backlog: [],
      Running: [],
      Waiting: [],
      Done: [],
    }
    for (const dc of DISPLAY_COLUMNS) {
      const merged: KanbanRow[] = []
      for (const src of DISPLAY_COLUMN_SOURCES[dc]) {
        merged.push(...(raw[src] ?? []))
      }
      out[dc] = apply(merged)
    }
    return out
  }, [kanbanQ.data, agentFilter, searchQ])

  // Available target_agent values for the filter
  const allAgents = useMemo(() => {
    const raw = kanbanQ.data?.columns
    if (!raw) return []
    const set = new Set<string>()
    for (const col of Object.values(raw)) {
      for (const row of col) set.add(row.target_agent)
    }
    return [...set].sort()
  }, [kanbanQ.data])

  // Phase 116-postdeploy 2026-05-12 — partition planning tasks into the
  // same display columns as daemon tasks. Filtered by `searchQ` so the
  // top-bar search bar continues to feel coherent across both sources.
  const planningTasks = planningQ.data?.tasks ?? []
  const planningByColumn = useMemo(() => {
    const q = searchQ.trim().toLowerCase()
    const match = (t: PlanningTask) => {
      if (!q) return true
      const blob =
        `${t.title} ${t.description ?? ''} ${t.tags.join(' ')}`.toLowerCase()
      return blob.includes(q)
    }
    const out: Record<DisplayColumn, PlanningTask[]> = {
      Backlog: [],
      Running: [],
      Waiting: [],
      Done: [],
    }
    for (const t of planningTasks) {
      if (!match(t)) continue
      if (t.status === 'pending') out.Backlog.push(t)
      else if (t.status === 'running') out.Running.push(t)
      else if (t.status === 'complete') out.Done.push(t)
      // failed planning tasks don't surface today
    }
    return out
  }, [planningTasks, searchQ])

  // 116-postdeploy 2026-05-12 (revision) — operator wanted honest count
  // labels after the "In Progress" column was reframed for live execution
  // only. Backlog = daemon-pending + ALL planning (PARTIAL/ACTIVE/BACKLOG/
  // PLANNED/drafted-quick now flow to pending). Running = daemon-only (the
  // column's whole point). Done = daemon-complete + recently-completed
  // quicks. Planning items still surface under "Backlog" with a subtitle.
  const totalBacklog = displayed
    ? displayed.Backlog.length + planningByColumn.Backlog.length
    : 0
  const totalRunning = displayed ? displayed.Running.length : 0
  const totalWaiting = displayed ? displayed.Waiting.length : 0
  const totalDone = displayed
    ? displayed.Done.length + planningByColumn.Done.length
    : 0

  return (
    <div className="mx-auto max-w-[1600px] px-7 py-6">
      {/* dash-redesign sweep — section-head pattern. Counts roll up
          into the .sub subtitle so the operator scans 'Tasks · N
          backlog · N running · N waiting · N done' on one row.
          New-task button stays right-anchored. */}
      <header className="mb-5">
        <div className="section-head mb-4">
          <div className="flex items-baseline gap-3">
            <h2>Tasks</h2>
            <span className="sub">
              {totalBacklog} backlog · {totalRunning} running ·{' '}
              {totalWaiting > 0 ? `${totalWaiting} waiting · ` : ''}
              {totalDone} done
            </span>
          </div>
          <Button
            size="sm"
            onClick={() => setCreateOpen(true)}
            className="font-medium"
          >
            <span className="mr-1.5" aria-hidden>
              +
            </span>
            New task
          </Button>
        </div>

        {/* Filter row */}
        <div className="flex flex-wrap items-center gap-2">
          <input
            type="search"
            value={searchQ}
            onChange={(e) => setSearchQ(e.target.value)}
            placeholder="Filter by id, agent, or type…"
            className="min-w-[200px] flex-1 rounded-md border border-border bg-bg-elevated px-3 py-1.5 text-sm text-fg-1 placeholder:text-fg-3 focus:border-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            aria-label="Filter tasks"
          />
          <select
            value={agentFilter}
            onChange={(e) => setAgentFilter(e.target.value)}
            className="rounded-md border border-border bg-bg-elevated px-2 py-1.5 text-sm text-fg-1"
            aria-label="Filter by target agent"
          >
            <option value="">Agent · any</option>
            {allAgents.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>
          {(searchQ || agentFilter || scope !== 'all') && (
            <button
              type="button"
              onClick={() => {
                setSearchQ('')
                setAgentFilter('')
                setScope('all')
              }}
              className="rounded-md px-2 py-1 text-xs text-fg-3 hover:text-fg-1"
            >
              Clear
            </button>
          )}
        </div>

        {/* 116-postdeploy 2026-05-12 — scope filter chips. "All" interleaves
            planning tasks with daemon tasks (default); "Agent tasks" hides
            planning rows; "Planning" hides daemon rows. */}
        <div
          className="mt-3 flex items-center gap-1"
          role="tablist"
          aria-label="Task source filter"
        >
          {([
            { id: 'all', label: 'All' },
            { id: 'agent', label: 'Agent tasks' },
            { id: 'planning', label: 'Planning' },
            { id: 'live', label: 'Live execution' },
          ] as ReadonlyArray<{ id: ScopeFilter; label: string }>).map((c) => (
            <button
              key={c.id}
              type="button"
              role="tab"
              aria-selected={scope === c.id}
              onClick={() => setScope(c.id)}
              className={
                'rounded-full px-3 py-1 font-mono text-[10px] uppercase tracking-wider transition-all ' +
                (scope === c.id
                  ? 'bg-primary/15 text-primary ring-1 ring-primary/30'
                  : 'text-fg-3 hover:bg-bg-elevated hover:text-fg-1')
              }
            >
              {c.label}
            </button>
          ))}
          <span className="ml-auto font-mono text-[10px] text-fg-3">
            {planningQ.data
              ? `${planningQ.data.sourceCount.phase} phases · ${planningQ.data.sourceCount.quick} quick · ${planningQ.data.sourceCount.todo} todos`
              : planningQ.isLoading
              ? 'loading planning…'
              : 'planning: offline'}
          </span>
        </div>
      </header>

      {transitionError && (
        <div className="mb-3 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-xs text-destructive">
          {transitionError}
        </div>
      )}

      {kanbanQ.isLoading && <KanbanSkeleton />}
      {kanbanQ.error && (
        <p className="text-sm text-destructive">
          {(kanbanQ.error as Error).message}
        </p>
      )}

      {displayed && (
        <DndContext sensors={sensors} onDragEnd={handleDragEnd}>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
            {DISPLAY_COLUMNS.map((name) => {
              // 116-postdeploy 2026-05-12 — "Live execution" filter: show
              // ONLY daemon rows in the Running column (truly-running agent
              // execution). Every other column renders empty so the
              // operator sees exactly what is executing this second.
              const daemonRows =
                scope === 'planning'
                  ? []
                  : scope === 'live'
                  ? name === 'Running'
                    ? displayed[name]
                    : []
                  : displayed[name]
              const planningRows =
                scope === 'agent' || scope === 'live'
                  ? []
                  : planningByColumn[name]
              return (
                <KanbanColumn
                  key={name}
                  name={name}
                  rows={daemonRows}
                  planningRows={planningRows}
                  onPlanningClick={(t) => setPlanningDetail(t)}
                />
              )
            })}
          </div>
        </DndContext>
      )}

      <CreateTaskModal
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={() => {
          void queryClient.invalidateQueries({ queryKey: ['tasks-kanban'] })
        }}
      />

      {/* 116-postdeploy 2026-05-12 — planning task detail modal. Read-only
          surface — operators manage these via the GSD CLI commands, not
          via dashboard drag-drop. */}
      <PlanningDetailDialog
        task={planningDetail}
        onClose={() => setPlanningDetail(null)}
      />
    </div>
  )
}

/* ====================================================================== */
/* COLUMN                                                                  */
/* ====================================================================== */

function KanbanColumn(props: {
  readonly name: DisplayColumn
  readonly rows: readonly KanbanRow[]
  // 116-postdeploy 2026-05-12 — planning tasks interleaved by column.
  readonly planningRows: readonly PlanningTask[]
  readonly onPlanningClick: (task: PlanningTask) => void
}) {
  const { name, rows, planningRows, onPlanningClick } = props
  const { setNodeRef, isOver } = useDroppable({ id: name })
  const totalCount = rows.length + planningRows.length
  return (
    <div
      ref={setNodeRef}
      className={
        'flex flex-col rounded-lg border bg-bg-elevated transition-all ' +
        (isOver
          ? 'border-primary border-dashed ring-2 ring-primary/20'
          : 'border-border')
      }
    >
      <header className="flex items-center justify-between border-b border-border px-3 py-2.5">
        <div className="flex items-center gap-2">
          <span className={statusDotClass(name)} aria-hidden />
          <h2 className="font-display text-sm font-medium uppercase tracking-wider text-fg-1">
            {DISPLAY_COLUMN_LABEL[name]}
          </h2>
          <span className="font-mono text-[10px] text-fg-3">{totalCount}</span>
          {planningRows.length > 0 && (
            <span
              className="font-mono text-[9px] text-fg-3"
              title={`${planningRows.length} planning ${
                planningRows.length === 1 ? 'task' : 'tasks'
              }`}
            >
              ({planningRows.length}p)
            </span>
          )}
        </div>
      </header>

      {/* 116-postdeploy 2026-05-12 — bump column gap from 2 (8px) to 3
          (12px). Operator screenshot of the Backlog column showed cards
          stacking too tight: the bottom of each card's wrapped title
          appeared to clip against the next card's top border. gap-2
          provided 8px of breathing room which was insufficient against
          the warn-bar accent + rounded corners. overflow-hidden stays on
          the cards themselves so the absolute-positioned accent bar
          (inset-y-0 left-0 w-1) doesn't bleed past the rounded edge. */}
      <div className="flex max-h-[70vh] flex-col gap-3 overflow-y-auto p-2">
        {totalCount === 0 ? (
          <EmptyColumn name={name} />
        ) : (
          <>
            {/* Planning cards first — they're the higher-signal "real
                workstream" surface. Daemon-task chains follow. */}
            {planningRows.map((t) => (
              <PlanningCard
                key={t.id}
                task={t}
                onClick={() => onPlanningClick(t)}
              />
            ))}
            {rows.map((row) => (
              <KanbanCard key={row.task_id} row={row} />
            ))}
          </>
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// 116-postdeploy 2026-05-12 — PlanningCard.
//
// Read-only surface (no draggable wrapper, no transition select). Border
// uses the `warn` token (vs daemon cards on the `primary` ladder) so the
// operator can scan the two streams apart at a glance. A small lock glyph
// emphasises that drag/drop is intentionally disabled.
// ---------------------------------------------------------------------------

function PlanningCard(props: {
  readonly task: PlanningTask
  readonly onClick: () => void
}) {
  const { task, onClick } = props
  const badgeLabel =
    task.source === 'phase'
      ? task.id.startsWith('phase:')
        ? `PHASE ${task.id.slice('phase:'.length)}`
        : 'PHASE'
      : task.source === 'todo'
      ? 'TODO'
      : task.id.startsWith('quick:')
      ? `QUICK ${task.id.slice('quick:'.length, 'quick:'.length + 10).toUpperCase()}`
      : 'QUICK'
  // 116-postdeploy 2026-05-12 — Title clipping fix.
  // Previously: `overflow-hidden` on the button + an absolute-positioned
  // accent <span> on the left edge. The overflow-hidden was needed to
  // clip the absolute accent to the rounded corner, but it ALSO clipped
  // multi-line titles (operator reported "Phase 999.5: ..." truncated
  // mid-character at the bottom). Replaced the absolute accent with a
  // native `border-l-4 border-warn/60` on the button itself — same
  // visual, no overflow concern, title wraps freely.
  return (
    <button
      type="button"
      onClick={onClick}
      className="group relative rounded-md border border-warn/40 border-l-4 !border-l-warn/60 bg-bg-base px-3 py-2.5 text-left text-xs transition-all hover:-translate-y-px hover:border-warn/60 hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      data-testid="planning-card"
      title="Planning artefact — read-only (manage via GSD commands)"
    >
      <div>
        <div className="mb-1 flex items-center gap-1.5">
          <span className="rounded-full bg-warn/15 px-1.5 py-0.5 font-mono text-[9px] font-medium uppercase tracking-wider text-warn">
            {badgeLabel}
          </span>
          <span
            aria-hidden
            className="font-mono text-[10px] text-fg-3"
            title="Read-only"
          >
            🔒
          </span>
          <span className="ml-auto font-mono text-[10px] text-fg-3">
            {task.tags.slice(0, 2).join(' · ')}
          </span>
        </div>
        <div className="mb-0.5 font-display text-sm font-medium text-fg-1">
          {task.title}
        </div>
        {/* 116-postdeploy 2026-05-12 — disclosure subtitle. Disambiguates
            planning "in-progress" (PARTIAL/ACTIVE phase, undrafted quick
            task) from real live agent execution. */}
        {task.subtitle && (
          <p className="mb-1 font-mono text-[10px] text-fg-3">
            {task.subtitle}
          </p>
        )}
        {task.description && (
          <p className="line-clamp-2 text-[11px] text-fg-2">
            {task.description}
          </p>
        )}
      </div>
    </button>
  )
}

// ---------------------------------------------------------------------------
// 116-postdeploy 2026-05-12 — Planning task detail dialog. Opens when a
// PlanningCard is clicked. Surfaces the file path so the operator can
// open the artefact in their editor; renders full description + tags.
// ---------------------------------------------------------------------------

function PlanningDetailDialog(props: {
  readonly task: PlanningTask | null
  readonly onClose: () => void
}) {
  const { task, onClose } = props
  return (
    <Dialog open={task !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        {task && (
          <>
            <DialogHeader>
              <DialogTitle className="font-display text-xl">
                {task.title}
              </DialogTitle>
              <DialogDescription className="text-fg-3">
                <span className="inline-flex items-center gap-1 rounded-full bg-warn/15 px-2 py-0.5 font-mono text-[10px] font-medium uppercase tracking-wider text-warn">
                  <span aria-hidden>🔒</span>
                  {task.source} · read-only
                </span>{' '}
                Manage via GSD commands;{' '}
                <code className="font-mono">.planning/</code> is the source of
                truth.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-3">
              {task.description && (
                <p className="text-sm leading-relaxed text-fg-1">
                  {task.description}
                </p>
              )}
              <dl className="space-y-1 text-xs">
                <div className="flex gap-2">
                  <dt className="text-fg-3">Status:</dt>
                  <dd className="font-mono text-fg-1">{task.status}</dd>
                </div>
                {task.filePath && (
                  <div className="flex gap-2">
                    <dt className="text-fg-3">File:</dt>
                    <dd className="break-all font-mono text-fg-1">
                      {task.filePath}
                    </dd>
                  </div>
                )}
                {task.createdAt && (
                  <div className="flex gap-2">
                    <dt className="text-fg-3">Created:</dt>
                    <dd className="font-mono text-fg-1">{task.createdAt}</dd>
                  </div>
                )}
                {task.tags.length > 0 && (
                  <div className="flex gap-2">
                    <dt className="text-fg-3">Tags:</dt>
                    <dd className="flex flex-wrap gap-1">
                      {task.tags.map((t) => (
                        <span
                          key={t}
                          className="rounded bg-bg-muted px-1.5 py-0.5 font-mono text-[10px] text-fg-2"
                        >
                          {t}
                        </span>
                      ))}
                    </dd>
                  </div>
                )}
              </dl>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={onClose}>
                Close
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}

function EmptyColumn(props: { readonly name: DisplayColumn }) {
  const messages: Record<DisplayColumn, string> = {
    Backlog: 'Backlog is empty — create a task',
    Running: 'Nothing in progress',
    Waiting: 'Nothing awaiting input',
    Done: 'No completed tasks yet',
  }
  return (
    <div className="flex h-32 items-center justify-center rounded-md border border-dashed border-border/60 px-3 text-center">
      <p className="text-xs text-fg-3">{messages[props.name]}</p>
    </div>
  )
}

/* ====================================================================== */
/* CARD                                                                    */
/* ====================================================================== */

function KanbanCard(props: { readonly row: KanbanRow }) {
  const { row } = props
  const queryClient = useQueryClient()
  const { attributes, listeners, setNodeRef, transform, isDragging } =
    useDraggable({ id: row.task_id })

  const style = transform
    ? {
        transform: `translate3d(${transform.x}px, ${transform.y}px, 0) scale(1.02)`,
      }
    : undefined

  // Status-derived priority rail color. Since the daemon doesn't expose
  // priority today, we encode urgency via the task's status: failed/errored
  // = danger; waiting (blocked) = warn; running = primary; otherwise muted.
  // When KanbanRow gains a `priority` field, swap to that.
  //
  // 116-postdeploy 2026-05-12 — paired border-l class for the rail.
  // Previously the rail was an absolute-positioned <span> inside an
  // `overflow-hidden` parent — see PlanningCard fix above for why we
  // moved the rail onto the card itself as border-l-4. Tailwind needs
  // literal classnames in source for tree-shaking, so we derive a
  // parallel `railBorderCls` alongside the bg variant.
  // `!` prefix forces `!important` on the left-border-color so it wins
  // deterministically over the cascade-later `border-{color}`
  // shorthand utilities (border-border / border-primary/60 / etc) that
  // otherwise paint left-border-color as part of all-sides. Without
  // the bang, the rail color would be clobbered on cards in the
  // non-dragging path.
  const railBorderCls =
    row.status === 'failed' ||
    row.status === 'timed_out' ||
    row.status === 'orphaned'
      ? '!border-l-destructive'
      : row.status === 'awaiting_input'
      ? '!border-l-warn'
      : row.status === 'running'
      ? '!border-l-primary'
      : '!border-l-fg-3/30'

  const statusPillCls =
    row.status === 'failed' ||
    row.status === 'timed_out' ||
    row.status === 'orphaned'
      ? 'bg-destructive/15 text-destructive'
      : row.status === 'awaiting_input'
      ? 'bg-warn/15 text-warn'
      : row.status === 'running'
      ? 'bg-primary/15 text-primary'
      : row.status === 'complete'
      ? 'bg-fg-3/15 text-fg-2'
      : 'bg-info/15 text-info'

  async function manualTransition(status: string) {
    try {
      await transitionTask(row.task_id, status)
      void queryClient.invalidateQueries({ queryKey: ['tasks-kanban'] })
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('transition failed', err)
    }
  }

  // 116-postdeploy 2026-05-12 — Title clipping fix (see PlanningCard
  // above for full root-cause analysis). Removed `overflow-hidden`
  // from the card; removed the absolute-positioned <span> rail;
  // attached `border-l-4 ${railBorderCls}` to the card itself. Visual
  // identity preserved (4px colored rail on the left), title wraps
  // freely without being clipped.
  return (
    <div
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      className={
        // We use `!`-important on the rail's left-border-color so it
        // wins over the cascade-later `border-{color}` shorthand
        // (which paints all four sides incl. left). This is the same
        // approach Tailwind itself uses for ring-* utilities that
        // need to beat border shorthands deterministically.
        'group relative cursor-grab rounded-md border border-l-4 bg-bg-base px-3 py-2.5 text-xs transition-all active:cursor-grabbing ' +
        (isDragging
          ? 'border-primary/60 opacity-70 shadow-lg '
          : 'border-border hover:-translate-y-px hover:border-primary/30 hover:shadow-md ') +
        railBorderCls
      }
    >
      <div>
        <div className="mb-1 flex items-center gap-1.5">
          <span
            className={
              'rounded-full px-1.5 py-0.5 font-mono text-[9px] font-medium uppercase tracking-wider ' +
              statusPillCls
            }
          >
            {row.status}
          </span>
          <span className="font-mono text-[10px] text-fg-3">
            {row.task_id.slice(0, 8)}
          </span>
          <span className="ml-auto font-mono text-[10px] text-fg-3">
            {relTime(row.started_at)}
          </span>
        </div>

        <div className="mb-0.5 font-display text-sm font-medium text-fg-1">
          {row.target_agent}
        </div>
        {row.task_type && (
          <div className="font-mono text-[10px] text-fg-3">{row.task_type}</div>
        )}
        {row.chain_token_cost > 0 && (
          <div className="mt-1 font-mono text-[10px] text-fg-3">
            {row.chain_token_cost.toLocaleString()} chain tokens
          </div>
        )}
        {row.error && (
          <div className="mt-1.5 rounded border border-destructive/30 bg-destructive/5 p-1.5 text-[10px] text-destructive">
            <span className="font-medium uppercase tracking-wider">err </span>
            {row.error.length > 100
              ? row.error.slice(0, 100) + '…'
              : row.error}
          </div>
        )}

        {/* Touch-friendly transition dropdown (hidden until hover on
            desktop; always visible on touch). dnd-kit's listeners are
            still attached but `onPointerDown` stopped at the select so
            it doesn't initiate a drag. */}
        <div
          className="mt-2 sm:opacity-0 sm:group-hover:opacity-100 sm:transition-opacity"
          onPointerDown={(e) => e.stopPropagation()}
        >
          <select
            className="w-full rounded border border-border bg-bg-elevated px-1.5 py-1 font-mono text-[10px] text-fg-2 hover:text-fg-1"
            onChange={(e) => {
              const v = e.target.value
              e.target.value = ''
              if (v) void manualTransition(v)
            }}
            defaultValue=""
            aria-label="Transition task status"
          >
            <option value="">→ move to…</option>
            <option value="running">running</option>
            <option value="awaiting_input">awaiting_input</option>
            <option value="complete">complete</option>
            <option value="failed">failed</option>
            <option value="cancelled">cancelled</option>
          </select>
        </div>
      </div>
    </div>
  )
}

function KanbanSkeleton() {
  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
      {[0, 1, 2, 3].map((i) => (
        <div
          key={i}
          className="rounded-lg border border-border bg-bg-elevated"
        >
          <div className="h-10 border-b border-border bg-bg-muted/40" />
          <div className="space-y-2 p-2">
            {[0, 1, 2].map((j) => (
              <div
                key={j}
                className="h-20 animate-pulse rounded-md border border-border bg-bg-base/60"
              />
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}

/* ====================================================================== */
/* CREATE TASK MODAL                                                       */
/* ====================================================================== */

function CreateTaskModal(props: {
  readonly open: boolean
  readonly onOpenChange: (open: boolean) => void
  readonly onCreated: () => void
}) {
  const { open, onOpenChange, onCreated } = props
  const agentsQ = useAgents()
  const agents = useMemo(() => {
    const payload = agentsQ.data as
      | { agents?: ReadonlyArray<{ name: string }> }
      | undefined
    return (payload?.agents ?? []).map((a) => a.name).sort()
  }, [agentsQ.data])

  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [targetAgent, setTargetAgent] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleCreate() {
    if (!title || !targetAgent) {
      setError('Title and target agent are required')
      return
    }
    setBusy(true)
    setError(null)
    try {
      await createTask({ title, description, target_agent: targetAgent })
      setTitle('')
      setDescription('')
      setTargetAgent('')
      onCreated()
      onOpenChange(false)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="font-display text-xl">New task</DialogTitle>
          <DialogDescription className="text-fg-3">
            Inject an operator-authored task. Lands in{' '}
            <span className="inline-flex items-center gap-1 rounded-full bg-info/15 px-2 py-0.5 font-mono text-[10px] font-medium uppercase tracking-wider text-info">
              <span className="h-1.5 w-1.5 rounded-full bg-info" />
              Backlog
            </span>{' '}
            as <code className="font-mono text-fg-2">status=pending</code>.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div>
            <label
              htmlFor="task-title"
              className="mb-1.5 block font-mono text-[10px] font-medium uppercase tracking-wider text-fg-3"
            >
              Title
            </label>
            <input
              id="task-title"
              className="w-full rounded-md border border-border bg-bg-base px-3 py-2 text-sm text-fg-1 placeholder:text-fg-3 focus:border-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Short headline"
            />
          </div>
          <div>
            <label
              htmlFor="task-target"
              className="mb-1.5 block font-mono text-[10px] font-medium uppercase tracking-wider text-fg-3"
            >
              Target agent
            </label>
            <select
              id="task-target"
              className="w-full rounded-md border border-border bg-bg-base px-3 py-2 text-sm text-fg-1 focus:border-primary focus:outline-none"
              value={targetAgent}
              onChange={(e) => setTargetAgent(e.target.value)}
            >
              <option value="">— select —</option>
              {agents.map((a) => (
                <option key={a} value={a}>
                  {a}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label
              htmlFor="task-description"
              className="mb-1.5 block font-mono text-[10px] font-medium uppercase tracking-wider text-fg-3"
            >
              Description
            </label>
            <textarea
              id="task-description"
              className="h-24 w-full resize-none rounded-md border border-border bg-bg-base px-3 py-2 text-sm text-fg-1 placeholder:text-fg-3 focus:border-primary focus:outline-none"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="(optional) markdown body"
            />
          </div>
          {error && (
            <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-xs text-destructive">
              {error}
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={handleCreate} disabled={busy}>
            {busy ? 'Creating…' : 'Create task'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
