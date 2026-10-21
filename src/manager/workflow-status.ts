/**
 * Phase 999.165 — live workflow status: what each worker is doing, and when
 * the workflow will likely finish.
 *
 * Activity labels are shown in Discord channels (including other tenants'),
 * so they are ALLOWLISTED per tool: a search query, a host, a file's base
 * name, a program name, an MCP server/tool name. Never a command's arguments,
 * a full URL, a path, or anything else from a tool input (argv and URLs carry
 * secrets — see the MCP-secrets-in-argv incident).
 *
 * The ETA is derived only from THIS workflow's finished steps. Before the first
 * step finishes there is no estimate — never a guess.
 *
 * Pure module.
 */

const LABEL_TEXT_MAX_CHARS = 60;

/** Phase 999.165 — how many times a steer/edit may restart one step. */
export const MAX_STEP_RESTARTS = 3;

function clip(text: string, max = LABEL_TEXT_MAX_CHARS): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

function baseName(path: string): string {
  const parts = path.split(/[\\/]/).filter((p) => p.length > 0);
  return parts[parts.length - 1] ?? path;
}

function field(input: unknown, key: string): string | undefined {
  if (input === null || typeof input !== "object") return undefined;
  const value = (input as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function hostOf(url: string): string | undefined {
  try {
    return new URL(url).host || undefined;
  } catch {
    return undefined;
  }
}

/** First program in a shell command: no env assignments, no arguments, no path. */
function programOf(command: string): string | undefined {
  for (const token of command.trim().split(/\s+/)) {
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) continue; // FOO=bar prefix
    if (token === "sudo" || token === "env" || token === "nohup" || token === "time") continue;
    const program = baseName(token).replace(/[^A-Za-z0-9._+-]/g, "");
    return program.length > 0 ? program : undefined;
  }
  return undefined;
}

/**
 * A short, secret-safe description of one tool call, e.g. `searching "cv2
 * containers"`, `reading docs.discord.com`, `writing mockup-d1.html`,
 * `running git`, `finnhub: quote`.
 */
export function summarizeToolUse(name: string, input?: unknown): string {
  const mcp = /^mcp__([^_].*?)__(.+)$/.exec(name);
  if (mcp) return clip(`${mcp[1]}: ${mcp[2]}`);
  switch (name) {
    case "WebSearch": {
      const q = field(input, "query");
      return q ? `searching "${clip(q, 48)}"` : "searching the web";
    }
    case "WebFetch": {
      const url = field(input, "url");
      const host = url ? hostOf(url) : undefined;
      return host ? `reading ${clip(host)}` : "reading a web page";
    }
    case "Read":
    case "Write":
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit": {
      const path = field(input, "file_path") ?? field(input, "notebook_path");
      const verb = name === "Read" ? "reading" : name === "Write" ? "writing" : "editing";
      return path ? `${verb} ${clip(baseName(path))}` : `${verb} a file`;
    }
    case "Glob":
    case "Grep":
      return "searching files";
    case "Bash": {
      const command = field(input, "command");
      const program = command ? programOf(command) : undefined;
      return program ? `running ${clip(program, 32)}` : "running a command";
    }
    case "Task":
    case "Agent": {
      const description = field(input, "description");
      return description ? `delegating: ${clip(description, 48)}` : "delegating to a subagent";
    }
    case "TodoWrite":
      return "updating its plan";
    default:
      return clip(name, 40);
  }
}

// ---------------------------------------------------------------------------
// ETA
// ---------------------------------------------------------------------------

export type StepViewStatus = "queued" | "running" | "done" | "failed" | "cancelled" | "skipped";

export interface EtaStep {
  readonly wave: number | null;
  readonly status: StepViewStatus;
  readonly startedAt?: number;
  readonly settledAt?: number;
}

export interface EtaInput {
  readonly now: number;
  /** Fleet-wide concurrent worker cap — steps beyond it queue. */
  readonly poolSize: number;
  /** 1-based wave currently executing (0 before the first wave starts). */
  readonly currentWave: number;
  readonly totalWaves: number;
  readonly steps: readonly EtaStep[];
  /** A synthesis/report step will run after the last wave. */
  readonly reportStepPending: boolean;
}

export type EtaEstimate =
  | {
      readonly kind: "estimate";
      readonly remainingMs: number;
      readonly medianStepMs: number;
      readonly basisSteps: number;
    }
  | { readonly kind: "unknown"; readonly reason: string };

export function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** A running step that is already past the median is assumed to need at least this share of it. */
const OVERRUN_FLOOR_SHARE = 0.1;

export function estimateWorkflowEta(input: EtaInput): EtaEstimate {
  const durations = input.steps
    .filter(
      (s) =>
        (s.status === "done" || s.status === "failed") &&
        s.startedAt !== undefined &&
        s.settledAt !== undefined,
    )
    .map((s) => s.settledAt! - s.startedAt!);
  if (durations.length === 0) {
    return { kind: "unknown", reason: "estimating once the first step finishes" };
  }
  const med = median(durations);
  const pool = Math.max(1, input.poolSize);
  const current = Math.max(1, input.currentWave);

  const inCurrent = input.steps.filter((s) => s.wave === current);
  const runningRemaining = inCurrent
    .filter((s) => s.status === "running")
    .map((s) =>
      Math.max(med * OVERRUN_FLOOR_SHARE, med - (input.now - (s.startedAt ?? input.now))),
    );
  const queuedCurrent = inCurrent.filter((s) => s.status === "queued").length;
  const currentWork = runningRemaining.reduce((a, b) => a + b, 0) + queuedCurrent * med;
  const currentTime = Math.max(Math.max(0, ...runningRemaining), currentWork / pool);

  let laterTime = 0;
  for (let wave = current + 1; wave <= input.totalWaves; wave += 1) {
    const queued = input.steps.filter((s) => s.wave === wave && s.status === "queued").length;
    laterTime += Math.ceil(queued / pool) * med;
  }
  const reportTime = input.reportStepPending ? med : 0;
  return {
    kind: "estimate",
    remainingMs: Math.round(currentTime + laterTime + reportTime),
    medianStepMs: Math.round(med),
    basisSteps: durations.length,
  };
}
