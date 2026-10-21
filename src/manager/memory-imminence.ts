/**
 * 999.147 — imminence predicates + the three-tier alert router.
 *
 * Born from the 2026-09-16 operator screenshot: eight MemoryGuard pages in four
 * hours, on a box that was never close to failure (`memory.events` all zero —
 * never throttled in the service's lifetime — PSI flat at 0.00, 23 GB available
 * on the host). Their words: "One agent opening a browser triggers a warning
 * notification. I shouldn't get notified for memory spikes from day to day
 * agent work. If the memory spike is so significant that a failure or crash is
 * imminent then I should get a notification with a button to alleviate the
 * pressure."
 *
 * Two measured facts shape everything here.
 *
 * 1. **`class:*:rss` cannot be satisfied when a browser is open.** From the
 *    prod journal, one daemon, consecutive samples:
 *      other {count:16, rssMb:  280, anonMb: 108}
 *      other {count:23, rssMb:38653, anonMb:5548}
 *    …while the whole cgroup held `currentMb: 13084` against a 17408 MB
 *    ceiling. 38 GB of "resident memory" inside a 13 GB cgroup is not a tuning
 *    problem; summed `VmRSS` counts every shared page once per process, and a
 *    browser tree maps the same pages into each child. `anonMb` is the honest
 *    number — anonymous pages are private by construction, so they actually add
 *    up. Every RSS/count/instance rule therefore drops to TELEMETRY.
 *
 * 2. **`total:pct` was paging about page cache.** The `cgroup at 97% of
 *    ceiling` alert carried `anon 6524MB` — i.e. ~10 GB of the 16.9 GB was
 *    reclaimable file cache the kernel drops for free. The fraction that can
 *    actually kill the fleet is anon (swap is capped at 2 GiB by the 08-14
 *    kernel layer), so `anonPct = anon / ceiling` replaces `current / ceiling`.
 *
 * The result is a level→trajectory shift. Every rule that fired in the
 * screenshot is a LEVEL predicate, which is why routine work trips them; the
 * operator's criterion ("failure or crash is imminent") is a TRAJECTORY one.
 * The trajectory shape is copied from memwatch v2's kill policy — *still
 * growing* OR *aged*, with a grace period, never a bare threshold — because
 * that one is live-fire proven (2026-08-14: killed a growing hog at 7.5 GiB,
 * spared a plateaued 7 GB one across ~7 ticks).
 *
 * IMPORTANT — why trajectory rather than more PSI gating: through the 90-minute
 * climb into the real 2026-08-14 OOM kill, PSI read zero and `memory.events`
 * was FLAT. A kernel-corroboration gate suppresses every warning on the way up;
 * that is what the 999.115 `total:pct` regression test was defending. A
 * trajectory predicate reads the census's own deltas and needs no kernel
 * corroboration at all, so it preserves that test's INTENT — a quiet climb must
 * still page — while removing the static level that fires on page cache.
 *
 * Pure: no I/O, no Date, no env. The caller supplies samples and the clock.
 */

import type { Breach } from "./memory-guard.js";

// ---------------------------------------------------------------------------
// Tiers
// ---------------------------------------------------------------------------

/**
 * Where a breach is allowed to land.
 *
 * - `page`     — instant Discord post, carries a relief button. Imminence only.
 * - `digest`   — rolled into ONE message per day. Structural certainties and
 *                slow tells: real, but not worth an interrupt.
 * - `telemetry`— journal only. The census still records it (the summary line is
 *                unchanged), it simply never reaches Discord.
 */
export type AlertTier = "page" | "digest" | "telemetry";

/**
 * Default tier per breach key. Matched by exact key first, then by the
 * `class:<cls>:<rule>` rule suffix, so a new class inherits its rule's tier
 * without an entry here.
 *
 * The three `page` entries below are the ONLY things that may interrupt a
 * human, and each is a direct measurement of a resource actually running out —
 * not an inference from a process census.
 */
const EXACT_TIERS: Readonly<Record<string, AlertTier>> = Object.freeze({
  // --- PAGE: imminence + direct exhaustion of a real resource --------------
  "host:mem": "page", // host MemAvailable under floor — nothing left to give
  "host:disk": "page", // the ENOSPC fleet-down shape
  "daemon:heap": "page", // V8 heap limit — the daemon itself is about to die

  // --- DIGEST: true, bounded, and not an interrupt -------------------------
  // Structural leaks (a restart survivor, a Node shim that should not exist).
  // Definitionally wrong, but a leak that has sat there for hours can wait for
  // the daily rollup.
  "proc:anon-balloon": "digest",
  "cgroup:swap": "digest",

  // --- TELEMETRY: superseded ----------------------------------------------
  // Measures `current`, which is dominated by reclaimable page cache. The 97%
  // page in the operator's screenshot was 10 GB of file cache. Replaced by
  // `imminent:anon-ceiling`, which measures the unreclaimable fraction.
  "total:pct": "telemetry",
});

/**
 * Tier per `class:*:<rule>` suffix.
 *
 * `rss`, `count`, `instances` and `procs` are all process-census proxies — the
 * population this phase exists to silence. `anonswap` survives to `digest`
 * because it is the one class rule measuring a quantity that actually adds up.
 */
const CLASS_RULE_TIERS: Readonly<Record<string, AlertTier>> = Object.freeze({
  rss: "telemetry",
  count: "digest",
  instances: "telemetry",
  procs: "telemetry",
  anonswap: "digest",
});

/** Every `imminent:*` key pages. That is what the prefix means. */
export const IMMINENT_PREFIX = "imminent:";

/**
 * Resolve a breach key to its tier.
 *
 * `overrides` is the operator escape hatch (`defaults.memoryGuard.alertTiers`)
 * — hot-reloadable, so a mis-tiered rule can be re-routed mid-incident without
 * a deploy. An override may name an exact key (`"total:pct"`) or a class rule
 * suffix (`"class:*:rss"`).
 */
export function resolveTier(
  key: string,
  overrides?: Readonly<Record<string, AlertTier>>,
): AlertTier {
  if (overrides) {
    const exact = overrides[key];
    if (exact) return exact;
    const rule = classRuleOf(key);
    if (rule) {
      const wild = overrides[`class:*:${rule}`];
      if (wild) return wild;
    }
  }
  if (key.startsWith(IMMINENT_PREFIX)) return "page";
  const exact = EXACT_TIERS[key];
  if (exact) return exact;
  const rule = classRuleOf(key);
  if (rule) return CLASS_RULE_TIERS[rule] ?? "digest";
  // Unknown key: digest, never telemetry. A rule added later must not vanish
  // silently just because nobody tiered it — it surfaces once a day until
  // someone decides where it belongs.
  return "digest";
}

function classRuleOf(key: string): string | null {
  if (!key.startsWith("class:")) return null;
  const idx = key.lastIndexOf(":");
  return idx > 5 ? key.slice(idx + 1) : null;
}

// ---------------------------------------------------------------------------
// Trajectory
// ---------------------------------------------------------------------------

export interface TrajectoryPoint {
  readonly atMs: number;
  readonly mb: number;
}

/**
 * Append a sample, dropping points older than `windowMs`.
 *
 * Immutable — returns a new array (house rule; also keeps the guard's state
 * swap a single assignment, so a throwing tick can never leave a half-updated
 * window behind).
 */
export function pushPoint(
  prev: readonly TrajectoryPoint[],
  point: TrajectoryPoint,
  windowMs: number,
): readonly TrajectoryPoint[] {
  const cutoff = point.atMs - windowMs;
  return [...prev.filter((p) => p.atMs > cutoff), point];
}

/**
 * Least-squares slope in MB/min over the window, or null when there is not
 * enough spread to fit a line.
 *
 * Least-squares rather than first-vs-last: the census is noisy tick to tick (a
 * subagent spawning and exiting swings anon by hundreds of MB), and endpoint
 * differencing turns that noise into a phantom trend in whichever direction the
 * last sample happened to land.
 */
export function slopeMbPerMin(
  points: readonly TrajectoryPoint[],
  minPoints = 3,
  minSpanMs = 100_000,
): number | null {
  if (points.length < minPoints) return null;
  const first = points[0];
  const last = points[points.length - 1];
  if (last.atMs - first.atMs < minSpanMs) return null;

  const n = points.length;
  // Minutes relative to the first point — keeps the numbers small and the fit
  // numerically stable against raw epoch-ms x-values.
  const xs = points.map((p) => (p.atMs - first.atMs) / 60_000);
  const ys = points.map((p) => p.mb);
  const meanX = xs.reduce((a, b) => a + b, 0) / n;
  const meanY = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - meanX;
    num += dx * (ys[i] - meanY);
    den += dx * dx;
  }
  if (den === 0) return null;
  return num / den;
}

/**
 * Minutes until `currentMb` reaches `targetMb` at the measured slope.
 * `null` when flat, falling, or already past the target.
 */
export function etaMinutes(
  currentMb: number,
  targetMb: number,
  slope: number | null,
): number | null {
  if (slope === null || slope <= 0) return null;
  const gap = targetMb - currentMb;
  if (gap <= 0) return 0;
  return gap / slope;
}

// ---------------------------------------------------------------------------
// Imminence evaluation
// ---------------------------------------------------------------------------

export interface ImminenceConfig {
  /** anon/ceiling at or above which the fleet pages outright. */
  readonly anonCritPct: number;
  /** anon/ceiling at or above which a RISING trend pages. */
  readonly anonWarnPct: number;
  /** Projected time-to-ceiling that counts as imminent. */
  readonly etaMinutes: number;
  /** Consecutive samples a trajectory breach must hold before it pages. */
  readonly sustainSamples: number;
  /** Trajectory window. */
  readonly windowMs: number;
  /** Host MemAvailable floor for the falling-host predicate. */
  readonly hostFloorMb: number;
}

export const IMMINENCE_DEFAULTS: Readonly<ImminenceConfig> = Object.freeze({
  // 0.85 of a 17408 MB ceiling ≈ 14.8 GB of ANON. Live prod anon runs
  // 6.3-8.3 GB (36-48%), so this sits far above the working range — unlike the
  // 0.8 `total:pct` line, which prod crosses routinely on page cache alone.
  anonCritPct: 0.85,
  anonWarnPct: 0.75,
  etaMinutes: 10,
  sustainSamples: 2,
  windowMs: 15 * 60_000,
  hostFloorMb: 2048,
});

export interface ImminenceInput {
  readonly nowMs: number;
  readonly anonMb: number;
  readonly ceilingMb: number | null;
  readonly anonPoints: readonly TrajectoryPoint[];
  readonly hostAvailableMb: number | null;
  readonly hostPoints: readonly TrajectoryPoint[];
  /** `isCorroborated().actNow` — the kernel is already stalling. */
  readonly actNow: boolean;
  readonly actNowReason: string;
  /** `memory.events.oom_kill` delta since the previous sample. */
  readonly oomKillDelta: number;
  readonly cfg: ImminenceConfig;
}

export interface ImminenceBreach extends Breach {
  /**
   * False for predicates that are already proof rather than projection (an OOM
   * kill happened; the kernel is stalling now) — those page on the first
   * sample. True for slope-derived ones, which must hold `sustainSamples`
   * consecutive ticks so a single noisy census cannot page anybody.
   */
  readonly requiresSustain: boolean;
  /** True when the pressure is NOW — bypasses the 6h cooldown. */
  readonly actNow: boolean;
}

/**
 * The page-worthy set. Everything here is either a measured exhaustion in
 * progress or a projection with a deadline inside `etaMinutes`.
 */
export function evaluateImminence(
  input: ImminenceInput,
): readonly ImminenceBreach[] {
  const out: ImminenceBreach[] = [];
  const { cfg } = input;

  // --- Proof, not projection: something already died. ----------------------
  // DELTA, never the absolute counter. `memory.events` is cumulative, so one
  // kill six weeks ago would otherwise page forever (the rule that the PSI
  // readers were built on in WS3).
  if (input.oomKillDelta > 0) {
    out.push({
      key: "imminent:oom-kill",
      severity: "critical",
      requiresSustain: false,
      actNow: true,
      message: `kernel OOM-killed ${input.oomKillDelta} task(s) in this cgroup since the last sample — the fleet is already losing processes`,
    });
  }

  // --- Proof: the kernel says it is stalling right now. --------------------
  if (input.actNow) {
    out.push({
      key: "imminent:kernel-stall",
      severity: "critical",
      requiresSustain: false,
      actNow: true,
      message: `kernel memory pressure is active — ${input.actNowReason}`,
    });
  }

  // --- Projection: the unreclaimable fraction is closing on the ceiling. ---
  if (input.ceilingMb !== null && input.ceilingMb > 0) {
    const anonPct = input.anonMb / input.ceilingMb;
    const critMb = input.ceilingMb * cfg.anonCritPct;
    const slope = slopeMbPerMin(input.anonPoints);
    const eta = etaMinutes(input.anonMb, critMb, slope);

    if (anonPct >= cfg.anonCritPct) {
      out.push({
        key: "imminent:anon-ceiling",
        severity: "critical",
        requiresSustain: false,
        actNow: true,
        message: `unreclaimable memory at ${(anonPct * 100).toFixed(0)}% of the ceiling (anon ${input.anonMb}MB / ${input.ceilingMb}MB) — page cache cannot absorb this`,
      });
    } else if (
      anonPct >= cfg.anonWarnPct &&
      eta !== null &&
      eta <= cfg.etaMinutes
    ) {
      out.push({
        key: "imminent:anon-ceiling",
        severity: "warn",
        requiresSustain: true,
        actNow: false,
        message: `unreclaimable memory at ${(anonPct * 100).toFixed(0)}% of the ceiling (anon ${input.anonMb}MB / ${input.ceilingMb}MB) and climbing ${(slope ?? 0).toFixed(0)}MB/min — ~${eta.toFixed(0)} min to exhaustion`,
      });
    }
  }

  // --- Projection: the host itself is running out. -------------------------
  // The cgroup can be healthy while the box around it is not (the 08-14 shape
  // had the balloon inside the cgroup, but a neighbour service can do it too).
  if (input.hostAvailableMb !== null) {
    const hostSlope = slopeMbPerMin(input.hostPoints);
    // Falling availability = negative slope; ETA to the floor is the gap over
    // the fall rate.
    const falling = hostSlope !== null && hostSlope < 0;
    const eta = falling
      ? (input.hostAvailableMb - cfg.hostFloorMb) / -(hostSlope as number)
      : null;
    if (
      falling &&
      eta !== null &&
      eta >= 0 &&
      eta <= cfg.etaMinutes &&
      input.hostAvailableMb > cfg.hostFloorMb
    ) {
      out.push({
        key: "imminent:host-exhaustion",
        severity: "warn",
        requiresSustain: true,
        actNow: false,
        message: `host MemAvailable ${input.hostAvailableMb}MB falling ${Math.abs(hostSlope as number).toFixed(0)}MB/min — ~${eta.toFixed(0)} min to the ${cfg.hostFloorMb}MB floor`,
      });
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// Sustain bookkeeping
// ---------------------------------------------------------------------------

/**
 * Advance the consecutive-sample counters: keys present this tick increment,
 * keys absent reset to zero (dropped from the map).
 *
 * Kept separate from `evaluateImminence` so the predicate stays a pure function
 * of one sample and the "has this held?" question stays a pure function of the
 * counters — each testable without the other.
 */
export function advanceSustain(
  prev: Readonly<Record<string, number>>,
  activeKeys: readonly string[],
): Readonly<Record<string, number>> {
  const next: Record<string, number> = {};
  for (const key of activeKeys) next[key] = (prev[key] ?? 0) + 1;
  return next;
}

/** Filter to the breaches that have actually held long enough to page. */
export function sustained(
  breaches: readonly ImminenceBreach[],
  counters: Readonly<Record<string, number>>,
  cfg: ImminenceConfig,
): readonly ImminenceBreach[] {
  return breaches.filter(
    (b) =>
      !b.requiresSustain || (counters[b.key] ?? 0) >= cfg.sustainSamples,
  );
}
