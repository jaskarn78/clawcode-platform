/**
 * 999.147 WS-3 — memory pressure on Unraid.
 *
 * Nothing watched that box before this. The operator asked for the same deal
 * as the fleet: "tracked and admin clawdy notified with a path to alleviate
 * before a crash or failure occurs."
 *
 * Unraid is NOT clawdy, and the differences decide the design (all measured
 * on 10.0.0.1, 2026-09-16):
 *
 *   - **No PSI.** `/proc/pressure/memory` is absent — the kernel is built
 *     without CONFIG_PSI. The corroboration primitive the fleet guard leans on
 *     does not exist here, so trajectory is the ONLY imminence signal
 *     available.
 *   - **Zero swap.** `Swap: 0 0 0`. There is no thrash phase to detect;
 *     exhaustion goes straight to the OOM killer, which on that box means
 *     losing a container (frigate, teslamate, the transcription worker).
 *   - **It already sits at 84% used** (26.8 GB of 32 GB, 5.1 GB available,
 *     2.5 GB of it tmpfs). Any naive level threshold reproduces exactly the
 *     flood this phase exists to remove. Baseline the present, alert on the
 *     delta.
 *
 * One `/var/log` exception to the trajectory rule: that is a **128 MB tmpfs**,
 * and filling it is the classic Unraid GUI-death. A tmpfs never self-clears,
 * so its level IS the trend — a level rule there is correct, not lazy.
 *
 * Cost discipline: the cheap snapshot (free + df + an OOM grep) is one SSH
 * round trip in well under a second. `docker stats --no-stream` measured
 * **4.9 s** across 20+ containers, so it is gathered LAZILY — only on a tick
 * that has already crossed a threshold, because it exists to NAME the
 * offender, not to detect the problem.
 */

import {
  pushPoint,
  slopeMbPerMin,
  type TrajectoryPoint,
} from "../manager/memory-imminence.js";

/**
 * The cheap snapshot, as one shell command. Tab-separated, one line per fact,
 * so the parser never has to care about locale or column drift.
 *
 * `free -m` rather than reading /proc/meminfo directly: Unraid's busybox-ish
 * userland is consistent here and the `available` column already does the
 * reclaimable-cache arithmetic correctly.
 */
export const UNRAID_SNAPSHOT_CMD = [
  `free -m | awk '/^Mem:/{printf "mem\\t%s\\t%s\\n",$2,$7} /^Swap:/{printf "swap\\t%s\\t%s\\n",$2,$3}'`,
  `df -m /var/log | awk 'NR==2{printf "log\\t%s\\t%s\\n",$2,$3}'`,
  // grep -c prints 0 and EXITS 1 when there are no matches, which would fail
  // the whole command under `set -e`-ish runners; `|| true` keeps the tick
  // alive on a healthy box, which is the overwhelmingly common case.
  `printf 'oom\\t%s\\n' "$(grep -ci 'out of memory' /var/log/syslog 2>/dev/null || true)"`,
].join("; ");

/** Names the offender. Only gathered once a threshold is already crossed. */
export const UNRAID_CONTAINERS_CMD = `docker stats --no-stream --format '{{.Name}}\\t{{.MemUsage}}' 2>/dev/null | head -40`;

export interface UnraidSnapshot {
  readonly memTotalMb: number;
  readonly memAvailableMb: number;
  readonly swapTotalMb: number;
  readonly swapUsedMb: number;
  readonly logTotalMb: number;
  readonly logUsedMb: number;
  readonly oomCount: number;
}

/**
 * Parse the snapshot. Returns null when the memory line is missing — a
 * truncated or error-laden SSH response must not be read as "0 MB available"
 * and page the operator at 3am.
 */
export function parseUnraidSnapshot(text: string): UnraidSnapshot | null {
  const rows = new Map<string, number[]>();
  for (const line of text.split("\n")) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 2) continue;
    const nums = parts.slice(1).map(Number);
    if (nums.some((n) => !Number.isFinite(n))) continue;
    rows.set(parts[0], nums);
  }
  const mem = rows.get("mem");
  if (!mem || mem.length < 2 || mem[0] <= 0) return null;
  const swap = rows.get("swap") ?? [0, 0];
  const log = rows.get("log") ?? [0, 0];
  const oom = rows.get("oom") ?? [0];
  return {
    memTotalMb: mem[0],
    memAvailableMb: mem[1],
    swapTotalMb: swap[0] ?? 0,
    swapUsedMb: swap[1] ?? 0,
    logTotalMb: log[0] ?? 0,
    logUsedMb: log[1] ?? 0,
    oomCount: oom[0] ?? 0,
  };
}

export interface UnraidContainer {
  readonly name: string;
  readonly memMb: number;
}

/** Parse `docker stats` MemUsage (`1.628GiB / 31.24GiB`) into MB. */
export function parseUnraidContainers(text: string): readonly UnraidContainer[] {
  const out: UnraidContainer[] = [];
  for (const line of text.split("\n")) {
    const [name, usage] = line.split("\t");
    if (!name || !usage) continue;
    const m = /^([\d.]+)\s*([KMG]i?B)/i.exec(usage.trim());
    if (!m) continue;
    const value = Number(m[1]);
    if (!Number.isFinite(value)) continue;
    const unit = m[2].toUpperCase();
    const mb = unit.startsWith("G")
      ? value * 1024
      : unit.startsWith("K")
        ? value / 1024
        : value;
    out.push({ name: name.trim(), memMb: Math.round(mb) });
  }
  return out.sort((a, b) => b.memMb - a.memMb);
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

export interface UnraidWatchConfig {
  /** MemAvailable floor the trend is projected against. */
  readonly floorMb: number;
  /** Projected minutes-to-floor that counts as imminent. */
  readonly etaMinutes: number;
  /** Consecutive ticks a trajectory breach must hold. */
  readonly sustainSamples: number;
  /** `/var/log` tmpfs percentage that pages. */
  readonly logPctWarn: number;
  readonly windowMs: number;
}

export const UNRAID_WATCH_DEFAULTS: Readonly<UnraidWatchConfig> = Object.freeze({
  // 2 GB on a swapless 32 GB box. Below this the OOM killer is the next
  // event, not a possibility.
  floorMb: 2048,
  etaMinutes: 15,
  sustainSamples: 2,
  // 128 MB tmpfs: 90% is ~13 MB of headroom, minutes of logging under a
  // chatty container.
  logPctWarn: 90,
  windowMs: 30 * 60_000,
});

export interface UnraidBreach {
  readonly key: string;
  readonly severity: "warn" | "critical";
  readonly message: string;
  readonly requiresSustain: boolean;
  /** True when this tick should pay the 4.9s docker-stats cost. */
  readonly wantsOffender: boolean;
}

export interface UnraidEvalInput {
  readonly snap: UnraidSnapshot;
  readonly points: readonly TrajectoryPoint[];
  /** Previous tick's OOM counter; null on the first tick after a restart. */
  readonly previousOomCount: number | null;
  readonly cfg: UnraidWatchConfig;
}

export function evaluateUnraid(
  input: UnraidEvalInput,
): readonly UnraidBreach[] {
  const { snap, cfg } = input;
  const out: UnraidBreach[] = [];

  // --- OOM kills: proof, not projection. -----------------------------------
  // DELTA, and clamped at zero. The counter's source is /var/log/syslog on a
  // tmpfs, so it RESETS on reboot or log rotation — unlike cgroup
  // memory.events it is not monotonic across the box's life. An unclamped
  // delta would read a reset as a large negative and, on the next kill, as a
  // phantom spike. Clamping treats every decrease as a reset: the counter
  // rebaselines and the next real kill still pages.
  if (input.previousOomCount !== null) {
    const delta = snap.oomCount - input.previousOomCount;
    if (delta > 0) {
      out.push({
        key: "unraid:oom-kill",
        severity: "critical",
        requiresSustain: false,
        wantsOffender: true,
        message: `Unraid OOM-killed ${delta} process(es) since the last check — ${snap.memAvailableMb}MB available of ${snap.memTotalMb}MB`,
      });
    }
  }

  // --- /var/log tmpfs: a level rule, and correctly so. ---------------------
  if (snap.logTotalMb > 0) {
    const pct = (snap.logUsedMb / snap.logTotalMb) * 100;
    if (pct >= cfg.logPctWarn) {
      out.push({
        key: "unraid:log-tmpfs",
        severity: "critical",
        requiresSustain: false,
        wantsOffender: false,
        message: `Unraid \`/var/log\` is ${pct.toFixed(0)}% full (${snap.logUsedMb}MB of ${snap.logTotalMb}MB) — this is a RAM disk that never self-clears, and the webGUI stops working when it fills`,
      });
    }
  }

  // --- Memory: trajectory only. --------------------------------------------
  const slope = slopeMbPerMin(input.points);
  const falling = slope !== null && slope < 0;
  if (falling && snap.memAvailableMb > cfg.floorMb) {
    // Direct arithmetic rather than the etaMinutes helper: that one projects a
    // RISING series toward a ceiling, and mirroring it through negation here
    // would be clever at the cost of being readable at 3am.
    const eta = (snap.memAvailableMb - cfg.floorMb) / -(slope as number);
    if (eta >= 0 && eta <= cfg.etaMinutes) {
      out.push({
        key: "unraid:mem-exhaustion",
        severity: "warn",
        requiresSustain: true,
        wantsOffender: true,
        message: `Unraid memory falling ${Math.abs(slope as number).toFixed(0)}MB/min — ${snap.memAvailableMb}MB available, ~${eta.toFixed(0)} min to the ${cfg.floorMb}MB floor. There is NO SWAP on this box, so the OOM killer is the next event.`,
      });
    }
  }
  // Already under the floor: no projection needed, and no sustain — this is
  // the state the projection above exists to predict.
  if (snap.memAvailableMb <= cfg.floorMb) {
    out.push({
      key: "unraid:mem-exhaustion",
      severity: "critical",
      requiresSustain: false,
      wantsOffender: true,
      message: `Unraid is down to ${snap.memAvailableMb}MB available of ${snap.memTotalMb}MB, below the ${cfg.floorMb}MB floor, with no swap to fall back on`,
    });
  }

  return out;
}

/** Append this tick's availability sample to the trajectory window. */
export function recordUnraidPoint(
  points: readonly TrajectoryPoint[],
  snap: UnraidSnapshot,
  atMs: number,
  cfg: UnraidWatchConfig,
): readonly TrajectoryPoint[] {
  return pushPoint(points, { atMs, mb: snap.memAvailableMb }, cfg.windowMs);
}
