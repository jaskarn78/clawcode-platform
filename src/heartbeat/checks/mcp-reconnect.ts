import type { CheckModule, CheckContext, CheckResult } from "../types.js";
import {
  performMcpReadinessHandshake,
  type McpServerState,
  type CapabilityProbeSnapshot,
} from "../../mcp/readiness.js";
import {
  probeAllMcpCapabilities,
  probeMcpCapability,
  type ProbeOrchestratorDeps,
} from "../../manager/capability-probe.js";
import {
  runRecoveryForServer,
} from "../../manager/recovery/registry.js";
import type {
  RecoveryDeps,
  AttemptRecord,
} from "../../manager/recovery/types.js";
import {
  makeRealCallTool,
  makeRealListTools,
  type McpServerConfig as RpcMcpServerConfig,
} from "../../mcp/json-rpc-call.js";
// Heartbeat execFile recovery path. Single source of truth for the child
// env via buildAnthropicSafeEnv.
import { buildAnthropicSafeEnv } from "../../manager/spawn-env.js";
import {
  partitionByThrottle,
  type PriorProbeState,
} from "../../mcp/probe-throttle.js";
import pino from "pino";

/**
 * Phase 85 Plan 01 Task 2 — `mcp-reconnect` heartbeat check.
 *
 * Runs every heartbeat tick (default 60s; per-agent override honored by
 * the heartbeat runner). Re-probes every configured MCP server via the
 * shared `performMcpReadinessHandshake` (same function used by the warm-
 * path startup gate in Task 1 — single regression lane).
 *
 * State machine over the per-agent `McpServerState` map exposed by
 * `SessionManager.getMcpStateForAgent` / `setMcpStateForAgent`:
 *
 *   Prior status    | Probe fresh  | Next status     | Notes
 *   ----------------+--------------+-----------------+---------------------
 *   ready/reconn.   | ready        | ready           | Steady-state; no-op
 *   ready           | failed       | degraded        | First flap
 *   degraded        | failed       | failed          | Persistent failure
 *   failed          | failed       | failed          | Still down
 *   failed          | ready        | ready           | Recovery — `lastSuccessAt`
 *                                                     refreshed, `failureCount`
 *                                                     reset to 0
 *
 * `failureCount` monotonically increments on each failed tick within a
 * `BACKOFF_RESET_MS` (5min) window measured from the last `lastSuccessAt`.
 * After that window elapses without success, the counter resets to 1
 * so operators get a fresh "recently-flapping" signal instead of a
 * monotonically-growing integer.
 *
 * NOT a real reconnect driver — the SDK owns the MCP subprocess lifecycle
 * and will transparently reconnect once the server's transport is healthy.
 * This check classifies + surfaces the health; Plans 02 and 03 read the
 * state to render it in the prompt + slash commands.
 *
 * Invariants:
 *   - Returns `healthy` when all ready, `warning` when any degraded but
 *     none failed, `critical` when any failed.
 *   - Optional-server failures count toward `degraded`/`failed` tallies
 *     but DO NOT escalate the check status past `warning` on their own
 *     (an optional-only failure still surfaces but shouldn't page ops).
 *   - Side-effect contract: persists merged state via both
 *     `sessionManager.setMcpStateForAgent` AND the handle's
 *     `setMcpState` (when reachable), so downstream consumers see the
 *     freshest data via whichever accessor they hold.
 */

/**
 * Rolling-window reset threshold. After this many ms without a successful
 * handshake the `failureCount` recycles to 1. Aligns with human-scale
 * "recent" for the `/clawcode-tools` reporting surface.
 */
const BACKOFF_RESET_MS = 5 * 60_000;

/**
 * Handle shape exposed by the persistent session for state mirroring.
 * Keeps this module's `ctx.sessionManager` access read-only beyond the
 * documented setters/getters.
 */
type HandleWithMcpState = {
  readonly setMcpState?: (s: ReadonlyMap<string, McpServerState>) => void;
  // Phase 94 Plan 03 — recovery-attempt history Map accessor for the
  // bounded 3-attempts-per-hour budget. Stable Map identity across
  // heartbeat ticks so the budget counter accumulates correctly.
  readonly getRecoveryAttemptHistory?: () => Map<string, AttemptRecord[]>;
};

/**
 * Phase 94 Plan 03 — heartbeat-edge recovery deps factory.
 *
 * Builds the DI surface for the recovery registry. Wires:
 *   - execFile via promisified node:child_process.execFile (Phase 91 sync-runner pattern)
 *   - opRead via shelling out to `op read <ref>` through that same execFile
 *   - killSubprocess as a no-op stub (SDK kill API not yet exposed; the
 *     SDK respawns subprocesses transparently, so a logged warn is enough
 *     today — production wiring lands when Plan 94-08 / SDK update lifts)
 *   - adminAlert as a logged warn stub (Phase 90.1 webhookManager wiring
 *     is followup work; the recovery ledger captures every alert event)
 *   - readEnvForServer / writeEnvForServer best-effort against agentConfig
 *
 * The recovery primitives themselves stay DI-pure — production code wires
 * real implementations at THIS edge (the heartbeat tick) per the plan rule.
 */
function buildRecoveryDepsForHeartbeat(
  agentName: string,
  ctx: CheckContext,
  log: import("pino").Logger,
): RecoveryDeps {
  return {
    execFile: async (cmd, args, options) => {
      // Late-load child_process so test workers that mock everything aren't
      // forced to load the native module. Mirrors src/sync/sync-runner.ts.
      const { execFile: execFileCb } = await import("node:child_process");
      return await new Promise((resolve, reject) => {
        const child = execFileCb(
          cmd,
          args as string[],
          {
            maxBuffer: 16 * 1024 * 1024,
            timeout: options?.timeoutMs,
            cwd: options?.cwd,
            // Phase 999.88 — per-site proxy opt-in. The mcp-reconnect
            // health probe spawns the configured MCP-server binary
            // directly via execFile to test process reachability after a
            // heartbeat failure. The reconnect path can be reached for
            // ANY MCP server (finnhub, homeassistant, 1password, AND
            // anthropic). Even for the `anthropic` server the reconnect
            // probe is a simple `--version`-style health command, NOT a
            // JSON-RPC initialize — so it does not need proxy injection.
            //
            // options.env (caller-supplied) passes through as extraEnv
            // (spreads LAST so caller-explicit values survive the strip).
            // Cast mirrors buildSpawnEnv's facade — execFile expects
            // NodeJS.ProcessEnv shape.
            env: buildAnthropicSafeEnv(options?.env,
            ) as NodeJS.ProcessEnv,
          },
          (err, stdout, stderr) => {
            // execFile callback fires with err=null on success. On non-zero
            // child exit, err.exitCode carries the numeric exit code; on
            // spawn errors (ENOENT etc.), err.code carries the system-error
            // string. We resolve with exitCode so the caller can branch on
            // it; spawn errors (ENOENT) propagate as rejections.
            if (err && (err as NodeJS.ErrnoException).errno !== undefined && (err as NodeJS.ErrnoException).code === "ENOENT") {
              reject(err);
              return;
            }
            // Phase 999.88 hygiene (CR-02) — NodeJS.ErrnoException.code is
            // `string | undefined`; the numeric process exit code lives on
            // ExecFileException.exitCode. Reading `.code` as a number was a
            // pre-existing type bug that silently returned 1 for ALL non-zero
            // exits, masking specific exit codes for recovery branching.
            type ExecFileException = NodeJS.ErrnoException & { exitCode?: number };
            const exitCode = err
              ? ((err as ExecFileException).exitCode ?? 1)
              : 0;
            resolve({
              stdout: stdout?.toString() ?? "",
              stderr: stderr?.toString() ?? "",
              exitCode,
            });
          },
        );
        // Phase 999.88 hygiene (WR-03) — the execFile callback already
        // propagates spawn errors via its first argument; the separate
        // `child.on("error", ...)` listener double-rejects an already-
        // settled Promise. Node silently drops the second rejection so the
        // bug isn't observable today, but removing the listener keeps the
        // Promise chain structurally sound.
      });
    },
    killSubprocess: async (serverName: string) => {
      // SDK doesn't expose a direct subprocess-kill API yet. Logged so the
      // operator sees the recovery attempt; the SDK transparently respawns
      // the MCP server on next call after a transport-level failure, so
      // even without a kill, the next heartbeat tick will re-probe and a
      // healthy handshake will lift status to ready.
      log.warn(
        { agent: agentName, serverName },
        "subprocess-restart: SDK kill API not exposed — relying on SDK transparent reconnect",
      );
    },
    adminAlert: async (text: string) => {
      // Phase 90.1 webhookManager bot-direct fallback wiring is followup.
      // For now, log at warn-level so the recovery ledger captures every
      // alert event; the daemon-edge wiring will replace this with a real
      // bot-direct DM to admin-clawdy.
      log.warn({ agent: agentName, alert: text }, "admin-clawdy alert (stub)");
    },
    opRead: async (reference: string) => {
      // Shell out to `op read <reference>`. Caller wraps in try/catch.
      // Phase 999.88 — strip ANTHROPIC_API_KEY via buildAnthropicSafeEnv.
      // The op CLI talks to 1password.com, not Anthropic.
      // Without this, the daemon's ambient ANTHROPIC_API_KEY would leak
      // into a subprocess that has no legitimate reason to see it.
      const { execFile: execFileCb } = await import("node:child_process");
      return await new Promise<string>((resolve, reject) => {
        execFileCb(
          "op",
          ["read", reference],
          {
            maxBuffer: 1024 * 1024,
            timeout: 30_000,
            env: buildAnthropicSafeEnv() as NodeJS.ProcessEnv,
          },
          (err, stdout) => {
            if (err) {
              reject(err);
              return;
            }
            resolve(stdout?.toString().trim() ?? "");
          },
        );
      });
    },
    readEnvForServer: (serverName: string) => {
      const cfg = ctx.sessionManager.getAgentConfig(agentName);
      const server = cfg?.mcpServers?.find((s) => s.name === serverName);
      return server?.env ? { ...server.env } : {};
    },
    writeEnvForServer: async (serverName: string, env: Record<string, string>) => {
      // Heartbeat-edge stub — the SessionManager mutator for live MCP
      // server env doesn't exist yet (Plan 94-08 / config-mutator land).
      // Logged so operators see the resolved env count; the next agent
      // restart will pick up freshly-resolved op:// values from the config.
      log.warn(
        { agent: agentName, serverName, envKeys: Object.keys(env).length },
        "writeEnvForServer: live env mutation not yet wired — restart agent to apply",
      );
    },
    log,
    // Phase 999.10 plan 03 (SEC-05) — when the daemon wired a
    // SecretsResolver into the runner via setSecretsResolver, route
    // op-refresh's invalidate() through it. Without this hook, opRead
    // (which production wires through the resolver) would otherwise
    // return the same stale cached value that triggered the auth-error.
    // Optional: tests / older deploy paths leave secretsResolver
    // undefined and the handler degrades to the pre-999.10 behavior.
    ...(ctx.secretsResolver
      ? {
          invalidate: (ref: string) => {
            ctx.secretsResolver!.invalidate(ref);
          },
        }
      : {}),
  };
}

const mcpReconnectCheck: CheckModule = {
  name: "mcp-reconnect",
  // 60s matches the default heartbeat interval; per-agent config can
  // override to a tighter/looser cadence.
  interval: 60,
  // 20s cap per tick is a conservative bound since the probe spawns
  // one child process per server in parallel, each with its own
  // MCP_HANDSHAKE_TIMEOUT_MS (5s). A fleet of 4 parallel MCPs fits
  // comfortably under 20s even on a cold host.
  timeout: 20,

  async execute(ctx: CheckContext): Promise<CheckResult> {
    const agentConfig = ctx.sessionManager.getAgentConfig(ctx.agentName);
    const allServers = agentConfig?.mcpServers ?? [];
    // Phase 999.27 — skip broker-pooled servers (1password broker shim).
    // The probe spawns the shim with the agent config's BASE env (the
    // daemon's clawdbot-fleet token), NOT the per-agent overridden token.
    // For acme-scope agents this caused the broker to see hash drift
    // every 60s heartbeat tick, triggering rebind cycles + pool churn that
    // saturated MCP capacity. The broker has its own dedicated heartbeat
    // at `heartbeat/checks/mcp-broker.ts` that uses `getPoolStatus()` to
    // verify pool aliveness without spawning probe shims.
    const { filterOutBrokerPooled } = await import(
      "../../mcp/broker-shim-detect.js"
    );
    const allProbeable = filterOutBrokerPooled(allServers);

    // INC-2026-08-11 — per-server probe throttle. A probe SPAWNS a throwaway
    // copy of the server (connect handshake, then capability probe: twice per
    // tick for a healthy one). For playwright-shopping that is a launcher, op
    // work, Xvfb and a real Chrome, every 60s, forever. Servers that opt in via
    // `minProbeIntervalMs` and are steady-state healthy are skipped this tick
    // and their prior state is carried forward VERBATIM below — carrying it is
    // not optional, because the tool-list filter gates on
    // `capabilityProbe.status === "ready"` and an absent/unknown state strips
    // every one of that server's tools from the model.
    const priorStateForThrottle = ctx.sessionManager.getMcpStateForAgent(
      ctx.agentName,
    );
    const { toProbe: servers, carried: carriedServers } = partitionByThrottle(
      allProbeable,
      priorStateForThrottle as ReadonlyMap<string, PriorProbeState>,
      Date.now(),
    );

    if (servers.length === 0 && carriedServers.length > 0) {
      // Everything healthy and inside its interval: nothing to spawn. Prior
      // state is already persisted, so leave it untouched.
      return {
        status: "healthy",
        message: `all ${carriedServers.length} MCP server(s) within probe interval (no spawn)`,
        metadata: { ready: carriedServers.length, degraded: 0, failed: 0, carried: carriedServers.length },
      };
    }

    if (allProbeable.length === 0) {
      return {
        status: "healthy",
        message:
          allServers.length === 0
            ? "no MCP servers configured"
            : "all MCP servers are broker-pooled (covered by mcp-broker check)",
        metadata: { ready: 0, degraded: 0, failed: 0 },
      };
    }

    const priorState = ctx.sessionManager.getMcpStateForAgent(ctx.agentName);
    const rep = await performMcpReadinessHandshake(servers);
    const now = Date.now();
    const merged = new Map<string, McpServerState>();

    let ready = 0;
    let degraded = 0;
    let failed = 0;

    for (const [name, fresh] of rep.stateByName) {
      const prior = priorState.get(name);

      if (fresh.status === "ready") {
        // Recovery (prior was not ready) OR steady-state. Either way the
        // counters reset and lastSuccessAt advances to the fresh value.
        merged.set(
          name,
          Object.freeze({
            ...fresh,
            failureCount: 0,
          }),
        );
        ready++;
        continue;
      }

      // fresh.status === "failed" — probe just couldn't reach it.
      // Decide whether this is a first flap (prior ready) or a continued
      // failure (prior already unhealthy).
      const priorFailures = prior?.failureCount ?? 0;
      const sinceLastSuccess =
        prior?.lastSuccessAt !== null && prior?.lastSuccessAt !== undefined
          ? now - prior.lastSuccessAt
          : Number.POSITIVE_INFINITY;
      const windowExpired = sinceLastSuccess > BACKOFF_RESET_MS;
      const nextCount = windowExpired ? 1 : priorFailures + 1;

      const nextStatus: McpServerState["status"] =
        prior?.status === "ready" ? "degraded" : "failed";

      if (nextStatus === "degraded") {
        degraded++;
      } else {
        failed++;
      }

      merged.set(
        name,
        Object.freeze({
          ...fresh,
          status: nextStatus,
          failureCount: nextCount,
          // Preserve prior lastSuccessAt so the backoff-window timer is
          // measurable across ticks. Fresh probe doesn't know history;
          // we do.
          lastSuccessAt: prior?.lastSuccessAt ?? null,
        }),
      );
    }

    // ----------------------------------------------------------------
    // Phase 94 Plan 01 — capability probe overlay.
    //
    // After the connect-test classifies each server, run the per-server
    // capability probe (`probeAllMcpCapabilities`) and write a
    // `capabilityProbe` snapshot onto each merged entry. The probe layer
    // is the orthogonal capability axis (D-02): connect ok BUT real
    // representative call broken → `degraded`, with verbatim error.
    //
    // Phase 94 Plan 01 Gap-Closure 2 — real callTool / listTools wired at
    // the heartbeat edge via JSON-RPC stdio (src/mcp/json-rpc-call.ts).
    // The capability-probe module itself stays DI-pure; this is the
    // production injection site.
    //
    //   - connect-fail (status: "failed") → capabilityProbe.status="failed",
    //     short-circuit (no probe spawned — we already know it's down)
    //   - connect-ok    (status: "ready") → run the registered probe with
    //     real callTool/listTools. A successful tools/list against the
    //     real MCP subprocess validates capability; failure (spawn ENOENT,
    //     timeout, error envelope) lifts the snapshot to `degraded` with
    //     the verbatim error.
    //
    // getProbeFor stays overridden to default-fallback (listTools-only)
    // until the registry entries' representative-call args are vetted
    // against real servers. Plan 94-03 will lift the override per-server
    // as each probe becomes proven safe to call in production.
    //
    // The lastSuccessAt sticky-preservation across degraded ticks is
    // already handled inside probeMcpCapability — pass prior snapshots in.
    // ----------------------------------------------------------------
    const probeLog = pino({ level: "silent" });
    const serversByName = new Map<string, RpcMcpServerConfig>();
    for (const s of servers) {
      serversByName.set(s.name, {
        name: s.name,
        command: s.command,
        args: s.args,
        env: s.env,
      });
    }
    const realListTools = makeRealListTools(serversByName);
    const realCallTool = makeRealCallTool(serversByName);
    const probeDeps: ProbeOrchestratorDeps = {
      callTool: async (serverName, toolName, args) => {
        return await realCallTool(serverName, toolName, args);
      },
      listTools: async (serverName: string) => {
        return await realListTools(serverName);
      },
      // Override getProbeFor so we run the default-fallback (which only
      // consults listTools) for every server. Plan 94-03 will lift this
      // override per-server as each registry probe is vetted to be safe
      // to call against real production MCP subprocesses (e.g.
      // SELECT 1 against the configured DB, vaults_list against
      // 1Password, browser_snapshot about:blank).
      getProbeFor: () => {
        return async (innerDeps) => {
          try {
            const tools = await innerDeps.listTools("__heartbeat_probe__");
            if (tools.length === 0) {
              return { kind: "failure", error: "no tools exposed" };
            }
            return { kind: "ok" };
          } catch (err) {
            return {
              kind: "failure",
              error: err instanceof Error ? err.message : String(err),
            };
          }
        };
      },
      now: () => new Date(),
      log: probeLog,
    };

    // Carry prior capabilityProbe blocks for lastSuccessAt preservation.
    const prevProbeByName = new Map<string, CapabilityProbeSnapshot>();
    for (const [name, prior] of priorState) {
      if (prior.capabilityProbe) {
        prevProbeByName.set(name, prior.capabilityProbe);
      }
    }

    // Probe ONLY the servers whose connect-test classified as anything
    // other than "failed". For "failed" connect-test we mirror status
    // directly into capabilityProbe — no need to spawn another probe.
    const readyOrDegradedNames: string[] = [];
    for (const [name, state] of merged) {
      if (state.status !== "failed") readyOrDegradedNames.push(name);
    }

    const probeResults = readyOrDegradedNames.length > 0
      ? await probeAllMcpCapabilities(readyOrDegradedNames, probeDeps, prevProbeByName)
      : new Map<string, CapabilityProbeSnapshot>();

    // Re-merge with capabilityProbe blocks attached. For "failed" servers
    // we synthesize the snapshot directly from the connect-test result.
    const probedMerged = new Map<string, McpServerState>();
    const nowIso = new Date().toISOString();
    for (const [name, state] of merged) {
      let probe: CapabilityProbeSnapshot;
      if (state.status === "failed") {
        const prior = prevProbeByName.get(name);
        probe = {
          lastRunAt: nowIso,
          status: "failed",
          ...(state.lastError?.message
            ? { error: state.lastError.message }
            : {}),
          ...(prior?.lastSuccessAt !== undefined
            ? { lastSuccessAt: prior.lastSuccessAt }
            : {}),
        };
      } else {
        // probeResults always has an entry for every readyOrDegraded name.
        probe = probeResults.get(name) ?? {
          lastRunAt: nowIso,
          status: "unknown",
        };
      }
      probedMerged.set(
        name,
        Object.freeze({
          ...state,
          capabilityProbe: probe,
        }),
      );
    }

    // Carry throttled servers through UNCHANGED. This must happen after the
    // loop above and must copy the prior entry wholesale: the loop's
    // `probeResults.get(name) ?? { status: "unknown" }` fallback would
    // otherwise stamp them `unknown`, which the tool-list filter reads as
    // not-ready and strips their tools. A carried server also counts as ready
    // in the tick's own counters, because that is what its state says.
    for (const cs of carriedServers) {
      const prior = priorState.get(cs.name);
      if (prior) {
        probedMerged.set(cs.name, prior);
        ready += 1;
      }
    }

    // ----------------------------------------------------------------
    // Phase 94 Plan 03 — recovery loop.
    //
    // For each server with capabilityProbe.status === "degraded", consult
    // the recovery registry. The registry enforces the bounded
    // 3-attempts-per-hour budget + admin-clawdy alert on the 3rd failure.
    // On a `recovered` outcome, re-probe THAT server immediately and lift
    // the snapshot to ready (so the LLM tool-list filter sees the recovery
    // before the next 60s heartbeat tick).
    //
    // Per-handle attempt history Map persists across ticks via the
    // SessionHandle.getRecoveryAttemptHistory() accessor; falls back to a
    // freshly-allocated Map when the handle isn't reachable (tests with a
    // minimal context). The Map IS NOT mutated for not-applicable outcomes,
    // so a server that no handler matches doesn't burn budget.
    // ----------------------------------------------------------------
    const sm2 = ctx.sessionManager as unknown as {
      readonly sessions?: Map<string, HandleWithMcpState>;
    };
    const handleForRecovery = sm2.sessions?.get(ctx.agentName);
    const attemptHistory: Map<string, AttemptRecord[]> =
      handleForRecovery?.getRecoveryAttemptHistory?.() ?? new Map();
    const recoveryLog = pino({ level: "silent" });
    const recoveryDeps = buildRecoveryDepsForHeartbeat(ctx.agentName, ctx, recoveryLog);

    // Snapshot the merged map so we can mutate per-server entries below
    // for `recovered` outcomes.
    const recoveryAdjusted = new Map<string, McpServerState>(probedMerged);
    for (const [name, state] of probedMerged) {
      const probe = state.capabilityProbe;
      if (!probe || probe.status !== "degraded") continue;
      const outcome = await runRecoveryForServer(
        name,
        state,
        attemptHistory,
        recoveryDeps,
      );
      if (outcome.kind === "recovered") {
        // Re-probe immediately so this tick reflects the recovery. Same
        // stub deps as the initial probe (the heartbeat layer's default-
        // fallback path treats a successful listTools as ready).
        try {
          const refreshedProbe = await probeMcpCapability(name, probeDeps, probe);
          recoveryAdjusted.set(
            name,
            Object.freeze({
              ...state,
              capabilityProbe: refreshedProbe,
            }),
          );
        } catch {
          // Re-probe threw — defensive; leave the original degraded
          // snapshot in place for the next heartbeat tick to retry.
        }
      }
      // not-applicable / retry-later / give-up → no snapshot mutation;
      // the registry already wrote the AttemptRecord entry.
    }

    // Persist merged state through the SessionManager accessor (primary
    // surface — read by IPC `list-mcp-status`, slash commands, and
    // Plan 02's prompt-builder) AND mirror onto the session handle for
    // TurnDispatcher-scope reads.
    ctx.sessionManager.setMcpStateForAgent(ctx.agentName, recoveryAdjusted);

    // Best-effort handle mirror. The sessions map + setMcpState live on
    // the handle contract introduced alongside this check; tolerate
    // absence so tests with a minimal fake context still run.
    try {
      const sm = ctx.sessionManager as unknown as {
        readonly sessions: Map<string, HandleWithMcpState>;
      };
      const handle = sm.sessions?.get(ctx.agentName);
      handle?.setMcpState?.(recoveryAdjusted);
    } catch {
      // Observational — never break the heartbeat tick on a handle miss.
    }

    const message = `${ready} ready, ${degraded} degraded, ${failed} failed`;
    const metadata = { ready, degraded, failed };

    if (failed > 0) {
      return { status: "critical", message, metadata };
    }
    if (degraded > 0) {
      return { status: "warning", message, metadata };
    }
    return { status: "healthy", message, metadata };
  },
};

export default mcpReconnectCheck;
