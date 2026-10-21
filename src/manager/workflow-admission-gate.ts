/**
 * Workflow worker admission gate — a global concurrency cap + cgroup
 * memory-pressure watermark for daemon-side workflow workers.
 *
 * WHY (2026-06-27 fleet-down): the workflow orchestrator fans out in-process
 * `anthropic-agent-sdk` workers. With no global bound, a multi-step /
 * multi-workflow burst drove the daemon heap past the 20G cgroup `MemoryMax`
 * and the kernel OOM-killed the whole fleet. This gate bounds how many workers
 * are admitted — and, because the orchestrator now tears a worker down
 * synchronously before releasing its slot, how many worker sessions are
 * RESIDENT — at once, ACROSS ALL workflows (the orchestrator is a singleton
 * holding one gate instance).
 *
 * Admission requires BOTH: a free concurrency slot AND cgroup memory below the
 * high-watermark. It fails OPEN on an unknown/unbounded memory reading (dev /
 * non-Linux / cgroup `max`) so tests and non-systemd hosts never block. It
 * waits (poll loop — cheap: ≤8 steps/workflow, a handful of workflows) until
 * both conditions hold or `admissionTimeoutMs` elapses, then throws
 * {@link WorkerAdmissionError}.
 *
 * FIFO fairness (INC-2026-07-26 client-a-personal starvation): acquires are
 * granted in ARRIVAL ORDER via an explicit wait queue — only the queue head
 * may take a freed slot. The original poll race handed a freed slot to
 * whichever waiter's 500ms tick fired first: a step queued 95s later was
 * admitted past five steps that had been waiting 14 minutes, and all five
 * starved to the admission timeout ~62s before the next slot freed. Waiters
 * hold NO session memory (the orchestrator spawns a worker only AFTER
 * acquire resolves), so queue length does not affect the residency bound —
 * the cap continues to bound resident workers exactly as before.
 *
 * Workflow workers cannot spawn further workers (the recursion guards in
 * `buildWorkflowWorkerConfig`), so a blocking acquire here is deadlock-free.
 *
 * Fully dependency-injected (now / sleep / readMemoryPercent / live getters)
 * so the unit tests run with no real cgroup or timers.
 */

import type { Logger } from "pino";

/** Thrown when a worker cannot be admitted before the admission timeout. */
export class WorkerAdmissionError extends Error {
  /** Which condition was blocking when the deadline elapsed. */
  readonly reason: "concurrency" | "memory";
  constructor(reason: "concurrency" | "memory", message: string) {
    super(message);
    this.name = "WorkerAdmissionError";
    this.reason = reason;
  }
}

export interface AdmissionGateDeps {
  /** Live max concurrent workers (read each attempt → restart/reload-aware). */
  readonly getMaxConcurrent: () => number;
  /** Live cgroup-memory high-watermark percent (0–100). */
  readonly getMemoryHighWatermarkPercent: () => number;
  /** Live admission timeout (ms) before a blocked acquire throws. */
  readonly getAdmissionTimeoutMs: () => number;
  /**
   * Current cgroup memory percent (0–100), or `null` when unknown/unbounded
   * (dev / non-Linux / cgroup `max`). `null` ⇒ fail-open (admit).
   */
  readonly readMemoryPercent: () => Promise<number | null>;
  /**
   * 999.106 G-2 — fresh on-acquire PSI read (a single readFileSync, only ever
   * called at the FIFO head — same cadence as readMemoryPercent). Optional
   * and fail-open: absent / `available === false` / throw ⇒ no tighten.
   */
  readonly readPressure?: () => {
    readonly available: boolean;
    readonly cgFull10: number | null;
    readonly cgSome60: number | null;
  };
  /**
   * 999.106 G-2 — census-derived anon-balloon signal (MemorySignalBus.get).
   * Null = never published or stale ⇒ ignored. The producer is an in-daemon
   * 60s timer that starves during a true stall BY DESIGN — this loop is a
   * moderate-pressure refinement; memwatch owns the stall regime.
   */
  readonly getBalloonSignal?: () => {
    readonly anonBalloon: boolean;
    readonly balloonPid: number | null;
  } | null;
  /** 999.106 G-2 — live tighten thresholds (single-sourced from the
   *  spawnGovernor config block; SPAWN_GOVERNOR_DEFAULTS mirrors). */
  readonly getTightenThresholds?: () => {
    readonly psiFull10: number;
    readonly psiSome60: number;
  };
  /** Clock (Date.now in production; injected in tests). */
  readonly now: () => number;
  /** Yielding sleep (real setTimeout in production; injected in tests). */
  readonly sleep: (ms: number) => Promise<void>;
  readonly logger: Logger;
  /** Poll interval (ms) while waiting for a slot / memory to clear. Default 500. */
  readonly pollMs?: number;
}

/**
 * Global admission gate for workflow workers. One instance per orchestrator
 * (which is a daemon singleton), so `active` is the fleet-wide live-worker
 * count across every concurrent workflow.
 */
export class WorkflowAdmissionGate {
  private active = 0;
  /**
   * FIFO wait queue of acquire() identity tokens (INC-2026-07-26). Only the
   * head may take a freed slot, so grants happen in arrival order and a
   * long-waiting step can no longer be jumped by a fresh acquire winning the
   * poll race. Entries are removed on grant (shift) and on timeout/abort
   * (splice in acquire's finally), so the queue never leaks a settled waiter.
   */
  private readonly waitQueue: object[] = [];
  private readonly deps: AdmissionGateDeps;
  private readonly pollMs: number;

  constructor(deps: AdmissionGateDeps) {
    this.deps = deps;
    this.pollMs = deps.pollMs ?? 500;
  }

  /** Live count of admitted-but-not-released workers (the resident bound). */
  get activeCount(): number {
    return this.active;
  }

  /** Live count of acquires blocked waiting for a slot (diagnostics). */
  get queuedCount(): number {
    return this.waitQueue.length;
  }

  /**
   * Acquire an admission slot. Resolves with an idempotent `release()` once
   * this acquire reaches the FRONT of the FIFO wait queue AND a concurrency
   * slot is free AND cgroup memory is below the watermark. Throws
   * {@link WorkerAdmissionError} if that does not happen before the admission
   * timeout, or if `signal` aborts first.
   */
  async acquire(signal?: AbortSignal): Promise<() => void> {
    const deadline = this.deps.now() + this.deps.getAdmissionTimeoutMs();
    let lastBlockReason: "concurrency" | "memory" = "concurrency";
    // Unique identity token — FIFO position marker (INC-2026-07-26).
    const waiter = {};
    this.waitQueue.push(waiter);

    try {
      for (;;) {
        if (signal?.aborted) {
          throw new WorkerAdmissionError(
            "concurrency",
            "workflow aborted before worker admission",
          );
        }

        // FIFO head gate first, THEN memory (async), THEN an ATOMIC
        // head+slot re-check + increment with no await between them. The
        // head re-check after the memory await matters for the same reason
        // the original slot check did: N concurrent head-candidates across
        // the await would otherwise all observe headship and over-admit.
        // The memory watermark is a soft gate (a slightly stale read is
        // fine); headship + the concurrency cap are the hard, race-free
        // bounds. Non-head waiters skip the memory read entirely — only the
        // head polls the cgroup.
        if (this.waitQueue[0] === waiter) {
          if (await this.memoryAdmits()) {
            if (
              this.waitQueue[0] === waiter &&
              this.active < Math.max(1, this.deps.getMaxConcurrent())
            ) {
              this.active += 1;
              this.waitQueue.shift();
              return this.makeRelease();
            }
            lastBlockReason = "concurrency";
          } else {
            lastBlockReason = "memory";
          }
        } else {
          // Blocked behind earlier arrivals — a concurrency-shaped wait even
          // if the head is currently memory-blocked.
          lastBlockReason = "concurrency";
        }

        if (this.deps.now() >= deadline) {
          throw new WorkerAdmissionError(
            lastBlockReason,
            `workflow worker admission timed out after ` +
              `${this.deps.getAdmissionTimeoutMs()}ms (blocked on ${lastBlockReason})`,
          );
        }
        await this.deps.sleep(this.pollMs);
      }
    } finally {
      // Timeout/abort exits leave the token in the queue — remove it so the
      // next waiter becomes head. The grant path already shifted it
      // (indexOf → -1 → no-op), so this is single-purpose cleanup.
      const idx = this.waitQueue.indexOf(waiter);
      if (idx !== -1) this.waitQueue.splice(idx, 1);
      // G-2 review — un-latch the once-per-episode tighten log: a timeout
      // exit otherwise left it set, swallowing the NEXT episode's line.
      this.resetTightenLog();
    }
  }

  private makeRelease(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active = Math.max(0, this.active - 1);
    };
  }

  /** G-2 — set while the head is pressure-tightened, so the deny is logged
   *  once per tighten EPISODE (the head re-polls every 500ms) not per poll.
   *  Reset in acquire's finally too (review: a timeout exit used to leave it
   *  latched, swallowing the NEXT episode's log line). */
  private tightenLogged = false;

  /** G-2 review — when the head was last memory-blocked (watermark OR
   *  tighten), on THIS gate's clock. Lets the orchestrator's stall sweep
   *  distinguish "no settles because admission is deliberately deferred
   *  under pressure" from "running workers are wedged" — without this, a
   *  tightened wave starved the settle-based stall detector and the sweep
   *  aborted HEALTHY running workers. */
  private lastMemoryBlockAt = 0;

  /** True when the head hit a memory block within the last `windowMs`
   *  (default 10 polls). Read by the orchestrator's stall sweep. */
  memoryBlockedRecently(windowMs = 5_000): boolean {
    return (
      this.lastMemoryBlockAt !== 0 &&
      this.deps.now() - this.lastMemoryBlockAt < windowMs
    );
  }

  /** G-2 review — public reset hook for acquire()'s finally. */
  resetTightenLog(): void {
    this.tightenLogged = false;
  }

  private async memoryAdmits(): Promise<boolean> {
    let pct: number | null;
    try {
      pct = await this.deps.readMemoryPercent();
    } catch (err: unknown) {
      // Fail-open: never block workflows because the telemetry read failed.
      this.deps.logger.warn(
        {
          component: "workflow-admission-gate",
          err: err instanceof Error ? err.message : String(err),
        },
        "memory read failed — admitting (fail-open)",
      );
      return true;
    }
    // null = unknown / unbounded cgroup → fail-open.
    if (pct !== null && pct >= this.deps.getMemoryHighWatermarkPercent()) {
      this.tightenLogged = false;
      this.lastMemoryBlockAt = this.deps.now();
      return false;
    }
    // 999.106 G-2 — backpressure tighten: PSI (fresh, on-acquire) + the
    // census balloon signal (shared holder, staleness-checked by the
    // producer-side maxAge). Every leg fails OPEN — this defers admission
    // under MODERATE pressure; a queued head keeps polling until pressure
    // clears or the admission timeout elapses (queue-not-kill, the existing
    // contract). NEVER a stall safety net: during a true stall the balloon
    // signal goes stale (ignored) and memwatch owns the kill.
    const tighten = this.evaluateTighten();
    if (tighten !== null) {
      this.lastMemoryBlockAt = this.deps.now();
      if (!this.tightenLogged) {
        this.tightenLogged = true;
        this.deps.logger.info(
          { component: "workflow-admission-gate", ...tighten },
          "admission tightened by memory pressure — queuing (not killing)",
        );
      }
      return false;
    }
    this.tightenLogged = false;
    return true;
  }

  /** The tighten deny-detail, or null when nothing tightens (fail-open). */
  private evaluateTighten(): Record<string, unknown> | null {
    const thresholds = this.deps.getTightenThresholds?.();
    if (!thresholds) return null;
    try {
      const psi = this.deps.readPressure?.();
      if (psi?.available) {
        // A threshold <=0 disables that leg (review: `0.00 >= 0` would be
        // ALWAYS-TIGHTEN on the idle-baseline fleet — the schema floors at
        // 0.1, this is defense in depth for config arriving any other way).
        if (
          thresholds.psiFull10 > 0 &&
          psi.cgFull10 !== null &&
          psi.cgFull10 >= thresholds.psiFull10
        ) {
          return { tighten: "psiFull10", value: psi.cgFull10 };
        }
        if (
          thresholds.psiSome60 > 0 &&
          psi.cgSome60 !== null &&
          psi.cgSome60 >= thresholds.psiSome60
        ) {
          return { tighten: "psiSome60", value: psi.cgSome60 };
        }
      }
    } catch {
      // fail open
    }
    try {
      const signal = this.deps.getBalloonSignal?.() ?? null;
      if (signal?.anonBalloon) {
        return { tighten: "anon-balloon", balloonPid: signal.balloonPid };
      }
    } catch {
      // fail open
    }
    return null;
  }
}
