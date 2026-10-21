/**
 * Phase 145 WS2 (Plan 05) — daemon-side background workflow orchestrator
 * (the FAN-OUT half).
 *
 * Purpose (SC-2): a long multi-step / parallel workflow must NOT run inside a
 * single interactive turn. If it did, one of the four turn watchdogs would see
 * its wall-clock duration (180s no-useful-tokens, the 2/15-min pause ceilings,
 * the 20-min absolute turn-duration ceiling, and the ~5-min heartbeat
 * queue-lock sweep). Instead, the triggering agent turn calls `start_workflow`,
 * the daemon returns a `wf_…` id in seconds and the turn SETTLES — and the
 * orchestration runs here as a daemon background job. No turn spans the
 * workflow, so no watchdog ever applies to it.
 *
 * THIS PLAN (fan-out only):
 *   - `launchWorkflow(parentAgentName, spec)` allocates a workflow id
 *     SYNCHRONOUSLY and kicks the worker spawns off as an UN-AWAITED background
 *     job (fire-and-forget, rejection-safe). The caller (the daemon IPC
 *     handler) returns the id immediately — that fast return IS the SC-2
 *     turn-decoupling mechanism.
 *   - Each parallel step is spawned as a worker sub-session via the injected
 *     `startAgent` (the same `SessionManager.startAgent` model the
 *     subagent-thread-spawner and warm-worker-pool use). The worker config
 *     carries:
 *       • a LIFTED, large-finite `maxTurnDurationMs` ceiling
 *         ({@link WORKFLOW_WORKER_MAX_TURN_DURATION_MS}) so a worker is not
 *         killed at the 20-min default (Plan 01 declared the field, Plan 03
 *         threaded it into `createStreamStallTracker`);
 *       • the fleet `disallowedTools` union PLUS both recursion guards
 *         (`spawn_subagent_thread` AND `start_workflow`) so a worker can never
 *         spawn further subagents or launch nested workflows (T-145-14);
 *       • `heartbeat.enabled: false` + the subagent memory-leak guards (via
 *         {@link buildSubagentOverrides}) so the heartbeat sweep — one of the
 *         four watchdogs — never fires on a worker.
 *   - A worker thread-binding is created at spawn. This is the
 *     reaper-SURVIVAL SUBSTRATE: the idle subagent-session-reaper
 *     (`subagent-session-reaper.ts`) reaps a `running` subagent-named session
 *     when EITHER its binding is missing (orphan) OR its `binding.lastActivity`
 *     is older than `idleTimeoutMinutes`. So the orchestrator must (a) create a
 *     binding so the worker is not orphan-reaped, and (b) refresh
 *     `lastActivity` on progress so an active-but-quiet worker is not idle-reaped
 *     (Plan 03 pinned this contract). `refreshWorkerActivity` is the
 *     progress-tick entry point Plan 06 calls.
 *
 * DEFERRED TO PLAN 06 (the fan-in half — left as seams here):
 *   - Driving each worker's step turn (the spawn here yields a started, idle
 *     session; the per-step `prompt` is baked into the worker's `soul` so
 *     whoever fires the turn has it).
 *   - The barrier: collecting each worker's final result via the existing relay
 *     mechanism — `relayAndMarkCompletedByThreadId` (driven by
 *     `subagent-completion-sweep.ts`), keyed by the worker binding's threadId.
 *   - Progress + final posting to the triggering agent's channel.
 *   The per-workflow state map ({@link WorkflowState}) is addressable by id so
 *   Plan 06's barrier + progress tick can find each worker.
 *
 * EVERYTHING is dependency-injected so the unit tests run with no real
 * sessions / registry / Discord (mirrors `warm-worker-pool.ts`).
 */

import type { Logger } from "pino";
import type { ResolvedAgentConfig } from "../shared/types.js";
import { buildSubagentOverrides } from "../discord/subagent-config-overrides.js";
import { splitMessage } from "../messaging/split.js";
// Finding 2 (260714-mkq review) — format BEFORE splitting. The bound-channel
// post path (daemon sendText) applies formatOutboundText per message AFTER our
// split; table re-render / em-dash replacement expanded raw 1900-char chunks
// to 2100-3074 chars → Discord 50035 → chunk silently dropped. Formatting here
// first is safe because formatOutboundText is documented idempotent
// (markdown-table-wrap.ts) — the second application downstream is a no-op.
// Import direction matches the existing manager→discord dependency
// (buildSubagentOverrides above); markdown-table-wrap has no manager imports,
// so no cycle.
import { formatOutboundText } from "../discord/markdown-table-wrap.js";
import { buildDeterministicSummary } from "./workflow-summary/deterministic-summary.js";
import {
  REPORT_STEP_ID,
  buildAuthoredReportPrompt,
} from "./workflow-summary/authored-report.js";
import {
  VERIFY_STEP_ID,
  buildVerifyFiguresPrompt,
  extractLedgerBlock,
  hasFigures,
  type FigureLedger,
} from "./workflow-summary/verify-figures.js";
import {
  RUN_RECORD_FILE,
  runRecordJson,
  type PreviousRun,
  type WorkflowOrigin,
} from "./workflow-summary/previous-run.js";
export type { WorkflowOrigin } from "./workflow-summary/previous-run.js";
import {
  looksLikeMetaSummary,
  pickBetterResult,
  CORRECTIVE_PROMPT,
  STEP_DELIVERY_CONTRACT,
} from "./workflow-summary/result-quality.js";
import {
  buildWorkflowReports,
  type ReportAttachment,
  type WorkflowReportDeps,
} from "./workflow-summary/workflow-reports.js";
import {
  WorkflowAdmissionGate,
  WorkerAdmissionError,
} from "./workflow-admission-gate.js";
// INC-2026-07-26 — the no-masquerade guard's message prefix, single-sourced so
// the step-retry classifier below and the guard that throws it cannot drift.
// Same-directory import; persistent-session-handle has no orchestrator import,
// so no cycle.
import { STREAM_STALL_MASQUERADE_PREFIX } from "./persistent-session-handle.js";
// Phase 999.165 — live status: activity labels + ETA.
import {
  MAX_STEP_RESTARTS,
  estimateWorkflowEta,
  summarizeToolUse,
  type EtaEstimate,
  type StepViewStatus,
} from "./workflow-status.js";
import { renderProgressPing } from "./workflow-status-render.js";
import { icons } from "../discord/icons.js";

/** Resolved concurrency / memory bounds for workflow-worker admission. */
export interface WorkflowLimits {
  /** Global cap on concurrently-RESIDENT workers across all workflows. */
  readonly maxConcurrentWorkers: number;
  /** Pause admitting new workers when cgroup memory ≥ this percent (0–100). */
  readonly memoryHighWatermarkPercent: number;
  /** Fail a step if it cannot be admitted within this many ms. */
  readonly admissionTimeoutMs: number;
  /**
   * INC-2026-08-10 — how a completed workflow is posted to the bound channel.
   * `summary` (default) posts ONE consolidated message; `inline` restores the
   * pre-incident concatenate-every-worker-result behavior as an operator
   * rollback. Optional so existing test doubles keep compiling.
   */
  readonly outputMode?: "summary" | "inline";
  /**
   * 999.106 QW-2 (worker diet) — fleet ceiling of MCP server names a worker
   * keeps (`defaults.workflow.worker.mcpServers`). `undefined` = inherit the
   * parent's full roster (pre-QW-2 behavior). Per-step `mcpServers` narrows
   * further within this ceiling.
   */
  readonly workerMcpAllowlist?: readonly string[];
}

/**
 * The lifted absolute turn-duration ceiling for a workflow worker (4 hours).
 *
 * The whole current fleet resolves `maxTurnDurationMs` to exactly the 20-min
 * default (`1_200_000`) — so a worker MUST get a strictly-larger value or a
 * >20-min workflow step trips the ceiling with no error (the SC-2 silent
 * failure). 4h is comfortably above any realistic single-step duration while
 * staying inside the Plan-01 zod envelope (min 20 min, max 8h = 28_800_000)
 * and FINITE — `createStreamStallTracker` throws on `0` / `Infinity`, so the
 * ceiling is LIFTED, never disabled. Activity-based stall detection
 * (no-useful-tokens / max-pause) stays armed underneath, so a genuinely hung
 * worker still aborts well before 4h (Plan 03 verified this).
 */
export const WORKFLOW_WORKER_MAX_TURN_DURATION_MS = 4 * 60 * 60_000;

/**
 * DoS cap on the number of parallel worker spawns per workflow (T-145-14).
 * A spec exceeding this is rejected FAST (before any worker spawns) so a
 * malformed / hostile spec cannot fan out unbounded sessions.
 *
 * 999.106 W-2: with waved execution this is the PER-WAVE cap — it preserves
 * the original fan-out bound (≤8 queued per parallel group) while
 * {@link MAX_WORKFLOW_TOTAL_STEPS} bounds the workflow's lifetime total.
 */
export const MAX_WORKFLOW_PARALLEL_STEPS = 8;

/**
 * 999.106 W-2 — total step budget across ALL waves. Peak residency is bounded
 * by the admission cap regardless of this number (only one wave is in flight
 * and teardown is synchronous per step), so the total cap bounds workflow
 * LIFETIME, not memory: 24 steps of work at a 3-worker residency ceiling.
 * The 4h05 {@link WORKFLOW_WALL_CLOCK_MS} from launch stays the hard time
 * ceiling — 24 steps never implies an unbounded run.
 */
export const MAX_WORKFLOW_TOTAL_STEPS = 24;

/** 999.106 W-2 — cap on the number of ordered waves per workflow. */
export const MAX_WORKFLOW_WAVES = 6;

/**
 * 999.106 W-2 — per-worker in-heap retention cap applied at each wave
 * boundary. After a wave's barrier the settled workers' `result`/`prompt`
 * strings are truncated to this length in heap — the FULL text is already on
 * disk (`resultFile`, written at settle) and downstream readers (the
 * final-report sources, the report PDFs) re-read it from disk via
 * `readWorkflowArtifact`, falling back to this in-heap prefix. 16k keeps the
 * fallback ABOVE the report builder's 14k per-source cap, so even the
 * no-disk-reader degraded path loses nothing the synthesis would have used.
 */
export const RESULT_HEAP_CAP = 16_000;

/**
 * Plan 06 — how often a running workflow posts a progress ping to the
 * triggering agent's bound channel (~6 min). Reaper-survival
 * (`refreshWorkerBinding`) happens on EVERY 60s sweep tick regardless; the
 * progress PING is throttled to this interval so a long workflow does not
 * spam the channel.
 */
export const WORKFLOW_PROGRESS_INTERVAL_MS = 6 * 60_000;

/**
 * Stall-recovery idle bound. If a RUNNING workflow makes no forward progress
 * (no worker settles to done/failed) for this long while workers are still
 * running, the 60s sweep aborts the wedged workers so the `allSettled` barrier
 * proceeds with PARTIAL results — instead of hanging on a stuck worker until
 * the 4h `WORKFLOW_WALL_CLOCK_MS` last resort (the failure the operator hit:
 * verify/synthesis workers stuck 13+ min, no completion, agent had to bail by
 * hand).
 *
 * BLUNT by design (advisor note): a completion-based idle bound cannot tell
 * "long but working" from "wedged", so it is set generously — a lone worker
 * that legitimately runs longer than this with NO sibling completing would be
 * aborted, and the per-worker wall-clock stays the absolute backstop.
 *
 * 15 → 45 min (INC-2026-07-26): a legitimate 31-min research step
 * (wf_Or0mdk's NAvLU3 worker) finished ~18 seconds before this bound's
 * 15-min idle-abort would have fired — the workflow's other steps had all
 * settled by 08:35:58 and the sweep would have killed the healthy last
 * worker at the next tick past 08:50:58. With the evidence-anchored
 * max-pause window (stream-stall-tracker, same incident), a genuinely
 * wedged worker is now aborted BY ITS OWN TRACKER within ~15 min of losing
 * tool-progress evidence — which settles the step and advances
 * `lastWorkerProgressAt` — so this workflow-level bound is no longer the
 * primary wedge detector. It remains the backstop for hangs OUTSIDE the
 * turn machinery (e.g. a dispatch that never starts a turn), sized above
 * any observed legitimate single-step duration and well below the 4h
 * per-worker wall clock.
 */
export const WORKFLOW_STALL_MS = 45 * 60_000;

/**
 * Per-step attempt budget (INC-2026-07-26): the first run plus ONE bounded
 * retry for RETRYABLE failures — a stall-abort (`stream-stall abort
 * masqueraded as a result message`, the exact signature the CHANNEL path
 * already auto-recovers via wedge-recovery re-run, but which the workflow
 * path previously recorded as a terminal step loss) or an admission timeout
 * (in the incident the starved cohort's slots freed ~62s after their
 * deadlines — one re-entry through the gate would have rescued all ten
 * steps). The retry re-enters the normal `gate.acquire()` path, so the
 * residency bound is preserved, and it is skipped once the workflow-level
 * stall recovery has fired or the workflow has exceeded its wall clock —
 * a retry must never extend a zombie workflow.
 */
export const MAX_STEP_ATTEMPTS = 2;

/**
 * Plan 06 — the orchestrator's per-worker hard wall-clock backstop (T-145-17).
 * Passed as an `AbortSignal` deadline to `dispatchTurn`, so a wedged worker is
 * killed and the barrier proceeds even if the in-turn stall detection / the
 * lifted `maxTurnDurationMs` ceiling somehow never fire. Set just ABOVE the
 * worker turn ceiling so the in-turn machinery aborts FIRST in the normal case
 * and this is purely the last-resort kill (defense in depth, not the primary
 * bound).
 */
export const WORKFLOW_WALL_CLOCK_MS = WORKFLOW_WORKER_MAX_TURN_DURATION_MS + 5 * 60_000;

/**
 * 999.106 QW-1 — dedicated deadline for the reserved `final-report` synthesis
 * step. It is a bounded EDITING turn over already-collected results (no
 * research, no tools beyond writing), so it must not inherit the 4h research
 * wall clock: by the time it runs, the barrier has passed and the workflow's
 * single-fire stall recovery has typically been spent, leaving the ~45-min
 * completion-based sweep as the only bound above it. A wedged report step
 * fails fast to the deterministic-summary fallback instead.
 */
export const REPORT_STEP_MAX_MS = 10 * 60_000;

/**
 * 999.106 QW-1 — how long a TERMINAL (done/failed) workflow stays in the
 * in-memory `workflows` map before the 60s sweep evicts it. Before this,
 * terminal workflows were NEVER evicted — every step's full prompt + result
 * strings were retained for the daemon's lifetime (~1 MB/workflow; the
 * measured 1.66 GB daemon heap). 15 min sits safely past the 10-min
 * `listWorkflows` view filter, so `/clawcode-workflows` and the dashboard see
 * no behavior change. Results remain on disk (`workflows/<wfId>/`).
 */
export const WORKFLOW_TERMINAL_RETENTION_MS = 15 * 60_000;

/**
 * Per-message chunk ceiling for the finalize post (quick task 260714-mkq).
 * Discord's hard limit is 2000 chars; 1900 leaves margin for any surrounding
 * formatting the bridge adds. An aggregated finalize whose header+body exceeds
 * this is split via {@link splitMessage} and posted as sequential chunks —
 * before this, an oversized result failed the whole post with a
 * "Must be 2000 or fewer in length" Discord error and the result was dropped.
 */
/**
 * 999.149 — how much of the posted report the parent answer turn is shown.
 * The report is already in the channel; this is context for the ANSWER, and a
 * workflow report can run long enough to crowd out the agent's own memory.
 */
const WORKFLOW_ANSWER_CONTEXT_CHARS = 6_000;

export const FINALIZE_CHUNK_MAX_LENGTH = 1900;

/**
 * The new workflow tool's recursion-guard name (mcp__<server>__<tool>).
 *
 * EXPORTED (260714-mkq review Finding 3) so subagent-thread-spawner can union
 * the SAME constant into its channel-less subagent disallowedTools: a
 * subagent-thread session has `channels: []`, so a start_workflow it launches
 * consumes admission-gate slots while EVERY postToBoundChannel delivery
 * (progress, stall notice, final result) is dropped — a silent result black
 * hole. Blocking the tool at the SDK level for channel-less sessions is the
 * same guard this orchestrator already applies to its own workers below.
 */
export const WORKFLOW_TOOL_DISALLOW = "mcp__clawcode__start_workflow";
/** The existing subagent-spawn recursion guard (mirrors the spawner union). */
const SUBAGENT_SPAWN_DISALLOW = "mcp__clawcode__spawn_subagent_thread";

/** One unit of work in a workflow. */
export interface WorkflowStep {
  readonly stepId: string;
  readonly prompt: string;
  /**
   * 999.106 QW-2 (worker diet) — optional allowlist of MCP server NAMES this
   * step's worker keeps. Narrowing only: resolved against the parent roster in
   * {@link buildWorkflowWorkerConfig}, so a step can never grant itself a
   * server the parent lacks. `[]` = tool-free. Absent = defer to the fleet
   * ceiling, else inherit the parent's full roster.
   */
  readonly mcpServers?: readonly string[];
}

/**
 * Internal queue entry: a step plus its spec position (2026-07-27 review).
 * The artifact filename is namespaced by this index — stepIds are
 * model-supplied with no uniqueness constraint, and the sanitizer is a
 * many-to-one mapping ("fetch!" and "fetch?" both collapse to "fetch_"), so
 * an id-only filename let concurrent colliding steps silently overwrite each
 * other's result file. `<index>-<stem>.md` makes collisions structurally
 * impossible; a retry reuses the same entry, so it overwrites only itself.
 */
interface QueuedWorkflowStep extends WorkflowStep {
  readonly artifactIndex: number;
  /**
   * 999.106 W-2 review — dispatch-time context prepended to the TURN INPUT of
   * wave ≥2 steps (never stored on worker.prompt, so report provenance keeps
   * the clean instruction): the workflow id is minted AFTER the spec is
   * authored, so a later-wave prompt cannot name `workflows/<id>/` itself —
   * this preamble hands the worker the concrete result-file paths of every
   * settled earlier step.
   */
  readonly promptPreamble?: string;
}

/**
 * The workflow spec. Exactly ONE of the two shapes (999.106 W-2):
 *   - `steps` — the original single parallel group. Normalized to one wave;
 *     byte-compatible with every pre-W-2 caller.
 *   - `waves` — ordered waves of parallel groups. Waves run SEQUENTIALLY:
 *     wave K's `allSettled` barrier + synchronous per-step teardown completes
 *     before wave K+1's first `gate.acquire`, so peak residency stays bounded
 *     by the admission cap regardless of total step count. This expresses
 *     "gather ∥ → synthesize → gather more → report" without a DAG engine
 *     (rejected: dependency resolver + cycle detection + partial-failure
 *     propagation for a shape no real workflow has needed).
 */
export interface WorkflowSpec {
  readonly steps?: readonly WorkflowStep[];
  readonly waves?: readonly (readonly WorkflowStep[])[];
}

/**
 * 999.106 W-2 — normalize a spec to its wave form and enforce the three
 * caps. Throws (fail-fast, before any worker spawns) on: both/neither shape
 * present, an empty wave list, an empty wave, a wave over
 * {@link MAX_WORKFLOW_PARALLEL_STEPS}, more than {@link MAX_WORKFLOW_WAVES}
 * waves, or a total over {@link MAX_WORKFLOW_TOTAL_STEPS}. Exported so the
 * daemon IPC boundary and tests validate through the SAME code path the
 * orchestrator launches through (3rd enforcement point).
 */
export function normalizeWorkflowSpec(
  spec: WorkflowSpec,
): readonly (readonly WorkflowStep[])[] {
  const hasSteps = Array.isArray(spec.steps);
  const hasWaves = Array.isArray(spec.waves);
  if (hasSteps === hasWaves) {
    throw new Error(
      "Workflow spec must provide exactly one of `steps` or `waves`",
    );
  }
  const waves: readonly (readonly WorkflowStep[])[] = hasWaves
    ? spec.waves!
    : [spec.steps!];
  if (waves.length === 0) {
    throw new Error("Workflow spec has no waves");
  }
  if (waves.length > MAX_WORKFLOW_WAVES) {
    throw new Error(
      `Workflow spec exceeds the ${MAX_WORKFLOW_WAVES}-wave cap (${waves.length})`,
    );
  }
  let total = 0;
  for (const [waveIndex, wave] of waves.entries()) {
    if (wave.length === 0) {
      throw new Error(`Workflow wave ${waveIndex + 1} has no steps`);
    }
    if (wave.length > MAX_WORKFLOW_PARALLEL_STEPS) {
      throw new Error(
        `Workflow wave ${waveIndex + 1} exceeds the ` +
          `${MAX_WORKFLOW_PARALLEL_STEPS}-parallel-step cap (${wave.length})`,
      );
    }
    total += wave.length;
  }
  if (total > MAX_WORKFLOW_TOTAL_STEPS) {
    throw new Error(
      `Workflow spec exceeds the ${MAX_WORKFLOW_TOTAL_STEPS}-total-step cap (${total})`,
    );
  }
  return waves;
}

/** Per-worker tracked state inside a workflow. */
export interface WorkflowWorker {
  readonly stepId: string;
  readonly sessionName: string;
  /** Synthetic threadId for the worker binding (= sessionName; workers have no
   *  real Discord thread). Used by the reaper-survival refresh. */
  readonly threadId: string;
  /** The step prompt — driven into the worker as its turn input (Plan 06
   *  `dispatchTurn`); NOT baked into the worker soul (clean system/user split).
   *  MUTABLE (999.106 QW-1): cleared to "" at finalize to release heap — the
   *  synthesis prompt alone can re-embed up to 8×14k chars of sibling results. */
  prompt: string;
  status: "spawning" | "running" | "failed" | "done";
  /** Spec position of this step — namespaces the artifact filename so
   *  colliding stepIds cannot overwrite each other (2026-07-27 review). */
  artifactIndex?: number;
  /** The worker's final result string (set when status → "done"). Plan 06
   *  collects this DIRECTLY from `dispatchTurn`'s return — the relay/completedAt
   *  seam deadlocks a channel-less worker (no `lastDeliveryAt` stamp). */
  result?: string;
  /** Workspace-relative artifact path (`workflows/<wfId>/<step>.md`) the
   *  result was persisted to, when the disk write succeeded (2026-07-27:
   *  results previously lived ONLY in daemon memory and the chunked channel
   *  post; an agent doing follow-up work had to scrape its own channel).
   *  Absent on failed steps or if the best-effort write failed. After
   *  finalize this is the ONLY route to the full result — the in-heap
   *  `result` string is released (999.106 QW-1). */
  resultFile?: string;
  /** The failure reason (set when status → "failed": spawn error, turn
   *  rejection, or the wall-clock abort). Surfaced in the final summary. */
  error?: string;
  /** When the step's turn was dispatched, and when it settled. Recorded so the
   *  report documents can show per-step timing - the orchestrator otherwise
   *  keeps timing only at the workflow level. Both absent on a worker that
   *  never got as far as a turn. */
  startedAt?: number;
  settledAt?: number;
  /** The per-worker AbortController, set while the turn runs in driveWorker and
   *  cleared in its finally. Stored on the worker so `sweepWorkflows` can abort
   *  a WEDGED worker for stall recovery without waiting out the 4h wall-clock. */
  controller?: AbortController;
  /** Phase 999.165 — set BEFORE `controller.abort()` when an operator or agent
   *  cancels this step (or its workflow). `attemptStep` reads it to report the
   *  step as cancelled and never retry it. */
  cancelRequested?: WorkflowControlMark;
  /** Phase 999.165 — the 1-based wave this worker ran in. */
  wave?: number;
  /** Phase 999.165 — the worker's latest tool call as a secret-safe label
   *  (`summarizeToolUse`), for the live status view and the progress ping. */
  activity?: { readonly label: string; readonly at: number };
  /** Phase 999.165 — tool calls made so far in this step's turn. */
  toolCalls?: number;
  /** Phase 999.165 — set BEFORE `controller.abort()` when a steer/edit restarts
   *  this step: `attemptStep` re-runs it with the new prompt (not a retry). */
  restartRequested?: {
    readonly mark: WorkflowControlMark;
    readonly guidance?: string;
    readonly prompt?: string;
  };
  /** Phase 999.165 — steers applied to this step, newest last. */
  steers?: { readonly text: string; readonly by: string; readonly at: number; readonly how: "injected" | "restart" | "amended" }[];
}

/**
 * Phase 999.165 — who stopped (or steered) a workflow or one of its steps, and
 * why. Recorded BEFORE any abort fires, so outcome decisions read this flag and
 * never the abort's error text (the real session handle's abort message is not
 * part of any contract).
 */
export interface WorkflowControlMark {
  readonly by: string;
  readonly reason?: string;
  readonly at: number;
}

/** Phase 999.165 — outcome of a cancel request (wire-safe). */
export type WorkflowCancelResult =
  | { readonly status: "cancelled"; readonly done: number; readonly stopped: number; readonly skipped: number }
  | { readonly status: "step-stopped"; readonly stepId: string }
  | { readonly status: "step-will-skip"; readonly stepId: string }
  | { readonly status: "step-already-finished"; readonly stepId: string; readonly stepStatus: string }
  | { readonly status: "step-not-found"; readonly stepId: string }
  | { readonly status: "already-cancelled"; readonly by: string }
  | { readonly status: "already-finished"; readonly workflowStatus: WorkflowState["status"] }
  | { readonly status: "not-found" };

/** Per-workflow tracked state, addressable by workflow id. */
export interface WorkflowState {
  readonly workflowId: string;
  readonly parentAgentName: string;
  readonly createdAt: number;
  status: "fanning-out" | "running" | "failed" | "done";
  readonly workers: WorkflowWorker[];
  /** Last time a progress ping was posted (throttle key for the 60s sweep). */
  lastProgressAt: number;
  /** Last time any worker SETTLED (done/failed) — the forward-progress marker
   *  the stall detector reads. Initialised to `createdAt` so a workflow whose
   *  workers never settle is still caught WORKFLOW_STALL_MS after launch. */
  lastWorkerProgressAt: number;
  /** Set once stall-recovery has aborted the wedged workers, so the 60s sweep
   *  does not re-abort every tick while the aborted workers drain. */
  stallAborted?: boolean;
  /**
   * INC-2026-07-26 review — aborts gate waiters (queued acquires) when stall
   * recovery fires. A retry or unstarted step waiting in the fleet-wide FIFO
   * has NO worker record and NO controller, so the sweep's running-worker
   * abort cannot reach it; without this, a waiter admitted minutes after
   * "proceeding with partial results" would spawn a fresh worker into the
   * stall-recovered workflow with zero remaining workflow-level protection
   * (stallAborted is single-fire) — extending finalize by up to the 4h
   * per-worker wall clock.
   */
  readonly admissionAbort: AbortController;
  /** When the workflow went terminal (999.106 QW-1) — set in `finalizeWorkflow`
   *  and in the launch job's catch, read by the sweep's terminal eviction. A
   *  terminal workflow with no stamp cannot be evicted, so BOTH terminal
   *  transitions stamp it. */
  finishedAt?: number;
  /** 999.106 W-2 review — planned totals from the normalized spec, so the
   *  progress ping / listWorkflows report against the WHOLE workflow instead
   *  of only spawned-so-far workers (between waves the old denominator read
   *  "N/N done, 0 in progress" — indistinguishable from a wedged finalize). */
  /** Mutable since 999.165: edit_workflow can add steps and waves. */
  totalPlannedSteps: number;
  totalWaves: number;
  /** 1-based wave currently executing (0 before the first wave starts). */
  currentWave: number;
  /** Phase 999.129 — template launch origin; recurring runs compare with the previous one. */
  readonly origin?: WorkflowOrigin;
  /** Phase 999.129 — the previous run found at synthesis time (read again at finalize). */
  previousRun?: PreviousRun | null;
  /** Phase 999.165 — set when the whole workflow was cancelled. Cancel reuses
   *  stall recovery's gates (`stallAborted` + `admissionAbort`), so this marker
   *  only changes wording: skip reasons, notices and the final summary. */
  cancelled?: WorkflowControlMark;
  /** Phase 999.165 — steps cancelled before they started; skipped at admission. */
  cancelledSteps?: Map<string, WorkflowControlMark>;
  /** Phase 999.165 — every step id in the plan, so a cancel can tell "pending"
   *  from "no such step". */
  readonly plannedStepIds: Set<string>;
  /** Phase 999.165 — the plan in order, with each step's 1-based wave, so the
   *  status view can show queued steps that have no worker record yet. */
  readonly planSteps: { readonly stepId: string; readonly wave: number }[];
  /** Phase 999.165 — the live plan. The wave loop reads it by index, so steps
   *  and waves added by edit_workflow before a wave starts run with it. */
  readonly waves: WorkflowStep[][];
  /** Phase 999.165 — the running wave's step queue while its runners are
   *  active (edit_workflow add_step "current" pushes here), and its preamble. */
  liveQueue?: QueuedWorkflowStep[];
  livePreamble?: string;
  /** Runners still pulling from `liveQueue`; decremented in the same
   *  synchronous block where a runner finds the queue empty. */
  activeRunners: number;
  /** Next free artifact index, so `NN-<step>.md` stays unique with added steps. */
  artifactCursor: number;
  /** Phase 999.165 — edits for steps that have not started, applied (and
   *  consumed) when the step spawns. */
  stepEdits?: Map<string, { prompt?: string; steers: { readonly text: string; readonly by: string }[] }>;
  /** Phase 999.165 — steer/edit restarts per step (capped). */
  stepRestarts?: Map<string, number>;
}

/** Phase 999.165 — outcome of a steer (wire-safe). */
export type WorkflowSteerResult =
  | {
      readonly status: "steered";
      /** Guidance delivered into the step's running turn. */
      readonly injected: readonly string[];
      /** Restarted with the guidance appended (injection not possible, or asked for). */
      readonly restarted: readonly string[];
      /** Not started yet: the guidance rides its prompt when it starts. */
      readonly amended: readonly string[];
      /** Already restarted the maximum number of times — left as is. */
      readonly limited: readonly string[];
    }
  | { readonly status: "nothing-to-steer" }
  | { readonly status: "empty-guidance" }
  | Extract<
      WorkflowCancelResult,
      { readonly status: "step-already-finished" | "step-not-found" | "already-cancelled" | "already-finished" | "not-found" }
    >;

/** Phase 999.165 — one edit to a running workflow. */
export type WorkflowEditOp =
  | { readonly kind: "replace_step"; readonly stepId: string; readonly prompt: string; readonly restart?: boolean }
  | {
      readonly kind: "add_step";
      readonly stepId: string;
      readonly prompt: string;
      readonly wave: "current" | "next" | "new";
      readonly mcpServers?: readonly string[];
    }
  | { readonly kind: "remove_step"; readonly stepId: string; readonly reason?: string };

/** Phase 999.165 — outcome of an edit (wire-safe). */
export type WorkflowEditResult =
  | { readonly status: "replaced"; readonly stepId: string; readonly restarted: boolean }
  | { readonly status: "step-running"; readonly stepId: string }
  | { readonly status: "restart-limit"; readonly stepId: string }
  | { readonly status: "added"; readonly stepId: string; readonly wave: number; readonly live: boolean }
  | { readonly status: "invalid"; readonly reason: string }
  | WorkflowCancelResult;

/** Phase 999.165 — one step in the live status view (wire-safe: no prompts). */
export interface WorkflowStepView {
  readonly stepId: string;
  readonly wave: number | null;
  readonly status: StepViewStatus;
  readonly startedAt?: number;
  readonly settledAt?: number;
  readonly elapsedMs?: number;
  readonly activity?: { readonly label: string; readonly agoMs: number };
  readonly toolCalls?: number;
  /** Why a step failed / was skipped / was cancelled (clipped). */
  readonly note?: string;
}

/** Phase 999.165 — the full live status of one workflow. */
export interface WorkflowDetail extends WorkflowSummary {
  readonly currentWave: number;
  readonly totalWaves: number;
  readonly steps: readonly WorkflowStepView[];
  readonly eta: EtaEstimate;
}

/** Compact, serialisable projection of a workflow for the `/clawcode-workflows`
 *  pull view (no AbortController / prompt strings — wire-safe). */
export interface WorkflowSummary {
  readonly workflowId: string;
  readonly parentAgentName: string;
  readonly status: WorkflowState["status"];
  readonly ageMs: number;
  readonly workers: {
    readonly total: number;
    readonly running: number;
    readonly done: number;
    readonly failed: number;
  };
  readonly lastProgressAt: number;
  /** Phase 999.165 — present when the workflow was cancelled. */
  readonly cancelled?: { readonly by: string; readonly reason?: string };
  /** 999.106 W-2 — whole-workflow planned step count (workers.total only
   *  counts spawned-so-far, which under-reports multi-wave runs for hours).
   *  Optional so pre-W-2 test doubles keep compiling; always set by
   *  listWorkflows. */
  readonly plannedSteps?: number;
  /** 999.106 W-2 — wave position, present only for multi-wave workflows. */
  readonly waves?: { readonly current: number; readonly total: number };
}

/**
 * All side-effects the orchestrator needs, injected so the unit tests run
 * synthetically and the daemon wires the real implementations at boot.
 */
export interface OrchestratorDeps {
  /**
   * Start a worker sub-session. Wraps `SessionManager.startAgent` in
   * production (the subagent-thread-spawner / warm-worker-pool model). Runs a
   * real session decoupled from the parent turn.
   */
  readonly startAgent: (
    name: string,
    config: ResolvedAgentConfig,
  ) => Promise<void>;
  /**
   * Stop a worker sub-session (production: `SessionManager.stopAgent`). Called
   * in `driveWorker`'s `finally` so the worker's in-process SDK session — and
   * its large retained conversation context — is freed from the daemon heap
   * BEFORE the admission slot is released. This makes the concurrency cap bound
   * RESIDENT sessions (peak memory), not merely active turns; the idle reaper
   * remains the orphan backstop.
   */
  readonly stopAgent: (name: string) => Promise<void>;
  /**
   * Register a per-worker LlmRuntime resolver BEFORE `startAgent` (the daemon
   * callback `SubagentThreadSpawner` / `WarmWorkerPool` use). Without this,
   * `startAgent` → `SdkSessionAdapter` `loadSdkModule()` calls
   * `getLlmRuntime(workerSessionName)` which throws for any name absent from
   * the boot-populated registry. MUST run before `startAgent`.
   */
  readonly registerLlmRuntime: (
    sessionName: string,
    workerConfig: ResolvedAgentConfig,
    parentAgentName: string,
    opts?: { firstTurnInput?: string; deferFirstTurn?: boolean },
  ) => void;
  /**
   * Create the worker's thread-binding (the reaper-survival substrate). In
   * production this is an atomic `mutateThreadRegistry(path, r => addBinding(r,
   * binding))` over `thread-bindings.json`, with the worker session name used
   * as a synthetic `threadId` (workers have no Discord thread; a non-snowflake
   * id is benign — the stale-binding sweep 404s + prunes it harmlessly).
   */
  readonly addWorkerBinding: (binding: {
    threadId: string;
    sessionName: string;
    agentName: string;
    lastActivity: number;
  }) => Promise<void>;
  /**
   * Refresh a worker binding's `lastActivity` (the reaper-survival contract).
   * Production: `mutateThreadRegistry(path, r => updateActivity(r, threadId,
   * ts))`. Plan 06's progress path drives this via `refreshWorkerActivity`.
   */
  readonly refreshWorkerBinding: (
    threadId: string,
    timestamp: number,
  ) => Promise<void>;
  /**
   * Remove a worker binding (own-creation → own-cleanup). Called when a worker
   * fails to spawn so the registry does not accumulate dead worker bindings.
   * Production: `mutateThreadRegistry(path, r => removeBinding(r, threadId))`.
   * Plan 06 calls this again on successful completion (after the barrier reads
   * the result).
   */
  readonly removeWorkerBinding: (threadId: string) => Promise<void>;
  /** Look up the triggering (parent) agent's resolved config. */
  readonly getParentConfig: (
    parentName: string,
  ) => ResolvedAgentConfig | undefined;
  /**
   * Drive a worker's turn and AWAIT its result (Plan 06). Production wraps
   * `SessionManager.dispatchTurn` — backend-agnostic (v2 SDK + v3, via
   * `handle.sendAndCollect`), needs no channel, and RETURNS the worker's final
   * response string. This is the worker turn-fire + result-collection in one:
   * `firstTurnInput` is v3/PTY-only (would leave a v2 worker idle) and the
   * relay/`completedAt` seam deadlocks a channel-less worker, so neither is
   * usable here. The optional `signal` is the wall-clock backstop.
   */
  readonly dispatchTurn: (
    sessionName: string,
    message: string,
    signal?: AbortSignal,
    /** Phase 999.165 — each tool call the worker makes (live status). */
    onToolUse?: (name: string, input?: unknown) => void,
  ) => Promise<string>;
  /**
   * Phase 999.165 — push a steer into a worker's RUNNING turn without
   * interrupting it. The daemon only injects on sessions built with the
   * attributed-stream demux (otherwise it declines and the orchestrator
   * restarts the step instead). Absent = always restart.
   */
  readonly injectMidTurn?: (
    sessionName: string,
    text: string,
  ) => { readonly injected: boolean; readonly reason?: string };
  /**
   * Post a progress ping / final result to the TRIGGERING agent's bound
   * channel. Production wraps the bridge send for the parent agent's channel
   * (the same surface the completion relay posts to). Best-effort; a post
   * failure must never wedge the workflow.
   */
  /**
   * 999.149 — dispatch ONE turn into the parent agent's own session so it
   * ANSWERS the operator, and post what it says. Optional: absent, fan-in
   * behaves exactly as before (report posted, agent silent).
   */
  readonly dispatchParentAnswer?: (agentName: string, prompt: string, workflowId: string) => Promise<boolean>;

  readonly postToBoundChannel: (
    parentAgentName: string,
    text: string,
  ) => Promise<void>;
  /**
   * Persist a workflow artifact under the PARENT agent's workspace
   * (2026-07-27 disk persistence). Production writes
   * `<parentWorkspace>/workflows/<workflowId>/<relativePath>` (mkdir -p,
   * containment-checked). Called on each step settle (result file) and at
   * finalize (summary.json) so results survive the daemon's 10-min terminal
   * prune and are consumable by the agent from DISK instead of channel
   * scraping. Best-effort at every call site — an fs failure must never
   * wedge the workflow.
   */
  /**
   * 999.109 review (CRITICAL) — register the worker's config with the
   * HeartbeatRunner so its `heartbeat.enabled: false` override is actually
   * LOAD-BEARING.
   *
   * `buildSubagentOverrides` sets `heartbeat.enabled: false` on every worker,
   * but the runner's per-agent gate reads its OWN `agentConfigs` map
   * (`agentConfig && agentConfig.heartbeat.enabled === false`). Workers were
   * never registered there, so the lookup returned undefined, the `&&`
   * short-circuited, and the ENTIRE heartbeat check loop ran against every
   * workflow worker — including the inbox check's own 5-minute
   * force-release watchdog (the same threshold as the stale-turn sweep) and
   * its inbox DRAIN, which pulls the PARENT's messages into the worker
   * session and marks them processed. `subagent-config-overrides.ts:26-37`
   * documents this exact trap; 999.57 paired the override with a
   * `setAgentConfigs` call for subagent THREADS and the pairing was never
   * made for workflow workers.
   *
   * Production: `heartbeatRunner.setAgentConfigs([workerConfig])` (an
   * additive upsert). Called AFTER `startAgent` so a tick that observes the
   * fresh session also sees the gate config. Optional so existing test
   * doubles keep compiling.
   */
  readonly registerHeartbeatConfig?: (config: ResolvedAgentConfig) => void;
  readonly persistWorkflowArtifact: (
    parentAgentName: string,
    workflowId: string,
    relativePath: string,
    content: string,
  ) => Promise<void>;
  /**
   * 999.106 W-2 — read back a persisted workflow artifact (the counterpart of
   * `persistWorkflowArtifact`, same containment check daemon-side). The wave
   * boundary caps each settled worker's in-heap `result` at
   * {@link RESULT_HEAP_CAP}; the final-report sources and the report PDFs
   * re-assemble FULL step text through this reader. Optional and best-effort:
   * absent (older test doubles) or throwing falls back to the in-heap capped
   * prefix — a disk failure degrades report fidelity, never the workflow.
   */
  readonly readWorkflowArtifact?: (
    parentAgentName: string,
    workflowId: string,
    relativePath: string,
  ) => Promise<string>;
  /**
   * Phase 999.129 — the most recent completed run of the same template +
   * params (from the persisted `run.json` records), or null. Absent = no
   * delta reporting.
   */
  readonly readPreviousRun?: (
    parentAgentName: string,
    origin: WorkflowOrigin,
    currentWorkflowId: string,
  ) => Promise<PreviousRun | null>;
  /**
   * INC-2026-08-10 - post the consolidated summary WITH the rendered report
   * PDFs in a single Discord message. Optional: when it is absent, or when it
   * throws (a bot missing ATTACH_FILES in the channel is a live failure mode on
   * this fleet), finalize falls back to the text-only post. Attachments are
   * always an enrichment, never the delivery.
   */
  readonly postFilesToBoundChannel?: (
    parentAgentName: string,
    text: string,
    files: readonly ReportAttachment[],
  ) => Promise<void>;
  /**
   * Report-rendering configuration (synthesis hook, browser driver, timeouts).
   * Absent means no PDFs are produced and the summary posts alone.
   */
  readonly reportDeps?: Omit<WorkflowReportDeps, "logger">;
  /**
   * Phase 999.123 — whether a parent agent's workflows run the reserved
   * `verify-figures` fact-check step before the final report. Resolved per
   * agent (live config). Absent = off for every agent.
   */
  readonly verifyFiguresFor?: (parentAgentName: string) => boolean;
  /**
   * Bound the agent's `workflows/` directory after a run persists into it.
   * Called best-effort at finalize - the moment a new directory appears - so
   * retention needs no new timer (a crash-looping cron has taken this fleet
   * down before). Optional: absent means artifacts accumulate, which is the
   * pre-existing behavior.
   */
  readonly pruneWorkflowArtifacts?: (parentAgentName: string) => Promise<void>;
  /** ID generator (nanoid in production; deterministic in tests). */
  readonly generateId: () => string;
  /** Clock (Date.now in production; injected in tests). */
  readonly now: () => number;
  /**
   * Live worker-admission bounds (read on each acquire so a config change takes
   * effect on the next workflow without reconstructing the orchestrator).
   */
  readonly getWorkflowLimits: () => WorkflowLimits;
  /**
   * Current cgroup memory percent (0–100), or `null` when unknown/unbounded
   * (dev / non-Linux / cgroup `max`) — the admission gate fails OPEN on null.
   * Production wraps `readCgroupMemoryStats()`.
   */
  readonly readMemoryPercent: () => Promise<number | null>;
  /** 999.106 G-2 — passed through to the admission gate (see
   *  AdmissionGateDeps.readPressure). Optional, fail-open. */
  readonly readPressure?: () => {
    readonly available: boolean;
    readonly cgFull10: number | null;
    readonly cgSome60: number | null;
  };
  /** 999.106 G-2 — passed through to the admission gate (see
   *  AdmissionGateDeps.getBalloonSignal). Optional, fail-open. */
  readonly getBalloonSignal?: () => {
    readonly anonBalloon: boolean;
    readonly balloonPid: number | null;
  } | null;
  /** 999.106 G-2 — live tighten thresholds for the admission gate. */
  readonly getGateTightenThresholds?: () => {
    readonly psiFull10: number;
    readonly psiSome60: number;
  };
  /**
   * Yielding sleep used by the admission gate's poll loop (production: real
   * setTimeout; injected in tests). Optional — defaults to a real timer.
   */
  readonly sleep?: (ms: number) => Promise<void>;
  readonly logger: Logger;
}

/**
 * Build a workflow-worker `ResolvedAgentConfig` from the triggering agent's
 * config. Mirrors `WarmWorkerPool.buildWorkerConfig` /
 * `SubagentThreadSpawner`'s `subagentConfig` recipe, with three workflow
 * specifics:
 *   1. LIFTED `maxTurnDurationMs` ({@link WORKFLOW_WORKER_MAX_TURN_DURATION_MS}).
 *   2. The `disallowedTools` union carries BOTH recursion guards.
 *   3. `buildSubagentOverrides` applies heartbeat-off + memory-leak guards so
 *      the heartbeat sweep (a watchdog) never fires on the worker.
 * The worker `soul` carries only a ROLE MARKER (system prompt); the step prompt
 * is driven into the worker as its TURN INPUT by the fan-in (Plan 06
 * `dispatchTurn`) — a clean system/user split, and the same prompt is never
 * carried in two places.
 */
export function buildWorkflowWorkerConfig(
  parentConfig: ResolvedAgentConfig,
  sessionName: string,
  opts?: {
    /** Fleet ceiling (`defaults.workflow.worker.mcpServers`). */
    readonly mcpAllowlist?: readonly string[];
    /** Per-step narrowing (start_workflow `steps[].mcpServers`). */
    readonly stepMcpServers?: readonly string[];
  },
): ResolvedAgentConfig {
  // Strip the delegation directive (workers never orchestrate further work).
  const { delegates: _stripDelegates, ...rest } =
    parentConfig as ResolvedAgentConfig & { delegates?: unknown };

  const workflowRole =
    `\n\n--- WORKFLOW WORKER ---\n` +
    `You are a workflow worker running a single step of a background workflow. ` +
    `Your task arrives as your next message — complete it and report your result as your reply.\n`;

  // 999.106 QW-2 (worker diet) — resolve the worker's MCP roster. The fleet
  // knob is a CEILING, the per-step list narrows WITHIN it (review finding,
  // 3× confirmed): a step list is AGENT-AUTHORED input via start_workflow, so
  // `step ?? ceiling` would let any workflow silently defeat an operator's
  // fleet cap by re-requesting its full roster. Resolution:
  //   both present  → step ∩ ceiling   (ceiling is a hard upper bound)
  //   step only     → step             (canary lever, no fleet policy set)
  //   ceiling only  → ceiling
  //   neither       → FULL INHERIT (undefined — pre-QW-2 behavior; a
  //                   config-less deploy changes nothing)
  // The result is then intersected with the PARENT roster (fail-closed both
  // ways, mirroring optimizer/agent-runner.ts): only servers listed AND
  // attached survive — a step can never grant itself a server the parent
  // lacks. `[]` ⇒ a tool-free worker. Measured 08-14: the full inherited
  // roster costs ~540MB of sidecars per worker.
  const ceiling = opts?.mcpAllowlist;
  const stepList = opts?.stepMcpServers;
  const requested =
    stepList !== undefined && ceiling !== undefined
      ? stepList.filter((name) => new Set(ceiling).has(name))
      : (stepList ?? ceiling);
  const mcpOverride =
    requested === undefined
      ? {}
      : {
          mcpServers: (parentConfig.mcpServers ?? []).filter((s) =>
            new Set(requested).has(s.name),
          ),
        };

  return {
    ...rest,
    // Subagent overrides win over the spread (heartbeat-off + memory-leak
    // guards). Applied first; the per-field overrides below take precedence
    // where they overlap (none do — the override slice does not touch name /
    // channels / disallowedTools / maxTurnDurationMs / soul / mcpServers).
    ...buildSubagentOverrides(parentConfig, parentConfig, false),
    // QW-2 diet filter — after the spreads so the scoped roster always wins
    // (verified: neither spread above sets mcpServers, but explicit ordering
    // beats relying on that).
    ...mcpOverride,
    name: sessionName,
    channels: [],
    schedules: [],
    slashCommands: [],
    soul: (parentConfig.soul ?? "") + workflowRole,
    // Keep the parent's Layer-1 tool blocklist AND forbid BOTH a nested
    // subagent spawn and a nested workflow launch. Merge + dedupe — overwriting
    // with only the guards would silently drop a locked-down parent's
    // disallowedTools on the worker (T-145-14).
    disallowedTools: [
      ...new Set([
        ...(parentConfig.disallowedTools ?? []),
        SUBAGENT_SPAWN_DISALLOW,
        WORKFLOW_TOOL_DISALLOW,
      ]),
    ],
    // The SC-2 heart: lift the absolute turn-duration ceiling for the worker
    // (Plan 03 reads this at createStreamStallTracker). Large + finite.
    maxTurnDurationMs: WORKFLOW_WORKER_MAX_TURN_DURATION_MS,
  } as ResolvedAgentConfig;
}

/**
 * 999.106 W-2 review — a truncation that actually releases memory. V8's
 * String.prototype.slice returns a SlicedString whose backing store is the
 * FULL parent string, so a naive `result.slice(0, cap)` keeps every settled
 * wave's multi-hundred-KB result heap-resident until finalize — defeating the
 * wave-boundary spill entirely. The Buffer round-trip forces a fresh flat
 * allocation that references nothing.
 */
function detachedSlice(text: string, cap: number): string {
  return Buffer.from(text.slice(0, cap), "utf8").toString("utf8");
}

/** Appended when a step PROMPT is heap-capped: unlike results, prompts have no
 *  disk copy, so the cut is permanent — the report provenance must show it. */
export const PROMPT_TRUNCATION_MARKER =
  "\n…[prompt truncated at the wave boundary — full text not retained]";

/**
 * Sanitize a model-supplied stepId into a safe artifact file stem
 * (2026-07-27 disk persistence). stepIds arrive through the start_workflow
 * MCP tool with only `.min(1)` validation — "../evil" or "a/b" are legal
 * inputs, and the stem lands in a filesystem path under the parent
 * workspace. Everything outside [A-Za-z0-9_-] collapses to "_"; empty
 * results fall back to "step". The daemon-side writer ALSO containment-
 * checks the resolved path (defense in depth) — this is the first layer.
 */
export function sanitizeStepFileName(stepId: string): string {
  const stem = stepId.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64);
  return stem.length > 0 ? stem : "step";
}

/**
 * Daemon-side background workflow orchestrator (fan-out half). Construct once at
 * daemon boot with real deps and share the instance with Plan 06's barrier +
 * progress tick.
 */
/** Phase 999.165 — cancel reasons are shown in Discord; keep them short. */
const CONTROL_REASON_MAX_CHARS = 200;

function controlMark(
  request: { readonly by: string; readonly reason?: string },
  at: number,
): WorkflowControlMark {
  const reason = request.reason?.trim().slice(0, CONTROL_REASON_MAX_CHARS);
  return { by: request.by, ...(reason ? { reason } : {}), at };
}

/** "by <who> (<why>)" — the one wording every cancel notice and record uses. */
function describeCancel(mark: WorkflowControlMark): string {
  return `by ${mark.by}${mark.reason ? ` (${mark.reason})` : ""}`;
}

function cancelledSkipReason(mark: WorkflowControlMark): string {
  return `skipped: workflow cancelled ${describeCancel(mark)}`;
}

function skippedCancelledWorker(
  step: { readonly stepId: string; readonly prompt: string },
  mark: WorkflowControlMark,
): WorkflowWorker {
  return {
    stepId: step.stepId,
    sessionName: "(not started)",
    threadId: "",
    prompt: step.prompt,
    status: "failed",
    error: `skipped: step cancelled ${describeCancel(mark)}`,
  };
}

/** Phase 999.165 — steer/edit limits. */
const STEER_MAX_CHARS = 1_500;
const STEP_PROMPT_MAX_CHARS = 20_000;
const STEP_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** Read through a call: `stallAborted` can flip while a worker is awaited, and
 *  TypeScript would otherwise keep a narrowing from before the await. */
function isStallAborted(state: WorkflowState): boolean {
  return state.stallAborted === true;
}

/** A steer appended to a step's instructions (pending step or restart). */
function appendSteer(prompt: string, guidance: string, by: string): string {
  return `${prompt}\n\n[Update from ${by} — follow this in addition to the instructions above]\n${guidance}`;
}

/** The message injected into a step's RUNNING turn. */
function steerInjectionText(guidance: string, by: string): string {
  return `[Workflow update from ${by} — apply this to the task you are working on now, then continue]\n${guidance}`;
}

/** Apply (and consume) edits queued for a step that is about to spawn. */
function consumeStepEdits<T extends { readonly stepId: string; readonly prompt: string }>(
  state: WorkflowState,
  step: T,
): T {
  const edits = state.stepEdits?.get(step.stepId);
  if (!edits) return step;
  state.stepEdits!.delete(step.stepId);
  let prompt = edits.prompt ?? step.prompt;
  for (const steer of edits.steers) prompt = appendSteer(prompt, steer.text, steer.by);
  return { ...step, prompt };
}

/** Phase 999.165 — the compact projection shared by the list and the detail view. */
function summarizeWorkflow(state: WorkflowState, now: number): WorkflowSummary {
  const countBy = (s: WorkflowWorker["status"]): number =>
    state.workers.filter((w) => w.status === s).length;
  return {
    workflowId: state.workflowId,
    parentAgentName: state.parentAgentName,
    status: state.status,
    ageMs: now - state.createdAt,
    workers: {
      total: state.workers.length,
      running: countBy("running"),
      done: countBy("done"),
      failed: countBy("failed"),
    },
    lastProgressAt: state.lastProgressAt,
    plannedSteps: state.totalPlannedSteps,
    ...(state.cancelled
      ? {
          cancelled: {
            by: state.cancelled.by,
            ...(state.cancelled.reason ? { reason: state.cancelled.reason } : {}),
          },
        }
      : {}),
    ...(state.totalWaves > 1
      ? { waves: { current: state.currentWave, total: state.totalWaves } }
      : {}),
  };
}

const STEP_NOTE_MAX_CHARS = 160;

function viewStatus(worker: WorkflowWorker): StepViewStatus {
  if (worker.status === "running" || worker.status === "spawning") return "running";
  if (worker.status === "done") return "done";
  const error = worker.error ?? "";
  if (worker.cancelRequested !== undefined || error.startsWith("cancelled ") || error.startsWith("skipped: step cancelled")) {
    return "cancelled";
  }
  if (error.startsWith("skipped:")) return "skipped";
  return "failed";
}

function stepView(
  stepId: string,
  wave: number | null,
  worker: WorkflowWorker | undefined,
  state: WorkflowState,
  now: number,
): WorkflowStepView {
  if (!worker) {
    const cancelMark = state.cancelledSteps?.get(stepId);
    return cancelMark
      ? { stepId, wave, status: "cancelled", note: `will be skipped — cancelled ${describeCancel(cancelMark)}` }
      : { stepId, wave, status: "queued" };
  }
  const status = viewStatus(worker);
  const elapsedMs =
    worker.startedAt !== undefined ? (worker.settledAt ?? now) - worker.startedAt : undefined;
  const note =
    status !== "running" && status !== "done" && worker.error
      ? worker.error.replace(/\s+/g, " ").slice(0, STEP_NOTE_MAX_CHARS)
      : undefined;
  return {
    stepId,
    wave,
    status,
    ...(worker.startedAt !== undefined ? { startedAt: worker.startedAt } : {}),
    ...(worker.settledAt !== undefined ? { settledAt: worker.settledAt } : {}),
    ...(elapsedMs !== undefined ? { elapsedMs } : {}),
    ...(status === "running" && worker.activity
      ? { activity: { label: worker.activity.label, agoMs: now - worker.activity.at } }
      : {}),
    ...(worker.toolCalls ? { toolCalls: worker.toolCalls } : {}),
    ...(note ? { note } : {}),
  };
}

export class WorkflowOrchestrator {
  private readonly deps: OrchestratorDeps;
  private readonly workflows = new Map<string, WorkflowState>();
  /** Tracks in-flight background fan-out jobs so tests (and a graceful
   *  shutdown) can await quiescence. Production never awaits this — the whole
   *  point is that launchWorkflow returns before the workers complete. */
  private readonly inflight = new Set<Promise<void>>();
  /**
   * Global worker-admission gate (concurrency cap + memory watermark). One
   * instance — the orchestrator is a daemon singleton — so the cap is shared
   * across ALL workflows, not per-workflow (the per-spec DoS cap is the
   * separate {@link MAX_WORKFLOW_PARALLEL_STEPS}).
   */
  private readonly gate: WorkflowAdmissionGate;

  constructor(deps: OrchestratorDeps) {
    this.deps = deps;
    this.gate = new WorkflowAdmissionGate({
      getMaxConcurrent: () => deps.getWorkflowLimits().maxConcurrentWorkers,
      getMemoryHighWatermarkPercent: () =>
        deps.getWorkflowLimits().memoryHighWatermarkPercent,
      getAdmissionTimeoutMs: () => deps.getWorkflowLimits().admissionTimeoutMs,
      readMemoryPercent: () => deps.readMemoryPercent(),
      // 999.106 G-2 — backpressure readers (all optional + fail-open).
      ...(deps.readPressure ? { readPressure: deps.readPressure } : {}),
      ...(deps.getBalloonSignal
        ? { getBalloonSignal: deps.getBalloonSignal }
        : {}),
      ...(deps.getGateTightenThresholds
        ? { getTightenThresholds: deps.getGateTightenThresholds }
        : {}),
      // The admission timeout is WALL-CLOCK (how long a step may wait for a
      // slot), independent of the orchestrator's logical `deps.now()` (which
      // tests freeze to drive the sweep). In production deps.now() IS Date.now,
      // so this is identical there; in tests it lets the gate time out for real
      // while the sweep clock stays frozen.
      now: () => Date.now(),
      sleep:
        deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
      logger: deps.logger,
    });
  }

  /**
   * Allocate a workflow id and kick off the worker fan-out as an UN-AWAITED
   * background job. Returns the id SYNCHRONOUSLY — the caller (daemon IPC
   * handler) returns it to the agent immediately, settling the triggering turn
   * in seconds (the SC-2 turn-decoupling mechanism).
   *
   * Validation that must FAIL FAST (before any worker spawns) is done
   * synchronously here: an unknown agent or an over-cap spec throws so the IPC
   * handler can return a clean `{ ok: false }` and no partial fan-out occurs.
   */
  launchWorkflow(
    parentAgentName: string,
    spec: WorkflowSpec,
    options: { readonly origin?: WorkflowOrigin } = {},
  ): string {
    const parentConfig = this.deps.getParentConfig(parentAgentName);
    if (!parentConfig) {
      throw new Error(`Unknown agent '${parentAgentName}'`);
    }
    // 999.106 W-2 — normalize `{steps}|{waves}` and enforce per-wave / total /
    // wave-count caps. Throws fail-fast (before any worker spawns), matching
    // the pre-W-2 contract the IPC handler's catch depends on.
    const waves = normalizeWorkflowSpec(spec);

    const workflowId = `wf_${this.deps.generateId()}`;
    const state: WorkflowState = {
      workflowId,
      parentAgentName,
      createdAt: this.deps.now(),
      status: "fanning-out",
      workers: [],
      lastProgressAt: this.deps.now(),
      lastWorkerProgressAt: this.deps.now(),
      admissionAbort: new AbortController(),
      totalPlannedSteps: waves.reduce((n, wave) => n + wave.length, 0),
      totalWaves: waves.length,
      currentWave: 0,
      plannedStepIds: new Set(waves.flat().map((step) => step.stepId)),
      planSteps: waves.flatMap((wave, i) => wave.map((step) => ({ stepId: step.stepId, wave: i + 1 }))),
      waves: waves.map((wave) => [...wave]),
      activeRunners: 0,
      artifactCursor: 0,
      ...(options.origin ? { origin: options.origin } : {}),
    };
    this.workflows.set(workflowId, state);

    // Fire-and-forget: the fan-out runs in the background, NOT awaited by the
    // caller. We defer its START to a microtask (`Promise.resolve().then(...)`)
    // so NOTHING — not even the synchronous prefix of a worker spawn
    // (registerLlmRuntime / the startAgent invocation) — runs on the calling
    // tick. The caller therefore returns the id with ZERO worker side-effects
    // observed, which is the cleanest expression of the SC-2 turn-decoupling
    // guarantee. The `.catch` is load-bearing — an un-awaited worker-spawn
    // rejection must never become an unhandled rejection that crashes the
    // daemon.
    const job = Promise.resolve()
      .then(() => this.runWorkflow(workflowId, parentAgentName, parentConfig, waves))
      .catch((err: unknown) => {
        state.status = "failed";
        // 999.106 QW-1 — stamp terminality here too, or a crashed run is
        // never evicted from the map.
        state.finishedAt = this.deps.now();
        this.deps.logger.error(
          {
            component: "workflow-orchestrator",
            workflowId,
            agent: parentAgentName,
            err: err instanceof Error ? err.message : String(err),
          },
          "workflow run failed",
        );
      })
      .finally(() => {
        this.inflight.delete(job);
      });
    this.inflight.add(job);

    return workflowId;
  }

  /**
   * The background job body (Plan 06): fan out the workers, drive + collect
   * each worker's turn (the barrier), then finalize (post + cleanup). Runs
   * UN-AWAITED from `launchWorkflow` so the triggering turn already settled —
   * no turn watchdog spans this. The 60s `sweepWorkflows` runs ALONGSIDE this
   * for reaper-survival refresh + progress pings; the two coordinate purely
   * through the shared `workflows` map + per-worker `status`.
   */
  private async runWorkflow(
    workflowId: string,
    parentAgentName: string,
    parentConfig: ResolvedAgentConfig,
    waves: readonly (readonly WorkflowStep[])[],
  ): Promise<void> {
    const state = this.workflows.get(workflowId);
    if (!state) return;

    // Each step is an independent spawn→drive→teardown unit gated by the global
    // admission gate (concurrency cap + memory watermark). `allSettled` so one
    // step's failure NEVER aborts the others or deadlocks the group (T-145-17).
    // The gate — NOT a Promise.all over every step — is what bounds how many
    // workers are RESIDENT at once, ACROSS all concurrent workflows. This
    // replaces the former two-phase "spawn all, then drive all" (which created
    // every worker session up front and so could not be memory-bounded — the
    // 2026-06-27 OOM).
    //
    // BOUNDED RUNNERS (INC-2026-07-26): steps are consumed from a shared FIFO
    // queue by min(cap, N) runners instead of every step calling
    // `gate.acquire()` at fan-out. With the old shape, each step's admission
    // deadline was anchored at FAN-OUT time — 15 steps against 3 slots meant
    // the queued steps' deadlines all expired while earlier workers ran, and
    // 10 of 15 steps starved (2026-07-26 client-a-personal). A runner acquires
    // only when it actually picks a step up, so admission wait measures slot
    // CONTENTION, not queue position. Cross-workflow fairness comes from the
    // gate's own FIFO (same incident, same fix).
    state.status = "running";
    // 999.106 W-2 — waves run SEQUENTIALLY, each through the SAME single-group
    // machinery (shared FIFO queue drained by min(cap, N) bounded runners).
    // Wave K's `allSettled` barrier + synchronous per-step teardown completes
    // before wave K+1's first `gate.acquire`, so peak residency stays bounded
    // by the admission cap regardless of the total step count. The artifact
    // index runs GLOBALLY across waves so `NN-<stem>.md` filenames stay
    // collision-free workflow-wide.
    // Phase 999.165 — iterate the LIVE plan (`state.waves`) by index: steps and
    // waves added by edit_workflow before a wave starts run with it.
    void waves;
    for (let waveIndex = 0; waveIndex < state.waves.length; waveIndex += 1) {
      const wave = state.waves[waveIndex]!;
      // A spent workflow must not start another wave: stall recovery is
      // single-fire (its protection is gone) and the wall clock is the hard
      // ceiling. Drain every not-yet-started step as a terminal skip record —
      // surfaced in the summary, never silently dropped.
      const wallClockElapsed =
        this.deps.now() - state.createdAt >= WORKFLOW_WALL_CLOCK_MS;
      if (state.stallAborted === true || wallClockElapsed) {
        for (const remainingWave of state.waves.slice(waveIndex)) {
          for (const step of remainingWave) {
            state.workers.push({
              stepId: step.stepId,
              sessionName: "(not started)",
              threadId: "",
              prompt: step.prompt,
              status: "failed",
              error: wallClockElapsed
                ? "skipped: workflow wall clock elapsed before this wave started"
                : state.cancelled
                  ? cancelledSkipReason(state.cancelled)
                  : "skipped: workflow stall recovery fired in an earlier wave",
            });
          }
        }
        break;
      }
      // Reset the completion-based stall clock AT THE WAVE BOUNDARY. Without
      // this, a lone wave-K+1 step (the classic single "synthesize" wave)
      // inherits an idle clock that started at wave K's LAST settle — minutes
      // of barrier/teardown time it never had — and a legitimate long step is
      // wrongly stall-aborted (the 31-min step at INC-2026-07-26 cleared the
      // 45-min bound by margin only because its siblings kept settling).
      // `stallAborted` stays workflow-terminal: a genuinely wedged wave ends
      // the workflow with partial results and the loop head above drains the
      // remaining waves.
      state.lastWorkerProgressAt = this.deps.now();
      state.currentWave = waveIndex + 1;
      // 999.106 W-2 review — wave ≥2 workers get the CONCRETE earlier-step
      // result paths as dispatch-time context: the workflow id is minted after
      // the spec is authored, so a later-wave prompt cannot name the artifact
      // dir itself, and a worker globbing `workflows/` races concurrent runs
      // (retention keeps ~40 prior dirs). Never stored on worker.prompt.
      const settledFiles = state.workers
        .filter((w) => w.resultFile !== undefined)
        .map((w) => `- ${w.resultFile} (step: ${w.stepId})`);
      const promptPreamble =
        waveIndex === 0 || settledFiles.length === 0
          ? undefined
          : `[workflow context] You are running wave ${waveIndex + 1} of ` +
            `${state.waves.length} in background workflow ${workflowId}. Earlier ` +
            `steps' full results are saved in your workspace at:\n` +
            `${settledFiles.join("\n")}\n` +
            `Read those files from disk if your task builds on earlier output.\n\n`;
      const stepQueue: QueuedWorkflowStep[] = wave.map((step, i) => ({
        ...step,
        artifactIndex: state.artifactCursor + i,
        ...(promptPreamble !== undefined ? { promptPreamble } : {}),
      }));
      state.artifactCursor += wave.length;
      const workersBefore = state.workers.length;
      const runnerCount = Math.min(
        Math.max(1, this.deps.getWorkflowLimits().maxConcurrentWorkers),
        stepQueue.length,
      );
      // Phase 999.165 — expose the live queue while its runners pull from it,
      // so add_step "current" can join this wave.
      state.liveQueue = stepQueue;
      state.livePreamble = promptPreamble;
      state.activeRunners = runnerCount;
      await Promise.allSettled(
        Array.from({ length: runnerCount }, () =>
          this.runStepQueue(stepQueue, state, parentAgentName, parentConfig),
        ),
      );
      state.liveQueue = undefined;
      state.livePreamble = undefined;
      state.activeRunners = 0;
      // Cross-wave spill: cap this wave's settled `result`/`prompt` strings in
      // heap (full text is on disk via `resultFile`; downstream readers
      // re-hydrate through `readWorkflowArtifact`). The heap never holds more
      // than one wave of full results — the multi-wave analog of the QW-1
      // finalize release. `detachedSlice` (NOT .slice) — a V8 SlicedString
      // would keep the full parent string reachable and free nothing.
      // Prompts have no disk copy, so their cut is permanent and MARKED (the
      // report provenance renders w.prompt; an unmarked mid-word cut would
      // read as corruption).
      for (const worker of state.workers.slice(workersBefore)) {
        if (
          typeof worker.result === "string" &&
          worker.result.length > RESULT_HEAP_CAP
        ) {
          worker.result = detachedSlice(worker.result, RESULT_HEAP_CAP);
        }
        if (worker.prompt.length > RESULT_HEAP_CAP) {
          worker.prompt =
            detachedSlice(worker.prompt, RESULT_HEAP_CAP) +
            PROMPT_TRUNCATION_MARKER;
        }
      }
    }

    // INC-2026-08-14b — the report-synthesis step. Runs AFTER the barrier
    // (it needs every sibling result) through the SAME step machinery:
    // admission gate, spawn, delivery contract + meta-summary quality gate,
    // disk persistence, teardown. Gated on the report pipeline being
    // configured, at least one substantive result to synthesize from, and no
    // stall-abort (a bailed workflow must not spawn more work). Best-effort:
    // a synthesis failure records a failed step and the brief falls back to
    // the deterministic assembly.
    const doneCount = state.workers.filter((w) => w.status === "done").length;
    if (
      this.deps.reportDeps &&
      doneCount > 0 &&
      state.stallAborted !== true &&
      this.deps.now() - state.createdAt < WORKFLOW_WALL_CLOCK_MS
    ) {
      // Collision guard: a user step named "final-report" keeps its artifact;
      // the reserved step takes a suffixed id.
      const reservedId = state.workers.some((w) => w.stepId === REPORT_STEP_ID)
        ? `${REPORT_STEP_ID}-2`
        : REPORT_STEP_ID;
      // 999.106 W-2 review — the synth sources deliberately use the IN-HEAP
      // copies, NOT disk hydration: buildAuthoredReportPrompt caps each source
      // at 14k, strictly below the 16k wave-boundary prefix that is always
      // retained, so a disk read could never contribute a character the prompt
      // would use — while transiently re-ballooning up to 24 full results in
      // heap right before the synth step's memory-gated admission. Disk
      // hydration is reserved for finalize, where the PDFs genuinely need the
      // full text.
      const synthSources = state.workers.map((w) => ({
        stepId: w.stepId,
        prompt: w.prompt,
        status: w.status,
        ...(w.result !== undefined ? { result: w.result } : {}),
      }));
      // Phase 999.123 — the reserved fact-check step runs BEFORE the editor,
      // through the same machinery and deadline class, when the agent opts in
      // and the research carries figures. `synthSources` was captured above,
      // so the editor never sees the fact-checker as a research source; it
      // gets the ledger as hard rules instead. Best-effort: no ledger means
      // the report proceeds exactly as it would with the step off.
      let ledger: FigureLedger | null = null;
      if (
        this.deps.verifyFiguresFor?.(state.parentAgentName) === true &&
        hasFigures(synthSources) &&
        this.deps.now() - state.createdAt < WORKFLOW_WALL_CLOCK_MS
      ) {
        const verifyId = state.workers.some((w) => w.stepId === VERIFY_STEP_ID)
          ? `${VERIFY_STEP_ID}-2`
          : VERIFY_STEP_ID;
        const verifyStep: QueuedWorkflowStep = {
          stepId: verifyId,
          prompt: buildVerifyFiguresPrompt(synthSources),
          artifactIndex: state.workers.length,
        };
        try {
          await this.runStep(
            state,
            state.parentAgentName,
            parentConfig,
            verifyStep,
            REPORT_STEP_MAX_MS,
          );
          const verifyWorker = state.workers.find(
            (w) => w.stepId === verifyId && w.status === "done",
          );
          ledger = verifyWorker?.result ? extractLedgerBlock(verifyWorker.result) : null;
          if (!ledger) {
            this.deps.logger.warn(
              {
                component: "workflow-orchestrator",
                workflowId: state.workflowId,
                stepId: verifyId,
                status: verifyWorker?.status ?? state.workers.find((w) => w.stepId === verifyId)?.status,
              },
              "verify-figures step produced no usable ledger - report proceeds without one",
            );
          }
        } catch (err: unknown) {
          this.deps.logger.warn(
            {
              component: "workflow-orchestrator",
              workflowId: state.workflowId,
              err: err instanceof Error ? err.message : String(err),
            },
            "verify-figures step failed - report proceeds without a ledger",
          );
        }
      }
      // Phase 999.129 — recurring (template) runs: hand the editor the
      // previous run's conclusions so the report leads with what changed.
      let previous: PreviousRun | null = null;
      if (state.origin && this.deps.readPreviousRun) {
        try {
          previous = await this.deps.readPreviousRun(
            state.parentAgentName,
            state.origin,
            state.workflowId,
          );
        } catch (err: unknown) {
          this.deps.logger.warn(
            {
              component: "workflow-orchestrator",
              workflowId: state.workflowId,
              err: err instanceof Error ? err.message : String(err),
            },
            "previous-run lookup failed - report proceeds without deltas",
          );
        }
      }
      state.previousRun = previous;
      const promptOpts = {
        ...(ledger ? { ledger } : {}),
        ...(previous ? { previous } : {}),
      };
      const synthStep: QueuedWorkflowStep = {
        stepId: reservedId,
        prompt: buildAuthoredReportPrompt(synthSources, promptOpts),
        artifactIndex: state.workers.length,
      };
      try {
        // 999.106 QW-1 — the report step gets a tight dedicated deadline
        // (REPORT_STEP_MAX_MS): it is an editing turn over collected results,
        // running after the single-fire stall protection is typically spent.
        await this.runStep(
          state,
          state.parentAgentName,
          parentConfig,
          synthStep,
          REPORT_STEP_MAX_MS,
        );
      } catch (err: unknown) {
        this.deps.logger.warn(
          {
            component: "workflow-orchestrator",
            workflowId: state.workflowId,
            err: err instanceof Error ? err.message : String(err),
          },
          "report-synthesis step failed - brief falls back to deterministic assembly",
        );
      }
    }

    // Awaited so the background job (and shutdown drain) waits for the final
    // result to be delivered; the triggering turn already returned (this whole
    // runWorkflow is un-awaited from launchWorkflow). quick task 260714-mkq.
    await this.finalizeWorkflow(state);
  }

  /**
   * One runner's drain loop over the workflow's shared step queue
   * (INC-2026-07-26 bounded runners — see the runWorkflow comment). Runners
   * pull steps until the queue is empty; `queue.shift()` is race-free on the
   * single-threaded event loop (no await between check and take). The
   * try/catch is a defensive net: `runStep` handles every expected failure
   * internally, but an unexpected throw must not strand this runner (and with
   * it every step it would have drained) — the step is recorded as failed so
   * finalize never silently drops it.
   */
  private async runStepQueue(
    queue: QueuedWorkflowStep[],
    state: WorkflowState,
    parentAgentName: string,
    parentConfig: ResolvedAgentConfig,
  ): Promise<void> {
    for (;;) {
      const step = queue.shift();
      if (step === undefined) {
        // Same synchronous block as the empty check: once this runs, add_step
        // no longer counts this runner as able to pick up a pushed step.
        state.activeRunners = Math.max(0, state.activeRunners - 1);
        return;
      }
      // INC-2026-07-26 review — once stall recovery has fired, the workflow
      // has already told the operator it is proceeding with partial results
      // and its wedge protection (single-fire stallAborted) is spent. Spawning
      // MORE steps at that point would run them with no workflow-level
      // backstop and delay finalize by up to the per-worker wall clock. Drain
      // the remainder as terminal skipped records instead — surfaced in the
      // summary, never silently dropped.
      // 999.106 W-2 review — the elapsed wall clock is checked here TOO (not
      // only at the wave-loop head): without it a queued step whose workflow
      // just passed the 4h05 ceiling still enters gate.acquire and can sit in
      // the fleet-wide FIFO for up to the 1h admission timeout merely to be
      // TOCTOU-skipped after winning a slot — blocking finalize the whole
      // while.
      const wallClockElapsed =
        this.deps.now() - state.createdAt >= WORKFLOW_WALL_CLOCK_MS;
      if (state.stallAborted === true || wallClockElapsed) {
        state.workers.push({
          stepId: step.stepId,
          sessionName: "(not started)",
          threadId: "",
          prompt: step.prompt,
          status: "failed",
          error: wallClockElapsed
            ? "skipped: workflow wall clock elapsed before this step started"
            : state.cancelled
              ? cancelledSkipReason(state.cancelled)
              : "skipped: workflow stall recovery fired before this step started",
        });
        state.lastWorkerProgressAt = this.deps.now();
        continue;
      }
      // Phase 999.165 — a step cancelled before it started never enters the gate.
      const stepCancel = state.cancelledSteps?.get(step.stepId);
      if (stepCancel) {
        state.workers.push(skippedCancelledWorker(step, stepCancel));
        state.lastWorkerProgressAt = this.deps.now();
        continue;
      }
      try {
        await this.runStep(state, parentAgentName, parentConfig, step);
      } catch (err: unknown) {
        state.workers.push({
          stepId: step.stepId,
          sessionName: "(runner error)",
          threadId: "",
          prompt: step.prompt,
          status: "failed",
          error: err instanceof Error ? err.message : String(err),
        });
        state.lastWorkerProgressAt = this.deps.now();
        this.deps.logger.error(
          {
            component: "workflow-orchestrator",
            workflowId: state.workflowId,
            agent: parentAgentName,
            stepId: step.stepId,
            err: err instanceof Error ? err.message : String(err),
          },
          "workflow step runner error",
        );
      }
    }
  }

  /**
   * One step's full lifecycle with a bounded retry (INC-2026-07-26): up to
   * {@link MAX_STEP_ATTEMPTS} passes through `attemptStep` (admission-gated
   * spawn→drive→teardown). A RETRYABLE failure — admission timeout or the
   * stall-abort masquerade — gets exactly one re-entry through the normal
   * gate path, mirroring the channel path's wedge-recovery auto-rerun for
   * the identical stall signature. The failed attempt's worker record is
   * dropped before the retry so finalize reports the step's FINAL outcome
   * (not a phantom extra failure); the retry decision and the drop are both
   * logged so the attempt is never invisible. No retry once the workflow's
   * stall recovery has fired or its wall clock has elapsed.
   */
  private async runStep(
    state: WorkflowState,
    parentAgentName: string,
    parentConfig: ResolvedAgentConfig,
    step: QueuedWorkflowStep,
    deadlineMs?: number,
  ): Promise<void> {
    let current = step;
    for (let attempt = 1; attempt <= MAX_STEP_ATTEMPTS; attempt += 1) {
      const outcome = await this.attemptStep(
        state,
        parentAgentName,
        parentConfig,
        current,
        deadlineMs,
      );
      if (outcome.kind === "done") return;
      if (outcome.kind === "restart") {
        // Phase 999.165 — a steer/edit restart: drop the aborted attempt's
        // record and re-run through admission with the new prompt. Not a retry
        // (bounded separately by MAX_STEP_RESTARTS at the steer/edit entry).
        const idx = state.workers.indexOf(outcome.worker);
        if (idx !== -1) state.workers.splice(idx, 1);
        current = { ...current, prompt: outcome.prompt };
        attempt -= 1;
        this.deps.logger.info(
          { component: "workflow-orchestrator", workflowId: state.workflowId, stepId: step.stepId },
          "workflow step restarting with a steer/edit",
        );
        continue;
      }
      const withinWallClock =
        this.deps.now() - state.createdAt < WORKFLOW_WALL_CLOCK_MS;
      if (
        attempt >= MAX_STEP_ATTEMPTS ||
        !outcome.retryable ||
        !withinWallClock ||
        state.stallAborted === true
      ) {
        return;
      }
      const workerIdx = state.workers.indexOf(outcome.worker);
      if (workerIdx !== -1) {
        state.workers.splice(workerIdx, 1);
      }
      this.deps.logger.warn(
        {
          component: "workflow-orchestrator",
          workflowId: state.workflowId,
          agent: parentAgentName,
          stepId: step.stepId,
          attempt: attempt + 1,
          maxAttempts: MAX_STEP_ATTEMPTS,
          priorError: outcome.worker.error,
        },
        "workflow step retrying after retryable failure",
      );
    }
  }

  /**
   * A single admission-gated attempt at one step: wait for a concurrency
   * slot + memory headroom, spawn the worker, drive its turn, then release
   * the slot AFTER the worker is torn down (driveWorker's `finally` stops
   * the session). An admission timeout records a terminal `failed` worker so
   * the step is surfaced in the summary, never silently dropped. Returns the
   * outcome + retryability so `runStep` can decide on its bounded retry:
   *   - admission timeout → retryable (a slot may free just past the
   *     deadline — the 2026-07-26 cohort missed one by ~62s);
   *   - stall-abort masquerade turn failure → retryable (matches the channel
   *     path's auto-rerun for the same signature);
   *   - spawn failures / other turn errors / wall-clock aborts → terminal.
   */
  private async attemptStep(
    state: WorkflowState,
    parentAgentName: string,
    parentConfig: ResolvedAgentConfig,
    step: QueuedWorkflowStep,
    deadlineMs?: number,
  ): Promise<
    | { readonly kind: "done" }
    | {
        readonly kind: "failed";
        readonly worker: WorkflowWorker;
        readonly retryable: boolean;
      }
    | { readonly kind: "restart"; readonly worker: WorkflowWorker; readonly prompt: string }
  > {
    // Phase 999.165 — cancelled between attempts (or while queued): never enter the gate.
    const cancelledBeforeAdmission = state.cancelledSteps?.get(step.stepId);
    if (cancelledBeforeAdmission) {
      const skipped = skippedCancelledWorker(step, cancelledBeforeAdmission);
      state.workers.push(skipped);
      state.lastWorkerProgressAt = this.deps.now();
      return { kind: "failed", worker: skipped, retryable: false };
    }
    let release: (() => void) | null = null;
    try {
      // INC-2026-07-26 review — the workflow's admissionAbort signal tears a
      // queued waiter out of the fleet-wide FIFO the moment stall recovery
      // fires (a waiter has no worker record / controller, so the sweep's
      // running-worker abort cannot reach it any other way).
      release = await this.gate.acquire(state.admissionAbort.signal);
    } catch (err: unknown) {
      // Phase 999.165 — the admission abort was a cancel: say so, never retry.
      const cancelMark = state.cancelled ?? state.cancelledSteps?.get(step.stepId);
      if (cancelMark) {
        const skipped = skippedCancelledWorker(step, cancelMark);
        state.workers.push(skipped);
        state.lastWorkerProgressAt = this.deps.now();
        return { kind: "failed", worker: skipped, retryable: false };
      }
      const reason =
        err instanceof WorkerAdmissionError ? err.message : String(err);
      // Record a terminal worker so finalize surfaces the dropped step.
      const failedWorker: WorkflowWorker = {
        stepId: step.stepId,
        sessionName: "(not spawned)",
        threadId: "",
        prompt: step.prompt,
        status: "failed",
        error: `admission failed: ${reason}`,
      };
      state.workers.push(failedWorker);
      state.lastWorkerProgressAt = this.deps.now();
      this.deps.logger.warn(
        {
          component: "workflow-orchestrator",
          workflowId: state.workflowId,
          agent: parentAgentName,
          stepId: step.stepId,
          err: reason,
        },
        "workflow step admission failed",
      );
      return {
        kind: "failed",
        worker: failedWorker,
        retryable: err instanceof WorkerAdmissionError,
      };
    }

    try {
      // INC-2026-07-26 review — TOCTOU re-check: the acquire above can block
      // for minutes; stall recovery or the workflow wall clock may have fired
      // while this step waited. Spawning now would create a worker with no
      // remaining workflow-level protection (stallAborted is single-fire).
      // Release the slot and record a terminal skip instead.
      if (
        state.stallAborted === true ||
        this.deps.now() - state.createdAt >= WORKFLOW_WALL_CLOCK_MS
      ) {
        const skippedWorker: WorkflowWorker = {
          stepId: step.stepId,
          sessionName: "(not started)",
          threadId: "",
          prompt: step.prompt,
          status: "failed",
          error: state.cancelled
            ? cancelledSkipReason(state.cancelled)
            : "skipped: workflow stall recovery or wall clock fired while awaiting admission",
        };
        state.workers.push(skippedWorker);
        state.lastWorkerProgressAt = this.deps.now();
        return { kind: "failed", worker: skippedWorker, retryable: false };
      }
      const cancelledWhileQueued = state.cancelledSteps?.get(step.stepId);
      if (cancelledWhileQueued) {
        const skipped = skippedCancelledWorker(step, cancelledWhileQueued);
        state.workers.push(skipped);
        state.lastWorkerProgressAt = this.deps.now();
        return { kind: "failed", worker: skipped, retryable: false };
      }
      const worker = await this.spawnWorker(
        state,
        parentAgentName,
        parentConfig,
        consumeStepEdits(state, step),
      );
      if (worker.status === "running") {
        // 999.106 W-2 review — a wave step's deadline is the workflow's
        // REMAINING wall-clock budget, not a fresh 4h05 anchored at dispatch:
        // waves make hours-late dispatch the norm, and a dispatch-anchored
        // default would let a late wave run hours past the documented
        // whole-workflow ceiling while holding fleet admission slots. (The
        // report step still passes its own tighter REPORT_STEP_MAX_MS.)
        const remainingBudgetMs = Math.max(
          1,
          state.createdAt + WORKFLOW_WALL_CLOCK_MS - this.deps.now(),
        );
        await this.driveWorker(
          state,
          worker,
          deadlineMs ?? remainingBudgetMs,
          step.promptPreamble,
        );
      }
      // Phase 999.165 — a cancel wins over whatever error the abort produced,
      // and is never retried. A step that finished before the abort landed
      // (or kept its first result through a cancelled corrective pass) stays done.
      if (worker.cancelRequested !== undefined && worker.status !== "done") {
        worker.status = "failed";
        worker.error = `cancelled ${describeCancel(worker.cancelRequested)}`;
        return { kind: "failed", worker, retryable: false };
      }
      // Phase 999.165 — a steer/edit restart (flag set before the abort). A
      // step that finished first keeps its result; a stalled workflow does
      // not restart anything.
      if (worker.restartRequested !== undefined && worker.status !== "done" && !isStallAborted(state)) {
        const r = worker.restartRequested;
        return {
          kind: "restart",
          worker,
          prompt: r.prompt ?? appendSteer(worker.prompt, r.guidance ?? "", r.mark.by),
        };
      }
      if (worker.status === "done") {
        return { kind: "done" };
      }
      // Failed spawn (no error message → terminal) or failed turn. Only the
      // stall-abort masquerade is retryable — and NOT for a
      // `max-turn-duration` trip: that worker was killed for exhausting its
      // FULL turn budget (4h for workers), and a retry would double a
      // deterministic budget exhaustion to ~8h on one fleet slot. The
      // masquerade message encodes the trip reason machine-readably
      // (`(reason=<reason>…`) — single-sourced with the guard that builds it.
      const retryable =
        typeof worker.error === "string" &&
        worker.error.startsWith(STREAM_STALL_MASQUERADE_PREFIX) &&
        !worker.error.includes("(reason=max-turn-duration");
      return { kind: "failed", worker, retryable };
    } finally {
      release();
    }
  }

  /**
   * Drive ONE worker's turn to completion and collect its result. Backend-
   * agnostic via the injected `dispatchTurn` (returns the worker's final
   * response). A per-worker `AbortSignal` deadline ({@link WORKFLOW_WALL_CLOCK_MS})
   * is the last-resort kill so a wedged worker still releases the barrier. The
   * worker session is stopped + its binding removed in `finally` (own-creation
   * → own-cleanup) whether it succeeds or fails.
   */
  private async driveWorker(
    state: WorkflowState,
    worker: WorkflowWorker,
    deadlineMs: number = WORKFLOW_WALL_CLOCK_MS,
    promptPreamble?: string,
  ): Promise<void> {
    const controller = new AbortController();
    // Stall recovery (2026-06-26): expose the controller so sweepWorkflows can
    // abort a wedged worker. Cleared in `finally`.
    worker.controller = controller;
    worker.startedAt = this.deps.now();
    const deadline = setTimeout(() => controller.abort(), deadlineMs);
    // Do not keep the event loop alive solely for a worker's wall-clock timer.
    if (typeof deadline === "object" && "unref" in deadline) {
      (deadline as { unref: () => void }).unref();
    }

    try {
      // Phase 999.165 — cancelled while the worker was spawning: never start
      // the turn (a pre-aborted signal is not guaranteed to reject). The catch
      // below marks it failed, the finally tears the session down, and
      // attemptStep rewrites the error as the cancel.
      if (worker.cancelRequested !== undefined) {
        throw new Error("cancelled before the turn started");
      }
      // Phase 999.165 — live status: remember the latest tool call.
      const onToolUse = (name: string, input?: unknown): void => {
        worker.toolCalls = (worker.toolCalls ?? 0) + 1;
        worker.activity = { label: summarizeToolUse(name, input), at: this.deps.now() };
      };
      // INC-2026-08-14 (wf_X2SbTV) — the delivery contract rides EVERY step
      // prompt: the final message IS the deliverable. Workers kept ending
      // turns with "report delivered above" / status narrations, and the
      // final-message collection lost the real findings.
      let result = await this.deps.dispatchTurn(
        worker.sessionName,
        // W-2: the wave-context preamble (earlier steps' result-file paths)
        // rides the TURN INPUT only — worker.prompt stays the clean
        // instruction the report provenance shows.
        (promptPreamble ?? "") + worker.prompt + STEP_DELIVERY_CONTRACT,
        controller.signal,
        onToolUse,
      );
      // Collection quality gate — the backstop for models that ignore the
      // contract. ONE corrective re-dispatch to the SAME session (which still
      // holds its context, so "delivered above" recovers verbatim). Bounded,
      // best-effort: a retry failure keeps the original result.
      if (looksLikeMetaSummary(result)) {
        this.deps.logger.warn(
          {
            component: "workflow-orchestrator",
            workflowId: state.workflowId,
            stepId: worker.stepId,
            resultChars: result.length,
          },
          "step result looks like a meta-summary - one corrective re-dispatch",
        );
        try {
          const retry = await this.deps.dispatchTurn(
            worker.sessionName,
            CORRECTIVE_PROMPT,
            controller.signal,
            onToolUse,
          );
          result = pickBetterResult(result, retry);
        } catch (retryErr: unknown) {
          this.deps.logger.warn(
            {
              component: "workflow-orchestrator",
              workflowId: state.workflowId,
              stepId: worker.stepId,
              err: retryErr instanceof Error ? retryErr.message : String(retryErr),
            },
            "corrective re-dispatch failed - keeping original result",
          );
        }
      }
      worker.status = "done";
      worker.settledAt = this.deps.now();
      worker.result = result;
      // Forward-progress marker for the stall detector — a worker just settled.
      state.lastWorkerProgressAt = this.deps.now();
      // 2026-07-27 disk persistence — write the step result to the parent
      // workspace AT SETTLE TIME (not finalize) so a daemon crash mid-workflow
      // loses at most the in-flight steps. Best-effort: an fs failure is
      // logged and the workflow proceeds (the channel post still carries the
      // full result). The filename is namespaced by spec position (review):
      // stepIds have no uniqueness constraint and the sanitizer is
      // many-to-one, so an id-only name let colliding steps silently
      // overwrite each other. A retry reuses the same index — it overwrites
      // only its own prior attempt.
      const artifactPath =
        `${String(worker.artifactIndex ?? 0).padStart(2, "0")}-` +
        `${sanitizeStepFileName(worker.stepId)}.md`;
      try {
        await this.deps.persistWorkflowArtifact(
          state.parentAgentName,
          state.workflowId,
          artifactPath,
          result,
        );
        worker.resultFile = `workflows/${state.workflowId}/${artifactPath}`;
      } catch (persistErr: unknown) {
        this.deps.logger.warn(
          {
            component: "workflow-orchestrator",
            workflowId: state.workflowId,
            agent: state.parentAgentName,
            stepId: worker.stepId,
            err:
              persistErr instanceof Error
                ? persistErr.message
                : String(persistErr),
          },
          "workflow step result disk-persist failed (result still posted to channel)",
        );
      }
    } catch (err: unknown) {
      worker.status = "failed";
      worker.settledAt = this.deps.now();
      worker.error = err instanceof Error ? err.message : String(err);
      // A failure is still a settle — it advances the barrier, so it counts as
      // progress (otherwise a workflow of all-fast-failures would false-stall).
      state.lastWorkerProgressAt = this.deps.now();
      this.deps.logger.error(
        {
          component: "workflow-orchestrator",
          workflowId: state.workflowId,
          agent: state.parentAgentName,
          session: worker.sessionName,
          stepId: worker.stepId,
          err: worker.error,
        },
        "workflow worker turn failed",
      );
    } finally {
      clearTimeout(deadline);
      worker.controller = undefined;
      // SYNCHRONOUS TEARDOWN (2026-06-27 OOM fix): stop the worker session NOW
      // so its in-process SDK context (incl. large tool results) is freed from
      // the daemon heap BEFORE runStep releases the admission slot — this is
      // what makes the concurrency cap bound RESIDENT sessions (peak memory),
      // not just active turns. Previously this relied solely on the orphan
      // reaper's ~300s minAgeSeconds, leaving N finished sessions resident per
      // workflow. Both calls best-effort — a teardown failure must never wedge
      // the barrier, and the orphan reaper remains the backstop.
      await this.deps.stopAgent(worker.sessionName).catch(() => undefined);
      await this.deps
        .removeWorkerBinding(worker.threadId)
        .catch(() => undefined);
    }
  }

  /**
   * 999.106 W-2 — a settled worker's FULL result text. The wave boundary caps
   * the in-heap `result` at {@link RESULT_HEAP_CAP}; the full text lives on
   * disk (`resultFile`, written at settle). Prefers the disk copy via the
   * optional `readWorkflowArtifact` dep and falls back to the in-heap string
   * on a missing dep / missing file / read failure — degraded fidelity, never
   * a wedged workflow. `undefined` for workers that never produced a result.
   */
  private async readFullResult(
    state: WorkflowState,
    worker: WorkflowWorker,
  ): Promise<string | undefined> {
    const prefix = `workflows/${state.workflowId}/`;
    if (
      this.deps.readWorkflowArtifact &&
      worker.resultFile !== undefined &&
      worker.resultFile.startsWith(prefix)
    ) {
      try {
        return await this.deps.readWorkflowArtifact(
          state.parentAgentName,
          state.workflowId,
          worker.resultFile.slice(prefix.length),
        );
      } catch (err: unknown) {
        this.deps.logger.warn(
          {
            component: "workflow-orchestrator",
            workflowId: state.workflowId,
            stepId: worker.stepId,
            resultFile: worker.resultFile,
            err: err instanceof Error ? err.message : String(err),
          },
          "workflow artifact read-back failed - using in-heap (capped) result",
        );
      }
    }
    return worker.result;
  }

  /**
   * Post the final aggregated result to the bound channel + mark the workflow
   * terminal. A failed/timed-out worker is surfaced in the summary (never
   * silently dropped). `done` unless EVERY worker failed → `failed`.
   */
  private async finalizeWorkflow(state: WorkflowState): Promise<void> {
    const done = state.workers.filter((w) => w.status === "done");
    const failed = state.workers.filter((w) => w.status === "failed");
    state.status =
      state.workers.length > 0 && done.length === 0 ? "failed" : "done";
    // 999.106 QW-1 — stamped at the TOP (not after delivery) so a throw
    // anywhere below still leaves an evictable terminal workflow.
    state.finishedAt = this.deps.now();

    // 2026-07-27 disk persistence — machine-readable run summary next to the
    // per-step result files. Written BEFORE the header is built so the post
    // only advertises the directory when the summary landed (per-step files
    // are written at settle time in driveWorker). Best-effort.
    let summaryPersisted = false;
    try {
      await this.deps.persistWorkflowArtifact(
        state.parentAgentName,
        state.workflowId,
        "summary.json",
        JSON.stringify(
          {
            workflowId: state.workflowId,
            parentAgentName: state.parentAgentName,
            status: state.status,
            createdAt: state.createdAt,
            finishedAt: this.deps.now(),
            // Phase 999.129 — template launch origin (recurring-run lineage).
            ...(state.origin ? { origin: state.origin } : {}),
            // Phase 999.165 — who stopped it, when it was cancelled.
            ...(state.cancelled ? { cancelled: state.cancelled } : {}),
            steps: state.workers.map((w) => ({
              stepId: w.stepId,
              status: w.status,
              ...(w.resultFile !== undefined ? { resultFile: w.resultFile } : {}),
              ...(w.error !== undefined ? { error: w.error } : {}),
            })),
          },
          null,
          2,
        ),
      );
      summaryPersisted = true;
      // Prune AFTER this run's own directory exists, so the newest run is
      // always among those retained.
      await this.deps.pruneWorkflowArtifacts?.(state.parentAgentName).catch(
        (pruneErr: unknown) => {
          this.deps.logger.warn(
            {
              component: "workflow-orchestrator",
              agent: state.parentAgentName,
              err: pruneErr instanceof Error ? pruneErr.message : String(pruneErr),
            },
            "workflow artifact prune failed (non-fatal)",
          );
        },
      );
    } catch (err: unknown) {
      this.deps.logger.warn(
        {
          component: "workflow-orchestrator",
          workflowId: state.workflowId,
          agent: state.parentAgentName,
          err: err instanceof Error ? err.message : String(err),
        },
        "workflow summary disk-persist failed",
      );
    }

    // 999.106 W-2 — re-assemble FULL result text for the delivery readers
    // below (inline body, report PDFs, deterministic summary): the wave
    // boundary capped every prior wave's in-heap copies at RESULT_HEAP_CAP.
    // TRANSIENT by design — the QW-1 release further down still drops the
    // retained strings once `outbound` is composed.
    const fullResults = new Map<WorkflowWorker, string>();
    for (const worker of state.workers) {
      const full = await this.readFullResult(state, worker);
      if (full !== undefined) fullResults.set(worker, full);
    }
    const resultOf = (w: WorkflowWorker): string | undefined =>
      fullResults.get(w) ?? w.result;

    const header =
      (state.cancelled
        ? `🛑 Workflow \`${state.workflowId}\` cancelled ${describeCancel(state.cancelled)} — ` +
          `${done.length}/${state.totalPlannedSteps} step(s) finished before the stop`
        : `🧩 Workflow \`${state.workflowId}\` complete — ` +
          `${done.length}/${state.workers.length} step(s) succeeded` +
          (failed.length > 0 ? `, ${failed.length} failed` : "")) +
      (summaryPersisted
        ? `\n📁 Results saved to \`workflows/${state.workflowId}/\` in the workspace (per-step .md + summary.json)`
        : "");
    // INC-2026-08-10 — `body` used to be every worker's FULL result
    // concatenated. On a 4-step fin-client run that was 90,103 chars,
    // which splitMessage cut into ~51 sequential Discord messages. Nobody
    // reads that. It is retained ONLY behind the `inline` rollback mode.
    const outputMode = this.deps.getWorkflowLimits?.().outputMode ?? "summary";
    const body =
      outputMode === "inline"
        ? state.workers
            .map((w) =>
              w.status === "done"
                ? `\n\n**${w.stepId}:**\n${resultOf(w) ?? ""}`
                : `\n\n**${w.stepId}:** ⚠️ failed — ${w.error ?? "unknown error"}`,
            )
            .join("")
        : null;

    // quick task 260714-mkq — chunk the aggregated result so an oversized
    // finalize is DELIVERED (sequentially) instead of failing the whole post
    // with Discord's "Must be 2000 or fewer in length" error. splitMessage
    // returns a fresh readonly array (immutability preserved). A short result
    // yields exactly one chunk → no behavior change. Each chunk is awaited in
    // order; a failed chunk is LOGGED (never silently swallowed) and the loop
    // continues so a single transient failure does not drop the remaining
    // chunks. Awaited by runWorkflow's background job (still un-awaited by the
    // triggering turn), so shutdown drain waits for delivery.
    // Finding 2 (260714-mkq review) — FORMAT-THEN-SPLIT. The daemon's
    // postToBoundChannel path re-applies formatOutboundText per chunk; on
    // pre-formatted text that second application is a no-op (idempotent), so
    // a 1900-char chunk can no longer expand past Discord's 2000 hard limit.
    // INC-2026-08-10 — the default path is now a single consolidated post.
    // `buildDeterministicSummary` is composed purely from `state.workers`, so
    // it needs no LLM turn, no browser and no attachments: it is the floor that
    // richer delivery (synthesis + PDFs) degrades to, and it is hard-capped
    // below Discord's limit so a completion can never fail on length.
    // Render the two report PDFs BEFORE composing the summary, so the summary
    // can name the attachments it is actually shipping with - and, when the
    // render fails, so it names none. Best-effort and bounded internally;
    // `[]` is a normal return, not an error path.
    const reports =
      body === null && this.deps.reportDeps
        ? await buildWorkflowReports(
            {
              workflowId: state.workflowId,
              agentName: state.parentAgentName,
              createdAt: state.createdAt,
              now: this.deps.now(),
              // 999.106 W-2 — hydrated projections so the PDFs carry full step
              // text even after the wave-boundary heap cap.
              workers: state.workers.map((w) => ({
                stepId: w.stepId,
                status: w.status,
                prompt: w.prompt,
                ...(resultOf(w) !== undefined ? { result: resultOf(w) } : {}),
                ...(w.error !== undefined ? { error: w.error } : {}),
                ...(w.startedAt !== undefined ? { startedAt: w.startedAt } : {}),
                ...(w.settledAt !== undefined ? { settledAt: w.settledAt } : {}),
              })),
            },
            { ...this.deps.reportDeps, logger: this.deps.logger },
          )
        : { attachments: [] as const };
    const attachments = reports.attachments;

    // Phase 999.129 — persist the run record so the NEXT run of this template
    // (same params) can report what changed. Template runs only; best-effort.
    if (state.origin) {
      const synthesis = "synthesis" in reports ? reports.synthesis : undefined;
      try {
        await this.deps.persistWorkflowArtifact(
          state.parentAgentName,
          state.workflowId,
          RUN_RECORD_FILE,
          runRecordJson({
            workflowId: state.workflowId,
            template: state.origin.template,
            params: state.origin.params,
            finishedAt: state.finishedAt ?? this.deps.now(),
            status: state.status,
            ...(synthesis?.bluf ? { bluf: synthesis.bluf } : {}),
            keyFindings: synthesis?.keyFindings ?? [],
            nextSteps: synthesis?.nextSteps ?? [],
            changes: synthesis?.changes ?? [],
          }),
        );
      } catch (err: unknown) {
        this.deps.logger.warn(
          {
            component: "workflow-orchestrator",
            workflowId: state.workflowId,
            err: err instanceof Error ? err.message : String(err),
          },
          "run record persist failed - the next run will not see this one",
        );
      }
    }

    const outbound =
      body !== null
        ? formatOutboundText(header + body)
        : formatOutboundText(
            buildDeterministicSummary({
              workflowId: state.workflowId,
              workers: state.workers.map((w) => ({
                stepId: w.stepId,
                status: w.status,
                result: resultOf(w),
                error: w.error,
              })),
              artifactDir: summaryPersisted
                ? `workflows/${state.workflowId}/`
                : undefined,
              attachments: attachments.map((a) => a.name),
              ...("synthesis" in reports && reports.synthesis?.bluf
                ? { bluf: reports.synthesis.bluf }
                : {}),
              // Phase 999.120 — the findings land next to the PDF.
              ...("synthesis" in reports && reports.synthesis?.keyFindings?.length
                ? { keyFindings: reports.synthesis.keyFindings }
                : {}),
              ...("synthesis" in reports && reports.synthesis?.nextSteps?.length
                ? { nextSteps: reports.synthesis.nextSteps }
                : {}),
              // Phase 999.123 — the fact-check summary under the findings.
              ...("verification" in reports && reports.verification
                ? { verification: reports.verification }
                : {}),
              // Phase 999.129 — deltas since the previous recurring run.
              ...("synthesis" in reports && reports.synthesis?.changes?.length
                ? { changes: reports.synthesis.changes }
                : {}),
              ...(state.previousRun ? { previousRunAt: state.previousRun.finishedAt } : {}),
              elapsedMs: this.deps.now() - state.createdAt,
            }),
          );

    // 999.106 QW-1 — release the retained step text NOW that `outbound` is
    // composed and every reader above (summary.json, reports, deterministic
    // summary, inline body) has consumed it. This MUST sit before the
    // attachment-post branch below (its success path `return`s early). Full
    // results live on disk (`resultFile`) and in the outbound post; only the
    // in-heap copies are dropped. Before this, terminal workflows retained
    // every step's prompt+result for the daemon's lifetime (~1 MB/workflow —
    // the measured 1.66 GB daemon heap).
    for (const worker of state.workers) {
      worker.result = undefined;
      worker.prompt = "";
    }

    // 999.150 — THE AGENT ANSWERS FIRST, and normally it is the only thing
    // that lands.
    //
    // Operator, 2026-09-17: "Nobody ever wants to see the research workflow
    // pdf... Instead the agent should process the findings and report back."
    // So the deterministic summary is demoted to exactly what its own comment
    // always called it — the floor. It posts only when the agent could not
    // answer (dispatch threw, QUEUE_FULL, delivery failed, dep absent), which
    // is the one case where a status line beats silence.
    //
    // `outbound` is still composed above and still handed to the answer turn
    // as context: the agent needs the findings to answer, it just does not
    // need them posted at it.
    // Phase 999.165 — whoever cancelled already knows; no answer turn on top.
    if (!state.cancelled && (await this.dispatchParentAnswer(state, outbound))) return;

    this.deps.logger.warn(
      {
        component: "workflow-orchestrator",
        workflowId: state.workflowId,
        agent: state.parentAgentName,
      },
      "workflow parent answer did not land - posting the deterministic summary as the floor",
    );

    // One message carrying the summary AND any attachments. Discord's
    // attachment `content` does NOT go through splitMessage, which is exactly
    // why buildDeterministicSummary is hard-capped below the 2000 limit.
    // Attachments are empty unless a caller opted into rendering (999.150).
    if (attachments.length > 0 && this.deps.postFilesToBoundChannel) {
      try {
        await this.deps.postFilesToBoundChannel(
          state.parentAgentName,
          outbound,
          attachments,
        );
        return;
      } catch (err: unknown) {
        // Degrade, do not abort: a missing ATTACH_FILES permission must not
        // cost the operator the summary too.
        this.deps.logger.warn(
          {
            component: "workflow-orchestrator",
            workflowId: state.workflowId,
            agent: state.parentAgentName,
            attachments: attachments.map((a) => a.name),
            err: err instanceof Error ? err.message : String(err),
          },
          "workflow report attachment post failed - falling back to text-only",
        );
      }
    }

    const chunks = splitMessage(outbound, FINALIZE_CHUNK_MAX_LENGTH);
    for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex++) {
      try {
        await this.deps.postToBoundChannel(
          state.parentAgentName,
          chunks[chunkIndex]!,
        );
      } catch (err: unknown) {
        this.deps.logger.error(
          {
            component: "workflow-orchestrator",
            workflowId: state.workflowId,
            agent: state.parentAgentName,
            chunkIndex,
            chunkCount: chunks.length,
            err: err instanceof Error ? err.message : String(err),
          },
          "workflow final-result post failed",
        );
      }
    }
  }

  /**
   * 999.149 — give the parent agent a turn to ANSWER, and post what it says.
   *
   * The gap this closes: fan-in posted a report *about* the workflow —
   * `buildDeterministicSummary`, a status floor with no LLM in it — and the
   * agent that the operator was actually talking to never spoke. On
   * 2026-09-17 Client A asked fin-client for a financial plan, a workflow
   * ran, and what landed was a generated PDF that was not the thing he asked
   * for, with no agent response to say so. The agent had no idea the workflow
   * had finished: results never entered its context at all.
   *
   * So this dispatches ONE turn into the parent's own session — which already
   * holds the conversation that launched the workflow, so the agent can tell
   * whether the results answer the question that was actually asked. Its reply
   * is posted through the same chunked sink everything else uses.
   *
   * Deliberately ADDITIVE: the deterministic summary and any PDFs still post
   * exactly as before. This is the answer on top, not a replacement — changing
   * what the report contains is a separate decision from making the agent
   * respond at all.
   *
   * Never throws: the summary is already in the channel by the time we get
   * here, so a failed answer costs the answer and nothing else.
   */
  private async dispatchParentAnswer(state: WorkflowState, outbound: string): Promise<boolean> {
    const answer = this.deps.dispatchParentAnswer;
    if (!answer) return false;
    const prompt = [
      `Your workflow \`${state.workflowId}\` just finished. Nothing has been posted to the channel — YOUR reply is what the person sees.`,
      ``,
      `Answer the request that made you start this workflow, in your own voice:`,
      `- Lead with the bottom line, then what the findings actually say.`,
      `- If the results do NOT answer it — wrong shape, missing piece, a step that failed — say so plainly and say what you will do about it. Do not paper over it.`,
      `- No preamble, no meta-commentary about the workflow itself. They asked a question; give the answer.`,
      ``,
      `IF WHAT THEY ASKED FOR WAS A DELIVERABLE — a document, a report, a plan, a file of any kind —`,
      `then BUILD IT NOW from these findings (use the relevant skill) and share it with`,
      `mcp__clawcode__clawcode_share_file so it lands with this reply. The research output is raw`,
      `material, not the deliverable; do not hand them the research and call it the plan.`,
      ``,
      `Full per-step output is on disk under \`workflows/${state.workflowId}/\` in your workspace; read it if you need detail beyond what follows.`,
      ``,
      `Reply with your answer as your message text — it is posted for you, so do NOT use a tool to post the text itself. (Sharing a file is different; that is the only post you make.)`,
      ``,
      `--- workflow findings ---`,
      outbound.slice(0, WORKFLOW_ANSWER_CONTEXT_CHARS),
    ].join("\n");
    try {
      return await answer(state.parentAgentName, prompt, state.workflowId);
    } catch (err: unknown) {
      this.deps.logger.warn(
        {
          component: "workflow-orchestrator",
          workflowId: state.workflowId,
          agent: state.parentAgentName,
          err: err instanceof Error ? err.message : String(err),
        },
        "workflow parent answer failed - falling back to the deterministic summary",
      );
      return false;
    }
  }

  /**
   * One sweep tick — driven by the daemon's existing 60s `onTickAfter` (the
   * SINGLE driver, alongside the reapers / completion sweep; no separate timer
   * → no silent-path-bifurcation). For each RUNNING workflow this does two
   * distinct jobs (NOT the barrier — the barrier is `Promise.allSettled` in
   * `runWorkflow`):
   *   1. Reaper survival (EVERY tick): refresh each still-running worker's
   *      `binding.lastActivity` so the idle subagent-reaper does not kill a
   *      worker that is actively running a long (quiet) turn (Plan 03 contract).
   *   2. Progress ping (throttled to {@link WORKFLOW_PROGRESS_INTERVAL_MS}):
   *      post a concise progress line to the bound channel.
   * Pure scan + DI'd side effects (mirrors `subagent-completion-sweep`); safe
   * to call with no running workflows (no-op).
   */
  async sweepWorkflows(now: number): Promise<void> {
    for (const state of this.workflows.values()) {
      if (state.status !== "running" && state.status !== "fanning-out") {
        continue;
      }
      const running = state.workers.filter((w) => w.status === "running");
      // (1) Reaper survival — every tick.
      for (const worker of running) {
        await this.deps
          .refreshWorkerBinding(worker.threadId, now)
          .catch(() => undefined);
      }
      // (2) Progress ping — throttled.
      if (now - state.lastProgressAt >= WORKFLOW_PROGRESS_INTERVAL_MS) {
        state.lastProgressAt = now;
        // Phase 999.165 — ETA + what each running step is doing right now.
        const detail = this.describeWorkflow(state.workflowId);
        if (detail) {
          await this.deps
            .postToBoundChannel(state.parentAgentName, renderProgressPing(detail, icons))
            .catch(() => undefined);
        }
      }
      // (3) Stall recovery — no worker has settled for WORKFLOW_STALL_MS while
      // workers are still running ⇒ the remaining workers are wedged. Abort
      // them so the `allSettled` barrier proceeds with PARTIAL results, and
      // notify the channel. `stallAborted` guards a single fire (the aborted
      // workers transition to failed over the next ticks as their turns reject).
      if (
        !state.stallAborted &&
        running.length > 0 &&
        now - state.lastWorkerProgressAt >= WORKFLOW_STALL_MS &&
        // G-2 review — while the admission gate's head is memory-blocked
        // (watermark or pressure tighten), "no settles" is DELIBERATE
        // deferral, not a wedge: queued siblings cannot spawn, so the
        // settle-based idle clock starves even though the running workers
        // are healthy. Firing here would abort them — surrendering exactly
        // the work the backpressure loop exists to protect. The per-step
        // admission timeout (WorkerAdmissionError) remains the designed
        // bound for sustained pressure, and a genuine wedge with NO memory
        // block still stalls exactly as before.
        !this.gate.memoryBlockedRecently()
      ) {
        state.stallAborted = true;
        const done = state.workers.filter((w) => w.status === "done").length;
        const idleMin = Math.round((now - state.lastWorkerProgressAt) / 60_000);
        for (const worker of running) {
          worker.controller?.abort();
        }
        // INC-2026-07-26 review — also tear this workflow's QUEUED acquires
        // (retries / not-yet-started steps) out of the fleet-wide FIFO. They
        // have no worker record, so the loop above cannot reach them; without
        // this they would be admitted after the freed slots and spawn fresh
        // workers into a workflow that already reported partial results.
        state.admissionAbort.abort();
        await this.deps
          .postToBoundChannel(
            state.parentAgentName,
            `⚠️ Workflow \`${state.workflowId}\` stalled — ` +
              `${done}/${state.workers.length} step(s) done; aborting ` +
              `${running.length} stuck step(s) after ${idleMin}m with no progress, ` +
              `proceeding with partial results.`,
          )
          .catch(() => undefined);
      }
    }

    // (4) 999.106 QW-1 — terminal eviction. Before this, NOTHING ever deleted
    // from `this.workflows` (the "10-min prune" in older comments was only the
    // `listWorkflows` VIEW filter), so every finished workflow's state was
    // retained until daemon restart. 15-min retention sits past the 10-min
    // view filter — `/clawcode-workflows` + dashboard behavior is unchanged.
    // Map deletion during iteration is defined behavior, but a separate pass
    // keeps the running-workflow loop above simple.
    const evictable: string[] = [];
    for (const [workflowId, state] of this.workflows) {
      const terminal = state.status === "done" || state.status === "failed";
      if (
        terminal &&
        state.finishedAt !== undefined &&
        now - state.finishedAt >= WORKFLOW_TERMINAL_RETENTION_MS
      ) {
        evictable.push(workflowId);
      }
    }
    for (const workflowId of evictable) {
      this.workflows.delete(workflowId);
    }
  }

  /**
   * Spawn a single worker for one step, with the survival substrate. Returns
   * the tracked worker (status `running` on success, `failed` on spawn error)
   * so `runStep` decides whether to drive it. The concurrent-startAgent
   * registry race is already closed by the atomic `mutateRegistry` (999.65 /
   * #106); the admission gate above bounds how many of these run at once for
   * MEMORY reasons (a different concern from that race).
   */
  private async spawnWorker(
    state: WorkflowState,
    parentAgentName: string,
    parentConfig: ResolvedAgentConfig,
    step: QueuedWorkflowStep,
  ): Promise<WorkflowWorker> {
    // `${parent}-sub-${id}` so (a) `isSubagentThreadName` matches → the idle
    // reaper manages the worker, and (b) `isSubagentOrThreadSession` excludes
    // it from the top-level `/clawcode-fleet` listing.
    const sessionName = `${parentAgentName}-sub-${this.deps.generateId()}`;
    const worker: WorkflowWorker = {
      stepId: step.stepId,
      sessionName,
      threadId: sessionName,
      prompt: step.prompt,
      status: "spawning",
      wave: state.currentWave,
      // 2026-07-27 review — spec position namespaces the artifact filename
      // (colliding stepIds must not overwrite each other's result file).
      artifactIndex: step.artifactIndex,
    };
    state.workers.push(worker);

    const workerConfig = buildWorkflowWorkerConfig(parentConfig, sessionName, {
      // 999.106 QW-2 — fleet ceiling read LIVE (like the admission limits) so
      // a yaml edit applies on the next workflow; per-step narrowing rides the
      // step itself. The reserved final-report step carries no mcpServers
      // field, so it follows the fleet ceiling / full-inherit path.
      mcpAllowlist: this.deps.getWorkflowLimits().workerMcpAllowlist,
      stepMcpServers: step.mcpServers,
    });

    try {
      // ORDERING (mirrors the spawner): register the runtime resolver BEFORE
      // startAgent so SdkSessionAdapter construction finds it.
      this.deps.registerLlmRuntime(sessionName, workerConfig, parentAgentName);
      await this.deps.startAgent(sessionName, workerConfig);

      // Create the worker binding AFTER startAgent (mirrors the spawner order;
      // the reaper's minAgeSeconds — 300s in prod — comfortably covers this
      // window, so the worker is never orphan-reaped before its binding lands).
      // This binding is the reaper-survival substrate.
      await this.deps.addWorkerBinding({
        threadId: worker.threadId,
        sessionName,
        agentName: parentAgentName,
        lastActivity: this.deps.now(),
      });
      // 999.109 review (CRITICAL) — make `heartbeat.enabled: false` real for
      // this worker. Ordering mirrors subagent-thread-spawner: AFTER
      // startAgent, so a tick that sees the session also sees the gate.
      // Without it the whole heartbeat check loop (inbox force-release at
      // the SAME 5-min threshold, plus the parent-inbox drain) runs against
      // the worker and kills its turn — the sweep exemption alone only
      // changes which watchdog does the killing.
      this.deps.registerHeartbeatConfig?.(workerConfig);
      worker.status = "running";
      // 999.106 W-2 review — a successful SPAWN is forward progress for the
      // stall detector. Without this, a step that waited out most of the 60-min
      // admission FIFO (running=0 the whole time, so the sweep could not fire)
      // gets stall-aborted seconds after finally starting: the 45-min idle
      // bound is shorter than the 60-min admission timeout by design
      // (INC-2026-07-26 raised the latter so steps SURVIVE contention).
      state.lastWorkerProgressAt = this.deps.now();
    } catch (err: unknown) {
      worker.status = "failed";
      // INC-2026-07-26 — record the spawn error on the worker so finalize
      // shows the real reason (was "unknown error") and the retry classifier
      // sees a non-masquerade message (spawn failures are terminal).
      worker.error = `spawn failed: ${err instanceof Error ? err.message : String(err)}`;
      this.deps.logger.error(
        {
          component: "workflow-orchestrator",
          workflowId: state.workflowId,
          agent: parentAgentName,
          session: sessionName,
          stepId: step.stepId,
          err: err instanceof Error ? err.message : String(err),
        },
        "workflow worker spawn failed",
      );
      // Own-creation → own-cleanup: best-effort prune of any binding that may
      // have landed before the failure (idempotent if none was created).
      await this.deps
        .removeWorkerBinding(worker.threadId)
        .catch(() => undefined);
    }
    return worker;
  }

  /**
   * Refresh a worker's `binding.lastActivity` on a progress tick (the
   * reaper-survival contract Plan 03 pinned). No-op (no throw) for an unknown
   * workflow or worker. Plan 06's progress path calls this.
   */
  async refreshWorkerActivity(
    workflowId: string,
    workerSessionName: string,
  ): Promise<void> {
    const state = this.workflows.get(workflowId);
    if (!state) return;
    const worker = state.workers.find(
      (w) => w.sessionName === workerSessionName,
    );
    if (!worker) return;
    await this.deps.refreshWorkerBinding(worker.threadId, this.deps.now());
  }

  /** Read per-workflow state (Plan 06's barrier addresses workers through this). */
  getWorkflowState(workflowId: string): WorkflowState | undefined {
    return this.workflows.get(workflowId);
  }

  /**
   * Phase 999.165 — stop a running workflow. Every running step is aborted,
   * queued and later-wave steps are skipped, nothing is retried and no report
   * is synthesized. Reuses stall recovery's gates (`stallAborted` +
   * `admissionAbort`), which the wave loop, admission, retry and report paths
   * already honour; the `cancelled` marker only changes the wording. Finalize
   * still runs, so finished steps keep their saved results and the summary
   * says who stopped it.
   */
  cancelWorkflow(
    workflowId: string,
    request: { readonly by: string; readonly reason?: string },
  ): WorkflowCancelResult {
    const state = this.workflows.get(workflowId);
    if (!state) return { status: "not-found" };
    if (state.status === "done" || state.status === "failed") {
      return { status: "already-finished", workflowStatus: state.status };
    }
    if (state.cancelled) return { status: "already-cancelled", by: state.cancelled.by };
    const mark = controlMark(request, this.deps.now());
    state.cancelled = mark;
    state.stallAborted = true;
    const live = state.workers.filter((w) => w.status === "running" || w.status === "spawning");
    for (const worker of live) {
      worker.cancelRequested = mark;
      worker.controller?.abort();
    }
    state.admissionAbort.abort();
    const done = state.workers.filter((w) => w.status === "done").length;
    const skipped = Math.max(0, state.totalPlannedSteps - state.workers.length);
    this.deps.logger.info(
      {
        component: "workflow-orchestrator",
        workflowId,
        agent: state.parentAgentName,
        by: mark.by,
        stopped: live.length,
        done,
        skipped,
      },
      "workflow cancelled",
    );
    void this.deps
      .postToBoundChannel(
        state.parentAgentName,
        `🛑 Workflow \`${workflowId}\` cancelled ${describeCancel(mark)} — ` +
          `${done}/${state.totalPlannedSteps} step(s) done; stopping ${live.length} running, skipping the rest.`,
      )
      .catch(() => undefined);
    return { status: "cancelled", done, stopped: live.length, skipped };
  }

  /**
   * Phase 999.165 — stop one step; the rest of the workflow carries on. A
   * running step is aborted (and never retried); a step that has not started
   * is skipped when it reaches admission; a settled step is left alone.
   */
  cancelStep(
    workflowId: string,
    stepId: string,
    request: { readonly by: string; readonly reason?: string },
  ): WorkflowCancelResult {
    const state = this.workflows.get(workflowId);
    if (!state) return { status: "not-found" };
    if (state.status === "done" || state.status === "failed") {
      return { status: "already-finished", workflowStatus: state.status };
    }
    if (state.cancelled) return { status: "already-cancelled", by: state.cancelled.by };
    const mark = controlMark(request, this.deps.now());
    const records = state.workers.filter((w) => w.stepId === stepId);
    const live = records.find((w) => w.status === "running" || w.status === "spawning");
    if (live) {
      live.cancelRequested = mark;
      live.controller?.abort();
      this.deps.logger.info(
        { component: "workflow-orchestrator", workflowId, stepId, by: mark.by },
        "workflow step cancelled while running",
      );
      void this.deps
        .postToBoundChannel(
          state.parentAgentName,
          `🛑 Step \`${stepId}\` of workflow \`${workflowId}\` stopped ${describeCancel(mark)}; the rest of the workflow continues.`,
        )
        .catch(() => undefined);
      return { status: "step-stopped", stepId };
    }
    const settled = records[records.length - 1];
    if (settled) return { status: "step-already-finished", stepId, stepStatus: settled.status };
    if (!state.plannedStepIds.has(stepId)) return { status: "step-not-found", stepId };
    if (!state.cancelledSteps) state.cancelledSteps = new Map();
    state.cancelledSteps.set(stepId, mark);
    this.deps.logger.info(
      { component: "workflow-orchestrator", workflowId, stepId, by: mark.by },
      "workflow step cancelled before it started",
    );
    void this.deps
      .postToBoundChannel(
        state.parentAgentName,
        `⏭️ Step \`${stepId}\` of workflow \`${workflowId}\` will be skipped (cancelled ${describeCancel(mark)}).`,
      )
      .catch(() => undefined);
    return { status: "step-will-skip", stepId };
  }

  /** Common refusals for steer/edit; undefined when the workflow can be changed. */
  private refuseChange(
    state: WorkflowState | undefined,
  ): Extract<WorkflowCancelResult, { readonly status: "already-cancelled" | "already-finished" | "not-found" }> | undefined {
    if (!state) return { status: "not-found" };
    if (state.status === "done" || state.status === "failed") {
      return { status: "already-finished", workflowStatus: state.status };
    }
    if (state.cancelled) return { status: "already-cancelled", by: state.cancelled.by };
    return undefined;
  }

  /** Steps in the plan that have no worker record yet (not started), in plan order. */
  private pendingPlanSteps(state: WorkflowState): { readonly stepId: string; readonly wave: number }[] {
    const recorded = new Map<string, number>();
    for (const w of state.workers) recorded.set(w.stepId, (recorded.get(w.stepId) ?? 0) + 1);
    const out: { readonly stepId: string; readonly wave: number }[] = [];
    for (const plan of state.planSteps) {
      const seen = recorded.get(plan.stepId) ?? 0;
      if (seen > 0) {
        recorded.set(plan.stepId, seen - 1);
        continue;
      }
      if (state.cancelledSteps?.has(plan.stepId)) continue;
      out.push(plan);
    }
    return out;
  }

  /** Count a restart for a step; false when the step is at the cap. */
  private takeRestart(state: WorkflowState, stepId: string): boolean {
    const used = state.stepRestarts?.get(stepId) ?? 0;
    if (used >= MAX_STEP_RESTARTS) return false;
    if (!state.stepRestarts) state.stepRestarts = new Map();
    state.stepRestarts.set(stepId, used + 1);
    return true;
  }

  /**
   * Phase 999.165 — steer a running workflow. A running step gets the guidance
   * INTO its current turn when the session supports mid-turn injection;
   * otherwise (or with `restart: true`) the step is restarted with the guidance
   * appended — at most {@link MAX_STEP_RESTARTS} times, back through admission,
   * never counted as a retry. A step that has not started gets the guidance on
   * its prompt when it starts. Without `stepId`, every running and pending step
   * is steered.
   */
  steerWorkflow(
    workflowId: string,
    request: { readonly guidance: string; readonly by: string; readonly stepId?: string; readonly restart?: boolean },
  ): WorkflowSteerResult {
    const state = this.workflows.get(workflowId);
    const refused = this.refuseChange(state);
    if (refused) return refused;
    const guidance = request.guidance.trim().slice(0, STEER_MAX_CHARS);
    if (guidance.length === 0) return { status: "empty-guidance" };
    const live = state!.workers.filter(
      (w) => (w.status === "running" || w.status === "spawning") && (!request.stepId || w.stepId === request.stepId),
    );
    const pending = this.pendingPlanSteps(state!).filter((p) => !request.stepId || p.stepId === request.stepId);
    if (request.stepId && live.length === 0 && pending.length === 0) {
      const settled = [...state!.workers].reverse().find((w) => w.stepId === request.stepId);
      return settled
        ? { status: "step-already-finished", stepId: request.stepId, stepStatus: settled.status }
        : { status: "step-not-found", stepId: request.stepId };
    }
    if (live.length === 0 && pending.length === 0) return { status: "nothing-to-steer" };

    const mark = controlMark({ by: request.by }, this.deps.now());
    const injected: string[] = [];
    const restarted: string[] = [];
    const amended: string[] = [];
    const limited: string[] = [];
    for (const worker of live) {
      if (worker.status === "spawning") {
        // Its turn has not started: the steer rides the prompt it will run.
        worker.prompt = appendSteer(worker.prompt, guidance, mark.by);
        (worker.steers ??= []).push({ text: guidance, by: mark.by, at: mark.at, how: "amended" });
        amended.push(worker.stepId);
        continue;
      }
      if (request.restart !== true && this.deps.injectMidTurn) {
        const r = this.deps.injectMidTurn(worker.sessionName, steerInjectionText(guidance, mark.by));
        if (r.injected) {
          (worker.steers ??= []).push({ text: guidance, by: mark.by, at: mark.at, how: "injected" });
          injected.push(worker.stepId);
          continue;
        }
      }
      if (!this.takeRestart(state!, worker.stepId)) {
        limited.push(worker.stepId);
        continue;
      }
      worker.restartRequested = { mark, guidance };
      (worker.steers ??= []).push({ text: guidance, by: mark.by, at: mark.at, how: "restart" });
      worker.controller?.abort();
      restarted.push(worker.stepId);
    }
    for (const plan of pending) {
      if (!state!.stepEdits) state!.stepEdits = new Map();
      const edits = state!.stepEdits.get(plan.stepId) ?? { steers: [] };
      edits.steers.push({ text: guidance, by: mark.by });
      state!.stepEdits.set(plan.stepId, edits);
      amended.push(plan.stepId);
    }
    this.deps.logger.info(
      { component: "workflow-orchestrator", workflowId, by: mark.by, injected, restarted, amended, limited },
      "workflow steered",
    );
    const parts = [
      injected.length > 0 ? `delivered to ${injected.map((id) => `\`${id}\``).join(", ")} mid-step` : "",
      restarted.length > 0 ? `restarting ${restarted.map((id) => `\`${id}\``).join(", ")} with it` : "",
      amended.length > 0 ? `added to ${amended.length} step(s) not yet started` : "",
      limited.length > 0 ? `${limited.map((id) => `\`${id}\``).join(", ")} already restarted ${MAX_STEP_RESTARTS}× — left as is` : "",
    ].filter((part) => part.length > 0);
    void this.deps
      .postToBoundChannel(
        state!.parentAgentName,
        // 999.178 R1 — bot-emitted steer notice; compass icon via the registry.
        icons.prefix(
          "compass",
          `Workflow \`${workflowId}\` steered by ${mark.by}: ${parts.join("; ")}.`,
        ),
      )
      .catch(() => undefined);
    return { status: "steered", injected, restarted, amended, limited };
  }

  /**
   * Phase 999.165 — edit a running workflow's plan:
   *  - replace_step: a pending step starts with the new prompt; a running step
   *    needs `restart: true` (capped, back through admission).
   *  - add_step: joins the running wave while its runners are active
   *    ("current"), else the next wave, or a new final wave ("new"). Same caps
   *    as start_workflow: 8 steps per wave, 24 total, 6 waves.
   *  - remove_step: cancelStep.
   */
  editWorkflow(workflowId: string, op: WorkflowEditOp, request: { readonly by: string }): WorkflowEditResult {
    if (op.kind === "remove_step") {
      return this.cancelStep(workflowId, op.stepId, { by: request.by, ...(op.reason ? { reason: op.reason } : {}) });
    }
    const state = this.workflows.get(workflowId);
    const refused = this.refuseChange(state);
    if (refused) return refused;
    const st = state!;
    const prompt = op.prompt.trim();
    if (prompt.length === 0) return { status: "invalid", reason: "prompt is empty" };
    if (prompt.length > STEP_PROMPT_MAX_CHARS) {
      return { status: "invalid", reason: `prompt is over ${STEP_PROMPT_MAX_CHARS} characters` };
    }
    const mark = controlMark({ by: request.by }, this.deps.now());

    if (op.kind === "replace_step") {
      const live = st.workers.find((w) => w.stepId === op.stepId && (w.status === "running" || w.status === "spawning"));
      if (live?.status === "spawning") {
        live.prompt = prompt;
        this.postEdit(st, `✏️ Step \`${op.stepId}\` of workflow \`${workflowId}\` rewritten by ${mark.by} before it started.`);
        return { status: "replaced", stepId: op.stepId, restarted: false };
      }
      if (live) {
        if (op.restart !== true) return { status: "step-running", stepId: op.stepId };
        if (!this.takeRestart(st, op.stepId)) return { status: "restart-limit", stepId: op.stepId };
        live.restartRequested = { mark, prompt };
        live.controller?.abort();
        this.postEdit(st, `✏️ Step \`${op.stepId}\` of workflow \`${workflowId}\` rewritten by ${mark.by}; restarting it.`);
        return { status: "replaced", stepId: op.stepId, restarted: true };
      }
      if (this.pendingPlanSteps(st).some((p) => p.stepId === op.stepId)) {
        if (!st.stepEdits) st.stepEdits = new Map();
        st.stepEdits.set(op.stepId, { prompt, steers: [] });
        this.postEdit(st, `✏️ Step \`${op.stepId}\` of workflow \`${workflowId}\` rewritten by ${mark.by} before it started.`);
        return { status: "replaced", stepId: op.stepId, restarted: false };
      }
      const settled = [...st.workers].reverse().find((w) => w.stepId === op.stepId);
      return settled
        ? { status: "step-already-finished", stepId: op.stepId, stepStatus: settled.status }
        : { status: "step-not-found", stepId: op.stepId };
    }

    // add_step
    const stepId = op.stepId.trim();
    if (!STEP_ID_RE.test(stepId)) {
      return { status: "invalid", reason: "stepId must be 1-64 characters: letters, digits, '.', '_' or '-'" };
    }
    if (stepId === REPORT_STEP_ID || st.plannedStepIds.has(stepId)) {
      return { status: "invalid", reason: `stepId ${stepId} is already used in this workflow` };
    }
    const mcpServers = op.mcpServers?.map((name) => name.trim());
    if (mcpServers?.some((name) => name.length === 0)) {
      return { status: "invalid", reason: "mcpServers names must not be empty" };
    }
    if (st.totalPlannedSteps >= MAX_WORKFLOW_TOTAL_STEPS) {
      return { status: "invalid", reason: `the workflow is at the ${MAX_WORKFLOW_TOTAL_STEPS}-step cap` };
    }
    const newStep: WorkflowStep = { stepId, prompt, ...(mcpServers ? { mcpServers } : {}) };
    const currentIndex = Math.max(0, st.currentWave - 1);
    let targetIndex: number;
    let live = false;
    if (op.wave === "current" && st.liveQueue && st.activeRunners > 0 && st.waves[currentIndex]!.length < MAX_WORKFLOW_PARALLEL_STEPS) {
      st.liveQueue.push({
        ...newStep,
        artifactIndex: st.artifactCursor,
        ...(st.livePreamble !== undefined ? { promptPreamble: st.livePreamble } : {}),
      });
      st.artifactCursor += 1;
      targetIndex = currentIndex;
      live = true;
    } else if (op.wave === "current" && st.currentWave === 0) {
      targetIndex = 0; // the first wave has not started: it will include the step
    } else if (op.wave !== "new" && st.waves[st.currentWave] && st.waves[st.currentWave]!.length < MAX_WORKFLOW_PARALLEL_STEPS) {
      targetIndex = st.currentWave; // the next wave (0-based index = current 1-based wave)
    } else {
      if (st.waves.length >= MAX_WORKFLOW_WAVES) {
        return { status: "invalid", reason: `the workflow is at the ${MAX_WORKFLOW_WAVES}-wave cap` };
      }
      st.waves.push([]);
      targetIndex = st.waves.length - 1;
    }
    if (!live && st.waves[targetIndex]!.length >= MAX_WORKFLOW_PARALLEL_STEPS) {
      return { status: "invalid", reason: `wave ${targetIndex + 1} is at the ${MAX_WORKFLOW_PARALLEL_STEPS}-step cap` };
    }
    st.waves[targetIndex]!.push(newStep);
    st.plannedStepIds.add(stepId);
    // Keep the plan in wave order for the status view.
    const insertAt = st.planSteps.findIndex((p) => p.wave > targetIndex + 1);
    if (insertAt === -1) st.planSteps.push({ stepId, wave: targetIndex + 1 });
    else st.planSteps.splice(insertAt, 0, { stepId, wave: targetIndex + 1 });
    st.totalPlannedSteps += 1;
    st.totalWaves = st.waves.length;
    this.postEdit(
      st,
      `➕ Step \`${stepId}\` added to workflow \`${workflowId}\` by ${mark.by} (wave ${targetIndex + 1}${live ? ", starting as a slot frees" : ""}).`,
    );
    return { status: "added", stepId, wave: targetIndex + 1, live };
  }

  private postEdit(state: WorkflowState, text: string): void {
    this.deps.logger.info({ component: "workflow-orchestrator", workflowId: state.workflowId, text }, "workflow edited");
    void this.deps.postToBoundChannel(state.parentAgentName, text).catch(() => undefined);
  }

  /**
   * 999.109 — is `sessionName` a worker this orchestrator currently owns and
   * is actively driving?
   *
   * INC-2026-08-18: the heartbeat's fleet-wide stale-turn sweep force-released
   * three fin-client workflow workers at its 5-MINUTE interactive-turn
   * threshold, aborting all three workflows outright. The sweep deliberately
   * runs BEFORE the per-agent `heartbeat.enabled === false` gate (999.64: a
   * wedged subagent THREAD is otherwise unreachable) — but that same bypass
   * defeats the SC-2 contract this orchestrator is built on, where
   * `heartbeat.enabled: false` is what keeps the ~5-min queue-lock sweep off
   * a worker that is legitimately mid-research for 10-30 minutes.
   *
   * Ownership, NOT the session name, is the discriminator: workflow workers
   * and subagent threads BOTH use the `${parent}-sub-${id}` shape, and
   * subagent threads must stay sweepable. A worker is exempt only while this
   * orchestrator is driving it; the moment it settles (or the workflow goes
   * terminal) the sweep reclaims jurisdiction.
   *
   * Workers are NOT unprotected when exempt — they keep: the per-worker
   * wall-clock abort ({@link WORKFLOW_WALL_CLOCK_MS}, remaining-budget for
   * waved steps), the in-turn stream-stall tracker, the reserved report
   * step's {@link REPORT_STEP_MAX_MS}, and the sweep's own 45-min
   * {@link WORKFLOW_STALL_MS} recovery.
   */
  isLiveWorkerSession(sessionName: string): boolean {
    for (const state of this.workflows.values()) {
      if (state.status !== "running" && state.status !== "fanning-out") {
        continue;
      }
      for (const worker of state.workers) {
        if (
          worker.sessionName === sessionName &&
          (worker.status === "running" || worker.status === "spawning")
        ) {
          return true;
        }
      }
    }
    return false;
  }

  /**
   * Project in-flight + just-finished workflows for the `/clawcode-workflows`
   * pull view (the daemon-side analog of Claude Code's `/workflows`). Terminal
   * (done/failed) workflows older than 10 min are FILTERED FROM THIS VIEW so
   * it stays current (the map entries themselves are evicted separately by the
   * sweep at {@link WORKFLOW_TERMINAL_RETENTION_MS} — 999.106 QW-1; this
   * projection deletes nothing); optionally filtered by triggering agent.
   * Read-only projection — no scheduling/barrier side effects.
   */
  listWorkflows(filter?: { agent?: string }): WorkflowSummary[] {
    const now = this.deps.now();
    const out: WorkflowSummary[] = [];
    for (const state of this.workflows.values()) {
      const terminal = state.status === "done" || state.status === "failed";
      if (terminal && now - state.lastProgressAt > 10 * 60_000) continue;
      if (filter?.agent && state.parentAgentName !== filter.agent) continue;
      out.push(summarizeWorkflow(state, now));
    }
    return out;
  }

  /**
   * Phase 999.165 — the live status of one workflow: every planned step with
   * its wave, status, elapsed time, what it is doing right now (secret-safe
   * activity label), tool-call count and why it failed, plus an ETA derived
   * from this workflow's finished steps. Read-only projection.
   */
  describeWorkflow(workflowId: string): WorkflowDetail | undefined {
    const state = this.workflows.get(workflowId);
    if (!state) return undefined;
    const now = this.deps.now();
    const unmatched = [...state.workers];
    const steps: WorkflowStepView[] = state.planSteps.map((plan) => {
      const idx = unmatched.findIndex((w) => w.stepId === plan.stepId);
      const worker = idx === -1 ? undefined : unmatched.splice(idx, 1)[0];
      return stepView(plan.stepId, plan.wave, worker, state, now);
    });
    // Workers outside the plan (the synthesis/report step) follow the plan.
    for (const worker of unmatched) {
      steps.push(stepView(worker.stepId, worker.wave ?? null, worker, state, now));
    }
    const terminal = state.status === "done" || state.status === "failed";
    const eta: EtaEstimate = terminal
      ? { kind: "unknown", reason: "finished" }
      : state.cancelled
        ? { kind: "unknown", reason: "cancelled — the stopped steps are winding down" }
        : estimateWorkflowEta({
            now,
            poolSize: this.deps.getWorkflowLimits().maxConcurrentWorkers,
            currentWave: state.currentWave,
            totalWaves: state.totalWaves,
            steps: steps.map((st) => ({
              wave: st.wave,
              status: st.status,
              ...(st.startedAt !== undefined ? { startedAt: st.startedAt } : {}),
              ...(st.settledAt !== undefined ? { settledAt: st.settledAt } : {}),
            })),
            reportStepPending:
              this.deps.reportDeps !== undefined &&
              state.stallAborted !== true &&
              !steps.some((st) => st.wave === null),
          });
    return {
      ...summarizeWorkflow(state, now),
      currentWave: state.currentWave,
      totalWaves: state.totalWaves,
      steps,
      eta,
    };
  }

  /**
   * Test-only: await all in-flight background fan-out jobs. Production NEVER
   * calls this — the un-awaited fan-out is the whole SC-2 point.
   */
  async drainForTest(): Promise<void> {
    while (this.inflight.size > 0) {
      await Promise.all([...this.inflight]);
    }
  }
}
