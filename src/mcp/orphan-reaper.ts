/**
 * Phase 999.14 — orphan MCP server reaper.
 *
 * Three callsites share one scanner:
 *   - MCP-03: 60s periodic sweep (startOrphanReaper)
 *   - MCP-05: one-shot at boot (reapOrphans with reason='boot-scan')
 *   - FIND-123-A: one-shot at daemon shutdown after mcpTracker.killAll
 *     (reapOrphans with reason='shutdown-scan'). ClawCode does not own the
 *     `claude` subprocess spawn so the tracker's negative-pid kills cannot
 *     reach `mcp-server-mysql` grandchildren; the shutdown sweep is the
 *     deterministic backstop that closes the reparent-to-PID-1 window.
 *
 * Filter: ppid===1 AND uid===configuredUid AND cmdline matches union regex
 * AND age >= minAgeSeconds (default 5; prevents racing freshly-spawned MCPs
 * during the npm-wrapper exec handoff — Pitfall 3).
 *
 * Orphans use POSITIVE pid kills (their pgid leaders may already be dead and
 * the original pgid value may have been recycled — RESEARCH Open Question 2).
 * Live MCP cleanup uses NEGATIVE pid via process-tracker.ts.
 *
 * Canonical log shape (pinned by tests + CONTEXT.md):
 *   { component: "mcp-reaper", action: "sigterm" | "sigkill", pid, cmdline,
 *     reason: "orphan-ppid-1" | "boot-scan" | "shutdown-scan", graceMs?, msg }
 */

import type { Logger } from "pino";
import {
  listAllPids,
  readProcInfo,
  matchesAnyMcpCommand,
  procAgeSeconds,
  buildPipeOwnerMap,
  readStdinPipeInode,
  isStdinPipePartnerLive,
} from "./proc-scan.js";

/**
 * INC-2026-07-27 — orphaned headless-browser matcher.
 *
 * The `agent-browser` MCP server launches headless chrome with a per-session
 * `--user-data-dir=/tmp/agent-browser-chrome-<id>` profile. When the server
 * dies (crash, reap, MCP reconnect churn), chrome's parent disappears and the
 * BROWSER MASTER reparents to pid 1 — but it keeps running, holding ~200-280MB
 * plus its renderer children.
 *
 * The MCP scan above cannot see these: `matchesAnyMcpCommand` matches configured
 * MCP *commands*, and chrome is not one. So every reaped agent-browser leaked a
 * browser tree. On 2026-07-27 a crash-looping `smarthome` MCP drove ~1 leaked
 * master/min → 32 orphan masters / 337 processes / ~8G resident, which left no
 * headroom in the 20G cgroup and the kernel OOM-killed agent sessions fleet-wide
 * (8,693 chrome OOM kills on 2026-07-26 alone).
 *
 * Safety: a LIVE browser is a CHILD of its agent-browser server, so `ppid === 1`
 * already implies the owner is gone. The profile-dir match additionally scopes
 * this to agent-browser's own temp profiles — an operator's or an agent's other
 * chrome (different `--user-data-dir`) is never matched. Killing the master is
 * sufficient: renderers exit with it (verified in the 2026-07-27 manual sweep —
 * 32 masters SIGTERMed took the process count 407 → 6).
 */
export const AGENT_BROWSER_PROFILE_PATTERN =
  /--user-data-dir=\/tmp\/agent-browser-chrome-/;

/**
 * Grace age for browser orphans (seconds). Longer than the MCP scan's 5s: a
 * freshly-spawned chrome can briefly show `ppid === 1` during the launcher's
 * double-fork handoff, and reaping one mid-handoff would kill a browser the
 * server is about to use. 120s is far beyond any handoff and far below the
 * ~1/min leak rate's cost.
 */
export const BROWSER_ORPHAN_MIN_AGE_SECONDS = 120;

/** Reaper trigger source — used as the canonical `reason` log field. */
export type ReaperReason =
  | "orphan-ppid-1"
  | "boot-scan"
  | "shutdown-scan"
  | "orphan-browser";

/** A single orphan candidate returned by scanForOrphanMcps. */
export type OrphanCandidate = {
  readonly pid: number;
  readonly cmdline: readonly string[];
  readonly startTimeJiffies: number;
};

export interface ScanForOrphansArgs {
  readonly uid: number;
  readonly patterns: RegExp;
  readonly minAgeSeconds?: number;
  readonly clockTicksPerSec: number;
  readonly bootTimeUnix: number;
}

/** Walk /proc and return orphan MCP candidates. Pure — no kills, no logs.
 *
 * Phase 999.X — the `ppid === 1` heuristic alone produces false positives for
 * `npx`-launched MCP servers (e.g. `npx -y mcp-server-mysql@latest`). The
 * npx/npm-exec wrapper chain exits after handing off to the real binary,
 * leaving the actual `node mcp-server-mysql` process reparented to pid 1
 * even though claude is still wired to its stdin and reading tools off it.
 *
 * The pipe-partner check fixes this: we build a fleet-wide map of who holds
 * which pipe inode, then for each ppid===1 candidate we check whether its
 * stdin pipe is held by any OTHER process. If yes (claude is still writing
 * to it), skip — the orphan is "active." If no (truly abandoned), reap.
 *
 * Cost: one extra /proc walk per scan (fds per same-uid process). Acceptable
 * for the 60s periodic tick and the one-shot boot/shutdown scans.
 */
export async function scanForOrphanMcps(
  args: ScanForOrphansArgs,
): Promise<readonly OrphanCandidate[]> {
  const minAge = args.minAgeSeconds ?? 5;
  const pids = await listAllPids();
  const candidates: OrphanCandidate[] = [];
  for (const pid of pids) {
    const info = await readProcInfo(pid);
    if (!info) continue;
    if (info.ppid !== 1) continue;
    if (info.uid !== args.uid) continue;
    const cmdlineStr = info.cmdline.join(" ");
    if (!matchesAnyMcpCommand(cmdlineStr, args.patterns)) continue;
    const age = procAgeSeconds({
      startTimeJiffies: info.startTimeJiffies,
      bootTimeUnix: args.bootTimeUnix,
      clockTicksPerSec: args.clockTicksPerSec,
    });
    if (age < minAge) continue;
    candidates.push({
      pid: info.pid,
      cmdline: info.cmdline,
      startTimeJiffies: info.startTimeJiffies,
    });
  }
  if (candidates.length === 0) return candidates;

  // Second pass — eliminate candidates that are "orphaned by design."
  //
  // Two skip conditions; either keeps the orphan alive:
  //
  // (a) `.npm/_npx/` cached binaries. `npx -y <pkg>@latest` spawns through
  //     an npm-exec wrapper chain that always exits and reparents the leaf
  //     node process to pid 1, even though claude continues to communicate
  //     with it. The Anthropic SDK proxies that IPC through internal
  //     plumbing whose fd ownership doesn't surface in /proc walks, so we
  //     can't tell "active" from "dead" by inspecting the socket. The
  //     `.npm/_npx/` path is the load-bearing signal: it's a transient npm
  //     install — every process spawned from this path is npm-managed and
  //     should not be reaped by the orphan sweep.
  //
  // (b) Stdin pipe partner is a live process. Kept as a belt-and-suspenders
  //     check for non-npx MCP servers (e.g. python-launched) that DO leave
  //     the writer side in a visible parent. Cheaper than the npm-path
  //     check when it succeeds; falls through to (a) when no partner is
  //     found.
  //
  // Cost: one extra /proc walk per scan (only when there are candidates).
  // Acceptable for the 60s periodic tick and the one-shot boot/shutdown
  // scans.
  const pipeOwners = await buildPipeOwnerMap(args.uid);
  const survivors: OrphanCandidate[] = [];
  for (const c of candidates) {
    const cmdlineStr = c.cmdline.join(" ");
    if (cmdlineStr.includes("/.npm/_npx/")) {
      // npm-managed transient binary — always orphaned by design, never reap.
      continue;
    }
    const stdinInode = await readStdinPipeInode(c.pid);
    if (stdinInode !== null && isStdinPipePartnerLive(c.pid, stdinInode, pipeOwners)) {
      // Partner still holds the pipe/socket — actively wired to a live
      // process. Skip — orphan is in use despite ppid===1.
      continue;
    }
    survivors.push(c);
  }
  return survivors;
}

/**
 * Scan for orphaned headless-browser masters left behind by a dead
 * agent-browser MCP server (INC-2026-07-27). Pure — no kills, no logs.
 *
 * Deliberately does NOT run the MCP scan's stdin-pipe-partner check: that
 * check exists to spare `npx`-launched MCP servers still wired to claude's
 * stdin. A browser master is never wired that way (the MCP server talks to it
 * over the DevTools port), so the check would be meaningless here — `ppid === 1`
 * plus the agent-browser profile-dir match plus the age floor is the complete
 * orphan signature.
 */
export async function scanForOrphanBrowsers(args: {
  readonly uid: number;
  readonly clockTicksPerSec: number;
  readonly bootTimeUnix: number;
  readonly minAgeSeconds?: number;
  readonly profilePattern?: RegExp;
}): Promise<readonly OrphanCandidate[]> {
  const minAge = args.minAgeSeconds ?? BROWSER_ORPHAN_MIN_AGE_SECONDS;
  const pattern = args.profilePattern ?? AGENT_BROWSER_PROFILE_PATTERN;
  const pids = await listAllPids();
  const candidates: OrphanCandidate[] = [];
  for (const pid of pids) {
    const info = await readProcInfo(pid);
    if (!info) continue;
    if (info.ppid !== 1) continue;
    if (info.uid !== args.uid) continue;
    const cmdlineStr = info.cmdline.join(" ");
    if (!pattern.test(cmdlineStr)) continue;
    // Renderers/zygotes carry the same profile dir but are children of the
    // master, so they never reach ppid===1 while the master lives — and when
    // the master dies they exit on their own. Skip them explicitly anyway so
    // the log names the tree we actually target.
    if (/--type=/.test(cmdlineStr)) continue;
    const age = procAgeSeconds({
      startTimeJiffies: info.startTimeJiffies,
      bootTimeUnix: args.bootTimeUnix,
      clockTicksPerSec: args.clockTicksPerSec,
    });
    if (age < minAge) continue;
    candidates.push({
      pid: info.pid,
      cmdline: info.cmdline,
      startTimeJiffies: info.startTimeJiffies,
    });
  }
  return candidates;
}

/**
 * SIGTERM every orphaned browser master, wait the grace, SIGKILL survivors.
 * Same shape/contract as {@link reapOrphans} (idempotent on ESRCH, never
 * throws) so it can share the 60s tick without new failure modes.
 */
export async function reapOrphanBrowsers(args: {
  readonly uid: number;
  readonly clockTicksPerSec: number;
  readonly bootTimeUnix: number;
  readonly log: Logger;
  readonly minAgeSeconds?: number;
  readonly profilePattern?: RegExp;
  readonly graceMs?: number;
}): Promise<void> {
  const graceMs = args.graceMs ?? 10_000;
  const candidates = await scanForOrphanBrowsers(args);
  if (candidates.length === 0) return;

  for (const c of candidates) {
    args.log.warn(
      {
        component: "mcp-reaper",
        action: "sigterm",
        pid: c.pid,
        cmdline: c.cmdline.join(" "),
        reason: "orphan-browser" satisfies ReaperReason,
      },
      "reaping orphaned headless browser (agent-browser owner gone)",
    );
    killPidLogged(c.pid, "SIGTERM", args.log);
  }

  await sleep(graceMs);

  const survivors = await scanForOrphanBrowsers(args);
  for (const c of survivors) {
    args.log.warn(
      {
        component: "mcp-reaper",
        action: "sigkill",
        pid: c.pid,
        cmdline: c.cmdline.join(" "),
        reason: "orphan-browser" satisfies ReaperReason,
        graceMs,
      },
      "orphaned headless browser force-killed after grace",
    );
    killPidLogged(c.pid, "SIGKILL", args.log);
  }
}

/** Shared kill helper — ESRCH is benign (already gone); anything else logs. */
function killPidLogged(
  pid: number,
  signal: "SIGTERM" | "SIGKILL",
  log: Logger,
): void {
  try {
    process.kill(pid, signal);
  } catch (err: unknown) {
    const e = err as NodeJS.ErrnoException;
    if (e.code !== "ESRCH") {
      log.error(
        {
          component: "mcp-reaper",
          action: signal === "SIGTERM" ? "sigterm" : "sigkill",
          pid,
          code: e.code,
        },
        `${signal} failed unexpectedly`,
      );
    }
  }
}

export interface ReapOrphansArgs extends ScanForOrphansArgs {
  readonly reason: ReaperReason;
  readonly log: Logger;
  readonly graceMs?: number;
}

/**
 * Scan for orphan MCPs, SIGTERM each, await grace, SIGKILL stragglers.
 * Idempotent on ESRCH; errors logged but never propagate (would crash the
 * daemon's setInterval host).
 */
export async function reapOrphans(args: ReapOrphansArgs): Promise<void> {
  const graceMs = args.graceMs ?? 10_000;
  const candidates = await scanForOrphanMcps(args);
  if (candidates.length === 0) return;

  // SIGTERM each candidate (positive pid — orphans don't reliably retain pgid).
  for (const c of candidates) {
    args.log.warn(
      {
        component: "mcp-reaper",
        action: "sigterm",
        pid: c.pid,
        cmdline: c.cmdline.join(" "),
        reason: args.reason,
      },
      "reaping orphaned MCP server",
    );
    try {
      process.kill(c.pid, "SIGTERM");
    } catch (err: unknown) {
      const e = err as NodeJS.ErrnoException;
      if (e.code !== "ESRCH") {
        args.log.error(
          {
            component: "mcp-reaper",
            action: "sigterm",
            pid: c.pid,
            code: e.code,
          },
          "SIGTERM failed unexpectedly",
        );
      }
    }
  }

  // Grace period — let SIGTERM-handlers exit cleanly.
  await sleep(graceMs);

  // Rescan; survivors get SIGKILL.
  const survivors = await scanForOrphanMcps(args);
  for (const c of survivors) {
    args.log.warn(
      {
        component: "mcp-reaper",
        action: "sigkill",
        pid: c.pid,
        cmdline: c.cmdline.join(" "),
        reason: args.reason,
        graceMs,
      },
      "orphan MCP server force-killed after grace",
    );
    try {
      process.kill(c.pid, "SIGKILL");
    } catch (err: unknown) {
      const e = err as NodeJS.ErrnoException;
      if (e.code !== "ESRCH") {
        args.log.error(
          {
            component: "mcp-reaper",
            action: "sigkill",
            pid: c.pid,
            code: e.code,
          },
          "SIGKILL failed unexpectedly",
        );
      }
    }
  }
}

export interface StartOrphanReaperArgs extends ScanForOrphansArgs {
  readonly intervalMs?: number;
  readonly log: Logger;
  readonly graceMs?: number;
  /**
   * Optional callback invoked AFTER the orphan reap completes on each tick.
   * Wave 1 wires the MCP-09 stale-binding sweep here so the sweep runs
   * after the orphan reaper (locked decision per CONTEXT.md). Errors from
   * this callback are logged but never propagate (would crash setInterval).
   */
  readonly onTickAfter?: () => Promise<void>;
}

/**
 * Start the periodic orphan reaper. Returns the timer handle for clearInterval
 * on daemon shutdown. First tick fires AFTER intervalMs (boot-scan covers t=0).
 * Errors caught and logged — never propagate out of setInterval.
 *
 * The optional `onTickAfter` callback runs sequentially AFTER reapOrphans
 * completes — not in parallel — so Wave 1's MCP-09 sweep observes the
 * post-reap registry state on each tick.
 */
export function startOrphanReaper(args: StartOrphanReaperArgs): NodeJS.Timeout {
  const intervalMs = args.intervalMs ?? 60_000;
  const handle = setInterval(() => {
    void (async () => {
      try {
        await reapOrphans({
          uid: args.uid,
          patterns: args.patterns,
          minAgeSeconds: args.minAgeSeconds,
          clockTicksPerSec: args.clockTicksPerSec,
          bootTimeUnix: args.bootTimeUnix,
          reason: "orphan-ppid-1",
          log: args.log,
          graceMs: args.graceMs,
        });
      } catch (err: unknown) {
        args.log.error(
          { component: "mcp-reaper", err: String(err) },
          "reaper tick failed",
        );
      }
      // INC-2026-07-27 — same tick also reaps headless browsers orphaned by a
      // dead agent-browser MCP. Separate try/catch so a browser-scan failure
      // can never suppress the MCP reap above (or the onTickAfter callback).
      try {
        await reapOrphanBrowsers({
          uid: args.uid,
          clockTicksPerSec: args.clockTicksPerSec,
          bootTimeUnix: args.bootTimeUnix,
          log: args.log,
          graceMs: args.graceMs,
        });
      } catch (err: unknown) {
        args.log.error(
          { component: "mcp-reaper", err: String(err) },
          "browser-orphan reaper tick failed",
        );
      }
      if (args.onTickAfter) {
        try {
          await args.onTickAfter();
        } catch (err: unknown) {
          args.log.error(
            { component: "mcp-reaper", err: String(err) },
            "onTickAfter callback failed",
          );
        }
      }
    })();
  }, intervalMs);
  return handle;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// P4 (memory program) — npm-stray + survivor-cli scanners. ADDITIVE: the
// shipped scanners above are pinned (log shapes + behavior) and untouched.
// These two follow the same architecture: pure scan → SIGTERM → grace →
// rescan → SIGKILL, positive pids, ESRCH-benign. Both ship DARK — the daemon
// gates them behind `defaults.memoryGuard.remediation` (default "off") and
// runs alert-only before any reap (tighten-only lattice in reap-policy.ts).
// ---------------------------------------------------------------------------

/**
 * npm/npx WRAPPER processes (not the servers they exec). A live chain is
 * `claude → npm exec → node <server>`; when claude dies mid-handoff or the
 * exec'd child crashes, the wrapper reparents to pid 1 and idles forever
 * (~60-120MB each — the 07-27 census counted 9). Matches argv[0]/argv[1]
 * basenames `npm`/`npx`/`npm-cli.js`/`npx-cli.js` — deliberately does NOT
 * match `/.npm/_npx/` install paths, which are the LIVE exec'd servers the
 * MCP scan's Pitfall-3 skip protects.
 */
export const NPM_WRAPPER_PATTERN =
  /(?:^|\/)(?:npm|npx|npm-cli\.js|npx-cli\.js)(?:\s|$)/;

export function isNpmWrapperCmdline(cmdline: readonly string[]): boolean {
  // Only argv[0..1] identify the wrapper (`npm exec …`, `node …/npx-cli.js …`).
  // Later argv positions are the exec target's own args — never a signal.
  return cmdline
    .slice(0, 2)
    .some((a) => NPM_WRAPPER_PATTERN.test(a));
}

/** Wrapper strays idle for many minutes; 600s clears any legitimate handoff. */
export const NPM_STRAY_MIN_AGE_SECONDS = 600;

export async function scanForNpmStrays(
  args: Omit<ScanForOrphansArgs, "patterns">,
): Promise<readonly OrphanCandidate[]> {
  const minAge = args.minAgeSeconds ?? NPM_STRAY_MIN_AGE_SECONDS;
  const pids = await listAllPids();
  const firstPass: OrphanCandidate[] = [];
  for (const pid of pids) {
    const info = await readProcInfo(pid);
    if (info === null) continue;
    if (info.ppid !== 1) continue;
    if (info.uid !== args.uid) continue;
    if (!isNpmWrapperCmdline(info.cmdline)) continue;
    const age = procAgeSeconds({
      startTimeJiffies: info.startTimeJiffies,
      clockTicksPerSec: args.clockTicksPerSec,
      bootTimeUnix: args.bootTimeUnix,
    });
    if (age < minAge) continue;
    firstPass.push({
      pid: info.pid,
      cmdline: info.cmdline,
      startTimeJiffies: info.startTimeJiffies,
    });
  }
  if (firstPass.length === 0) return firstPass;

  // Same pipe-partner guard as the MCP scan: a wrapper whose stdin pipe is
  // still held by another live process is part of an active chain — skip.
  const pipeOwners = await buildPipeOwnerMap(args.uid);
  const out: OrphanCandidate[] = [];
  for (const c of firstPass) {
    const stdinInode = await readStdinPipeInode(c.pid);
    if (
      stdinInode !== null &&
      isStdinPipePartnerLive(c.pid, stdinInode, pipeOwners)
    ) {
      continue;
    }
    out.push(c);
  }
  return out;
}

/**
 * Survivor claude CLIs: a `claude` (or bwrap-wrapped claude) process that
 * reparented to pid 1 AND is absent from the daemon's live session registry.
 * These are the ~10G "unregistered claude class" from the 07-27 RCA —
 * sessions whose daemon-side handle was lost (crash, failed stop) while the
 * process kept running.
 *
 * Guards (ALL required — this scanner can kill an agent, so it is the most
 * conservative of the set):
 *   - `livePids` = union of registry claude pids + bridge child pids, the
 *     same closure MemoryGuard's census uses. pid present → never a candidate.
 *   - age ≥ 900s — no freshly-spawned session is ever matched.
 *   - `daemonUptimeSeconds` ≥ 300 — right after a daemon restart the registry
 *     is still repopulating; scanning then would flag every resuming session.
 */
export const SURVIVOR_CLI_MIN_AGE_SECONDS = 900;
export const SURVIVOR_CLI_MIN_DAEMON_UPTIME_SECONDS = 300;

export function isClaudeCliCmdline(cmdline: readonly string[]): boolean {
  const head = cmdline[0];
  if (head === undefined) return false;
  const base = head.split("/").at(-1) ?? "";
  if (base === "claude") return true;
  if (base === "bwrap") {
    return cmdline.some((a) => (a.split("/").at(-1) ?? "") === "claude");
  }
  return false;
}

export async function scanForSurvivorClis(
  args: Omit<ScanForOrphansArgs, "patterns"> & {
    readonly livePids: ReadonlySet<number>;
    readonly daemonUptimeSeconds: number;
  },
): Promise<readonly OrphanCandidate[]> {
  if (args.daemonUptimeSeconds < SURVIVOR_CLI_MIN_DAEMON_UPTIME_SECONDS) {
    return [];
  }
  const minAge = args.minAgeSeconds ?? SURVIVOR_CLI_MIN_AGE_SECONDS;
  const pids = await listAllPids();
  const out: OrphanCandidate[] = [];
  for (const pid of pids) {
    if (args.livePids.has(pid)) continue;
    const info = await readProcInfo(pid);
    if (info === null) continue;
    if (info.ppid !== 1) continue;
    if (info.uid !== args.uid) continue;
    if (!isClaudeCliCmdline(info.cmdline)) continue;
    const age = procAgeSeconds({
      startTimeJiffies: info.startTimeJiffies,
      clockTicksPerSec: args.clockTicksPerSec,
      bootTimeUnix: args.bootTimeUnix,
    });
    if (age < minAge) continue;
    out.push({
      pid: info.pid,
      cmdline: info.cmdline,
      startTimeJiffies: info.startTimeJiffies,
    });
  }
  return out;
}

/**
 * Shared act step for the P4 scanners: alert every candidate; in reap mode
 * additionally SIGTERM → grace → rescan → SIGKILL. The rescan (not a pid
 * recheck) mirrors `reapOrphans` — a pid that exited during grace simply
 * doesn't reappear.
 */
export async function actOnScannedOrphans(args: {
  readonly reason: "npm-stray" | "survivor-cli";
  readonly mode: "alert" | "reap";
  readonly scan: () => Promise<readonly OrphanCandidate[]>;
  readonly log: Logger;
  readonly graceMs?: number;
}): Promise<void> {
  const candidates = await args.scan();
  if (candidates.length === 0) return;

  for (const c of candidates) {
    args.log.warn(
      {
        component: "mcp-reaper",
        action: args.mode === "reap" ? "sigterm" : "alert",
        pid: c.pid,
        cmdline: c.cmdline.join(" "),
        reason: args.reason,
      },
      args.mode === "reap"
        ? `reaping ${args.reason} process`
        : `${args.reason} candidate detected (alert-only)`,
    );
    if (args.mode === "reap") {
      killPidLogged(c.pid, "SIGTERM", args.log);
    }
  }
  if (args.mode !== "reap") return;

  await sleep(args.graceMs ?? 10_000);

  const survivors = await args.scan();
  for (const c of survivors) {
    args.log.warn(
      {
        component: "mcp-reaper",
        action: "sigkill",
        pid: c.pid,
        cmdline: c.cmdline.join(" "),
        reason: args.reason,
        graceMs: args.graceMs ?? 10_000,
      },
      `${args.reason} process force-killed after grace`,
    );
    killPidLogged(c.pid, "SIGKILL", args.log);
  }
}
