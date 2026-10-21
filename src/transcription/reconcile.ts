/**
 * 999.143 — decide what the watcher should DO, given what the Unraid trees look
 * like now and what we did last time.
 *
 * Pure on purpose: the interesting failure modes here are duplicate cards, a
 * card that never completes, and a transcript delivered twice. All of those are
 * state-machine bugs, and none of them need Discord or SSH to test.
 *
 * The tree is the routing key — `/data-client-a/output/<job>` belongs to
 * client-a-personal — so a job can never be delivered to the wrong channel by
 * accident, only by misconfiguring the tree map.
 */
import { deriveState, type JobState, type WorkerProgress } from "./progress.js";
import { shouldRedraw } from "./card.js";

/** What we remember about a job between polls. */
export type TrackedJob = {
  readonly tree: string;
  readonly job: string;
  readonly messageId?: string;
  readonly last?: JobState;
  /** Set once the transcript has been delivered, so it is never delivered twice. */
  readonly completed?: boolean;
  /** Set once a failure has been reported. */
  readonly reportedFailure?: boolean;
};

/** One job as it currently appears on Unraid. */
export type Observed = {
  readonly tree: string;
  readonly job: string;
  readonly progress?: WorkerProgress;
  readonly done: boolean;
  readonly failed?: string;
  /** Position in the shared GPU queue, 1 = next. */
  readonly queuePosition?: number;
};

export type Action =
  | { readonly kind: "post"; readonly tree: string; readonly job: string; readonly state: JobState; readonly queuePosition?: number }
  | { readonly kind: "edit"; readonly tree: string; readonly job: string; readonly messageId: string; readonly state: JobState; readonly queuePosition?: number }
  | { readonly kind: "complete"; readonly tree: string; readonly job: string; readonly messageId?: string; readonly state: JobState }
  | { readonly kind: "fail"; readonly tree: string; readonly job: string; readonly messageId?: string; readonly reason: string };

const key = (tree: string, job: string) => `${tree}/${job}`;

/**
 * How advanced an observation is. The worker does not remove the source file
 * from inbox/ until the job FINISHES, so for a job's whole lifetime it appears
 * twice in one poll: queued (still in inbox) and running (output dir exists).
 * Both carry the same key, and reconcile compares each against the PREVIOUS
 * state, so without collapsing them first it posted two cards for one job.
 */
function rank(o: Observed): number {
  if (o.done) return 4;
  if (o.failed) return 3;
  if (o.progress) return 2;      // running, with real progress
  return 1;                      // queued / no detail
}

/** One observation per job, keeping the most advanced view of it. */
export function collapse(observed: readonly Observed[]): Observed[] {
  const best = new Map<string, Observed>();
  for (const o of observed) {
    const k = key(o.tree, o.job);
    const prev = best.get(k);
    if (!prev || rank(o) > rank(prev)) best.set(k, o);
  }
  return [...best.values()];
}

export type ReconcileResult = {
  readonly actions: readonly Action[];
  readonly next: ReadonlyMap<string, TrackedJob>;
};

export function reconcile(
  tracked: ReadonlyMap<string, TrackedJob>,
  observed: readonly Observed[],
  now: number = Date.now(),
): ReconcileResult {
  const actions: Action[] = [];
  const next = new Map<string, TrackedJob>();

  for (const o of collapse(observed)) {
    const k = key(o.tree, o.job);
    const prev = tracked.get(k);

    // --- failure ---------------------------------------------------------
    if (o.failed) {
      if (prev?.reportedFailure) {
        next.set(k, prev);                      // already told them once
        continue;
      }
      actions.push({ kind: "fail", tree: o.tree, job: o.job, messageId: prev?.messageId, reason: o.failed });
      next.set(k, { ...(prev ?? { tree: o.tree, job: o.job }), reportedFailure: true });
      continue;
    }

    const raw: WorkerProgress = o.progress ?? { job: o.job, phase: o.done ? "done" : "queued" };
    const state = deriveState(raw, now, prev?.last?.pct ?? 0);

    // --- completion ------------------------------------------------------
    // Driven by the worker's own sentinel, not by the percentage: the bar is an
    // estimate, the sentinel is the fact.
    if (o.done) {
      if (prev?.completed) {
        next.set(k, prev);                      // transcript already delivered
        continue;
      }
      const finished: JobState = { ...state, phase: "done", pct: 100, etaSeconds: 0 };
      actions.push({ kind: "complete", tree: o.tree, job: o.job, messageId: prev?.messageId, state: finished });
      next.set(k, { ...(prev ?? { tree: o.tree, job: o.job }), last: finished, completed: true });
      continue;
    }

    // --- first sight -----------------------------------------------------
    if (!prev) {
      actions.push({ kind: "post", tree: o.tree, job: o.job, state, queuePosition: o.queuePosition });
      next.set(k, { tree: o.tree, job: o.job, last: state });
      continue;
    }

    // --- in flight -------------------------------------------------------
    // Without a messageId the post is still in flight (or failed); carry the
    // state forward and let the next tick draw it rather than posting twice.
    if (prev.messageId && shouldRedraw(prev.last, state)) {
      actions.push({
        kind: "edit", tree: o.tree, job: o.job, messageId: prev.messageId,
        state, queuePosition: o.queuePosition,
      });
    }
    next.set(k, { ...prev, last: state });
  }

  // Jobs that vanished from the trees are dropped from memory: the output dir
  // was cleaned up, so there is nothing left to report and nothing to edit.
  return { actions, next };
}

/**
 * Build the initial tracked state from whatever is ALREADY on disk, emitting no
 * actions for it.
 *
 * Without this the first tick treats every historical job as brand new: on the
 * very first run this replayed 46 finished jobs, posting cards and re-delivering
 * old transcripts into live channels before it was stopped. The output trees are
 * an archive, not a queue — anything already finished when the watcher starts is
 * history and must stay silent.
 *
 * Work that is genuinely IN FLIGHT at startup is different: the daemon may have
 * just restarted mid-job, and the owner should still get a card for a recording
 * that is being transcribed right now. So running and queued jobs are left
 * untracked, and the next tick picks them up as new.
 */
export function prime(observed: readonly Observed[]): Map<string, TrackedJob> {
  const tracked = new Map<string, TrackedJob>();
  for (const o of collapse(observed)) {
    if (o.done) {
      tracked.set(key(o.tree, o.job), { tree: o.tree, job: o.job, completed: true });
    } else if (o.failed) {
      tracked.set(key(o.tree, o.job), { tree: o.tree, job: o.job, reportedFailure: true });
    }
    // running / queued: deliberately NOT tracked, so the next tick posts a card.
  }
  return tracked;
}

/** Record the message id a post produced, so later ticks edit instead of re-posting. */
export function withMessageId(
  tracked: ReadonlyMap<string, TrackedJob>,
  tree: string,
  job: string,
  messageId: string,
): Map<string, TrackedJob> {
  const next = new Map(tracked);
  const k = key(tree, job);
  const prev = next.get(k) ?? { tree, job };
  next.set(k, { ...prev, messageId });
  return next;
}
