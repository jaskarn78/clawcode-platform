/**
 * Remote (ssh-stdio) MCP auto-reconnect — 2026-09-24.
 *
 * WHY: MCP servers that run on another machine over `ssh <host> <server>`
 * (mac-remote-node, mac-chrome, mac-mini-node) die whenever that machine
 * sleeps or reboots, and the Claude Code CLI never notices: measured on the
 * pinned 2.1.280 binary, a stdio server whose process exits keeps reporting
 * `status: "connected"` in `mcpServerStatus()` and is never respawned. Every
 * Mac sleep therefore stranded all four Mac agents' tools until an agent
 * restart (prod 2026-09-24, first overnight reboot after the mac-chrome
 * rollout).
 *
 * The SDK's `Query.reconnectMcpServer(name)` does respawn the server in place
 * (no agent restart, no lost context) — but it must NEVER be aimed at a host
 * that isn't answering: a reconnect into a hanging ssh blocks the session's
 * control channel for the whole ssh ConnectTimeout (measured: a concurrent
 * `mcpServerStatus()` waited 14 s behind it — `interrupt` would too).
 *
 * So the decision below is deliberately conservative:
 *   dead      = SDK says `failed` (accurate for spawn-time failures, e.g. the
 *               daemon booted while the Mac slept) OR the agent's CLI has no
 *               live child process whose argv is exactly [command, ...args]
 *               (ssh is a real binary, so its argv is never rewritten — this is
 *               why the module is scoped to ssh servers only; npx/shebang
 *               servers would false-positive)
 *   reconnect = dead AND host TCP-reachable on N consecutive ticks AND the
 *               agent has no active turn AND the per-server backoff allows it
 *
 * A spurious reconnect of a live server is harmless (the old process is
 * replaced; mac-chrome re-attaches to the Mac-side mux, which keeps the one
 * approved Chrome connection — no new Chrome prompt).
 *
 * Pure: every side effect (process scan, TCP probe, SDK call, clock) is
 * injected, so the decision table is unit-testable.
 */

import { basename } from "node:path";

/** ssh options that consume the NEXT argv element as their value. */
const SSH_OPTS_WITH_VALUE = new Set("BbcDEeFIiJLlmOoPpQRSWw".split(""));

/**
 * Destination host of an ssh-command MCP server, or null when the server is
 * not an ssh invocation. Returns the host part only (`user@host` → `host`),
 * which is what `ssh -G` resolves.
 */
export function sshHostAlias(
  command: string,
  args: readonly string[],
): string | null {
  if (basename(command) !== "ssh") return null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--") {
      const dest = args[i + 1];
      return dest ? stripUser(dest) : null;
    }
    if (a.startsWith("-") && a.length > 1) {
      // `-oFoo=bar` / `-p22` carry their value inline; `-o Foo=bar` / `-p 22`
      // consume the next element. Bundled boolean flags (`-4Ntv`) consume
      // nothing unless the LAST letter takes a value (`-vp 22`).
      const last = a[a.length - 1]!;
      const inlineValue = a.length > 2 && SSH_OPTS_WITH_VALUE.has(a[1]!);
      if (!inlineValue && SSH_OPTS_WITH_VALUE.has(last)) i++;
      continue;
    }
    return stripUser(a);
  }
  return null;
}

function stripUser(dest: string): string {
  const at = dest.lastIndexOf("@");
  return at >= 0 ? dest.slice(at + 1) : dest;
}

/** True when a live process argv is exactly this server's spawn argv. */
export function argvMatchesServer(
  childArgv: readonly string[],
  command: string,
  args: readonly string[],
): boolean {
  if (childArgv.length !== args.length + 1) return false;
  if (basename(childArgv[0]!) !== basename(command)) return false;
  for (let i = 0; i < args.length; i++) {
    if (childArgv[i + 1] !== args[i]) return false;
  }
  return true;
}

/** Tunables. Defaults chosen for a 30 s heartbeat tick. */
export type ReconnectPolicy = Readonly<{
  /** Consecutive reachable probes required before reconnecting (anti-DarkWake-flap). */
  reachableStreak: number;
  /** Minimum gap between two attempts on the same server. */
  minAttemptGapMs: number;
  /** Backoff ceiling after repeated failed attempts. */
  maxBackoffMs: number;
}>;

export const DEFAULT_RECONNECT_POLICY: ReconnectPolicy = Object.freeze({
  reachableStreak: 2,
  minAttemptGapMs: 60_000,
  maxBackoffMs: 15 * 60_000,
});

/** Per (agent, server) memory carried across ticks. */
export type ServerReconnectState = Readonly<{
  reachableStreak: number;
  lastAttemptAt: number | null;
  consecutiveFailures: number;
}>;

export const INITIAL_SERVER_STATE: ServerReconnectState = Object.freeze({
  reachableStreak: 0,
  lastAttemptAt: null,
  consecutiveFailures: 0,
});

/** Required wait after the last attempt, doubling per consecutive failure. */
export function backoffMs(
  consecutiveFailures: number,
  policy: ReconnectPolicy,
): number {
  const exp = Math.min(consecutiveFailures, 10);
  return Math.min(policy.minAttemptGapMs * 2 ** exp, policy.maxBackoffMs);
}

export type RemoteServer = Readonly<{
  name: string;
  command: string;
  args: readonly string[];
  host: string;
}>;

export type RemoteReconnectDeps = Readonly<{
  /** argv of every live child of the agent's CLI process; null = CLI pid unknown. */
  listCliChildArgv: () => Promise<readonly (readonly string[])[] | null>;
  /** SDK-reported status per server name (empty map when unavailable). */
  getSdkStatuses: () => Promise<ReadonlyMap<string, string>>;
  /** Short TCP probe of the ssh destination (resolved via `ssh -G`). */
  isHostReachable: (host: string) => Promise<boolean>;
  hasActiveTurn: () => boolean;
  /** SDK `reconnectMcpServer`; throws on failure. */
  reconnect: (serverName: string) => Promise<void>;
  now: () => number;
}>;

export type ServerOutcome = Readonly<{
  server: string;
  host: string;
  action:
    | "alive"
    | "unknown-pid"
    | "unreachable"
    | "awaiting-streak"
    | "busy"
    | "backoff"
    | "reconnected"
    | "reconnect-failed";
  deadReason?: "sdk-failed" | "no-process";
  error?: string;
}>;

/**
 * One tick for one agent. Returns the per-server outcomes plus the NEXT state
 * map (never mutates `prior`). Never throws — a failing dep degrades that
 * server's outcome, not the tick.
 */
export async function runRemoteMcpReconnectTick(args: {
  readonly servers: readonly RemoteServer[];
  readonly prior: ReadonlyMap<string, ServerReconnectState>;
  readonly deps: RemoteReconnectDeps;
  readonly policy?: ReconnectPolicy;
}): Promise<{
  outcomes: readonly ServerOutcome[];
  next: ReadonlyMap<string, ServerReconnectState>;
}> {
  const policy = args.policy ?? DEFAULT_RECONNECT_POLICY;
  const { deps } = args;
  const next = new Map<string, ServerReconnectState>();
  const outcomes: ServerOutcome[] = [];
  if (args.servers.length === 0) return { outcomes, next };

  const children = await deps.listCliChildArgv().catch(() => null);
  const statuses = await deps
    .getSdkStatuses()
    .catch(() => new Map<string, string>());
  // One probe per host per tick, shared by that host's servers.
  const reachability = new Map<string, Promise<boolean>>();
  const probe = (host: string): Promise<boolean> => {
    let p = reachability.get(host);
    if (!p) {
      p = deps.isHostReachable(host).catch(() => false);
      reachability.set(host, p);
    }
    return p;
  };

  for (const s of args.servers) {
    const prior = args.prior.get(s.name) ?? INITIAL_SERVER_STATE;
    const sdkFailed = statuses.get(s.name) === "failed";
    const processAlive =
      children !== null &&
      children.some((argv) => argvMatchesServer(argv, s.command, s.args));

    if (children === null && !sdkFailed) {
      // CLI pid unknown (agent starting / stopped) and nothing says failed:
      // cannot judge liveness — do nothing, forget the streak.
      next.set(s.name, { ...prior, reachableStreak: 0 });
      outcomes.push({ server: s.name, host: s.host, action: "unknown-pid" });
      continue;
    }
    if (processAlive && !sdkFailed) {
      next.set(s.name, INITIAL_SERVER_STATE);
      outcomes.push({ server: s.name, host: s.host, action: "alive" });
      continue;
    }

    const deadReason = sdkFailed ? "sdk-failed" : "no-process";
    if (!(await probe(s.host))) {
      next.set(s.name, { ...prior, reachableStreak: 0 });
      outcomes.push({ server: s.name, host: s.host, action: "unreachable", deadReason });
      continue;
    }
    const streak = prior.reachableStreak + 1;
    if (streak < policy.reachableStreak) {
      next.set(s.name, { ...prior, reachableStreak: streak });
      outcomes.push({ server: s.name, host: s.host, action: "awaiting-streak", deadReason });
      continue;
    }
    if (deps.hasActiveTurn()) {
      next.set(s.name, { ...prior, reachableStreak: streak });
      outcomes.push({ server: s.name, host: s.host, action: "busy", deadReason });
      continue;
    }
    const t = deps.now();
    if (
      prior.lastAttemptAt !== null &&
      t - prior.lastAttemptAt < backoffMs(prior.consecutiveFailures, policy)
    ) {
      next.set(s.name, { ...prior, reachableStreak: streak });
      outcomes.push({ server: s.name, host: s.host, action: "backoff", deadReason });
      continue;
    }

    try {
      await deps.reconnect(s.name);
      // Trust, but verify: `reconnect` resolves after the new server's
      // initialize handshake, so its process must be visible now. If it
      // isn't, liveness detection is blind for this server (wrong pid,
      // yaml args hot-edited away from the running CLI's boot-time argv,
      // an unseen argv transform) — resetting state here would reconnect
      // it every other tick forever. Count it as a failure so backoff
      // engages instead.
      const after = await deps.listCliChildArgv().catch(() => null);
      const visible =
        after !== null &&
        after.some((argv) => argvMatchesServer(argv, s.command, s.args));
      if (!visible) {
        throw new Error(
          "reconnect resolved but no matching server process is visible (liveness detection blind for this server)",
        );
      }
      next.set(s.name, INITIAL_SERVER_STATE);
      outcomes.push({ server: s.name, host: s.host, action: "reconnected", deadReason });
    } catch (err) {
      next.set(s.name, {
        reachableStreak: streak,
        lastAttemptAt: t,
        consecutiveFailures: prior.consecutiveFailures + 1,
      });
      outcomes.push({
        server: s.name,
        host: s.host,
        action: "reconnect-failed",
        deadReason,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return { outcomes, next };
}

/** The agent's ssh-command MCP servers, with their destination host. */
export function remoteServersOf(
  mcpServers: readonly {
    readonly name: string;
    readonly command: string;
    readonly args: readonly string[];
  }[],
): readonly RemoteServer[] {
  const out: RemoteServer[] = [];
  for (const s of mcpServers) {
    const host = sshHostAlias(s.command, s.args);
    if (host) out.push({ name: s.name, command: s.command, args: s.args, host });
  }
  return out;
}
