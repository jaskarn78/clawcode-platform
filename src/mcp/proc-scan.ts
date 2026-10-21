/**
 * Phase 999.14 — /proc walker + parser primitives.
 *
 * Pure-stdlib helpers for the MCP child process lifecycle hardening fix.
 * No npm dependencies; only `node:fs/promises`.
 *
 * Exported surface:
 *   - parseStatPpid(stat)          → number  (Pitfall-4-safe: lastIndexOf(')'))
 *   - readProcInfo(pid)            → ProcInfo | null  (cmdline + ppid + uid + starttime)
 *   - listAllPids()                → readonly number[]
 *   - buildMcpCommandRegexes(cfg)  → RegExp  (union of configured commands)
 *   - matchesAnyMcpCommand(s, re)  → boolean
 *   - procAgeSeconds({...})        → number  (pure math; no syscalls)
 *   - readBootTimeUnix()           → Promise<number>  (parses /proc/stat btime once)
 *
 * Security invariants (per ~/.claude/rules/security.md):
 *   - NEVER reads /proc/{pid}/environ. Resolved op:// secrets land in environ
 *     and would leak into reaper logs. Cmdline is operator-controlled config,
 *     safe to log.
 *
 * Linux-only: /proc is the canonical source. Tests skip on non-Linux.
 */

import { readFile, readdir, readlink } from "node:fs/promises";

/** Configured MCP server entry (subset of clawcode.yaml mcpServers entry). */
export type McpServerCommandConfig = {
  readonly command: string;
  readonly args: readonly string[];
};

/** Parsed /proc/{pid} snapshot. Returned by readProcInfo. */
export type ProcInfo = {
  readonly pid: number;
  readonly ppid: number;
  readonly uid: number;
  readonly cmdline: readonly string[];
  /** Field 22 of /proc/{pid}/stat — clock ticks since boot. Used for age filter. */
  readonly startTimeJiffies: number;
};

/**
 * Parse the ppid (field 4) from a /proc/{pid}/stat line.
 *
 * Pitfall 4: the comm field (field 2) is wrapped in parens but its contents
 * may contain spaces, parens, or even newlines (kernel just copies the first
 * 16 bytes of the binary's task name). Naive `split(' ')[3]` is broken on
 * `123 (sh -c foo) S 1 ...` and `123 (claude (test-agent)) S 1 ...`.
 *
 * Stable parser: find the last `)` (end of comm field), then split the tail.
 * Tail layout: `state ppid pgrp session ...`.
 *
 * @throws if no closing paren or ppid is non-numeric.
 */
export function parseStatPpid(stat: string): number {
  const close = stat.lastIndexOf(")");
  if (close === -1) {
    throw new Error("malformed /proc/stat: no closing paren in comm field");
  }
  // Skip the ") " separator between comm end and the state field.
  const tail = stat.slice(close + 2).split(" ");
  // tail[0] = state (R/S/D/...), tail[1] = ppid
  const ppid = Number(tail[1]);
  if (!Number.isFinite(ppid)) {
    throw new Error("malformed /proc/stat: ppid is not numeric");
  }
  return ppid;
}

/**
 * Parse field 22 (starttime, in clock ticks since boot) from /proc/{pid}/stat.
 *
 * After the comm field, the remaining fields are space-delimited. starttime is
 * field 22 overall, which is index 19 in the post-comm tail (state ppid pgrp
 * session tty_nr tpgid flags minflt cminflt majflt cmajflt utime stime cutime
 * cstime priority nice num_threads itrealvalue **starttime**).
 */
function parseStatStartTime(stat: string): number {
  const close = stat.lastIndexOf(")");
  if (close === -1) {
    throw new Error("malformed /proc/stat: no closing paren");
  }
  const tail = stat.slice(close + 2).split(" ");
  const starttime = Number(tail[19]);
  if (!Number.isFinite(starttime)) {
    throw new Error("malformed /proc/stat: starttime is not numeric");
  }
  return starttime;
}

/**
 * Read /proc/{pid}/{stat,cmdline,status} concurrently and return a snapshot.
 *
 * Returns null if the proc disappeared mid-read (ENOENT/ESRCH). Other I/O
 * errors bubble. NEVER reads /proc/{pid}/environ.
 *
 * cmdline is NUL-delimited argv; we split on \0 and drop the trailing empty.
 * uid is parsed from the `Uid:` line of /proc/{pid}/status (real UID, the
 * first numeric field).
 */
export async function readProcInfo(pid: number): Promise<ProcInfo | null> {
  try {
    const [stat, cmdRaw, status] = await Promise.all([
      readFile(`/proc/${pid}/stat`, "utf-8"),
      readFile(`/proc/${pid}/cmdline`, "utf-8"),
      readFile(`/proc/${pid}/status`, "utf-8"),
    ]);
    const ppid = parseStatPpid(stat);
    const startTimeJiffies = parseStatStartTime(stat);
    const uidMatch = status.match(/^Uid:\s*(\d+)/m);
    const uid = uidMatch ? Number(uidMatch[1]) : Number.NaN;
    const cmdline = cmdRaw.split("\0").filter((s) => s.length > 0);
    return { pid, ppid, uid, cmdline, startTimeJiffies };
  } catch (err: unknown) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT" || e.code === "ESRCH") return null;
    throw err;
  }
}

/** Return all numeric entries under /proc as a sorted readonly array of pids. */
export async function listAllPids(): Promise<readonly number[]> {
  const entries = await readdir("/proc");
  const out: number[] = [];
  for (const e of entries) {
    if (/^\d+$/.test(e)) out.push(Number(e));
  }
  return out;
}

/** Escape regex metacharacters so a literal command becomes a safe pattern. */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Extract the bare package name from an npm-style package spec, if the arg
 * looks like one. Returns null otherwise (e.g. flags, file paths).
 *
 * Examples:
 *   "mcp-server-mysql@latest"          → "mcp-server-mysql"
 *   "@takescake/1password-mcp@latest"  → "1password-mcp"
 *   "@playwright/mcp@latest"           → "mcp"
 *   "mcp-server-mysql"                 → "mcp-server-mysql"
 *   "/opt/.../brave_search.py"         → null (path, not npm spec)
 *   "-y"                               → null (flag)
 *
 * Phase 999.14 hot-fix: orphan grandchildren end up with cmdlines like
 * `sh -c mcp-server-mysql` or `node /home/.../bin/mcp-server-mysql` after
 * the npm-wrapper exec handoff. The original `npx -y mcp-server-mysql@latest`
 * full-form doesn't substring-match those. By also adding the bare package
 * name as a word-boundary alternative, the reaper catches both the live
 * full-invocation form AND the orphan transformations.
 */
function extractBarePackageName(arg: string): string | null {
  if (arg.startsWith("-")) return null;
  if (arg.includes("/") && (arg.startsWith("/") || arg.startsWith("."))) {
    return null; // path, not an npm spec
  }
  // Strip @version suffix (anything after the LAST @, but not the leading @scope)
  const lastAt = arg.lastIndexOf("@");
  const base = lastAt > 0 ? arg.slice(0, lastAt) : arg;
  // Take last path segment (handles @scope/name)
  const lastSegment = base.split("/").pop() ?? base;
  if (/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(lastSegment)) {
    return lastSegment;
  }
  return null;
}

/**
 * Build a single union regex from configured MCP server entries.
 *
 * Each configured entry contributes its FULL invocation form
 * (`command + ' ' + args.join(' ')`) to the alternation. Phase 999.14 hot-fix
 * (2026-04-30 deploy reveal): also contributes the bare npm package name
 * extracted from each non-flag arg (`\b<name>\b` substring match) so the
 * orphan reaper catches grandchildren whose cmdline got transformed by the
 * npm/sh wrapper exec chain.
 *
 * For example, `npx -y mcp-server-mysql@latest` produces TWO alternatives:
 *   - `npx -y mcp-server-mysql@latest`          (matches live npm-exec proc)
 *   - `\bmcp-server-mysql\b`                    (matches orphan `sh -c mcp-server-mysql` and `node /.../bin/mcp-server-mysql`)
 *
 * Throws on empty input — boundary validation per coding-style.md.
 */
export function buildMcpCommandRegexes(
  serverConfigs: Readonly<Record<string, McpServerCommandConfig>>,
): RegExp {
  const entries = Object.values(serverConfigs);
  if (entries.length === 0) {
    throw new Error("buildMcpCommandRegexes: empty serverConfigs (boundary violation)");
  }
  const alternatives: string[] = [];
  for (const cfg of entries) {
    const full =
      cfg.args.length > 0
        ? `${cfg.command} ${cfg.args.join(" ")}`
        : cfg.command;
    alternatives.push(escapeRegex(full));

    // Bare npm package names — see extractBarePackageName JSDoc above.
    for (const arg of cfg.args) {
      const bareName = extractBarePackageName(arg);
      if (bareName) {
        alternatives.push(`\\b${escapeRegex(bareName)}\\b`);
      }
    }
  }
  // Deduplicate to keep the regex small.
  const uniq = Array.from(new Set(alternatives));
  return new RegExp(`(?:${uniq.join("|")})`);
}

/** Test a cmdline string (space-joined argv) against the union regex. */
export function matchesAnyMcpCommand(cmdline: string, patterns: RegExp): boolean {
  return patterns.test(cmdline);
}

/** Pure age math; no syscalls. */
export function procAgeSeconds(args: {
  readonly startTimeJiffies: number;
  readonly bootTimeUnix: number;
  readonly clockTicksPerSec: number;
}): number {
  const procStartUnix = args.bootTimeUnix + args.startTimeJiffies / args.clockTicksPerSec;
  return Date.now() / 1000 - procStartUnix;
}

/**
 * Return the Linux clock-ticks-per-second constant.
 *
 * Hardcoded to 100 (the canonical x86_64/aarch64 value of `getconf CLK_TCK`
 * — verified on clawdy 6.14 + dev 6.8). The kernel exports CLK_TCK at
 * compile time; in practice every modern Linux ships at 100 (or 250 on
 * some embedded kernels we don't deploy to). Test override: production
 * callsites pass this value explicitly to scanForOrphanMcps so tests can
 * inject any number without poking sysconf.
 *
 * Linux-only: not meaningful on non-Linux. Daemon already gates the
 * tracker construction on Linux at the callsite via /proc presence.
 */
export function readClockTicksPerSec(): number {
  return 100;
}

// FIND-123-A.next T-09 — `discoverClaudeSubprocessPid` + `DiscoverClaudeOpts`
// removed. Claude PIDs now come from the per-handle `ClaudePidSink` populated
// by the structural spawn wrapper (`src/manager/detached-spawn.ts`); reintro
// is pinned by the static-grep test under `src/mcp/__tests__/`.

/**
 * Phase 999.14 MCP-01 — enumerate MCP child PIDs spawned by the given
 * `claude` subprocess.
 *
 * Walks /proc, returns PIDs whose ppid === claudePid AND whose cmdline
 * matches the configured MCP command regex. Excludes the youngest 5s
 * window (Pitfall 3 — npm-wrapper exec handoff race) is the orphan
 * reaper's job; here we want EVERY child including freshly-spawned ones
 * since we're registering them at agent-start.
 *
 * Returns readonly array; empty array on non-Linux or zero matches.
 */
export async function discoverAgentMcpPids(
  claudePid: number,
  patterns: RegExp,
): Promise<readonly number[]> {
  let pids: readonly number[];
  try {
    pids = await listAllPids();
  } catch {
    return [];
  }
  const out: number[] = [];
  for (const pid of pids) {
    let info: ProcInfo | null;
    try {
      info = await readProcInfo(pid);
    } catch {
      continue;
    }
    if (!info) continue;
    if (info.ppid !== claudePid) continue;
    const cmdlineStr = info.cmdline.join(" ");
    if (!matchesAnyMcpCommand(cmdlineStr, patterns)) continue;
    out.push(info.pid);
  }
  return out;
}

/**
 * Read system boot time (Unix seconds) from /proc/stat `btime` line.
 *
 * Called once at daemon start; the result is passed into procAgeSeconds for
 * every age check. Avoids repeated /proc/stat reads in hot loops.
 */
export async function readBootTimeUnix(): Promise<number> {
  const text = await readFile("/proc/stat", "utf-8");
  const match = text.match(/^btime\s+(\d+)/m);
  if (!match) {
    throw new Error("malformed /proc/stat: no btime line");
  }
  return Number(match[1]);
}

/**
 * Phase 999.15 — POSIX liveness check for a PID.
 *
 * Uses `process.kill(pid, 0)` — signal 0 only checks existence + permission,
 * does not actually signal the target. Errno semantics:
 *   - ESRCH (no such process)        → returns false
 *   - EPERM (process exists, no perm) → returns true
 *     (sufficient for our purposes — we only care that the proc IS running,
 *      not whether we can kill it.)
 *   - other errors                    → rethrown (surfacing unknowns)
 *
 * Validates: returns false IMMEDIATELY for pid <= 0 (no syscall). NaN /
 * non-finite input also returns false. This guards against bad input rather
 * than throwing — callers may pass stale tracker values.
 */
export function isPidAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "ESRCH") return false;
    if (code === "EPERM") return true;
    throw err;
  }
}

/**
 * Read the IPC inode of a process's stdin (`/proc/<pid>/fd/0`).
 *
 * Returns a string like `"pipe:12345"` or `"socket:67890"` when stdin is an
 * IPC channel (anonymous pipe OR socket-pair). Returns `null` for any other
 * fd type (closed, regular file, tty, /dev/null). A return of `null` means
 * "no partner to check," and the orphan-reaper falls through to its existing
 * reap heuristic.
 *
 * Note: the Anthropic Agent SDK spawns child MCP servers with `socketpair(2)`
 * for stdio, NOT pipes (you'll see `socket:[N]` in fd/0), so matching only
 * pipes misses every SDK-spawned MCP server. Match both.
 *
 * Phase 999.X — powers `isStdinPipePartnerLive`: the reaper uses this to
 * skip reaping when a candidate's stdin is still wired to a live partner
 * (active MCP server whose npm-exec wrapper exited and bumped ppid to 1).
 */
export async function readStdinPipeInode(pid: number): Promise<string | null> {
  try {
    const target = await readlink(`/proc/${pid}/fd/0`);
    const m = target.match(/^(pipe|socket):\[(\d+)\]$/);
    if (!m) return null;
    return `${m[1]}:${m[2]}`;
  } catch {
    return null;
  }
}

/**
 * Build a map from IPC inode → list of pids that hold it as an open fd.
 *
 * Walks every process owned by `uid` (when `uid !== undefined`; otherwise
 * all accessible processes) and inspects each fd link. Matches BOTH
 * `pipe:[N]` and `socket:[N]` — the SDK uses `socketpair(2)` for child
 * stdio, not pipes (see `readStdinPipeInode`). The map collects every pid
 * that has ANY fd pointing at each inode.
 *
 * Keys are namespaced: `pipe:N` vs `socket:N`. The namespace is part of
 * the key so a pipe inode and a socket inode with the same N never collide.
 *
 * Errors per-process are silent: missing /proc/<pid>/fd (dead between read
 * and inspect) is the dominant failure mode and irrelevant for the snapshot.
 *
 * Performance: one full /proc walk + one readdir per process + one readlink
 * per fd. On a quiet box this is dominated by the fd readlinks (~hundreds of
 * pids × ~10 fds each = ~thousands of syscalls). Acceptable for a 60s tick.
 */
export async function buildPipeOwnerMap(
  uid: number | undefined,
): Promise<ReadonlyMap<string, readonly number[]>> {
  const map = new Map<string, number[]>();
  const pids = await listAllPids();
  for (const pid of pids) {
    try {
      if (uid !== undefined) {
        const info = await readProcInfo(pid);
        if (!info || info.uid !== uid) continue;
      }
      const fdDir = `/proc/${pid}/fd`;
      const fds = await readdir(fdDir);
      for (const fd of fds) {
        try {
          const target = await readlink(`${fdDir}/${fd}`);
          const m = target.match(/^(pipe|socket):\[(\d+)\]$/);
          if (m && m[1] !== undefined && m[2] !== undefined) {
            const key = `${m[1]}:${m[2]}`;
            const arr = map.get(key) ?? [];
            arr.push(pid);
            map.set(key, arr);
          }
        } catch {
          // fd vanished between readdir and readlink — skip.
        }
      }
    } catch {
      // process exited mid-scan or no permission — skip.
    }
  }
  return map;
}

/**
 * Returns `true` when the process's stdin pipe is held by at least one OTHER
 * process (i.e. someone is still writing to this MCP server's stdin —
 * typically a live claude client). Returns `false` when stdin is not a pipe,
 * the pipe has no other holders, or any /proc read fails.
 *
 * The orphan reaper uses this as a "still being communicated with" gate:
 * candidates that pass this check are SKIPPED, fixing the false-positive
 * where `npx`-launched MCP servers had their wrapper processes exit
 * (reparenting them to pid 1) while remaining actively wired to claude.
 */
export function isStdinPipePartnerLive(
  pid: number,
  pipeInode: string,
  pipeOwners: ReadonlyMap<string, readonly number[]>,
): boolean {
  const holders = pipeOwners.get(pipeInode);
  if (!holders) return false;
  return holders.some((h) => h !== pid);
}
