/**
 * 999.106 G-2 (Design C §1) — backpressure loop unit pins.
 *
 * Three seams, all fail-open:
 *   - MemorySignalBus: passive holder + staleness window.
 *   - WorkflowAdmissionGate: PSI/balloon tighten defers the FIFO head
 *     (queue-not-kill), clears when pressure clears.
 *   - SpawnGovernor: tighten blocks ENFORCE classes only; the agent class
 *     stays advisory (operator/boot/restart spawns never hard-block).
 *   - MemoryGuard: publishes the balloon signal EVERY census tick.
 */
import { describe, it, expect } from "vitest";
import pino from "pino";
import { MemorySignalBus } from "../memory-signal-bus.js";
import {
  WorkflowAdmissionGate,
  WorkerAdmissionError,
} from "../workflow-admission-gate.js";
import { SpawnGovernor, SpawnAdmissionError } from "../spawn-governor.js";
import { MemoryGuard, type ProcSample } from "../memory-guard.js";

const silent = pino({ level: "silent" });

interface PsiState {
  available: boolean;
  cgFull10: number | null;
  cgSome60: number | null;
  throws?: boolean;
}

function makeGate(args: {
  psi?: PsiState;
  balloon?: { anonBalloon: boolean; balloonPid: number | null } | null;
  timeoutMs?: number;
  withThresholds?: boolean;
  thresholds?: { psiFull10: number; psiSome60: number };
}) {
  return new WorkflowAdmissionGate({
    getMaxConcurrent: () => 2,
    getMemoryHighWatermarkPercent: () => 85,
    getAdmissionTimeoutMs: () => args.timeoutMs ?? 300,
    readMemoryPercent: async () => 40,
    ...(args.psi
      ? {
          readPressure: () => {
            if (args.psi!.throws) throw new Error("synthetic PSI failure");
            return args.psi!;
          },
        }
      : {}),
    ...(args.balloon !== undefined
      ? { getBalloonSignal: () => args.balloon ?? null }
      : {}),
    ...((args.withThresholds ?? true)
      ? {
          getTightenThresholds: () =>
            args.thresholds ?? { psiFull10: 10, psiSome60: 10 },
        }
      : {}),
    now: () => Date.now(),
    sleep: () => new Promise((r) => setImmediate(r)),
    logger: silent,
    pollMs: 1,
  });
}

describe("MemorySignalBus (999.106 G-2)", () => {
  it("returns the latest signal while fresh, null when stale or never published", () => {
    const bus = new MemorySignalBus();
    expect(bus.get(180_000, 1_000_000)).toBeNull();
    bus.publish({ at: 1_000_000, anonBalloon: true, balloonPid: 42 });
    expect(bus.get(180_000, 1_100_000)).toMatchObject({ balloonPid: 42 });
    // 3 ticks + 1ms past → stale → null (the self-disabling doctrine).
    expect(bus.get(180_000, 1_180_001)).toBeNull();
  });
});

describe("WorkflowAdmissionGate — pressure tighten (999.106 G-2)", () => {
  it("psiFull10 over the line defers the head to the admission timeout (queue-not-kill)", async () => {
    const gate = makeGate({
      psi: { available: true, cgFull10: 25, cgSome60: 0 },
    });
    await expect(gate.acquire()).rejects.toThrowError(WorkerAdmissionError);
    await expect(gate.acquire()).rejects.toMatchObject({ reason: "memory" });
  });

  it("psiSome60 over the line also tightens", async () => {
    const gate = makeGate({
      psi: { available: true, cgFull10: 0, cgSome60: 30 },
    });
    await expect(gate.acquire()).rejects.toMatchObject({ reason: "memory" });
  });

  it("admits once pressure clears mid-wait (defer, not kill)", async () => {
    const psi: PsiState = { available: true, cgFull10: 25, cgSome60: 0 };
    const gate = makeGate({ psi, timeoutMs: 10_000 });
    const pending = gate.acquire();
    setTimeout(() => {
      psi.cgFull10 = 0;
    }, 20);
    const release = await pending;
    expect(gate.activeCount).toBe(1);
    release();
  });

  it("a fresh anon-balloon signal tightens; a stale/null one is ignored", async () => {
    const blocked = makeGate({
      psi: { available: true, cgFull10: 0, cgSome60: 0 },
      balloon: { anonBalloon: true, balloonPid: 777 },
    });
    await expect(blocked.acquire()).rejects.toMatchObject({ reason: "memory" });

    const stale = makeGate({
      psi: { available: true, cgFull10: 0, cgSome60: 0 },
      balloon: null, // bus.get returned null (stale / never published)
    });
    const release = await stale.acquire();
    release();
  });

  it("a threshold of 0 DISABLES that leg, never always-tightens (review: 0.00 >= 0)", async () => {
    // Idle-baseline PSI is exactly 0.00 — a 0 threshold must not match it.
    const gate = makeGate({
      psi: { available: true, cgFull10: 0, cgSome60: 0 },
      thresholds: { psiFull10: 0, psiSome60: 0 },
    });
    const release = await gate.acquire();
    release();
  });

  it("fails OPEN: PSI unavailable, PSI throwing, or no thresholds getter all admit", async () => {
    for (const gate of [
      makeGate({ psi: { available: false, cgFull10: 99, cgSome60: 99 } }),
      makeGate({
        psi: { available: true, cgFull10: 99, cgSome60: 99, throws: true },
      }),
      makeGate({
        psi: { available: true, cgFull10: 99, cgSome60: 99 },
        withThresholds: false,
      }),
    ]) {
      const release = await gate.acquire();
      release();
    }
  });
});

describe("SpawnGovernor — pressure tighten (999.106 G-2)", () => {
  function makeGovernor(args: {
    psi?: PsiState;
    balloon?: { anonBalloon: boolean; balloonPid: number | null } | null;
    sink?: Record<string, unknown>[];
    cfg?: Record<string, unknown>;
  }) {
    const log = args.sink
      ? pino(
          { level: "info" },
          {
            write(line: string) {
              try {
                args.sink!.push(JSON.parse(line) as Record<string, unknown>);
              } catch {
                /* ignore */
              }
            },
          },
        )
      : silent;
    return new SpawnGovernor({
      resolveConfig: () =>
        ({ admissionTimeoutMs: 100, ...(args.cfg ?? {}) }) as never,
      readMemoryPercent: async () => 40,
      ...(args.psi ? { readPressure: () => args.psi! } : {}),
      ...(args.balloon !== undefined
        ? { getBalloonSignal: () => args.balloon ?? null }
        : {}),
      log,
      sleep: () => new Promise((r) => setImmediate(r)),
    });
  }

  it("tighten blocks an ENFORCE class (worker) to the admission timeout", async () => {
    const g = makeGovernor({
      psi: { available: true, cgFull10: 25, cgSome60: 0 },
    });
    await expect(g.acquire("p-sub-x1y2z3")).rejects.toThrowError(
      SpawnAdmissionError,
    );
    await expect(g.acquire("p-sub-a1b2c3")).rejects.toMatchObject({
      reason: "memory",
    });
  });

  it("the agent class stays ADVISORY under tighten: logs advisory-block and admits", async () => {
    const sink: Record<string, unknown>[] = [];
    const g = makeGovernor({
      psi: { available: true, cgFull10: 25, cgSome60: 0 },
      sink,
    });
    const release = await g.acquire("personal");
    release();
    const advisory = sink.find((l) => l.action === "advisory-block");
    expect(advisory).toBeDefined();
    expect(advisory).toMatchObject({ reason: "memory", tighten: "psiFull10" });
  });

  it("a fresh balloon signal blocks enforce classes; deny log names the pid", async () => {
    const sink: Record<string, unknown>[] = [];
    const g = makeGovernor({
      psi: { available: true, cgFull10: 0, cgSome60: 0 },
      balloon: { anonBalloon: true, balloonPid: 777 },
      sink,
    });
    await expect(g.acquire("p-sub-x1y2z3")).rejects.toMatchObject({
      reason: "memory",
    });
    const deferred = sink.find((l) => l.action === "deferred");
    expect(deferred).toMatchObject({
      tighten: "anon-balloon",
      balloonPid: 777,
    });
  });

  it("fails OPEN when PSI is unavailable and no balloon signal is wired", async () => {
    const g = makeGovernor({
      psi: { available: false, cgFull10: 99, cgSome60: 99 },
    });
    const release = await g.acquire("p-sub-x1y2z3");
    release();
  });

  it("a threshold of 0 DISABLES that leg (review: 0.00 >= 0 would always-tighten)", async () => {
    const g = makeGovernor({
      psi: { available: true, cgFull10: 0, cgSome60: 0 },
      cfg: { gateTightenPsiFull10: 0, gateTightenPsiSome60: 0 },
    });
    const release = await g.acquire("p-sub-x1y2z3");
    release();
  });

  it("the TERMINAL rejected emit names the tighten detail too (review)", async () => {
    const sink: Record<string, unknown>[] = [];
    const g = makeGovernor({
      psi: { available: true, cgFull10: 0, cgSome60: 0 },
      balloon: { anonBalloon: true, balloonPid: 777 },
      sink,
    });
    await expect(g.acquire("p-sub-x1y2z3")).rejects.toMatchObject({
      reason: "memory",
    });
    const rejected = sink.find((l) => l.action === "rejected");
    expect(rejected).toMatchObject({
      reason: "memory",
      tighten: "anon-balloon",
      balloonPid: 777,
    });
  });
});

describe("MemoryGuard — gate-tighten signal publish (999.106 G-2)", () => {
  const DAEMON_PID = 1000;
  const balloonProc: ProcSample = {
    pid: 4242,
    ppid: 1,
    rssKb: 500_000,
    anonKb: 5 * 1024 * 1024, // 5 GiB anon — over the 4 GiB gate line
    swapKb: 1 * 1024 * 1024,
    comm: "ugrep",
    args: "ugrep -r pattern /",
  };

  function tickOnce(procs: ProcSample[]) {
    const published: {
      at: number;
      anonBalloon: boolean;
      balloonPid: number | null;
    }[] = [];
    const guard = new MemoryGuard({
      log: silent,
      resolveConfig: () => ({}),
      daemonPid: DAEMON_PID,
      readers: {
        readCgroup: () => ({
          currentBytes: 10 * 1024 ** 3,
          ceilingBytes: 17 * 1024 ** 3,
          anonBytes: 8 * 1024 ** 3,
          fileBytes: 2 * 1024 ** 3,
        }),
        listProcs: () => procs,
        readHost: () => ({
          availableMb: 8000,
          swapFreeMb: 8000,
          rootDiskFreeGb: 50,
        }),
      },
      now: () => 5_000_000,
      publishMemorySignal: (s) => published.push(s),
    });
    guard.tick();
    return published;
  }

  it("publishes anonBalloon:true with the pid when a proc crosses gateBalloonMb", () => {
    const published = tickOnce([balloonProc]);
    expect(published).toEqual([
      { at: 5_000_000, anonBalloon: true, balloonPid: 4242 },
    ]);
  });

  it("publishes anonBalloon:false EVERY tick when healthy (silence = dead producer)", () => {
    const published = tickOnce([
      { ...balloonProc, anonKb: 100_000, swapKb: 0 },
    ]);
    expect(published).toEqual([
      { at: 5_000_000, anonBalloon: false, balloonPid: null },
    ]);
  });
});
