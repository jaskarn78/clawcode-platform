/**
 * Phase 999.47 Plan 02 Task 2 — `homelab-refresh` heartbeat check.
 *
 * Hourly tick that polls the homelab inventory at
 * `<repoPath>/scripts/refresh.sh` (Plan 03 ships the script body),
 * reads the frozen `<repoPath>/.refresh-last.json` contract written by
 * the script, and emits the SC-7 telemetry log line
 * `phase999.47-homelab-refresh` with the operator-grep shape
 * `{ ok, hostCount, vmCount, containerCount, driftCount, commitsha }`.
 *
 * `journalctl -u clawcode -g phase999.47-homelab-refresh` is the
 * operator's primary surface for verifying that the homelab refresh
 * loop is running.
 *
 * ──────────────────────────────────────────────────────────────────
 * FLEET-LEVEL DESIGN DECISION (plan-context Option A vs Option B):
 * Option A chosen — sentinel agent gating.
 *
 * The heartbeat runner iterates `getRunningAgents()` and calls
 * `execute(ctx)` per-agent. The homelab refresh is fleet-level (one
 * tick across the fleet, not per-agent), so we pick the
 * alphabetically-first running agent as the sentinel and no-op for
 * every other agent. Option B (a separate fleet-level scheduler hook
 * in runner.ts) was rejected because the integration would have
 * exceeded the 30-line additive ceiling the plan budgeted for it —
 * the runner already has per-check interval gating, per-check timeout
 * supervision, NDJSON logging, and zone tracking, and threading a
 * second scheduling pathway through those concerns would have
 * widened the blast radius beyond this plan's scope.
 *
 * Trade-off: every per-agent iteration of this check runs a
 * cheap-but-non-trivial accessor (`getRunningAgents().sort()[0] ===
 * agentName`) and returns early for non-sentinel agents. At fleet
 * scales of ~10-15 agents and a 60-min cadence this is sub-millisecond
 * overhead per tick.
 *
 * ──────────────────────────────────────────────────────────────────
 * MUTEX (Test 7 — D-04c overlap-guard):
 * `isRunning` is module-level state so a sentinel-rotation mid-tick
 * (e.g. the alphabetically-first agent restarts while a prior tick is
 * still in flight) does not bypass the guard. If a new tick fires
 * while the previous one is still draining, we log the structured
 * `previous-tick-still-running` line and return `"warning"`.
 *
 * ──────────────────────────────────────────────────────────────────
 * SUBPROCESS + REINDEX INJECTION (test mockability):
 * The script-runner and the reindex-runner are module-level slots
 * with test-only setters (`__setExecaForTests`, `__setReindexRunnerForTests`).
 * Production uses the promisified `node:child_process.execFile`
 * (Phase 91 sync-runner pattern mirrored from
 * `src/heartbeat/checks/mcp-reconnect.ts`); tests override via the
 * `__set*` helpers and restore in `afterEach`. Matches the existing
 * codebase idiom — fs-probe uses direct `node:fs/promises` imports
 * plus a per-call ctx-injected clock; mcp-reconnect uses execFile
 * via DI helpers. homelab-refresh follows the mcp-reconnect pattern.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { CheckContext, CheckModule, CheckResult } from "../types.js";
import { logger } from "../../shared/logger.js";
import {
  refreshOutputSchema,
  type RefreshOutput,
} from "../../homelab/refresh-output-schema.js";

// ────────────────────────────────────────────────────────────────────
// Module-level mutex — guards against overlapping ticks (Test 7).
// ────────────────────────────────────────────────────────────────────
let isRunning = false;

// ────────────────────────────────────────────────────────────────────
// Module-level injection slots for the subprocess runner + reindex
// runner. Production keeps the defaults; tests override via the __set
// helpers and restore in afterEach.
// ────────────────────────────────────────────────────────────────────
type ExecaLike = (
  command: string,
  args: readonly string[],
  options?: { cwd?: string; timeout?: number },
) => Promise<{ stdout: string; stderr: string; exitCode: number | null }>;

type ReindexRunner = (repoPath: string) => Promise<void>;

const execFileP = promisify(execFile);

// Production subprocess runner — wraps the promisified node:child_process
// execFile. node:child_process returns a richer object than our narrow
// `ExecaLike` shape; the wrapper extracts only stdout/stderr/exitCode.
// On non-zero exit OR timeout, execFile throws with `code` / `signal`
// fields. We translate those into the `ExecaLike` resolved-value shape
// so the check's branching logic stays uniform.
const defaultExecaImpl: ExecaLike = async (cmd, args, options) => {
  try {
    const result = await execFileP(cmd, [...args], {
      cwd: options?.cwd,
      timeout: options?.timeout,
    });
    return {
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: 0,
    };
  } catch (err) {
    const errAny = err as NodeJS.ErrnoException & {
      stdout?: string | Buffer;
      stderr?: string | Buffer;
      code?: number | string;
    };
    const stdout =
      errAny.stdout !== undefined
        ? typeof errAny.stdout === "string"
          ? errAny.stdout
          : errAny.stdout.toString()
        : "";
    const stderr =
      errAny.stderr !== undefined
        ? typeof errAny.stderr === "string"
          ? errAny.stderr
          : errAny.stderr.toString()
        : errAny.message ?? "";
    const exitCode =
      typeof errAny.code === "number" ? errAny.code : errAny.code === undefined ? null : -1;
    return { stdout, stderr, exitCode };
  }
};

let execaImpl: ExecaLike = defaultExecaImpl;

const defaultReindexRunner: ReindexRunner = async (repoPath: string) => {
  // Fire-and-forget: spawn `clawcode homelab reindex --quiet` (owned by
  // Task 3). We swallow errors at the caller so a reindex failure NEVER
  // fails the refresh tick — operators see the failure in a separate
  // `phase999.47-homelab-reindex-error` log line.
  await execaImpl("clawcode", ["homelab", "reindex", "--quiet"], {
    cwd: repoPath,
    timeout: 60_000,
  });
};

let reindexRunner: ReindexRunner = defaultReindexRunner;

/** Test-only: replace the subprocess runner. Restore in afterEach. */
export function __setExecaForTests(impl: ExecaLike | null): void {
  execaImpl = impl ?? defaultExecaImpl;
}

/** Test-only: replace the reindex runner. Restore in afterEach. */
export function __setReindexRunnerForTests(impl: ReindexRunner | null): void {
  reindexRunner = impl ?? defaultReindexRunner;
}

/** Test-only: reset the module-level mutex. */
export function __resetMutexForTests(): void {
  isRunning = false;
}

// ────────────────────────────────────────────────────────────────────
// Defaults — match `defaults.homelab` schema defaults in
// src/config/schema.ts. The check reads the agent config's view of
// these but falls back to the constants when the optional block is
// absent (Task 1: the block IS optional).
// ────────────────────────────────────────────────────────────────────
const DEFAULT_REPO_PATH = "/home/clawcode/homelab";
const DEFAULT_REFRESH_INTERVAL_MINUTES = 60;
const REFRESH_SCRIPT_TIMEOUT_MS = 5 * 60 * 1000; // 5 min — refresh.sh polls remote sources.
const CONSECUTIVE_FAILURE_ALERT_THRESHOLD = 3;

// ────────────────────────────────────────────────────────────────────
// In-memory last-tick tracker for Test 8 (interval-based skip).
// Not persistent — daemon restarts re-arm the next tick freely.
// ────────────────────────────────────────────────────────────────────
let lastTickAtMs: number | null = null;

/** Test-only: reset the last-tick tracker. */
export function __resetLastTickForTests(): void {
  lastTickAtMs = null;
}

type HomelabConfig = {
  readonly enabled: boolean;
  readonly refreshIntervalMinutes: number;
  readonly repoPath: string;
};

/**
 * Resolve the homelab config block. Per-agent overrides are NOT
 * supported (homelab is fleet-level); the loader resolver propagates
 * `defaults.homelab` verbatim into every ResolvedAgentConfig. We read
 * it from the sentinel agent's resolved config and fall back to
 * documented constants when `defaults.homelab` is omitted from
 * clawcode.yaml entirely.
 *
 * Reload semantics: ConfigReloader (Phase 22) re-resolves every
 * agent's ResolvedAgentConfig when clawcode.yaml changes. The next
 * heartbeat tick reads the updated `cfg.homelab` via this function,
 * so a YAML edit to `defaults.homelab.refreshIntervalMinutes` or
 * `enabled` takes effect on the very next tick — no daemon restart
 * required. `repoPath` reads the live value too, but operators
 * should restart for cleanliness (refresh.sh's cwd is captured by
 * the subprocess at boot).
 */
function resolveHomelabConfig(ctx: CheckContext): HomelabConfig {
  const agentConfig = ctx.sessionManager.getAgentConfig?.(ctx.agentName);
  const fromConfig = agentConfig?.homelab;
  return {
    enabled: fromConfig?.enabled ?? true,
    refreshIntervalMinutes:
      fromConfig?.refreshIntervalMinutes ?? DEFAULT_REFRESH_INTERVAL_MINUTES,
    repoPath: fromConfig?.repoPath ?? DEFAULT_REPO_PATH,
  };
}

/**
 * Determine whether THIS execute() invocation is the sentinel run
 * for the fleet-level tick. Picks the alphabetically-first running
 * agent name; returns true only if it matches ctx.agentName.
 */
function isSentinel(ctx: CheckContext): boolean {
  const running = ctx.sessionManager.getRunningAgents();
  if (running.length === 0) return false;
  const sorted = [...running].sort();
  return sorted[0] === ctx.agentName;
}

/**
 * Log a structured `phase999.47-homelab-refresh` line with the
 * canonical operator-grep shape. `commitsha` matches the field name
 * operators grep for in journalctl (no underscore — see plan).
 */
function logRefreshTelemetry(
  level: "info" | "warn",
  payload: {
    readonly ok: boolean;
    readonly hostCount: number;
    readonly vmCount: number;
    readonly containerCount: number;
    readonly driftCount: number;
    readonly commitsha: string | null;
    readonly reason?: string;
  },
): void {
  if (level === "info") {
    logger.info(payload, "phase999.47-homelab-refresh");
  } else {
    logger.warn(payload, "phase999.47-homelab-refresh");
  }
}

/**
 * Build a synthetic zero-counts payload used for malformed / missing
 * / failed-spawn refresh outputs. Keeps the operator-grep field shape
 * stable across all three failure paths.
 */
function syntheticFailurePayload(reason: string): {
  ok: false;
  hostCount: 0;
  vmCount: 0;
  containerCount: 0;
  driftCount: 0;
  commitsha: null;
  reason: string;
} {
  return {
    ok: false,
    hostCount: 0,
    vmCount: 0,
    containerCount: 0,
    driftCount: 0,
    commitsha: null,
    reason,
  };
}

async function readAndParseRefreshOutput(
  repoPath: string,
): Promise<
  | { kind: "ok"; data: RefreshOutput }
  | { kind: "missing" }
  | { kind: "malformed" }
> {
  const outputPath = join(repoPath, ".refresh-last.json");
  let raw: string;
  try {
    raw = await readFile(outputPath, "utf-8");
  } catch (err) {
    const errAny = err as NodeJS.ErrnoException;
    if (errAny.code === "ENOENT") return { kind: "missing" };
    return { kind: "malformed" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: "malformed" };
  }

  const result = refreshOutputSchema.safeParse(parsed);
  if (!result.success) return { kind: "malformed" };
  return { kind: "ok", data: result.data };
}

const homelabRefreshCheck: CheckModule = {
  name: "homelab-refresh",
  // D-04 hourly cadence in seconds. The heartbeat runner's per-check
  // interval gate ensures we only fire once per hour even though it
  // ticks every 60s. Operators can hot-reload `defaults.homelab.refreshIntervalMinutes`
  // in clawcode.yaml — the value above is the module-level fallback;
  // production reads the live value at consumption time (lastTickAtMs
  // self-guard below).
  interval: DEFAULT_REFRESH_INTERVAL_MINUTES * 60,
  // 5-min cap aligned with REFRESH_SCRIPT_TIMEOUT_MS — refresh.sh
  // polls remote sources (tailscale, virsh-over-SSH, op item list);
  // operators tune by restarting if the budget proves too tight.
  timeout: 5 * 60,

  async execute(ctx: CheckContext): Promise<CheckResult> {
    // ────────────────────────────────────────────────────────────────
    // Option A — sentinel-agent gating. Non-sentinel agents no-op.
    // ────────────────────────────────────────────────────────────────
    if (!isSentinel(ctx)) {
      return { status: "healthy", message: "sentinel-skip" };
    }

    const cfg = resolveHomelabConfig(ctx);
    if (!cfg.enabled) {
      return { status: "healthy", message: "homelab-refresh disabled in config" };
    }

    // ────────────────────────────────────────────────────────────────
    // Test 7 — module-level mutex catches overlapping ticks.
    // ────────────────────────────────────────────────────────────────
    if (isRunning) {
      logRefreshTelemetry("warn", syntheticFailurePayload("previous-tick-still-running"));
      return {
        status: "warning",
        message: "previous tick still running — skipping this tick",
      };
    }

    // ────────────────────────────────────────────────────────────────
    // Test 8 — interval-based skip. The runner ticks every 60s but
    // we only refresh once per `refreshIntervalMinutes` window. Reads
    // the resolved config value at execute time, so a hot-reload of
    // `defaults.homelab.refreshIntervalMinutes` takes effect at the
    // next interval boundary without daemon restart.
    // ────────────────────────────────────────────────────────────────
    const intervalMs = cfg.refreshIntervalMinutes * 60 * 1000;
    const nowMs = Date.now();
    if (lastTickAtMs !== null && nowMs - lastTickAtMs < intervalMs) {
      return { status: "healthy", message: "within-interval-window" };
    }

    isRunning = true;
    try {
      lastTickAtMs = nowMs;

      // ──────────────────────────────────────────────────────────────
      // Spawn refresh.sh via injected execa. 5-min timeout — refresh.sh
      // polls multiple remote sources sequentially.
      // ──────────────────────────────────────────────────────────────
      const scriptPath = join(cfg.repoPath, "scripts", "refresh.sh");
      let exitCode: number | null = 0;
      let stderr = "";
      try {
        const result = await execaImpl("bash", [scriptPath], {
          cwd: cfg.repoPath,
          timeout: REFRESH_SCRIPT_TIMEOUT_MS,
        });
        exitCode = result.exitCode;
        stderr = result.stderr;
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        stderr = errMsg.slice(0, 200);
        exitCode = -1;
      }

      if (exitCode !== 0) {
        const reason = stderr.length > 0 ? stderr.slice(0, 200) : "refresh-script-failed";
        logRefreshTelemetry("warn", syntheticFailurePayload(reason));
        return {
          status: "warning",
          message: `homelab refresh.sh failed: ${reason}`,
        };
      }

      // ──────────────────────────────────────────────────────────────
      // Read + parse .refresh-last.json. Branch on every failure path.
      // ──────────────────────────────────────────────────────────────
      const parsed = await readAndParseRefreshOutput(cfg.repoPath);
      if (parsed.kind === "missing") {
        logRefreshTelemetry("warn", syntheticFailurePayload("refresh-output-missing"));
        return {
          status: "warning",
          message: ".refresh-last.json missing after refresh.sh ran",
        };
      }
      if (parsed.kind === "malformed") {
        logRefreshTelemetry("warn", syntheticFailurePayload("refresh-output-malformed"));
        return {
          status: "warning",
          message: ".refresh-last.json malformed (schema parse failed)",
        };
      }

      const data = parsed.data;
      const telemetry = {
        ok: data.ok,
        hostCount: data.counts.hostCount,
        vmCount: data.counts.vmCount,
        containerCount: data.counts.containerCount,
        driftCount: data.counts.driftCount,
        commitsha: data.commitsha,
        ...(data.ok === false && data.failureReason
          ? { reason: data.failureReason }
          : {}),
      };

      if (data.ok === true) {
        logRefreshTelemetry("info", telemetry);

        // ────────────────────────────────────────────────────────────
        // Fire-and-forget reindex. NEVER awaited — a reindex failure
        // must NOT mark the refresh tick as failed.
        // ────────────────────────────────────────────────────────────
        reindexRunner(cfg.repoPath).catch((err) => {
          const errMsg = err instanceof Error ? err.message : String(err);
          logger.warn(
            { err: errMsg },
            "phase999.47-homelab-reindex-error",
          );
        });

        return {
          status: "healthy",
          message: `homelab refreshed: ${data.counts.hostCount} hosts, ${data.counts.vmCount} VMs, ${data.counts.containerCount} containers, ${data.counts.driftCount} drift`,
          metadata: {
            commitsha: data.commitsha,
            counts: data.counts,
            noDiff: data.noDiff,
          },
        };
      }

      // ok === false path — emit the warn telemetry plus the
      // consecutive-failure alert if we've crossed the D-04c threshold.
      logRefreshTelemetry("warn", telemetry);
      if (data.consecutiveFailures >= CONSECUTIVE_FAILURE_ALERT_THRESHOLD) {
        // v1 deliverable: journalctl-grep surface; Discord webhook push
        // deferred (no fleet-alert consumer in src/). Parallel DRIFT.md
        // `## Refresh Failures` row is written by refresh.sh in Plan 03.
        logger.error(
          {
            ok: false,
            reason: data.failureReason,
            consecutiveFailures: data.consecutiveFailures,
          },
          "phase999.47-homelab-fleet-alert",
        );
      }
      return {
        status: "warning",
        message: `homelab refresh failed: ${data.failureReason ?? "unknown"} (consecutiveFailures=${data.consecutiveFailures})`,
      };
    } finally {
      isRunning = false;
    }
  },
};

export default homelabRefreshCheck;
