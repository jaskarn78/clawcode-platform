/**
 * Phase 109-D — fleet-wide observability snapshot builder.
 *
 * Pure helper that walks /proc once + reads the cgroup memory files once
 * and assembles the FleetStatsData shape for the daemon's `fleet-stats`
 * IPC handler.
 *
 * Linux-only signals (cgroup, /proc) degrade to null on hosts where they
 * are unavailable rather than throwing — observability must never crash
 * the daemon.
 *
 * Reuses (no new substrate):
 *   - `listAllPids`, `readProcInfo`, `matchesAnyMcpCommand` from proc-scan
 *   - `readCgroupMemoryStats` from cgroup-stats
 *
 * Emits no logs of its own; the IPC handler logs success/failure once per
 * call.
 */

import { readFile } from "node:fs/promises";
import {
  listAllPids,
  readProcInfo,
  type ProcInfo,
} from "../mcp/proc-scan.js";
import { readCgroupMemoryStats } from "./cgroup-stats.js";
import type { FleetStatsData } from "../dashboard/types.js";

/** A claude proc cmdline like `/usr/bin/claude` or just `claude` (npm bin shim). */
const CLAUDE_CMDLINE_RE = /(?:^|\/)claude$/;

/**
 * Match the argv0 of a /proc cmdline against the canonical claude binary
 * shape. Identical regex to `discoverClaudeSubprocessPid` in
 * proc-scan.ts:306 — keep them in sync.
 */
export function cmdlineMatchesClaude(cmdline: readonly string[]): boolean {
  const argv0 = cmdline[0] ?? "";
  return CLAUDE_CMDLINE_RE.test(argv0);
}

/**
 * Phase 110 Stage 0a — runtime classification for an MCP shim/server.
 *
 *   - "node":     Loader-auto-injected `clawcode {search,image,browser}-mcp`
 *                 (or `mcp-broker-shim`) running under the bundled Node
 *                 CLI — current production runtime.
 *   - "static":   Stage 0b's static-binary alternate runtime — Go binary
 *                 deployed at /opt/clawcode/bin/clawcode-mcp-shim, dispatched
 *                 via `--type <search|image|browser>`. Recognized by basename.
 *   - "python":   Stage 0b's python-wrapper alternate runtime (reserved —
 *                 implementation deferred). Recognized via the
 *                 `python3 /path/to/clawcode-mcp-shim.py` cmdline shape.
 *   - "external": Yaml-defined entries the loader does NOT auto-inject
 *                 (e.g. brave_search.py, fal_ai.py, mcp-server-mysql).
 *                 These are out of scope for shim-runtime swap.
 */
export type McpRuntime = "node" | "static" | "python" | "external";

/**
 * Phase 110 Stage 0b — classify a /proc cmdline by its runtime cohort.
 *
 * Pure function; no I/O. Used to label MCP shim children so /api/fleet-stats
 * can split the fleet into runtime cohorts (Stage 0/1 memory-reduction
 * targets vs. external servers).
 *
 * Match strategy: argv0 basename (path-agnostic). The Wave 2 deploy
 * installs the Go binary at /opt/clawcode/bin/clawcode-mcp-shim, but a dev
 * build may live at any path. Matching the basename keeps both code paths
 * in scope without an explicit allowlist.
 *
 * Distinction between Stage 0b's reserved Python translator and the
 * generic Python externals (brave_search.py, fal_ai.py) is by argv[1]
 * basename — only `clawcode-mcp-shim.py` triggers the "python" runtime.
 * Everything else under `python` / `python3` falls through to "external"
 * (preserves Stage 0a behavior).
 */
export function classifyShimRuntime(cmdline: readonly string[]): McpRuntime {
  if (cmdline.length === 0) return "external";
  const argv0 = cmdline[0]!;
  const basename = argv0.split("/").pop() ?? argv0;

  // Phase 110 Stage 0b — Go static binary basename.
  if (basename === "clawcode-mcp-shim") return "static";

  // Phase 110 Stage 0b — reserved Python translator. Distinguish from
  // generic Python externals (brave_search.py, fal_ai.py, …) by inspecting
  // argv[1]'s basename for the clawcode-mcp-shim.py marker.
  if (basename === "python3" || basename === "python") {
    const arg1 = cmdline[1] ?? "";
    const arg1Base = arg1.split("/").pop() ?? arg1;
    if (arg1Base === "clawcode-mcp-shim.py") return "python";
    return "external"; // brave_search.py, fal_ai.py — Stage 0a behavior preserved.
  }

  // Stage 0a — Node bundled CLI shim (`clawcode <type>-mcp`).
  if (basename === "clawcode") return "node";

  // Anything else (1Password broker via npx, dumb-pipe externals, etc.)
  return "external";
}

/**
 * Per-pattern aggregate over a list of MCP cmdline regexes.
 *
 * Each entry's `pattern` is the human-readable pattern label (e.g.
 * "mcp-server-mysql"); the daemon caller derives these from the configured
 * mcpServers map. Procs whose cmdline matches multiple patterns are
 * counted once per matching pattern (intentional — operator can see which
 * label is responsible). RSS is summed in MB.
 *
 * Phase 110 Stage 0a — `runtime` lets `/api/fleet-stats` consumers split
 * the fleet into shim-runtime cohorts (the targets of Stage 0 / Stage 1
 * memory-reduction work) vs. external servers (out of scope). The summary
 * `shimRuntimeBaseline` field on the parent `FleetStatsData` rolls these
 * up so dashboards can show the win headline without iterating per-pattern.
 */
export type McpFleetAggregate = {
  readonly pattern: string;
  readonly count: number;
  readonly rssMB: number;
  readonly runtime: McpRuntime;
};

/** Read VmRSS from /proc/[pid]/status (kB). Returns 0 on failure. */
export async function readProcRssMB(pid: number): Promise<number> {
  try {
    const status = await readFile(`/proc/${pid}/status`, "utf8");
    const match = status.match(/^VmRSS:\s*(\d+)\s*kB/m);
    if (!match) return 0;
    return Number(match[1]) / 1024;
  } catch {
    return 0;
  }
}

/**
 * Walk every pid in /proc once and aggregate by MCP pattern + count
 * claude procs. Cheap when /proc has ~1k entries (single readdir, 1k
 * concurrent reads).
 *
 * Returns null when /proc is unavailable (non-Linux dev machines, sealed
 * containers without procfs).
 */
export async function buildFleetStats(args: {
  readonly daemonPid: number;
  readonly trackedClaudeCount: number;
  /**
   * Phase 110 Stage 0a — element shape now carries `runtime` so the
   * daemon-side classification (loader-auto-injected shims vs.
   * yaml-defined externals) flows through to /api/fleet-stats consumers
   * without re-deriving from the cmdline at the dashboard boundary.
   */
  readonly mcpPatterns: ReadonlyArray<{
    readonly label: string;
    readonly regex: RegExp;
    readonly runtime: McpRuntime;
  }>;
  readonly cgroupPath?: string;
  /** Test seam — defaults to readProcRssMB. Tests inject deterministic values. */
  readonly readRssMB?: (pid: number) => Promise<number>;
}): Promise<FleetStatsData> {
  const readRss = args.readRssMB ?? readProcRssMB;
  const sampledAt = Date.now();
  const cgroupSnap = await readCgroupMemoryStats(args.cgroupPath);
  const cgroup = cgroupSnap
    ? {
        memoryCurrentBytes: cgroupSnap.memoryCurrent,
        memoryMaxBytes: cgroupSnap.memoryMax,
        memoryPercent: cgroupSnap.memoryPercent,
      }
    : null;

  let pids: readonly number[];
  try {
    pids = await listAllPids();
  } catch {
    return {
      cgroup,
      claudeProcDrift: null,
      mcpFleet: [],
      shimRuntimeBaseline: null,
      noWebhookFallbacksTotal: snapshotNoWebhookFallbacks(),
      sampledAt,
    };
  }

  const infos = await Promise.all(
    pids.map(async (pid) => {
      try {
        return await readProcInfo(pid);
      } catch {
        return null;
      }
    }),
  );

  let claudeLiveCount = 0;
  const aggByLabel = new Map<
    string,
    { count: number; rssKB: number; runtime: McpRuntime }
  >();
  for (const p of args.mcpPatterns) {
    aggByLabel.set(p.label, { count: 0, rssKB: 0, runtime: p.runtime });
  }

  const rssReads: Array<Promise<void>> = [];
  for (const info of infos) {
    if (!info) continue;
    if (cmdlineMatchesClaude(info.cmdline)) claudeLiveCount += 1;
    const cmdlineStr = info.cmdline.join(" ");
    for (const { label, regex } of args.mcpPatterns) {
      if (regex.test(cmdlineStr)) {
        const slot = aggByLabel.get(label)!;
        slot.count += 1;
        rssReads.push(
          readRss(info.pid).then((mb) => {
            slot.rssKB += mb * 1024;
          }),
        );
      }
    }
  }
  await Promise.all(rssReads);

  const mcpFleet: McpFleetAggregate[] = [];
  for (const [label, { count, rssKB, runtime }] of aggByLabel) {
    mcpFleet.push({
      pattern: label,
      count,
      rssMB: Math.round(rssKB / 1024),
      runtime,
    });
  }
  // Stable order: alphabetical, plays well with snapshot tests + greppable
  // operator output.
  mcpFleet.sort((a, b) => a.pattern.localeCompare(b.pattern));

  return {
    cgroup,
    claudeProcDrift: {
      liveCount: claudeLiveCount,
      trackedCount: args.trackedClaudeCount,
      drift: Math.max(0, claudeLiveCount - args.trackedClaudeCount),
    },
    mcpFleet,
    shimRuntimeBaseline: buildShimRuntimeBaseline(mcpFleet),
    noWebhookFallbacksTotal: snapshotNoWebhookFallbacks(),
    sampledAt,
  };
}

/**
 * Phase 110 Stage 0a — roll up `mcpFleet` entries by runtime so dashboards
 * can show "{count} shims, {rssMB} MB on node runtime" without iterating.
 *
 * Skips `runtime: "external"` (yaml-defined entries are not in scope for
 * the Stage 0 swap). Returns `null` when there are no shim-runtime
 * entries at all (e.g. a host without auto-inject — distinguish from
 * "all-zero" baseline so the dashboard renderer can show "unknown" vs.
 * "0 shims").
 */
function buildShimRuntimeBaseline(
  mcpFleet: ReadonlyArray<McpFleetAggregate>,
): FleetStatsData["shimRuntimeBaseline"] {
  const buckets: Partial<Record<
    Exclude<McpRuntime, "external">,
    { count: number; rssMB: number }
  >> = {};
  let any = false;
  for (const entry of mcpFleet) {
    if (entry.runtime === "external") continue;
    any = true;
    const slot = buckets[entry.runtime] ?? { count: 0, rssMB: 0 };
    slot.count += entry.count;
    slot.rssMB += entry.rssMB;
    buckets[entry.runtime] = slot;
  }
  if (!any) return null;
  // Always include "node" key (even at 0/0) so the headline metric shape
  // is stable for dashboards. "static" / "python" only appear when an
  // entry classified as such (Stage 0b widens the enum).
  return {
    node: buckets.node ?? { count: 0, rssMB: 0 },
    ...(buckets.static !== undefined ? { static: buckets.static } : {}),
    ...(buckets.python !== undefined ? { python: buckets.python } : {}),
  };
}

/** Test-only escape hatch — used by the unit tests to inject fake proc info. */
export type _FleetStatsTestArgs = {
  readonly procInfos: ReadonlyArray<ProcInfo>;
};

// ---------------------------------------------------------------------------
// Phase 119 D-05 — `no_webhook_fallbacks_total{agent, channel}` counter.
//
// Module-scoped singleton (mirrors how Phase 109's other fleet-stats
// accumulators work — no DI plumbing through every IPC handler). Increment
// is called from `daemon-post-to-agent-ipc.ts` at exactly two sites:
//   1. Bot-direct fallback rung — when the bot client successfully delivers
//      a message via plain-text fallback (no webhook available).
//   2. Inbox-only return path — when neither webhook nor bot-direct path
//      delivered, and the inbox is the final landing zone.
//
// `snapshotNoWebhookFallbacks()` returns a shallow copy as a plain
// `Record<string, number>` so the IPC reply is JSON-safe by construction
// (no Map→Record adapter needed at the boundary). The key shape
// `${agent}:${channel}` keeps single-colon grep ergonomics for journalctl.
// ---------------------------------------------------------------------------

const noWebhookFallbacksCounter = new Map<string, number>();

export function incrementNoWebhookFallback(
  agent: string,
  channel: string,
): void {
  const key = `${agent}:${channel}`;
  const prev = noWebhookFallbacksCounter.get(key) ?? 0;
  noWebhookFallbacksCounter.set(key, prev + 1);
}

export function snapshotNoWebhookFallbacks(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [key, value] of noWebhookFallbacksCounter) {
    out[key] = value;
  }
  return out;
}

/**
 * Test-only reset. Module-scoped state survives across vitest `describe`
 * blocks; tests that exercise the counter MUST call this in `beforeEach` so
 * prior-test increments don't leak. Production callers never invoke this.
 */
export function _resetNoWebhookFallbacks(): void {
  noWebhookFallbacksCounter.clear();
}
