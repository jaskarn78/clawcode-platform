/**
 * P3 (memory program, 3b) — SpawnGovernor: class-aware admission gate for
 * every managed claude-CLI spawn.
 *
 * Bounds concurrent SPAWNS (admission + the cold-start window), NOT
 * residency — residency stays with the per-class caps that already exist
 * (workflow gate 3, threads 3/parent, pool warmSize+2). Slots are held
 * from acquire until `startAgentCore` returns (success OR failure),
 * released in `finally`, so slots turn over in bounded time and a
 * workflow slot-holder queued here always makes progress (no deadlock
 * with the inner WorkflowAdmissionGate — they compose: this bounds spawn
 * bursts, that bounds worker residency).
 *
 * Class modes:
 *   - `agent`: ADVISORY (default 4) — operator/boot/restart actions must
 *     never hard-block (wedge recovery, crash restart). On block: one
 *     telemetry line, then admit.
 *   - `worker`/`fork`/`pool`: ENFORCE — FIFO queue with the
 *     WorkflowAdmissionGate's proven head-recheck loop (INC-2026-07-26
 *     starvation discipline), memory watermark (percent of the effective
 *     min(high,max) ceiling via cgroup-stats — P1), admission timeout,
 *     queue-depth cap.
 *
 * Fail-open: memory read null/throw → admit. `enabled: false` → no-op.
 * All knobs live-read per acquire (`defaults.spawnGovernor.*`).
 */

import type { Logger } from "pino";
import { spawnKindOf } from "./subagent-name.js";

export type SpawnClass = "agent" | "worker" | "fork" | "pool";

export function spawnClassOf(name: string): SpawnClass {
  const kind = spawnKindOf(name);
  if (kind === "agent") return "agent";
  if (kind === "fork") return "fork";
  if (kind === "pool") return "pool";
  return "worker"; // sub | via | thread
}

export class SpawnAdmissionError extends Error {
  readonly reason: "concurrency" | "memory" | "queue-full";
  constructor(reason: "concurrency" | "memory" | "queue-full", message: string) {
    super(`SpawnGovernor: ${message}`);
    this.name = "SpawnAdmissionError";
    this.reason = reason;
  }
}

export interface ResolvedSpawnGovernorConfig {
  readonly enabled?: boolean;
  readonly memoryWatermarkPercent?: number;
  readonly admissionTimeoutMs?: number;
  readonly queueDepthPerClass?: number;
  /** Residency cap for fork-kind sessions (first ever — forks had none). */
  readonly maxResidentForks?: number;
  /** 999.106 G-2 — PSI gate-tighten lines (cgroup memory.pressure `full
   *  avg10` / `some avg60`). Far below memwatch's kill line (50): admission
   *  tightens BEFORE the box stalls hard enough to be worth killing. */
  readonly gateTightenPsiFull10?: number;
  readonly gateTightenPsiSome60?: number;
  readonly classes?: Readonly<
    Partial<
      Record<
        SpawnClass,
        { readonly maxConcurrentSpawns?: number; readonly mode?: "advisory" | "enforce" }
      >
    >
  >;
}

/** Runtime defaults — schema `.default()`s mirror these (single source). */
export const SPAWN_GOVERNOR_DEFAULTS = Object.freeze({
  enabled: true,
  memoryWatermarkPercent: 85,
  admissionTimeoutMs: 120_000,
  queueDepthPerClass: 16,
  maxResidentForks: 4,
  // G-2 — schema .default()s mirror these (single source; never daemon `??`).
  gateTightenPsiFull10: 10,
  gateTightenPsiSome60: 10,
  classes: Object.freeze({
    agent: { maxConcurrentSpawns: 4, mode: "advisory" as const },
    worker: { maxConcurrentSpawns: 3, mode: "enforce" as const },
    fork: { maxConcurrentSpawns: 2, mode: "enforce" as const },
    pool: { maxConcurrentSpawns: 2, mode: "enforce" as const },
  }),
});

export interface SpawnGovernorDeps {
  /** Live config resolver — read per acquire (reloadable). */
  readonly resolveConfig: () => ResolvedSpawnGovernorConfig | undefined;
  /**
   * Cgroup memory percent of the EFFECTIVE ceiling (min(high,max)) —
   * production wires readCgroupMemoryStats().memoryPercent. null →
   * unbounded/unreadable → fail open.
   */
  readonly readMemoryPercent: () => Promise<number | null>;
  /**
   * 999.106 G-2 — fresh on-acquire PSI read (production:
   * memory-pressure.readPressure over the daemon's own cgroup dir; a single
   * readFileSync, same cost as the cgroup-% read above). Optional and
   * fail-open: absent / `available === false` / throw ⇒ no tighten.
   */
  readonly readPressure?: () => {
    readonly available: boolean;
    readonly cgFull10: number | null;
    readonly cgSome60: number | null;
  };
  /**
   * 999.106 G-2 — census-derived anon-balloon signal (production:
   * MemorySignalBus.get with the guard's signalMaxAgeMs). Null = never
   * published or stale ⇒ ignored (fail-open — the bus's producer is an
   * in-daemon timer that starves during a true stall BY DESIGN; memwatch
   * owns that regime).
   */
  readonly getBalloonSignal?: () => {
    readonly anonBalloon: boolean;
    readonly balloonPid: number | null;
  } | null;
  readonly log: Logger;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}

interface ClassState {
  active: number;
  readonly waitQueue: object[];
}

const POLL_MS = 250;

export class SpawnGovernor {
  private readonly deps: SpawnGovernorDeps;
  private readonly state = new Map<SpawnClass, ClassState>();

  constructor(deps: SpawnGovernorDeps) {
    this.deps = deps;
  }

  private classState(cls: SpawnClass): ClassState {
    let st = this.state.get(cls);
    if (!st) {
      st = { active: 0, waitQueue: [] };
      this.state.set(cls, st);
    }
    return st;
  }

  private resolved() {
    const cfg = this.deps.resolveConfig() ?? {};
    return {
      enabled: cfg.enabled ?? SPAWN_GOVERNOR_DEFAULTS.enabled,
      memoryWatermarkPercent:
        cfg.memoryWatermarkPercent ??
        SPAWN_GOVERNOR_DEFAULTS.memoryWatermarkPercent,
      admissionTimeoutMs:
        cfg.admissionTimeoutMs ?? SPAWN_GOVERNOR_DEFAULTS.admissionTimeoutMs,
      queueDepthPerClass:
        cfg.queueDepthPerClass ?? SPAWN_GOVERNOR_DEFAULTS.queueDepthPerClass,
      gateTightenPsiFull10:
        cfg.gateTightenPsiFull10 ??
        SPAWN_GOVERNOR_DEFAULTS.gateTightenPsiFull10,
      gateTightenPsiSome60:
        cfg.gateTightenPsiSome60 ??
        SPAWN_GOVERNOR_DEFAULTS.gateTightenPsiSome60,
      classCfg: (cls: SpawnClass) => ({
        maxConcurrentSpawns:
          cfg.classes?.[cls]?.maxConcurrentSpawns ??
          SPAWN_GOVERNOR_DEFAULTS.classes[cls].maxConcurrentSpawns,
        mode:
          cfg.classes?.[cls]?.mode ?? SPAWN_GOVERNOR_DEFAULTS.classes[cls].mode,
      }),
    };
  }

  /** Live-resolved fork residency cap (used by startAgentCore's pre-check). */
  maxResidentForks(): number {
    const cfg = this.deps.resolveConfig() ?? {};
    if (cfg.enabled === false) return Number.POSITIVE_INFINITY;
    return cfg.maxResidentForks ?? SPAWN_GOVERNOR_DEFAULTS.maxResidentForks;
  }

  /** Diagnostics/telemetry snapshot. */
  get stats(): Readonly<Record<SpawnClass, { active: number; queued: number }>> {
    const out = {} as Record<SpawnClass, { active: number; queued: number }>;
    for (const cls of ["agent", "worker", "fork", "pool"] as const) {
      const st = this.state.get(cls);
      out[cls] = { active: st?.active ?? 0, queued: st?.waitQueue.length ?? 0 };
    }
    return out;
  }

  /**
   * G-2 — memory verdict + the tighten deny-detail (psi values / balloon
   * pid). Returned, NOT stashed on the instance (review: concurrent per-class
   * admissions interleave across the async read, so shared state misattributed
   * the WHY fields in the deny telemetry).
   */
  private async memoryAdmits(
    watermarkPct: number,
    tighten: { psiFull10: number; psiSome60: number },
  ): Promise<{ admit: boolean; detail: Record<string, unknown> | null }> {
    let pct: number | null;
    try {
      pct = await this.deps.readMemoryPercent();
    } catch {
      return { admit: true, detail: null }; // fail open
    }
    if (pct !== null && pct >= watermarkPct) {
      return { admit: false, detail: null };
    }
    // 999.106 G-2 — backpressure tighten. Both readers fail OPEN (absent /
    // unavailable / throw ⇒ no tighten): this is a moderate-pressure
    // refinement, never a stall safety net — during a true stall the fresh
    // cgroup-% read above still gates and memwatch owns the kill. A
    // threshold <=0 disables that leg (review: `0.00 >= 0` would be
    // ALWAYS-TIGHTEN on the idle-baseline fleet; the schema floors at 0.1 —
    // this is defense in depth).
    try {
      const psi = this.deps.readPressure?.();
      if (psi?.available) {
        if (
          tighten.psiFull10 > 0 &&
          psi.cgFull10 !== null &&
          psi.cgFull10 >= tighten.psiFull10
        ) {
          return {
            admit: false,
            detail: { tighten: "psiFull10", value: psi.cgFull10 },
          };
        }
        if (
          tighten.psiSome60 > 0 &&
          psi.cgSome60 !== null &&
          psi.cgSome60 >= tighten.psiSome60
        ) {
          return {
            admit: false,
            detail: { tighten: "psiSome60", value: psi.cgSome60 },
          };
        }
      }
    } catch {
      // fail open
    }
    try {
      const signal = this.deps.getBalloonSignal?.() ?? null;
      if (signal?.anonBalloon) {
        return {
          admit: false,
          detail: { tighten: "anon-balloon", balloonPid: signal.balloonPid },
        };
      }
    } catch {
      // fail open
    }
    return { admit: true, detail: null };
  }

  private emit(
    action: "deferred" | "admitted-after-wait" | "rejected" | "advisory-block",
    cls: SpawnClass,
    name: string,
    extra: Record<string, unknown>,
  ): void {
    const st = this.classState(cls);
    this.deps.log.info(
      {
        tag: "spawn-governor",
        class: cls,
        name,
        action,
        active: st.active,
        queued: st.waitQueue.length,
        ...extra,
      },
      "spawn-governor",
    );
  }

  /**
   * Acquire a spawn slot for `name`. Returns the release fn (call in
   * `finally`). Throws SpawnAdmissionError only for ENFORCE classes.
   */
  async acquire(name: string): Promise<() => void> {
    const cfg = this.resolved();
    if (!cfg.enabled) return () => {};
    const cls = spawnClassOf(name);
    const { maxConcurrentSpawns, mode } = cfg.classCfg(cls);
    const st = this.classState(cls);
    const now = this.deps.now ?? Date.now;
    const sleep =
      this.deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));

    const makeRelease = (): (() => void) => {
      let released = false;
      return () => {
        if (released) return;
        released = true;
        st.active = Math.max(0, st.active - 1);
      };
    };

    const tightenCfg = {
      psiFull10: cfg.gateTightenPsiFull10,
      psiSome60: cfg.gateTightenPsiSome60,
    };

    // Fast path — capacity free and memory fine (advisory classes never
    // block regardless).
    if (st.waitQueue.length === 0 && st.active < maxConcurrentSpawns) {
      const verdict = await this.memoryAdmits(
        cfg.memoryWatermarkPercent,
        tightenCfg,
      );
      // G-2 review — atomic queue+slot RE-CHECK after the async memory read
      // (the enforce loop has always done this at its head re-check; the
      // fast path could over-admit past the cap when N concurrent acquires
      // all observed a free slot before any incremented). A lost slot falls
      // through to the enforce FIFO below.
      if (
        verdict.admit &&
        st.waitQueue.length === 0 &&
        st.active < maxConcurrentSpawns
      ) {
        st.active += 1;
        return makeRelease();
      }
      if (mode === "advisory") {
        // G-2 — under tighten too, the agent class stays advisory: operator /
        // boot / restart / wedge-recovery spawns must never hard-block.
        this.emit("advisory-block", cls, name, {
          reason: verdict.admit ? "concurrency" : "memory",
          ...(verdict.detail ?? {}),
        });
        st.active += 1;
        return makeRelease();
      }
    } else if (mode === "advisory") {
      this.emit("advisory-block", cls, name, { reason: "concurrency" });
      st.active += 1;
      return makeRelease();
    }

    // ENFORCE path — FIFO with head-recheck (WorkflowAdmissionGate
    // discipline, INC-2026-07-26).
    if (st.waitQueue.length >= cfg.queueDepthPerClass) {
      this.emit("rejected", cls, name, { reason: "queue-full" });
      throw new SpawnAdmissionError(
        "queue-full",
        `${cls} spawn queue is full (${cfg.queueDepthPerClass})`,
      );
    }
    const waiter = {};
    st.waitQueue.push(waiter);
    const deadline = now() + cfg.admissionTimeoutMs;
    const queuedAt = now();
    let deferredLogged = false;
    let lastBlock: "concurrency" | "memory" = "concurrency";
    // G-2 review — per-ACQUIRE tighten detail (a local, never instance
    // state), spread into deny emits only when the block is memory-shaped.
    let lastDetail: Record<string, unknown> | null = null;
    try {
      for (;;) {
        if (st.waitQueue[0] === waiter) {
          const verdict = await this.memoryAdmits(
            cfg.memoryWatermarkPercent,
            tightenCfg,
          );
          if (verdict.admit) {
            // Atomic head+slot re-check after the async memory read.
            if (st.waitQueue[0] === waiter && st.active < maxConcurrentSpawns) {
              st.active += 1;
              st.waitQueue.shift();
              if (deferredLogged) {
                this.emit("admitted-after-wait", cls, name, {
                  queuedMs: now() - queuedAt,
                });
              }
              return makeRelease();
            }
            lastBlock = "concurrency";
            lastDetail = null;
          } else {
            lastBlock = "memory";
            lastDetail = verdict.detail;
          }
        } else {
          lastBlock = "concurrency";
          lastDetail = null;
        }
        if (!deferredLogged) {
          deferredLogged = true;
          this.emit("deferred", cls, name, {
            reason: lastBlock,
            ...(lastDetail ?? {}),
          });
        }
        if (now() >= deadline) {
          // G-2 review — the TERMINAL deny line carries the tighten detail
          // too (it is the line an operator greps after a SpawnAdmissionError;
          // the matching deferred line can be a full admission window older).
          this.emit("rejected", cls, name, {
            reason: lastBlock,
            queuedMs: now() - queuedAt,
            ...(lastDetail ?? {}),
          });
          throw new SpawnAdmissionError(
            lastBlock,
            `${cls} spawn admission timed out after ${cfg.admissionTimeoutMs}ms (blocked on ${lastBlock})`,
          );
        }
        await sleep(POLL_MS);
      }
    } finally {
      const idx = st.waitQueue.indexOf(waiter);
      if (idx !== -1) st.waitQueue.splice(idx, 1);
    }
  }
}
