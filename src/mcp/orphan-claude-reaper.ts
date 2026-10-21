/**
 * Phase 109-B — orphan-claude reaper.
 *
 * Catches the today-fire pattern (2026-05-03): `claude` subprocesses whose
 * PPID is the daemon, but which are NOT in `tracker.getRegisteredAgents()`.
 * The 999.14 MCP-child reaper matches MCP cmdline regexes; an orphan
 * claude is its own children's PPID, so neither it nor its grandchildren
 * are PPID=1 — they slip through the existing reaper entirely.
 *
 * Modes (rollback safety, hot-reload via ConfigReloader):
 *   - "off"   — module noop. Operator escape hatch.
 *   - "alert" — scan, emit a canonical pino warn per orphan, do NOT kill.
 *               Default for first ~7 days post-deploy so operators can
 *               audit the false-positive rate before flipping to reap.
 *   - "reap"  — scan, alert, then SIGTERM the orphan claude. 10s grace,
 *               then SIGKILL stragglers. The claude's MCP children become
 *               PPID=1 orphans and get cleaned up by the existing 999.14
 *               cmdline-matching reaper on the next tick.
 *
 * False-positive guards (non-negotiable):
 *   - minAgeSeconds default 30 — never touch claude under 30s old (SDK
 *     respawn windows fit comfortably under this).
 *   - tracker snapshot is read AT START of each tick. A claude registered
 *     mid-tick by session-manager polled discovery is NOT touched.
 *   - daemonPid === 1 → noop (defensive: an orphan reaper that thinks
 *     daemon is init would reap every claude on the host).
 *   - kill-switch env: CLAWCODE_ORPHAN_CLAUDE_REAPER_DISABLE=1.
 *
 * Canonical log shape (pinned by tests):
 *   { component: "orphan-claude-reaper",
 *     action: "alert" | "sigterm" | "sigkill",
 *     pid, cmdline, ageSec, mode,
 *     msg: "orphan claude proc detected" | "reaping orphan claude" | "..." }
 */

import type { Logger } from "pino";
import {
  listAllPids,
  readProcInfo,
  procAgeSeconds,
} from "./proc-scan.js";
import type { McpProcessTracker } from "./process-tracker.js";

export type OrphanClaudeReaperMode = "off" | "alert" | "reap";

/** Same regex used by `discoverClaudeSubprocessPid` — keep them aligned. */
const CLAUDE_ARGV0_RE = /(?:^|\/)claude$/;
/** A sandboxed agent's claude runs as `bwrap <binds> -- <claudebin> <args>`. */
const BWRAP_ARGV0_RE = /(?:^|\/)bwrap$/;

/**
 * Recognize a claude process from its argv — directly (`…/claude`) OR wrapped in
 * bubblewrap for a sandboxed agent (`bwrap <binds> -- …/claude …`). Without the
 * bwrap branch the orphan reaper would go blind to sandboxed agents' claude
 * processes (argv[0] is `bwrap`, not `claude`). NOTE: the primary cleanup path
 * for sandboxed agents is the pidSink (captures bwrap's PID) + `--die-with-parent`
 * group-kill; this keeps the `/proc` backstop covering them too.
 */
export function isClaudeProcessCmdline(cmdline: readonly string[]): boolean {
  const argv0 = cmdline[0] ?? "";
  if (CLAUDE_ARGV0_RE.test(argv0)) return true;
  if (BWRAP_ARGV0_RE.test(argv0)) {
    const sep = cmdline.indexOf("--");
    return sep >= 0 && CLAUDE_ARGV0_RE.test(cmdline[sep + 1] ?? "");
  }
  return false;
}

export type OrphanClaudeCandidate = {
  readonly pid: number;
  readonly cmdline: readonly string[];
  readonly ageSec: number;
};

/**
 * Mask `--mcp-config` secrets out of a `claude` argv before it reaches a log
 * sink. The `--mcp-config` value is a JSON blob embedding plaintext secrets
 * (1Password `OP_SERVICE_ACCOUNT_TOKEN`, MySQL password, third-party API
 * keys); dumping it into journald is a confirmed cleartext-secret leak.
 *
 * Pure — no I/O, no mutation of the input array (a fresh array is built per
 * the project immutability rule). Two argv forms are handled:
 *   - two-element: `["--mcp-config", "{JSON}"]` → `--mcp-config [redacted]`
 *   - single-element: `["--mcp-config={JSON}"]` → `--mcp-config=[redacted]`
 * Any other element passes through unchanged. A trailing `--mcp-config` with
 * no following value does not throw (nothing to mask).
 */
export function redactCmdline(cmdline: readonly string[]): string {
  const out: string[] = [];
  for (let i = 0; i < cmdline.length; i++) {
    const el = cmdline[i]!;
    if (el === "--mcp-config") {
      out.push(el);
      if (i + 1 < cmdline.length) {
        out.push("[redacted]");
        i++; // skip the secret value
      }
    } else if (el.startsWith("--mcp-config=")) {
      out.push("--mcp-config=[redacted]");
    } else {
      out.push(el);
    }
  }
  return out.join(" ");
}

export type ScanArgs = {
  readonly daemonPid: number;
  readonly tracker: McpProcessTracker;
  readonly uid: number;
  readonly minAgeSeconds: number;
  readonly bootTimeUnix: number;
  readonly clockTicksPerSec: number;
};

/**
 * Walk /proc and return the orphan-claude candidates.
 *
 * Pure — no kills, no logs. Snapshots `tracker.getRegisteredAgents()` ONCE
 * at start so a mid-walk register from session-manager doesn't corrupt the
 * decision (CONTEXT.md non-negotiable).
 */
export async function scanForOrphanClaudes(
  args: ScanArgs,
): Promise<readonly OrphanClaudeCandidate[]> {
  if (args.daemonPid <= 1) return []; // defensive — see header

  // Snapshot tracker entries' claudePids — claude PIDs we know about.
  const trackedClaudePids = new Set<number>();
  for (const [name, entry] of args.tracker.getRegisteredAgents()) {
    if (name.startsWith("__broker:")) continue; // broker-owned synthetic owners
    trackedClaudePids.add(entry.claudePid);
  }

  let pids: readonly number[];
  try {
    pids = await listAllPids();
  } catch {
    return []; // /proc unavailable
  }

  const candidates: OrphanClaudeCandidate[] = [];
  for (const pid of pids) {
    let info;
    try {
      info = await readProcInfo(pid);
    } catch {
      continue;
    }
    if (!info) continue;
    if (info.ppid !== args.daemonPid) continue;
    if (info.uid !== args.uid) continue;
    if (!isClaudeProcessCmdline(info.cmdline)) continue;
    if (trackedClaudePids.has(pid)) continue;
    const ageSec = procAgeSeconds({
      startTimeJiffies: info.startTimeJiffies,
      bootTimeUnix: args.bootTimeUnix,
      clockTicksPerSec: args.clockTicksPerSec,
    });
    if (ageSec < args.minAgeSeconds) continue;
    candidates.push({ pid: info.pid, cmdline: info.cmdline, ageSec });
  }
  return candidates;
}

export type TickArgs = ScanArgs & {
  readonly mode: OrphanClaudeReaperMode;
  readonly log: Logger;
  readonly graceMs?: number;
  /** Test seam — defaults to process.kill. */
  readonly killFn?: (pid: number, signal: NodeJS.Signals) => void;
  /** Test seam — defaults to setTimeout for SIGKILL grace. */
  readonly sleepFn?: (ms: number) => Promise<void>;
};

/** Default kill — wraps process.kill so we can stub in tests. */
const defaultKillFn = (pid: number, signal: NodeJS.Signals): void => {
  process.kill(pid, signal);
};

const defaultSleepFn = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

/**
 * One tick of the orphan-claude reaper.
 *
 * In "off" mode: noop (returns immediately).
 * In "alert" mode: scan + emit one pino warn per candidate. No kills.
 * In "reap" mode: scan + alert + SIGTERM each candidate. After
 *   `graceMs`, SIGKILL any candidate still alive on a re-scan.
 *
 * Errors during kill (other than ESRCH) are logged but never propagate —
 * callers wire this into setInterval and a thrown error would crash the
 * tick loop (matches 999.14 reaper invariant).
 */
export async function tickOrphanClaudeReaper(args: TickArgs): Promise<void> {
  if (args.mode === "off") return;
  if (process.env.CLAWCODE_ORPHAN_CLAUDE_REAPER_DISABLE === "1") return;

  const candidates = await scanForOrphanClaudes(args);
  if (candidates.length === 0) return;

  const killFn = args.killFn ?? defaultKillFn;
  const sleepFn = args.sleepFn ?? defaultSleepFn;
  const graceMs = args.graceMs ?? 10_000;

  // Alert phase — both modes log every candidate so operators see the
  // pre-reap baseline in journalctl.
  for (const c of candidates) {
    args.log.warn(
      {
        component: "orphan-claude-reaper",
        action: "alert",
        pid: c.pid,
        cmdline: redactCmdline(c.cmdline),
        ageSec: Math.round(c.ageSec),
        mode: args.mode,
      },
      "orphan claude proc detected",
    );
  }

  if (args.mode === "alert") return;

  // Reap phase — SIGTERM each candidate.
  for (const c of candidates) {
    args.log.warn(
      {
        component: "orphan-claude-reaper",
        action: "sigterm",
        pid: c.pid,
        cmdline: redactCmdline(c.cmdline),
        ageSec: Math.round(c.ageSec),
        mode: args.mode,
      },
      "reaping orphan claude",
    );
    try {
      killFn(c.pid, "SIGTERM");
    } catch (err: unknown) {
      const e = err as NodeJS.ErrnoException;
      if (e.code !== "ESRCH") {
        args.log.error(
          {
            component: "orphan-claude-reaper",
            action: "sigterm",
            pid: c.pid,
            code: e.code,
          },
          "SIGTERM failed unexpectedly",
        );
      }
    }
  }

  await sleepFn(graceMs);

  // Re-scan: anything still alive gets SIGKILL.
  const stragglers = await scanForOrphanClaudes(args);
  for (const c of stragglers) {
    args.log.warn(
      {
        component: "orphan-claude-reaper",
        action: "sigkill",
        pid: c.pid,
        cmdline: redactCmdline(c.cmdline),
        ageSec: Math.round(c.ageSec),
        mode: args.mode,
        graceMs,
      },
      "orphan claude force-killed after grace",
    );
    try {
      killFn(c.pid, "SIGKILL");
    } catch (err: unknown) {
      const e = err as NodeJS.ErrnoException;
      if (e.code !== "ESRCH") {
        args.log.error(
          {
            component: "orphan-claude-reaper",
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

/**
 * Live-mode getter so the daemon's onTickAfter closure can read the
 * latest yaml-configured mode from the singleton config without
 * restarting. `getMode()` returns the current value at call time
 * (post-ConfigReloader update).
 */
export type ModeGetter = () => OrphanClaudeReaperMode;
