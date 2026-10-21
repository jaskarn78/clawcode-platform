/**
 * FIND-123-A.next T-01 — structural spawn wrapper for the Claude Agent SDK's
 * `spawnClaudeCodeProcess` hook (sdk.d.ts:1806).
 *
 * The SDK's default `spawnLocalProcess` calls `spawn()` WITHOUT `detached:
 * true`, so the spawned `claude` CLI inherits the daemon's process group.
 * When ClawCode tries to group-kill via `process.kill(-claudePid, signal)`
 * during shutdown, the kernel routes the signal to the daemon's own pgid
 * (no-op or worse). Grandchildren — the per-agent MCP servers
 * `mcp-server-mysql`, npx wrappers, etc. — outlive shutdown and reparent
 * to PID 1, where they idle until the next reaper sweep.
 *
 * This wrapper replaces the SDK default with a spawn that:
 *   - sets `detached: true` so the child becomes its own process-group leader
 *   - mirrors the SDK's stdio contract: stderr is `"ignore"` unless
 *     `DEBUG_CLAUDE_AGENT_SDK` is set in env, matching the default
 *     `G = (DEBUG_CLAUDE_AGENT_SDK || options.stderr) ? "pipe" : "ignore"`
 *     branch in `sdk.mjs:ProcessTransport.spawnLocalProcess`
 *   - keeps `windowsHide: true` (SDK default) and passes through the SDK's
 *     `AbortSignal`
 *   - captures the spawned PID into a caller-supplied mutable sink so the
 *     daemon can `process.kill(-pid, ...)` at shutdown without falling back
 *     to the legacy `/proc`-walk discovery (`discoverClaudeSubprocessPid`).
 *
 * Same pattern as the 999.28 group-kill probe-wrapper precedent
 * (`d15c8f1 fix(mcp): group-kill probe wrappers`).
 *
 * Sink semantics (locked by FIND-123-A.next operator decision):
 *   - mutate-on-every-spawn — the SDK's `ProcessTransport.initialize()` is
 *     re-callable on claude crash + daemon respawn; the latest pid wins
 *   - cleared by `createPersistentSessionHandle`'s `close()` so the daemon
 *     doesn't group-kill a recycled PID at terminal shutdown
 *
 * Out of scope for this wrapper:
 *   - `stderr` callback forwarding (the SDK Options field; not used by
 *     ClawCode today and the SDK doesn't expose it through `SpawnOptions`)
 *   - registering exit listeners — the SDK already wires those in its own
 *     transport layer and double-registration would double-fire `onExit`
 */

import { spawn, type ChildProcess } from "node:child_process";
import type {
  SpawnOptions as SdkSpawnOptions,
  SpawnedProcess as SdkSpawnedProcess,
} from "@anthropic-ai/claude-agent-sdk";
import { applySandboxEnv, seedClaudeConfigDir, wrapWithBwrap, type SandboxBindPlan } from "./bwrap-sandbox.js";
import { logger } from "../shared/logger.js";

const log = logger.child({ component: "detached-spawn" });

/**
 * Attach `'error'` listeners to the spawned child's stdio streams so an
 * asynchronous stream error (most importantly `EPIPE`) can NEVER escalate to a
 * process-wide `uncaughtException` that exits the whole daemon.
 *
 * WHY (2026-06-19 prod-down): a sandboxed agent's `claude` died at cold
 * SDK init (it could not complete init inside the namespace). The
 * SDK's `ProcessTransport.write()` then wrote the next init message to the dead
 * child's stdin. `Writable.write()` does NOT throw EPIPE synchronously — the
 * kernel reports the broken pipe asynchronously as an `'error'` event on the
 * stream. The SDK attaches `process.on("error")` (child-level, handles spawn
 * ENOENT) but attaches NO listener to `child.stdin`/`child.stdout`, and its
 * `write()` only wraps the call in a *synchronous* try/catch. So the async
 * `'error'` had no handler → Node raised `uncaughtException` → the daemon's
 * global handler called `process.exit(1)` → systemd crash-loop. ONE agent's
 * spawn failure took down the ENTIRE 11-agent fleet.
 *
 * Adding an `'error'` listener makes Node deliver the error to us instead of
 * crashing (an EventEmitter with no `'error'` listener throws; with one it does
 * not). The child's death is still observed by the SDK via its `process.on
 * ("exit")` handler → the query iterator rejects → the awaited start/resume path
 * catches it and marks the agent `crashed` (recovery) — the orderly,
 * already-correct failure path that the crash used to preempt.
 *
 * Unconditional (NOT sandbox-gated): any agent whose `claude` dies mid-init can
 * trip this, the sandbox merely made death more likely. Adding listeners does
 * not change the spawn argv/env/stdio, so the fleet still spawns identically;
 * it only adds the missing safety net. Distinct from the SDK's own `onExit`
 * wiring (an `'error'` listener on a stdio stream never double-fires `onExit`).
 */
function guardChildStreams(child: ChildProcess): void {
  const onStreamError = (stream: "stdin" | "stdout" | "stderr") => (err: NodeJS.ErrnoException) => {
    // EPIPE / ECONNRESET = "the peer (claude) went away" — expected when claude
    // dies at init or during teardown; the loud, attributable signal comes from
    // the awaited start/resume rejection. Log at debug to avoid per-restart spam
    // across the fleet. Any OTHER stream error is unexpected → warn.
    const expected = err?.code === "EPIPE" || err?.code === "ECONNRESET";
    const level = expected ? "debug" : "warn";
    log[level](
      { stream, code: err?.code, err: err?.message },
      "claude child stdio error (swallowed — would otherwise crash the daemon)",
    );
  };
  child.stdin?.on("error", onStreamError("stdin"));
  child.stdout?.on("error", onStreamError("stdout"));
  // stderr is "ignore" (no stream) unless DEBUG_CLAUDE_AGENT_SDK piped it.
  child.stderr?.on("error", onStreamError("stderr"));
}

/**
 * Mutable handle the daemon reads during shutdown to obtain the live claude
 * subprocess PID. Owned by `createPersistentSessionHandle`.
 *
 * `pid` is non-null between the moment the wrapper spawns and the moment
 * the handle's `close()` clears it. Mutates on SDK respawn.
 */
export interface ClaudePidSink {
  pid: number | null;
}

/**
 * Build a `spawnClaudeCodeProcess`-compatible closure that the SDK invokes
 * once per (re-)spawn. Each invocation writes the resulting PID into
 * `pidSink` so the daemon can read it without a `/proc` walk.
 *
 * When `sandboxPlan` is present + enabled (and the agent is non-admin), the
 * spawned `command`/`args` are wrapped as `bwrap <binds> -- <command> <args>`
 * (see `bwrap-sandbox.ts`). The wrapper is a pass-through otherwise, so the
 * non-sandboxed fleet spawns byte-identically. bwrap inherits the SAME
 * `cwd`/`env`/`signal`/`stdio` and (via `--die-with-parent` in the bind-set)
 * tears down the inner claude + its MCP grandchildren when killed. The captured
 * PID is bwrap's — the process-group leader (`detached: true`) — so the
 * daemon's `process.kill(-pid)` group-kill at shutdown still reaps the whole
 * sandbox.
 *
 * @param pidSink mutable sink — set on every spawn, cleared on handle close
 * @param sandboxPlan frozen per-agent bwrap bind-plan, or undefined (no sandbox)
 * @returns the spawn function to pass as `options.spawnClaudeCodeProcess`
 */
export function makeDetachedSpawn(
  pidSink: ClaudePidSink,
  sandboxPlan?: SandboxBindPlan,
): (options: SdkSpawnOptions) => SdkSpawnedProcess {
  return ({ command, args, cwd, env, signal }: SdkSpawnOptions): SdkSpawnedProcess => {
    const wantStderr = Boolean(env["DEBUG_CLAUDE_AGENT_SDK"]);
    // Phase 145: ensure the per-agent CLAUDE_CONFIG_DIR exists + is seeded BEFORE
    // the sandboxed claude starts (idempotent; no-op for the non-sandboxed fleet).
    // CRITICAL containment: this is a NEW *synchronous* (mkdir/copy) step on the
    // cold spawn path. A raw throw here would become an `uncaughtException` →
    // daemon crash-loop — the EXACT 2026-06-19 failure class. So catch it and fall
    // through to the spawn: a missing config dir then makes bwrap's hard `--bind`
    // fail → the child exits non-zero → the SDK's onExit → start/resume rejection
    // marks the agent `crashed` (the same orderly, contained channel as any bad
    // bind), NOT a fleet crash. (A copy failure after mkdir succeeds leaves the
    // dir bindable → claude starts degraded; WS-3 preflight / WS-4 canary catch it.)
    try {
      seedClaudeConfigDir(sandboxPlan);
    } catch (err) {
      log.warn(
        { err: (err as NodeJS.ErrnoException)?.message, configDir: sandboxPlan?.claudeConfigDir },
        "seedClaudeConfigDir failed — proceeding; bwrap --bind fails closed if the config dir is absent",
      );
    }
    const wrapped = wrapWithBwrap(command, args, sandboxPlan);
    // Strip the fleet 1Password vault token from a confined agent's env (unless
    // it opted into runtime `op`). Pass-through env reference otherwise.
    const spawnEnv = applySandboxEnv(env, sandboxPlan);
    const child = spawn(wrapped.command, wrapped.args, {
      cwd,
      env: spawnEnv,
      signal,
      stdio: ["pipe", "pipe", wantStderr ? "pipe" : "ignore"],
      windowsHide: true,
      detached: true,
    });
    // Load-bearing fail-safe (2026-06-19 incident): the SDK leaves the child's
    // stdio streams without an `'error'` listener, so an async EPIPE on a write
    // to a dead claude becomes an uncaughtException → daemon exit. Guard them.
    guardChildStreams(child);
    pidSink.pid = child.pid ?? null;
    return child as unknown as SdkSpawnedProcess;
  };
}
