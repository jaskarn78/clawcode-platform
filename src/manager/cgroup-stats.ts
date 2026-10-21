/**
 * Phase 109-D — cgroup memory sampler.
 *
 * Reads the daemon's cgroup memory.current / memory.max from /sys/fs/cgroup
 * so observability can surface memory pressure BEFORE the cgroup OOM-kills
 * the daemon. systemd places the clawcode service under
 * /sys/fs/cgroup/system.slice/clawcode.service/ in cgroup v2; the daemon
 * runs inside that scope so the read is straightforward file I/O.
 *
 * Linux-only: returns null on any I/O error (including non-Linux dev
 * machines + container environments without cgroup v2). Non-fatal —
 * observability degrades to "unknown" rather than failing the heartbeat.
 *
 * No npm deps; built-in fs only.
 */

import { readFile } from "node:fs/promises";
import { resolveOwnCgroupDir } from "./memory-guard.js";

export type CgroupMemoryStats = {
  /** Bytes of resident memory currently charged to the cgroup. */
  readonly memoryCurrent: number;
  /** Bytes of the cgroup MemoryMax (or `null` when set to "max"). */
  readonly memoryMax: number | null;
  /**
   * 2026-07-31 memory program F2 — bytes of MemoryHigh (the kernel
   * reclaim/throttle line), or `null` when unset ("max").
   */
  readonly memoryHigh: number | null;
  /**
   * The EFFECTIVE ceiling: `min(memoryHigh, memoryMax)` when either is
   * set; null only when both are unbounded. This is the denominator every
   * pressure consumer must use — measuring against memoryMax alone let
   * the workflow admission gate admit workers directly into throttle
   * territory once MemoryHigh went live (85%×20G max = 100% of the 17G
   * high line).
   */
  readonly effectiveCeiling: number | null;
  /**
   * memoryCurrent / effectiveCeiling × 100, or null when unbounded.
   * F2 SEMANTIC CHANGE: previously percent-of-memoryMax; now
   * percent-of-effective-ceiling. All three consumers (workflow admission
   * gate, fleet-stats, preflight) deliberately inherit the new meaning.
   */
  readonly memoryPercent: number | null;
  /** Absolute path read from. */
  readonly path: string;
};

/**
 * Last-resort fallback only — F2 prefers the SELF-RESOLVED cgroup dir
 * (from /proc/self/cgroup via memory-guard's resolveOwnCgroupDir) so the
 * reader is correct even when the service name or slice changes.
 */
const DEFAULT_CGROUP_PATH = "/sys/fs/cgroup/system.slice/clawcode.service";

async function readCgroupNum(path: string): Promise<number | null> {
  const raw = (await readFile(path, "utf8")).trim();
  if (raw === "max") return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/**
 * Read the cgroup's memory.current + memory.max + memory.high.
 *
 * "max" is the cgroup v2 sentinel for unbounded — surfaced as null so
 * callers can render "unbounded" without sentinel detection.
 *
 * Returns null when memory.current is unreadable — host isn't Linux, the
 * service isn't running under systemd, or cgroup v2 isn't mounted.
 * memory.high being unreadable degrades to null (older kernels), never
 * fails the read.
 */
export async function readCgroupMemoryStats(
  cgroupPath?: string,
): Promise<CgroupMemoryStats | null> {
  const path = cgroupPath ?? resolveOwnCgroupDir() ?? DEFAULT_CGROUP_PATH;
  try {
    const [memoryCurrent, memoryMax, memoryHigh] = await Promise.all([
      readCgroupNum(`${path}/memory.current`),
      readCgroupNum(`${path}/memory.max`),
      readCgroupNum(`${path}/memory.high`).catch(() => null),
    ]);
    if (memoryCurrent === null) return null;
    const bounded = [memoryHigh, memoryMax].filter(
      (v): v is number => v !== null && v > 0,
    );
    const effectiveCeiling = bounded.length > 0 ? Math.min(...bounded) : null;
    const memoryPercent =
      effectiveCeiling === null
        ? null
        : (memoryCurrent / effectiveCeiling) * 100;
    return {
      memoryCurrent,
      memoryMax,
      memoryHigh,
      effectiveCeiling,
      memoryPercent,
      path,
    };
  } catch {
    return null;
  }
}
