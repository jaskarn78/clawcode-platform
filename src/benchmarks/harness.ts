/**
 * Bench harness — isolated daemon lifecycle (Plan 51-02).
 *
 * Owns the three-step dance that makes `clawcode bench` deterministic:
 *
 *   1. `writeBenchAgentConfig(tmpHome, { agentName })` — materialize a
 *      minimal clawcode.yaml into a tempdir (no Discord, no MCP, no
 *      scheduler entries — fastest possible boot, haiku model).
 *   2. `spawnIsolatedDaemon({ tmpHome, configPath })` — spawn `npx tsx
 *      src/manager/daemon-entry.ts` with `HOME=<tmpHome>` overridden in
 *      env. Because `MANAGER_DIR = join(homedir(), ".clawcode", "manager")`
 *      resolves at MODULE LOAD via `homedir()`, a tempdir HOME propagates
 *      to a tempdir socket at `<tmpHome>/.clawcode/manager/clawcode.sock`.
 *   3. `awaitDaemonReady(socketPath)` — poll the `status` IPC method until
 *      it responds or the attempt budget is exhausted.
 *   4. Caller runs `bench-run-prompt` / `latency` IPC calls.
 *   5. `handle.stop()` — SIGTERM the daemon, unlink the socket.
 *
 * All three steps are dependency-injectable so unit tests never need to
 * spawn a real daemon — pass `spawner`, `ipcClient`, or `writeConfig`
 * stubs at the call sites.
 *
 * SECURITY: tempdir HOME isolation means the bench daemon cannot read the
 * operator's real `~/.clawcode` state and cannot corrupt it. Socket lives
 * inside the tempdir — no global file-system pollution. `stop()` is
 * idempotent: swallows "already dead" / "socket gone" conditions.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { resolve, join } from "node:path";
import { mkdir, writeFile, unlink, access } from "node:fs/promises";
import { stringify as stringifyYaml } from "yaml";

import { sendIpcRequest } from "../ipc/client.js";
// Phase 999.87 — single source of truth for child-spawn env credential
// handling. The helper strips ANTHROPIC_API_KEY (same effect the
// previous inline `{ ANTHROPIC_API_KEY: _anth, ...rest }` had) and
// HOME passes through as extraEnv (spreads LAST in the helper).
import { buildAnthropicSafeEnv } from "../manager/spawn-env.js";

/** A running (or test-stubbed) isolated daemon handle. */
export type DaemonHandle = {
  readonly pid: number;
  readonly socketPath: string;
  /** SIGTERM the daemon and unlink the socket. Idempotent — swallows errors. */
  readonly stop: () => Promise<void>;
};

/**
 * Subset of `ChildProcess` that `spawnIsolatedDaemon` actually needs. This
 * is the DI contract — test stubs return `{ pid, kill }` without being
 * full `ChildProcess` instances.
 */
export type SpawnedChild = Pick<ChildProcess, "pid" | "kill">;

/** DI-friendly spawner type. Accepts either a fake or node's real spawn. */
export type Spawner = (
  cmd: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
) => SpawnedChild;

/** Options for `spawnIsolatedDaemon`. */
export type SpawnOpts = {
  readonly tmpHome: string;
  readonly configPath: string;
  /** Override for tests — production uses real `spawn`. */
  readonly spawner?: Spawner;
};

const defaultSpawner: Spawner = (cmd, args, env) =>
  spawn(cmd, [...args], {
    detached: true,
    stdio: "ignore",
    env,
    cwd: process.cwd(),
  });

/**
 * Spawn an isolated daemon in a tempdir-rooted HOME so `MANAGER_DIR`
 * resolves to `<tmpHome>/.clawcode/manager` and the socket lives under
 * the tempdir. Returns a `DaemonHandle` with a `stop()` that SIGTERMs the
 * daemon and unlinks the socket (both idempotent).
 *
 * @param opts - `tmpHome` (must exist), `configPath` (the bench-agent
 *               config written by `writeBenchAgentConfig`), and an
 *               optional `spawner` for tests.
 */
export async function spawnIsolatedDaemon(
  opts: SpawnOpts,
): Promise<DaemonHandle> {
  // Pre-create the socket dir so the daemon doesn't race on its own mkdir.
  await mkdir(join(opts.tmpHome, ".clawcode", "manager"), { recursive: true });

  const entryScript = resolve(
    process.cwd(),
    "src/manager/daemon-entry.ts",
  );

  // Phase 999.87 — strip ANTHROPIC_API_KEY via buildAnthropicSafeEnv
  // (single source of truth) so the bench daemon uses Claude Code OAuth
  // like a normal agent. HOME passes through as
  // extraEnv (spreads LAST in the helper) so the tempdir HOME override
  // wins over any inherited ambient HOME.
  const env: NodeJS.ProcessEnv = buildAnthropicSafeEnv({
    HOME: opts.tmpHome,
  }) as NodeJS.ProcessEnv;

  const spawner = opts.spawner ?? defaultSpawner;
  const child = spawner(
    "npx",
    ["tsx", entryScript, "--config", opts.configPath],
    env,
  );

  const pid = child.pid;
  if (typeof pid !== "number") {
    throw new Error("spawnIsolatedDaemon: child process has no pid");
  }

  const socketPath = join(
    opts.tmpHome,
    ".clawcode",
    "manager",
    "clawcode.sock",
  );

  return Object.freeze({
    pid,
    socketPath,
    stop: async () => {
      try {
        child.kill("SIGTERM");
      } catch {
        /* already dead — ignore */
      }
      try {
        await access(socketPath);
        await unlink(socketPath);
      } catch {
        /* socket already gone — ignore */
      }
    },
  });
}

/** Options for `awaitDaemonReady`. */
export type AwaitReadyOpts = {
  readonly maxAttempts?: number;
  readonly delayMs?: number;
  readonly ipcClient?: typeof sendIpcRequest;
};

/**
 * Poll the daemon's `status` IPC method until it responds OR until
 * `maxAttempts` is exhausted. Returns `true` on success, `false` on
 * timeout. Never throws — callers decide how to react to `false`.
 *
 * Defaults: 30 attempts × 500ms = 15s ceiling. Override via opts for
 * tests (50ms × 3 attempts = 150ms ceiling).
 */
export async function awaitDaemonReady(
  socketPath: string,
  opts: AwaitReadyOpts = {},
): Promise<boolean> {
  const maxAttempts = opts.maxAttempts ?? 30;
  const delayMs = opts.delayMs ?? 500;
  const client = opts.ipcClient ?? sendIpcRequest;
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise((r) => setTimeout(r, delayMs));
    try {
      await client(socketPath, "status", {});
      return true;
    } catch {
      /* not ready yet — retry */
    }
  }
  return false;
}

/** Options for `writeBenchAgentConfig`. */
export type WriteBenchConfigOpts = {
  readonly agentName: string;
  readonly model?: "haiku" | "sonnet" | "opus";
};

/**
 * Write a minimal `clawcode.yaml` that defines a single bench-agent. No
 * Discord channels, no MCP servers, no scheduler entries — fastest
 * possible boot. The written YAML round-trips through `loadConfig`.
 *
 * @returns Absolute path to the written config file.
 */
export async function writeBenchAgentConfig(
  tmpHome: string,
  opts: WriteBenchConfigOpts,
): Promise<string> {
  const model = opts.model ?? "haiku";
  const workspace = join(tmpHome, ".clawcode-bench-workspace", opts.agentName);
  await mkdir(workspace, { recursive: true });
  const cfg = {
    version: 1,
    defaults: { model },
    agents: [
      {
        name: opts.agentName,
        channels: [] as string[],
        model,
        heartbeat: false,
        workspace,
      },
    ],
  };
  const path = join(tmpHome, "clawcode-bench.yaml");
  await writeFile(path, stringifyYaml(cfg), "utf-8");
  return path;
}
