/**
 * Phase 999.165 — plain-text rendering of workflow status and control results,
 * shared by the agent tools (MCP) and the Discord operator view so an agent and
 * the operator read the same words.
 *
 * Pure: wire-shape inputs in, strings out.
 */

import type {
  WorkflowCancelResult,
  WorkflowDetail,
  WorkflowEditResult,
  WorkflowSteerResult,
  WorkflowStepView,
  WorkflowSummary,
} from "./workflow-orchestrator.js";
import { MAX_STEP_RESTARTS, type EtaEstimate, type StepViewStatus } from "./workflow-status.js";
import type { IconName, IconRegistry } from "../discord/icons.js";

/**
 * 999.178 R1 — step-status glyphs render through the `cc_*` icon set when a
 * registry is passed (the Discord channel surface), and as plain text when it
 * is not (the MCP `workflow_status` tool result and the fenced slash view,
 * where a custom emoji would show as a raw `<:cc_x:id>` token). The status
 * word already carries the meaning, so the icon is decorative either way —
 * never a Unicode fallback.
 */
const STATUS_ICON_NAME: Partial<Record<StepViewStatus, IconName>> = {
  running: "hourglass",
  done: "circle_check",
  failed: "circle_x",
  cancelled: "stop",
  skipped: "forward",
};

/** The status glyph, or "" — `queued` keeps its typographic middot. */
function statusIcon(status: StepViewStatus, reg?: IconRegistry): string {
  if (status === "queued") return "·";
  const name = STATUS_ICON_NAME[status];
  if (!name) return "";
  return reg ? reg.inline(name) : "";
}

/** "4m", "1h 05m", "45s". */
export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${String(m % 60).padStart(2, "0")}m`;
}

function workflowLine(wf: WorkflowSummary): string {
  const planned = wf.plannedSteps ?? wf.workers.total;
  const wave = wf.waves ? ` · wave ${wf.waves.current}/${wf.waves.total}` : "";
  const state = wf.cancelled
    ? `cancelled by ${wf.cancelled.by}${wf.cancelled.reason ? ` (${wf.cancelled.reason})` : ""}`
    : wf.status;
  return (
    `${wf.workflowId} — ${state} · ${wf.workers.done}/${planned} step(s) done` +
    (wf.workers.running > 0 ? `, ${wf.workers.running} running` : "") +
    (wf.workers.failed > 0 ? `, ${wf.workers.failed} failed/skipped` : "") +
    `${wave} · ${formatDuration(wf.ageMs)} old`
  );
}

export function renderWorkflowListText(workflows: readonly WorkflowSummary[]): string {
  if (workflows.length === 0) {
    return "No background workflows are running (finished ones drop off this list after 10 minutes).";
  }
  return workflows.map(workflowLine).join("\n");
}

export function renderCancelResultText(workflowId: string, result: WorkflowCancelResult): string {
  switch (result.status) {
    case "cancelled":
      return (
        `Cancelled ${workflowId}: ${result.done} step(s) had finished; stopping ${result.stopped} running, ` +
        `skipping ${result.skipped} not started. Finished steps keep their saved results; the summary posts when the stopped steps wind down.`
      );
    case "step-stopped":
      return `Stopped step ${result.stepId} of ${workflowId}. The rest of the workflow continues.`;
    case "step-will-skip":
      return `Step ${result.stepId} of ${workflowId} has not started; it will be skipped. The rest of the workflow continues.`;
    case "step-already-finished":
      return `Step ${result.stepId} of ${workflowId} already finished (${result.stepStatus}); nothing to stop.`;
    case "step-not-found":
      return `${workflowId} has no step named ${result.stepId}. Check the step ids with workflow_status.`;
    case "already-cancelled":
      return `${workflowId} was already cancelled by ${result.by}.`;
    case "already-finished":
      return `${workflowId} already finished (${result.workflowStatus}); nothing to stop.`;
    case "not-found":
      return `No workflow ${workflowId} is running (finished workflows are forgotten after a while).`;
  }
}

// ---------------------------------------------------------------------------
// Live status (slice 2): ETA, per-step view, progress ping.
// ---------------------------------------------------------------------------

/** Discord's message limit, with headroom. */
const DISCORD_TEXT_MAX_CHARS = 1900;
const PING_MAX_RUNNING_LINES = 8;
/** Activity older than this is shown with its age ("… (4m ago)"). */
const STALE_ACTIVITY_MS = 60_000;

function capText(text: string, max = DISCORD_TEXT_MAX_CHARS): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export function renderEta(eta: EtaEstimate): string {
  return eta.kind === "estimate"
    ? `ETA ~${formatDuration(eta.remainingMs)} (median step ${formatDuration(eta.medianStepMs)} over ${eta.basisSteps} finished)`
    : `ETA: ${eta.reason}`;
}

function activityText(step: WorkflowStepView): string {
  if (!step.activity) return "starting";
  const age = step.activity.agoMs >= STALE_ACTIVITY_MS ? ` (${formatDuration(step.activity.agoMs)} ago)` : "";
  return `${step.activity.label}${age}`;
}

/** The 6-minute progress message: header + one line per running step. */
export function renderProgressPing(detail: WorkflowDetail, reg?: IconRegistry): string {
  const done = detail.steps.filter((st) => st.status === "done").length;
  const planned = detail.plannedSteps ?? detail.steps.length;
  const hourglass = reg ? reg.inline("hourglass") : "";
  const header =
    `${hourglass ? `${hourglass} ` : ""}Workflow \`${detail.workflowId}\` — ${done}/${planned} step(s) done` +
    (detail.totalWaves > 1 ? ` · wave ${detail.currentWave}/${detail.totalWaves}` : "") +
    ` · ${renderEta(detail.eta)}`;
  const running = detail.steps.filter((st) => st.status === "running");
  const lines = running
    .slice(0, PING_MAX_RUNNING_LINES)
    .map((st) => `• \`${st.stepId}\` — ${formatDuration(st.elapsedMs ?? 0)} · ${activityText(st)}`);
  if (running.length > PING_MAX_RUNNING_LINES) {
    lines.push(`• …and ${running.length - PING_MAX_RUNNING_LINES} more running`);
  }
  const queued = detail.steps.filter((st) => st.status === "queued").length;
  const failed = detail.steps.filter((st) => st.status === "failed").length;
  const tail = [queued > 0 ? `${queued} queued` : "", failed > 0 ? `${failed} failed` : ""]
    .filter((t) => t.length > 0)
    .join(" · ");
  return capText([header, ...lines, ...(tail ? [tail] : [])].join("\n"));
}

function stepLine(step: WorkflowStepView, reg?: IconRegistry): string {
  const icon = statusIcon(step.status, reg);
  const pfx = icon ? `${icon} ` : "";
  switch (step.status) {
    case "queued":
      return `  ${pfx}${step.stepId} — queued`;
    case "running":
      return (
        `  ${pfx}${step.stepId} — running ${formatDuration(step.elapsedMs ?? 0)} · ${activityText(step)}` +
        (step.toolCalls ? ` · ${step.toolCalls} tool call(s)` : "")
      );
    case "done":
      return `  ${pfx}${step.stepId} — done in ${formatDuration(step.elapsedMs ?? 0)}`;
    default:
      return (
        `  ${pfx}${step.stepId} — ${step.status}` +
        (step.elapsedMs !== undefined ? ` after ${formatDuration(step.elapsedMs)}` : "") +
        (step.note ? `: ${step.note}` : "")
      );
  }
}

/** Every step, grouped by wave, with the ETA — for workflow_status and Discord. */
export function renderWorkflowDetailText(detail: WorkflowDetail, reg?: IconRegistry): string {
  const lines: string[] = [];
  const done = detail.steps.filter((st) => st.status === "done").length;
  const planned = detail.plannedSteps ?? detail.steps.length;
  const state = detail.cancelled
    ? `cancelled by ${detail.cancelled.by}${detail.cancelled.reason ? ` (${detail.cancelled.reason})` : ""}`
    : detail.status;
  lines.push(
    `${detail.workflowId} · ${detail.parentAgentName} — ${state} · ${done}/${planned} step(s) done` +
      (detail.totalWaves > 1 ? ` · wave ${detail.currentWave}/${detail.totalWaves}` : "") +
      ` · ${formatDuration(detail.ageMs)} old`,
  );
  lines.push(renderEta(detail.eta));
  const waves = [...new Set(detail.steps.map((st) => st.wave))];
  for (const wave of waves) {
    lines.push(wave === null ? "Report" : detail.totalWaves > 1 ? `Wave ${wave}` : "Steps");
    for (const step of detail.steps.filter((st) => st.wave === wave)) lines.push(stepLine(step, reg));
  }
  return capText(lines.join("\n"));
}

// ---------------------------------------------------------------------------
// Steer / edit results (slice 3).
// ---------------------------------------------------------------------------

export function renderSteerResultText(workflowId: string, result: WorkflowSteerResult): string {
  switch (result.status) {
    case "steered": {
      const parts = [
        result.injected.length > 0 ? `delivered into the running turn of ${result.injected.join(", ")}` : "",
        result.restarted.length > 0
          ? `restarting ${result.restarted.join(", ")} with it (that attempt's progress so far is discarded)`
          : "",
        result.amended.length > 0 ? `added to ${result.amended.join(", ")}, which start later` : "",
        result.limited.length > 0
          ? `${result.limited.join(", ")} already restarted ${MAX_STEP_RESTARTS} times — not changed`
          : "",
      ].filter((part) => part.length > 0);
      return `Steered ${workflowId}: ${parts.join("; ")}.`;
    }
    case "nothing-to-steer":
      return `${workflowId} has no running or pending steps to steer.`;
    case "empty-guidance":
      return "Give some guidance to steer with.";
    default:
      return renderCancelResultText(workflowId, result);
  }
}

export function renderEditResultText(workflowId: string, result: WorkflowEditResult): string {
  switch (result.status) {
    case "replaced":
      return result.restarted
        ? `Rewrote ${result.stepId} and restarted it with the new instructions.`
        : `Rewrote ${result.stepId}; it runs with the new instructions when it starts.`;
    case "step-running":
      return (
        `${result.stepId} is running. Pass restart: true to restart it with the new instructions, ` +
        `or use steer_workflow to adjust it without restarting.`
      );
    case "restart-limit":
      return `${result.stepId} was already restarted ${MAX_STEP_RESTARTS} times; not restarting it again.`;
    case "added":
      return `Added ${result.stepId} to wave ${result.wave} of ${workflowId}${result.live ? "; it starts as soon as a worker slot frees" : ""}.`;
    case "invalid":
      return `Could not edit ${workflowId}: ${result.reason}.`;
    default:
      return renderCancelResultText(workflowId, result);
  }
}
