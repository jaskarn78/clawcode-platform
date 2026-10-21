/**
 * 999.106 G-2 (Design C §1) — census-derived memory signal, shared holder.
 *
 * The backpressure loop has TWO producers with deliberately different
 * freshness semantics:
 *   - PSI + cgroup-% are read ON-ACQUIRE by each gate (a single readFileSync,
 *     same cost as the cgroup read the gates already do at the FIFO head) —
 *     no staleness machinery, always fresh.
 *   - The anon-balloon flag genuinely needs the ~100-proc `/proc` census that
 *     `MemoryGuard.tick()` already runs every 60s — THAT is what this bus
 *     carries. MemoryGuard publishes at the end of each tick; the gates read
 *     through `get(maxAgeMs)` and treat null/stale as "no signal".
 *
 * DOCTRINE (stated out loud, per the design): this bus's producer is an
 * in-daemon 60s timer. During a genuine stall the daemon's event loop starves,
 * the timer does not fire, the signal goes stale precisely when pressure
 * peaks — and by fail-open design the loop then DISABLES ITSELF. That is
 * correct and intended: the fresh per-acquire cgroup-% + PSI reads still
 * gate, and memwatch (out-of-process, OOM-shielded) still kills. This loop is
 * a refinement for MODERATE pressure and EARLY growth, never a stall safety
 * net.
 *
 * Passive holder (publish/get) rather than a push model so MemoryGuard stays
 * ignorant of its consumers — no MemoryGuard → gates dependency edge.
 */

export interface MemorySignal {
  /** Producer clock at publish (Date.now in production). */
  readonly at: number;
  /** Fattest non-daemon anon+swap proc exceeds `gateBalloonMb`. */
  readonly anonBalloon: boolean;
  /** The balloon's pid, for the gates' deny-log line. Null when no balloon. */
  readonly balloonPid: number | null;
}

export class MemorySignalBus {
  private latest: MemorySignal | null = null;

  publish(signal: MemorySignal): void {
    this.latest = signal;
  }

  /** Null when never published OR older than `maxAgeMs` — the reader treats
   *  both as "no signal" (fail-open). */
  get(maxAgeMs: number, now: number = Date.now()): MemorySignal | null {
    return this.latest !== null && now - this.latest.at <= maxAgeMs
      ? this.latest
      : null;
  }
}
