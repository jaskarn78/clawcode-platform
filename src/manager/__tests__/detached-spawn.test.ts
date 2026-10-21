/**
 * FIND-123-A.next T-06 — unit + integration coverage for makeDetachedSpawn.
 *
 * Three layers:
 *
 *   1. Wrapper unit — assert the returned ChildProcess has its OWN process
 *      group (pgid === pid). This is the property that makes
 *      `process.kill(-pid, signal)` deliver the signal to the entire tree
 *      instead of the daemon's own group.
 *   2. Integration — spawn a real "claude" stand-in that itself spawns a
 *      child. Send SIGTERM to the negative PID; assert both processes
 *      receive the signal (no ESRCH on the grandchild). This reproduces
 *      the FIND-123-A grandchild orphan path end-to-end.
 *   3. Lifecycle — sink mutates on every wrapper invocation
 *      (re-spawn semantics) and never blocks SDK errors.
 *
 * Linux-only invariants (pgid check, `setsid`-like behavior) — skipped
 * on non-Linux. The CI runner (clawdy) is Linux.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { execPath } from "node:process";
import { makeDetachedSpawn, type ClaudePidSink } from "../detached-spawn.js";

// WS-2 Layer A (sandbox-hardening-2026-06-19) — capture the stdio-guard's log
// calls (and keep the suite quiet). The guard MUST log (no silent swallow), so
// the EPIPE-guard tests below assert it does. Harmless to the pre-existing
// suites — they don't assert on the logger.
const { logSpies } = vi.hoisted(() => ({
  logSpies: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
  },
}));
// NB: vi.mock resolves RELATIVE TO THIS TEST FILE (src/manager/__tests__/), so
// the shared logger is two levels up — not the one-level path the source uses.
vi.mock("../../shared/logger.js", () => ({ logger: { child: () => logSpies } }));

const isLinux = process.platform === "linux";

/**
 * Read field 5 (pgid) of /proc/{pid}/stat — POSIX process-group id.
 * Linux-only. Returns null on read failure (process already exited /
 * non-Linux).
 *
 * /proc/PID/stat format: "PID (comm) state ppid pgrp ...". The comm
 * field can contain spaces/parens, so we slice everything after the
 * LAST ')'.
 */
function readPgidViaProcStat(pid: number): number | null {
  try {
    const raw = readFileSync(`/proc/${pid}/stat`, "utf8");
    const lastParen = raw.lastIndexOf(")");
    if (lastParen < 0) return null;
    const fields = raw.slice(lastParen + 1).trim().split(/\s+/);
    // After the closing paren: state(1) ppid(2) pgrp(3) — pgrp is index 2.
    const pgrp = Number(fields[2]);
    return Number.isFinite(pgrp) ? pgrp : null;
  } catch {
    return null;
  }
}

describe("makeDetachedSpawn — wrapper unit", () => {
  let sink: ClaudePidSink;
  beforeEach(() => {
    sink = { pid: null };
  });

  it.skipIf(!isLinux)("Unit-1: spawned child becomes its own process-group leader", async () => {
    const wrapper = makeDetachedSpawn(sink);
    const ac = new AbortController();
    const child = wrapper({
      command: "sleep",
      args: ["5"],
      env: { ...process.env } as Record<string, string | undefined>,
      signal: ac.signal,
    }) as unknown as { pid: number; kill(s: NodeJS.Signals): boolean; on(e: "exit", l: () => void): void };

    expect(child.pid).toBeGreaterThan(1);
    // Linux pgid lookup via /proc/{pid}/stat field 5 (pgrp).
    const pgid = readPgidViaProcStat(child.pid);
    expect(pgid).toBe(child.pid);
    // Cleanup — group-kill via negative PID.
    process.kill(-child.pid, "SIGKILL");
    await new Promise<void>((resolve) => child.on("exit", () => resolve()));
  });

  it("Unit-2: sink is populated synchronously on each wrapper invocation", async () => {
    const wrapper = makeDetachedSpawn(sink);
    const ac = new AbortController();
    expect(sink.pid).toBeNull();

    const child = wrapper({
      command: "sleep",
      args: ["5"],
      env: { ...process.env } as Record<string, string | undefined>,
      signal: ac.signal,
    }) as unknown as { pid: number; on(e: "exit", l: () => void): void };

    expect(sink.pid).toBe(child.pid);

    // Cleanup
    if (isLinux) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        /* best-effort */
      }
    } else {
      ac.abort();
    }
    await new Promise<void>((resolve) => child.on("exit", () => resolve()));
    void ac;
  });

  it("Unit-3: re-invoking the wrapper mutates the SAME sink to the new pid (mutate-on-every-spawn)", async () => {
    const wrapper = makeDetachedSpawn(sink);
    const ac1 = new AbortController();
    const ac2 = new AbortController();

    const child1 = wrapper({
      command: "sleep",
      args: ["5"],
      env: { ...process.env } as Record<string, string | undefined>,
      signal: ac1.signal,
    }) as unknown as { pid: number; on(e: "exit", l: () => void): void };
    const pid1 = sink.pid;
    expect(pid1).toBe(child1.pid);

    const child2 = wrapper({
      command: "sleep",
      args: ["5"],
      env: { ...process.env } as Record<string, string | undefined>,
      signal: ac2.signal,
    }) as unknown as { pid: number; on(e: "exit", l: () => void): void };

    // Latest pid wins — locked sink semantics.
    expect(sink.pid).toBe(child2.pid);
    expect(sink.pid).not.toBe(pid1);

    // Cleanup both.
    for (const c of [child1, child2]) {
      if (isLinux) {
        try {
          process.kill(-c.pid, "SIGKILL");
        } catch {
          /* best-effort */
        }
      }
    }
    await Promise.all([
      new Promise<void>((resolve) => child1.on("exit", () => resolve())),
      new Promise<void>((resolve) => child2.on("exit", () => resolve())),
    ]);
    // Reference acs so unused-var lint stays quiet — abort intentionally
    // skipped because process.kill already terminated both children.
    void ac1;
    void ac2;
  });

  it("Unit-4: stderr defaults to 'ignore' unless DEBUG_CLAUDE_AGENT_SDK env is set", async () => {
    // Indirect contract assertion — the wrapper's stdio behavior is not
    // surface-observable via the returned ChildProcess (Node sets the
    // stream to null when stdio entry is "ignore"). Pin via the
    // resulting ChildProcess.stderr being null when env is unset, and
    // non-null when env is set.
    const wrapper = makeDetachedSpawn(sink);

    const ac = new AbortController();
    const childA = spawnViaWrapper(wrapper, ac.signal, {});
    expect(childA.stderr, "stderr should be null when DEBUG_CLAUDE_AGENT_SDK is unset").toBeNull();
    cleanupChild(childA);
    await new Promise<void>((resolve) => childA.on("exit", () => resolve()));

    const ac2 = new AbortController();
    const childB = spawnViaWrapper(wrapper, ac2.signal, {
      DEBUG_CLAUDE_AGENT_SDK: "1",
    });
    expect(
      childB.stderr,
      "stderr should be a Readable stream when DEBUG_CLAUDE_AGENT_SDK is set",
    ).not.toBeNull();
    cleanupChild(childB);
    await new Promise<void>((resolve) => childB.on("exit", () => resolve()));
  });
});

describe("makeDetachedSpawn — integration with grandchild", () => {
  it.skipIf(!isLinux)(
    "Int-1: SIGTERM to negative-PID reaches a grandchild (no orphan reparenting)",
    async () => {
      // Build a shell command that spawns a `sleep 30` grandchild via
      // `bash -c "sleep 30 & wait $!"`. Both processes share the new
      // process group because of detached:true. SIGTERM to -pid must
      // terminate BOTH (parent + grandchild).
      const sink: ClaudePidSink = { pid: null };
      const wrapper = makeDetachedSpawn(sink);
      const ac = new AbortController();

      const child = wrapper({
        command: "bash",
        args: ["-c", "sleep 30 & echo $! ; wait $!"],
        env: { ...process.env } as Record<string, string | undefined>,
        signal: ac.signal,
      }) as unknown as {
        pid: number;
        stdout: NodeJS.ReadableStream;
        on(e: "exit", l: () => void): void;
      };

      // Read the grandchild pid printed by the echo above.
      const grandchildPidStr = await new Promise<string>((resolve) => {
        let buf = "";
        child.stdout.on("data", (chunk: Buffer) => {
          buf += chunk.toString();
          if (buf.includes("\n")) resolve(buf.trim().split("\n")[0]!);
        });
      });
      const grandchildPid = Number(grandchildPidStr);
      expect(grandchildPid).toBeGreaterThan(1);

      // Group kill via negative PID. Must NOT throw ESRCH.
      let ESRCH = false;
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ESRCH") ESRCH = true;
      }
      expect(ESRCH).toBe(false);

      // Parent must exit.
      await new Promise<void>((resolve) => child.on("exit", () => resolve()));

      // Grandchild must also be dead within a short grace.
      await new Promise<void>((resolve) => setTimeout(resolve, 300));
      let grandchildAlive = false;
      try {
        process.kill(grandchildPid, 0);
        grandchildAlive = true;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ESRCH") grandchildAlive = false;
      }
      expect(
        grandchildAlive,
        `grandchild PID ${grandchildPid} survived process-group SIGTERM — FIND-123-A grandchild leak.`,
      ).toBe(false);
    },
    20_000,
  );
});

function spawnViaWrapper(
  wrapper: ReturnType<typeof makeDetachedSpawn>,
  signal: AbortSignal,
  envOverride: Record<string, string>,
): {
  pid: number;
  stderr: NodeJS.ReadableStream | null;
  on(e: "exit", l: () => void): void;
} {
  return wrapper({
    command: "sleep",
    args: ["5"],
    env: { ...process.env, ...envOverride } as Record<string, string | undefined>,
    signal,
  }) as unknown as {
    pid: number;
    stderr: NodeJS.ReadableStream | null;
    on(e: "exit", l: () => void): void;
  };
}

function cleanupChild(child: { pid: number }): void {
  if (!isLinux) return;
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    /* best-effort */
  }
}

// Suppress unused-import lint when the integration test is the only
// `spawn` consumer and CI skips it on non-Linux runners.
void spawn;

// ---------------------------------------------------------------------------
// WS-2 Layer A — child stdio EPIPE guard (sandbox-hardening-2026-06-19).
//
// Pins the load-bearing fix for the 2026-06-19 prod-down: the Claude Agent SDK
// leaves the spawned child's stdin/stdout WITHOUT an `'error'` listener, so when
// its `ProcessTransport.write()` writes to a dead `claude`'s stdin the async
// EPIPE became an `uncaughtException` → the daemon `process.exit(1)`-ed → the
// whole 11-agent fleet crash-looped. `guardChildStreams` attaches the missing
// listeners so the error is delivered-and-logged, never crash-the-process.
//
// Tested in ISOLATION from Layer B (the global crash classifier, crash-policy.ts)
// with a REAL spawned child — the only faithful way to exercise the actual stream
// objects. The real-kernel EPIPE → SDK exitError → agent-marked-crashed
// composition can only be confirmed at canary (WS-4 validator + broken bind);
// this proves the mechanism that makes that composition non-fatal.
// ---------------------------------------------------------------------------
describe("makeDetachedSpawn — child stdio EPIPE guard (WS-2 Layer A)", () => {
  const spawned: ChildProcess[] = [];

  function spawnGuarded(): ChildProcess {
    const pidSink: ClaudePidSink = { pid: null };
    // No sandbox plan → proves the guard is UNCONDITIONAL (the EPIPE crash can
    // hit any agent whose claude dies mid-init, not just sandboxed ones).
    const wrapper = makeDetachedSpawn(pidSink);
    const child = wrapper({
      command: execPath,
      args: ["-e", "setTimeout(() => {}, 400)"],
      env: { ...process.env } as Record<string, string | undefined>,
      signal: new AbortController().signal,
    }) as unknown as ChildProcess;
    spawned.push(child);
    return child;
  }

  const EPIPE = () => Object.assign(new Error("write EPIPE"), { code: "EPIPE" });

  beforeEach(() => {
    for (const k of Object.keys(logSpies) as (keyof typeof logSpies)[]) logSpies[k].mockClear();
  });

  afterEach(() => {
    for (const c of spawned.splice(0)) {
      try { c.kill("SIGKILL"); } catch { /* already gone */ }
    }
  });

  it("attaches an 'error' listener to stdin AND stdout (the streams the SDK leaves bare)", () => {
    const child = spawnGuarded();
    expect(child.stdin).not.toBeNull();
    expect(child.stdout).not.toBeNull();
    expect(child.stdin!.listenerCount("error")).toBeGreaterThanOrEqual(1);
    expect(child.stdout!.listenerCount("error")).toBeGreaterThanOrEqual(1);
  });

  it("swallows a stdin EPIPE instead of throwing (an unguarded stream crashes the process)", () => {
    const child = spawnGuarded();
    // An EventEmitter with NO 'error' listener throws synchronously on emit;
    // with our listener it is delivered + swallowed. This is exactly how Node
    // surfaces a real broken-pipe write — not throwing here == not crashing the
    // daemon in production.
    expect(() => child.stdin!.emit("error", EPIPE())).not.toThrow();
  });

  it("swallows a stdout EPIPE too (defense-in-depth on the read stream)", () => {
    const child = spawnGuarded();
    expect(() => child.stdout!.emit("error", EPIPE())).not.toThrow();
  });

  it("logs the swallowed EPIPE at debug (expected 'peer went away' — quiet, never silent)", () => {
    const child = spawnGuarded();
    child.stdin!.emit("error", EPIPE());
    expect(logSpies.debug).toHaveBeenCalledTimes(1);
    expect(logSpies.debug.mock.calls[0]![0]).toEqual(
      expect.objectContaining({ stream: "stdin", code: "EPIPE" }),
    );
    expect(logSpies.warn).not.toHaveBeenCalled();
  });

  it("logs an UNEXPECTED stream error at warn (still swallowed, but surfaced)", () => {
    const child = spawnGuarded();
    const weird = Object.assign(new Error("unexpected"), { code: "ESOMETHING" });
    expect(() => child.stdin!.emit("error", weird)).not.toThrow();
    expect(logSpies.warn).toHaveBeenCalledTimes(1);
    expect(logSpies.warn.mock.calls[0]![0]).toEqual(
      expect.objectContaining({ stream: "stdin", code: "ESOMETHING" }),
    );
  });
});
