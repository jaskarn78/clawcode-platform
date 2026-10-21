import { describe, it, expect, vi } from "vitest";
import {
  sshHostAlias,
  argvMatchesServer,
  backoffMs,
  remoteServersOf,
  runRemoteMcpReconnectTick,
  DEFAULT_RECONNECT_POLICY,
  INITIAL_SERVER_STATE,
  type RemoteReconnectDeps,
  type RemoteServer,
  type ServerReconnectState,
} from "../remote-mcp-reconnect.js";

// Verbatim prod args (clawcode.yaml, 2026-09-24).
const MAC_CHROME_ARGS = [
  "-o", "BatchMode=yes", "-o", "ConnectTimeout=15", "-o", "ServerAliveInterval=30",
  "macbook",
  "/Users/x/.local/share/clawcode-mac-node/node/bin/node",
  "/Users/x/.local/share/clawcode-mac-node/chrome-mux.mjs",
  "attach",
];
const MAC_REMOTE_NODE_ARGS = [
  "-o", "BatchMode=yes", "-o", "ConnectTimeout=15", "macbook",
  "env", "PEEKABOO_DISABLE_TOOLS=browser", "/Users/x/.local/bin/peekaboo", "mcp", "--no-remote",
];

const CHROME: RemoteServer = { name: "mac-chrome", command: "ssh", args: MAC_CHROME_ARGS, host: "macbook" };
const PEEKABOO: RemoteServer = { name: "mac-remote-node", command: "ssh", args: MAC_REMOTE_NODE_ARGS, host: "macbook" };

describe("sshHostAlias", () => {
  it("finds the destination after -o option pairs (prod mac-chrome)", () => {
    expect(sshHostAlias("ssh", MAC_CHROME_ARGS)).toBe("macbook");
  });
  it("finds the destination when the remote command has its own flags (prod mac-remote-node)", () => {
    expect(sshHostAlias("ssh", MAC_REMOTE_NODE_ARGS)).toBe("macbook");
  });
  it("strips user@ and honors inline option values", () => {
    expect(sshHostAlias("ssh", ["-oBatchMode=yes", "-p22", "owner_a@macmini", "x"])).toBe("macmini");
  });
  it("skips separated option values and bundled boolean flags", () => {
    expect(sshHostAlias("ssh", ["-p", "2222", "-4Nv", "-i", "/k", "host1", "cmd"])).toBe("host1");
  });
  it("accepts an absolute ssh path", () => {
    expect(sshHostAlias("/usr/bin/ssh", ["h"])).toBe("h");
  });
  it("returns null for non-ssh servers and destination-less argv", () => {
    expect(sshHostAlias("npx", ["-y", "some-mcp"])).toBeNull();
    expect(sshHostAlias("ssh", ["-o", "BatchMode=yes"])).toBeNull();
  });
});

describe("argvMatchesServer", () => {
  it("matches the exact spawn argv (as read from /proc/<pid>/cmdline)", () => {
    expect(argvMatchesServer(["ssh", ...MAC_CHROME_ARGS], "ssh", MAC_CHROME_ARGS)).toBe(true);
  });
  it("rejects a sibling server's argv and a truncated argv", () => {
    expect(argvMatchesServer(["ssh", ...MAC_REMOTE_NODE_ARGS], "ssh", MAC_CHROME_ARGS)).toBe(false);
    expect(argvMatchesServer(["ssh", ...MAC_CHROME_ARGS.slice(0, -1)], "ssh", MAC_CHROME_ARGS)).toBe(false);
  });
});

describe("remoteServersOf", () => {
  it("keeps only ssh servers", () => {
    const out = remoteServersOf([
      { name: "mac-chrome", command: "ssh", args: MAC_CHROME_ARGS },
      { name: "brave-search", command: "npx", args: ["-y", "brave"] },
    ]);
    expect(out.map((s) => s.name)).toEqual(["mac-chrome"]);
    expect(out[0]!.host).toBe("macbook");
  });
});

describe("backoffMs", () => {
  it("doubles per failure and caps", () => {
    const p = DEFAULT_RECONNECT_POLICY;
    expect(backoffMs(0, p)).toBe(60_000);
    expect(backoffMs(1, p)).toBe(120_000);
    expect(backoffMs(50, p)).toBe(p.maxBackoffMs);
  });
});

const ARGV_BY_SERVER: Record<string, string[]> = {
  "mac-chrome": ["ssh", ...MAC_CHROME_ARGS],
  "mac-remote-node": ["ssh", ...MAC_REMOTE_NODE_ARGS],
};

/**
 * Fake world: `live` is the CLI's current children. A successful reconnect
 * spawns the server (adds its argv), exactly like the real SDK does.
 */
function deps(
  over: Partial<RemoteReconnectDeps> = {},
  liveInit: string[][] = [],
): RemoteReconnectDeps & {
  reconnect: ReturnType<typeof vi.fn>;
  isHostReachable: ReturnType<typeof vi.fn>;
  live: string[][];
} {
  const live = [...liveInit];
  return {
    live,
    listCliChildArgv: async () => live,
    getSdkStatuses: async () => new Map(),
    isHostReachable: vi.fn(async () => true),
    hasActiveTurn: () => false,
    reconnect: vi.fn(async (name: string) => {
      live.push(ARGV_BY_SERVER[name]!);
    }),
    now: () => 1_000_000,
    ...over,
  } as never;
}

async function tick(
  servers: readonly RemoteServer[],
  prior: ReadonlyMap<string, ServerReconnectState>,
  d: RemoteReconnectDeps,
) {
  return runRemoteMcpReconnectTick({ servers, prior, deps: d });
}

describe("runRemoteMcpReconnectTick", () => {
  it("live process → alive, no probe, no reconnect, state reset", async () => {
    const d = deps({}, [["ssh", ...MAC_CHROME_ARGS]]);
    const prior = new Map([["mac-chrome", { reachableStreak: 1, lastAttemptAt: 5, consecutiveFailures: 3 }]]);
    const { outcomes, next } = await tick([CHROME], prior, d);
    expect(outcomes[0]!.action).toBe("alive");
    expect(d.isHostReachable).not.toHaveBeenCalled();
    expect(d.reconnect).not.toHaveBeenCalled();
    expect(next.get("mac-chrome")).toEqual(INITIAL_SERVER_STATE);
  });

  it("dead + host unreachable (Mac asleep) → NEVER reconnects (control-channel hang guard)", async () => {
    const d = deps({ isHostReachable: vi.fn(async () => false) });
    const { outcomes, next } = await tick([CHROME], new Map(), d);
    expect(outcomes[0]).toMatchObject({ action: "unreachable", deadReason: "no-process" });
    expect(d.reconnect).not.toHaveBeenCalled();
    expect(next.get("mac-chrome")!.reachableStreak).toBe(0);
  });

  it("dead + reachable needs 2 consecutive ticks, then reconnects once", async () => {
    const d = deps();
    const t1 = await tick([CHROME], new Map(), d);
    expect(t1.outcomes[0]!.action).toBe("awaiting-streak");
    expect(d.reconnect).not.toHaveBeenCalled();
    const t2 = await tick([CHROME], t1.next, d);
    expect(t2.outcomes[0]!.action).toBe("reconnected");
    expect(d.reconnect).toHaveBeenCalledExactlyOnceWith("mac-chrome");
    expect(t2.next.get("mac-chrome")).toEqual(INITIAL_SERVER_STATE);
  });

  it("an unreachable blip resets the streak (DarkWake flap)", async () => {
    let up = true;
    const d = deps({ isHostReachable: vi.fn(async () => up) });
    const t1 = await tick([CHROME], new Map(), d);
    up = false;
    const t2 = await tick([CHROME], t1.next, d);
    up = true;
    const t3 = await tick([CHROME], t2.next, d);
    expect(t3.outcomes[0]!.action).toBe("awaiting-streak");
    expect(d.reconnect).not.toHaveBeenCalled();
  });

  it("active turn → busy, keeps streak, no reconnect", async () => {
    const d = deps({ hasActiveTurn: () => true });
    const prior = new Map([["mac-chrome", { ...INITIAL_SERVER_STATE, reachableStreak: 1 }]]);
    const { outcomes, next } = await tick([CHROME], prior, d);
    expect(outcomes[0]!.action).toBe("busy");
    expect(d.reconnect).not.toHaveBeenCalled();
    expect(next.get("mac-chrome")!.reachableStreak).toBe(2);
  });

  it("failed reconnect backs off, then retries after the gap", async () => {
    let t = 1_000_000;
    const reconnect = vi.fn(async () => { throw new Error("Connection closed"); });
    const d = deps({ reconnect, now: () => t });
    const prior = new Map([["mac-chrome", { ...INITIAL_SERVER_STATE, reachableStreak: 1 }]]);
    const a = await tick([CHROME], prior, d);
    expect(a.outcomes[0]).toMatchObject({ action: "reconnect-failed", error: "Connection closed" });
    expect(a.next.get("mac-chrome")).toMatchObject({ lastAttemptAt: t, consecutiveFailures: 1 });

    t += 60_000; // backoff after 1 failure = 120 s
    const b = await tick([CHROME], a.next, d);
    expect(b.outcomes[0]!.action).toBe("backoff");
    expect(reconnect).toHaveBeenCalledTimes(1);

    t += 61_000;
    const c = await tick([CHROME], b.next, d);
    expect(c.outcomes[0]!.action).toBe("reconnect-failed");
    expect(reconnect).toHaveBeenCalledTimes(2);
    expect(c.next.get("mac-chrome")!.consecutiveFailures).toBe(2);
  });

  it("boot-while-asleep: SDK `failed` counts as dead even while the CLI child list is unknown", async () => {
    let revived = false;
    const d = deps({
      listCliChildArgv: async () => (revived ? [["ssh", ...MAC_CHROME_ARGS]] : null),
      getSdkStatuses: async () => new Map([["mac-chrome", "failed"]]),
      reconnect: vi.fn(async () => { revived = true; }),
    });
    const prior = new Map([["mac-chrome", { ...INITIAL_SERVER_STATE, reachableStreak: 1 }]]);
    const { outcomes } = await tick([CHROME], prior, d);
    expect(outcomes[0]).toMatchObject({ action: "reconnected", deadReason: "sdk-failed" });
  });

  it("CLI pid unknown and SDK not failed → unknown-pid, hands off", async () => {
    const d = deps({ listCliChildArgv: async () => null });
    const { outcomes } = await tick([CHROME], new Map(), d);
    expect(outcomes[0]!.action).toBe("unknown-pid");
    expect(d.isHostReachable).not.toHaveBeenCalled();
  });

  it("probes a shared host once per tick; revives only the dead server", async () => {
    const d = deps({}, [["ssh", ...MAC_REMOTE_NODE_ARGS]]);
    const prior = new Map([["mac-chrome", { ...INITIAL_SERVER_STATE, reachableStreak: 1 }]]);
    const { outcomes } = await tick([CHROME, PEEKABOO], prior, d);
    expect(outcomes.map((o) => [o.server, o.action])).toEqual([
      ["mac-chrome", "reconnected"],
      ["mac-remote-node", "alive"],
    ]);
    expect(d.isHostReachable).toHaveBeenCalledTimes(1);
  });

  it("a throwing dep degrades to a safe outcome instead of throwing", async () => {
    const d = deps({
      listCliChildArgv: async () => { throw new Error("EACCES"); },
      getSdkStatuses: async () => { throw new Error("closed"); },
    });
    const { outcomes } = await tick([CHROME], new Map(), d);
    expect(outcomes[0]!.action).toBe("unknown-pid");
  });

  it("reconnect resolves but no matching process appears → failure + backoff, NOT a reset (no reconnect loop)", async () => {
    // e.g. wrong pid source, or yaml args hot-edited away from the running
    // CLI's boot-time argv: detection is blind for this server.
    let t = 1_000_000;
    const reconnect = vi.fn(async () => {}); // resolves, spawns nothing visible
    const d = deps({ reconnect, now: () => t });
    const prior = new Map([["mac-chrome", { ...INITIAL_SERVER_STATE, reachableStreak: 1 }]]);
    const a = await tick([CHROME], prior, d);
    expect(a.outcomes[0]!.action).toBe("reconnect-failed");
    expect(a.outcomes[0]!.error).toMatch(/no matching server process is visible/);
    expect(a.next.get("mac-chrome")!.consecutiveFailures).toBe(1);

    t += 30_000;
    const b = await tick([CHROME], a.next, d);
    expect(b.outcomes[0]!.action).toBe("backoff");
    expect(reconnect).toHaveBeenCalledTimes(1);
  });

  it("never mutates the prior state map", async () => {
    const prior = new Map([["mac-chrome", { ...INITIAL_SERVER_STATE, reachableStreak: 1 }]]);
    const frozen = JSON.stringify([...prior]);
    await tick([CHROME], prior, deps());
    expect(JSON.stringify([...prior])).toBe(frozen);
  });
});
