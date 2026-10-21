/**
 * Kernel memory-PRESSURE readers (PSI + cgroup reclaim events).
 *
 * WHY (INC-2026-08-09). MemoryGuard judged memory trouble entirely from raw
 * usage and process counts, and paged `chrome count 17 over budget 12` while
 * every authoritative kernel metric read exactly zero: cgroup `memory.pressure`
 * all zeros, `memory.events` never throttled once, 6.25G of a 17G soft ceiling.
 * Nothing in the codebase read /proc/pressure or memory.pressure at all.
 *
 * PSI (pressure stall information) is the canonical signal: it measures time
 * tasks actually STALLED waiting on memory, which is the thing an operator
 * cares about. `memory.events` is the corroborating fact — the kernel
 * incrementing `high`/`max` means it really did throttle this cgroup.
 *
 * TWO RULES THIS MODULE EXISTS TO ENFORCE:
 *
 *  1. DELTAS, NEVER ABSOLUTES. `memory.events` counters are CUMULATIVE for the
 *     life of the cgroup. Testing an absolute would mean one throttle six weeks
 *     ago permanently un-gates every alert forever. Corroboration is always a
 *     change since the previous sample — and the first sample after a daemon
 *     restart therefore cannot corroborate, by construction.
 *  2. FAIL OPEN. A kernel without CONFIG_PSI, or a cgroup v1 host, returns null
 *     here. Callers must treat null as "cannot corroborate ⇒ allow the alert",
 *     never as "no pressure ⇒ suppress". A gate that fails closed silently
 *     disables the guard, which is the exact invisible-degradation failure this
 *     work exists to remove.
 */

import { readFileSync } from "node:fs";

/** One PSI line: `some avg10=0.00 avg60=0.00 avg300=0.00 total=0`. */
export interface PsiLine {
  readonly avg10: number;
  readonly avg60: number;
  readonly avg300: number;
  readonly total: number;
}

export interface PsiSample {
  readonly some: PsiLine | null;
  readonly full: PsiLine | null;
}

/** cgroup v2 memory.events — cumulative reclaim/OOM counters. */
export interface MemoryEvents {
  readonly low: number;
  readonly high: number;
  readonly max: number;
  readonly oom: number;
  readonly oomKill: number;
}

/** Everything the corroboration rule needs from one tick. */
export interface PressureSample {
  /** False when PSI is unreadable (no CONFIG_PSI / cgroup v1) ⇒ fail open. */
  readonly available: boolean;
  /** cgroup `some` avg60 — the primary in-the-moment stall measure. */
  readonly cgSome60: number | null;
  /** cgroup `full` avg60 — every non-idle task stalled. Pathological. */
  readonly cgFull60: number | null;
  /** cgroup `full` avg10 — the fast "everyone is stalling NOW" signal the
   *  999.106 G-2 gate-tighten condition reads (10s window reacts inside one
   *  admission poll cycle where avg60 lags). */
  readonly cgFull10: number | null;
  /** host-wide `some` avg60, for host-scoped findings. */
  readonly hostSome60: number | null;
  readonly events: MemoryEvents | null;
}

/** Parse one PSI file body. Returns nulls for lines that are absent. */
export function parsePsi(text: string): PsiSample {
  const line = (prefix: string): PsiLine | null => {
    const row = text
      .split("\n")
      .find((l) => l.trim().startsWith(`${prefix} `));
    if (!row) return null;
    const num = (k: string): number => {
      const m = new RegExp(`${k}=([0-9.]+)`).exec(row);
      return m ? Number(m[1]) : 0;
    };
    return {
      avg10: num("avg10"),
      avg60: num("avg60"),
      avg300: num("avg300"),
      total: num("total"),
    };
  };
  return { some: line("some"), full: line("full") };
}

/** Parse cgroup v2 `memory.events` (`key value` per line). */
export function parseMemoryEvents(text: string): MemoryEvents {
  const get = (k: string): number => {
    const row = text.split("\n").find((l) => l.startsWith(`${k} `));
    return row ? Number(row.split(/\s+/)[1]) || 0 : 0;
  };
  return {
    low: get("low"),
    high: get("high"),
    max: get("max"),
    oom: get("oom"),
    oomKill: get("oom_kill"),
  };
}

function readOrNull(path: string): string | null {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return null;
  }
}

/**
 * Production reader. Every field degrades independently: a host without PSI
 * still yields `events`, and vice versa.
 */
export function readPressure(cgroupDir: string | null): PressureSample {
  const cgPsiRaw = cgroupDir ? readOrNull(`${cgroupDir}/memory.pressure`) : null;
  const hostPsiRaw = readOrNull("/proc/pressure/memory");
  const eventsRaw = cgroupDir ? readOrNull(`${cgroupDir}/memory.events`) : null;

  const cgPsi = cgPsiRaw ? parsePsi(cgPsiRaw) : null;
  const hostPsi = hostPsiRaw ? parsePsi(hostPsiRaw) : null;

  return {
    available: cgPsiRaw !== null || hostPsiRaw !== null,
    cgSome60: cgPsi?.some?.avg60 ?? null,
    cgFull60: cgPsi?.full?.avg60 ?? null,
    cgFull10: cgPsi?.full?.avg10 ?? null,
    hostSome60: hostPsi?.some?.avg60 ?? null,
    events: eventsRaw ? parseMemoryEvents(eventsRaw) : null,
  };
}

/**
 * Thresholds.
 *
 * Calibrated against the live fleet baseline, which is exactly 0.00 on
 * avg10/avg60/avg300 with `memory.events` all-zero since boot and
 * `memory.current` at ~37% of the 17G `memory.high`. So these do NOT separate
 * "busy" from "idle" — they separate ZERO from NONZERO.
 */
export const PRESSURE_THRESHOLDS = Object.freeze({
  /**
   * ~600ms of stall per minute: ~100x above sensor noise on a box reading
   * 0.00, and ~2 orders of magnitude below anything a human would notice.
   * This is the "something real is happening" line, not "act now".
   */
  corroborateSome60: 1.0,
  /** Host-scoped findings need a much louder host signal to corroborate. */
  hostCorroborateSome60: 5.0,
  /** ACT NOW. */
  actNowSome60: 10.0,
  /**
   * `full` means every non-idle task stalled. On a cgroup at 37% with zero
   * lifetime throttle events, any sustained `full` is pathological by
   * definition — there is no benign explanation.
   */
  actNowFull60: 1.0,
});

export interface CorroborationInput {
  readonly current: PressureSample;
  /** Previous tick's events, for the delta. Null on the first tick. */
  readonly previousEvents: MemoryEvents | null;
  /** Host-scoped findings use the host PSI line instead of the cgroup's. */
  readonly scope?: "cgroup" | "host";
}

export interface CorroborationVerdict {
  readonly corroborated: boolean;
  readonly actNow: boolean;
  /** Why — for the alert body, so an operator never has to ask. */
  readonly reason: string;
}

/**
 * Does independent kernel evidence support a PROXY breach right now?
 *
 * Order is deliberate: an event that actually HAPPENED (the kernel throttled
 * this cgroup) beats a smoothed percentage that needs its own calibration.
 */
export function isCorroborated(input: CorroborationInput): CorroborationVerdict {
  const { current, previousEvents } = input;

  // FAIL OPEN — never let a missing sensor silence the guard.
  if (!current.available) {
    return {
      corroborated: true,
      actNow: false,
      reason: "PSI unavailable on this kernel — alerting ungated (fail-open)",
    };
  }

  // PRIMARY: reclaim/throttle events since the previous sample.
  if (current.events && previousEvents) {
    const dHigh = current.events.high - previousEvents.high;
    const dMax = current.events.max - previousEvents.max;
    if (dHigh > 0 || dMax > 0) {
      return {
        corroborated: true,
        actNow: dMax > 0,
        reason: `cgroup throttled since last sample (high +${dHigh}, max +${dMax})`,
      };
    }
  }

  // SECONDARY: measured stall.
  const some60 =
    input.scope === "host" ? current.hostSome60 : current.cgSome60;
  const floor =
    input.scope === "host"
      ? PRESSURE_THRESHOLDS.hostCorroborateSome60
      : PRESSURE_THRESHOLDS.corroborateSome60;
  const full60 = current.cgFull60 ?? 0;
  const actNow =
    (some60 ?? 0) >= PRESSURE_THRESHOLDS.actNowSome60 ||
    full60 >= PRESSURE_THRESHOLDS.actNowFull60;

  if (some60 !== null && some60 >= floor) {
    return {
      corroborated: true,
      actNow,
      reason: `memory stall ${some60.toFixed(2)}% (avg60)${full60 > 0 ? `, full ${full60.toFixed(2)}%` : ""}`,
    };
  }

  const throttles = current.events
    ? current.events.high + current.events.max
    : null;
  return {
    corroborated: false,
    actNow: false,
    reason:
      previousEvents === null
        ? "no prior sample yet (first tick after restart) — cannot corroborate"
        : `no kernel pressure: stall ${some60 === null ? "n/a" : `${some60.toFixed(2)}%`}, lifetime throttles ${throttles ?? "n/a"}`,
  };
}

/** Compact fields for the periodic summary line. */
export function pressureSummaryFields(
  sample: PressureSample,
  previousEvents: MemoryEvents | null,
): Record<string, unknown> {
  return {
    psiAvailable: sample.available,
    psiCgSome60: sample.cgSome60,
    psiCgFull60: sample.cgFull60,
    psiHostSome60: sample.hostSome60,
    eventsHigh: sample.events?.high ?? null,
    eventsMax: sample.events?.max ?? null,
    eventsOomKill: sample.events?.oomKill ?? null,
    eventsHighDelta:
      sample.events && previousEvents
        ? sample.events.high - previousEvents.high
        : null,
  };
}
