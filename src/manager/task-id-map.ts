/**
 * 999.173 — tool_use id → background task id.
 *
 * `Query.stopTask(taskId)` takes the TASK id carried by `system/task_started`
 * (e.g. `a1b2…` for a subagent, `b…` for a Bash task), not the id of the
 * tool_use block that started it. The 999.64 detach path
 * (`tryBackgroundOrRelease`) only knows the tool_use id, so it passed that to
 * `stopTask` and the call was a silent no-op (measured 2026-09-25, SDK 0.3.282).
 *
 * `observe()` learns the mapping from `task_started` frames. `stopForToolUse()`
 * stops immediately when the task id is known, otherwise DEFERS the stop until
 * the matching `task_started` arrives — a detach can resolve before the CLI
 * reports the task. Deferred stops expire after `pendingTtlMs` so a tool that
 * never becomes a task cannot leak an entry. Both maps are size-capped.
 *
 * Idempotent on repeated frames: the handle observes a frame both in the
 * demux tap (attributed mode) and in the turn loop (legacy mode), and the
 * attributed path forwards ambient frames to the next turn, so the same
 * `task_started` can be seen twice.
 */

type StopFn = (taskId: string) => Promise<unknown> | unknown;

type Frame = {
  readonly type?: string;
  readonly subtype?: string;
  readonly task_id?: unknown;
  readonly tool_use_id?: unknown;
};

export const TASK_ID_MAP_CAP = 500;
export const DEFAULT_PENDING_STOP_TTL_MS = 10 * 60 * 1000;

export type StopOutcome = "stopped" | "deferred";

export class TaskIdMap {
  private readonly stopTask: StopFn;
  private readonly now: () => number;
  private readonly pendingTtlMs: number;
  private readonly byToolUse = new Map<string, string>();
  private readonly pendingStops = new Map<string, number>();

  constructor(opts: { stopTask: StopFn; now?: () => number; pendingTtlMs?: number }) {
    this.stopTask = opts.stopTask;
    this.now = opts.now ?? Date.now;
    this.pendingTtlMs = opts.pendingTtlMs ?? DEFAULT_PENDING_STOP_TTL_MS;
  }

  /** Learn from a stream frame. Non-task frames are ignored; never throws. */
  observe(frame: unknown): void {
    const f = frame as Frame | null | undefined;
    if (f?.type !== "system" || f.subtype !== "task_started") return;
    const taskId = f.task_id;
    const toolUseId = f.tool_use_id;
    if (typeof taskId !== "string" || taskId.length === 0) return;
    if (typeof toolUseId !== "string" || toolUseId.length === 0) return;
    this.byToolUse.delete(toolUseId);
    this.byToolUse.set(toolUseId, taskId);
    trimOldest(this.byToolUse, TASK_ID_MAP_CAP);
    const requestedAt = this.pendingStops.get(toolUseId);
    if (requestedAt !== undefined) {
      this.pendingStops.delete(toolUseId);
      if (this.now() - requestedAt <= this.pendingTtlMs) this.fire(taskId);
    }
  }

  taskIdFor(toolUseId: string): string | undefined {
    return this.byToolUse.get(toolUseId);
  }

  /** Stop the task started by `toolUseId` now, or as soon as its task id is known. */
  stopForToolUse(toolUseId: string): StopOutcome {
    const taskId = this.byToolUse.get(toolUseId);
    if (taskId !== undefined) {
      this.fire(taskId);
      return "stopped";
    }
    this.sweepPending();
    this.pendingStops.set(toolUseId, this.now());
    trimOldest(this.pendingStops, TASK_ID_MAP_CAP);
    return "deferred";
  }

  private sweepPending(): void {
    const cutoff = this.now() - this.pendingTtlMs;
    for (const [id, at] of this.pendingStops) {
      if (at < cutoff) this.pendingStops.delete(id);
    }
  }

  private fire(taskId: string): void {
    try {
      // `.catch` is load-bearing: stopTask rejects asynchronously on some
      // backends (v3 V3UnsupportedMutatorError); an unhandled rejection takes
      // the daemon down.
      void Promise.resolve(this.stopTask(taskId)).catch(() => {
        /* best-effort */
      });
    } catch {
      // best-effort — never fatal
    }
  }
}

function trimOldest<K, V>(map: Map<K, V>, cap: number): void {
  while (map.size > cap) {
    const oldest = map.keys().next();
    if (oldest.done) return;
    map.delete(oldest.value);
  }
}
