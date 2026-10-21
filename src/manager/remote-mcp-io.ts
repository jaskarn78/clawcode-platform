/**
 * I/O edge for remote-mcp-reconnect (2026-09-24). Kept out of the pure
 * decision module so that one stays unit-testable without /proc or sockets.
 */

import { readdir, readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { connect } from "node:net";

const execFileP = promisify(execFile);

/**
 * argv of every live descendant of `pid` (up to `maxDepth` generations),
 * read from /proc (Linux). Unsandboxed, the Claude CLI spawns stdio MCP
 * servers as DIRECT children and ssh keeps its argv verbatim, so
 * `/proc/<child>/cmdline` equals `[command, ...args]` (verified on prod
 * 2026-09-24). Descendants rather than children because under the bwrap
 * sandbox the recorded pid is bwrap's (detached-spawn.ts), making the MCP
 * servers grandchildren. Returns null when /proc is unavailable.
 */
export async function listChildArgv(
  pid: number,
  maxDepth = 3,
): Promise<readonly (readonly string[])[] | null> {
  let entries: string[];
  try {
    entries = await readdir("/proc");
  } catch {
    return null;
  }
  // One pass: ppid → live children.
  const kids = new Map<number, number[]>();
  for (const e of entries) {
    if (!/^\d+$/.test(e)) continue;
    try {
      // /proc/<pid>/stat: "pid (comm) state ppid ..." — comm may contain
      // spaces/parens, so split after the LAST ')'.
      const stat = await readFile(`/proc/${e}/stat`, "utf8");
      const rest = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      if (rest[0] === "Z") continue; // zombie: exited, not reaped yet
      const ppid = Number(rest[1]);
      const list = kids.get(ppid);
      if (list) list.push(Number(e));
      else kids.set(ppid, [Number(e)]);
    } catch {
      // process exited mid-scan — skip
    }
  }
  const out: string[][] = [];
  let frontier = kids.get(pid) ?? [];
  for (let depth = 0; depth < maxDepth && frontier.length > 0; depth++) {
    const nextFrontier: number[] = [];
    for (const child of frontier) {
      try {
        const raw = await readFile(`/proc/${child}/cmdline`);
        const argv = raw.toString("utf8").split("\0");
        if (argv[argv.length - 1] === "") argv.pop();
        if (argv.length > 0) out.push(argv);
      } catch {
        // exited between the stat pass and now — skip
      }
      nextFrontier.push(...(kids.get(child) ?? []));
    }
    frontier = nextFrontier;
  }
  return out;
}

type SshTarget = { readonly hostname: string; readonly port: number };
const targetCache = new Map<string, SshTarget>();

/**
 * Resolve an ssh destination alias to its real hostname/port through the
 * daemon user's ssh config (`ssh -G` prints the effective config without
 * connecting). Cached for the daemon's lifetime — ssh config changes need a
 * restart anyway (mcpServers aren't hot-reloadable).
 */
export async function resolveSshTarget(alias: string): Promise<SshTarget | null> {
  const cached = targetCache.get(alias);
  if (cached) return cached;
  try {
    const { stdout } = await execFileP("ssh", ["-G", alias], { timeout: 5_000 });
    let hostname = alias;
    let port = 22;
    for (const line of stdout.split("\n")) {
      const [k, v] = line.trim().split(/\s+/, 2);
      if (k === "hostname" && v) hostname = v;
      else if (k === "port" && v && Number.isFinite(Number(v))) port = Number(v);
    }
    const target = { hostname, port };
    targetCache.set(alias, target);
    return target;
  } catch {
    return null;
  }
}

/** TCP connect probe: true when something accepts on host:port within timeoutMs. */
export function tcpReachable(
  hostname: string,
  port: number,
  timeoutMs = 3_000,
): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = connect({ host: hostname, port });
    const done = (ok: boolean): void => {
      sock.removeAllListeners();
      sock.destroy();
      resolve(ok);
    };
    sock.setTimeout(timeoutMs, () => done(false));
    sock.once("connect", () => done(true));
    sock.once("error", () => done(false));
  });
}

/** Alias → reachable, via `ssh -G` resolution + TCP probe. */
export async function isSshHostReachable(alias: string): Promise<boolean> {
  const target = await resolveSshTarget(alias);
  if (!target) return false;
  return tcpReachable(target.hostname, target.port);
}
