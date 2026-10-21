/**
 * Phase 96 Plan 07 Task 1 — `fs-probe` heartbeat check.
 *
 * Mirrors src/heartbeat/checks/mcp-reconnect.ts (Phase 85 plan 01).
 *
 * The heartbeat runner already iterates agents and calls execute(ctx)
 * per-agent — so this check is a per-agent execute() (NOT a tick(deps)
 * iterating agents itself). Same shape as mcp-reconnect.
 *
 * Per-tick behavior (per-agent):
 *   1. Resolve fileAccess paths via 96-01 resolveFileAccess loader helper
 *      (defaults+per-agent merge, {agent} token expansion, dedup)
 *   2. Get current SessionHandle via SessionManager.getSessionHandle
 *   3. Read prev snapshot via handle.getFsCapabilitySnapshot (lastSuccessAt
 *      preservation across ticks — Phase 96 D-CONTEXT freshness signal)
 *   4. Invoke runFsProbe(paths, deps, prev) — 5s per-path timeout,
 *      parallel-independence, verbatim error pass-through (96-01)
 *   5. On completed: writeFsSnapshot atomic temp+rename + setFsCapabilitySnapshot
 *      (in-memory mirror updated → next turn's stable prefix re-renders with
 *      fresh capability block per 96-02 / D-13)
 *   6. On failed: graceful no-op (no persist, no in-memory mutation; warning
 *      log + warning result)
 *
 * Schedule contract (D-01):
 *   - boot once via warm-path APPROXIMATION (no separate session-start probe
 *     code path; deploy-runbook Step 4 mandatory fleet-wide `clawcode probe-fs
 *     <agent>` + first 60s heartbeat tick provides TWO-STEP coverage)
 *   - heartbeat tick (60s default — interval=60 below; same cadence as Phase 85
 *     mcp-reconnect)
 *   - on-demand via /clawcode-probe-fs slash + clawcode probe-fs CLI (96-05)
 *
 * Per-agent failure-isolation (FPC-PARALLEL-INDEPENDENCE):
 *   The check catches probe rejections so the heartbeat runner can keep going
 *   for OTHER agents on its next iteration. Mirrors Phase 85 mcp-reconnect's
 *   per-agent try/catch idiom.
 *
 * NEVER re-implements runFsProbe or writeFsSnapshot — production wires
 * 96-01 primitives. Pinned by static-grep (see 96-07 verification block).
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { access, constants, mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { resolve as pathResolve } from "node:path";
import pino from "pino";

import type { CheckModule, CheckContext, CheckResult } from "../types.js";
import { runFsProbe } from "../../manager/fs-probe.js";
import { writeFsSnapshot } from "../../manager/fs-snapshot-store.js";
import { resolveFileAccess } from "../../config/loader.js";

/**
 * Compute the canonical fs-capability.json path for a given agent.
 * Mirrors the same path formula used by the daemon-fs-ipc.ts production
 * wiring (src/manager/daemon.ts:2555-2556):
 *
 *   ~/.clawcode/agents/<agent>/fs-capability.json
 *
 * Operator-observable state for /clawcode-status + clawcode fs-status (96-05).
 * Last-writer-wins atomic temp+rename (RESEARCH.md Pitfall 6) — concurrent
 * writes from heartbeat tick + on-demand probe-fs IPC resolve cleanly.
 */
function getFsCapabilityPath(agent: string): string {
  return join(homedir(), ".clawcode", "agents", agent, "fs-capability.json");
}

const fsProbeCheck: CheckModule = {
  name: "fs-probe",
  // D-01: 60s tick cadence — pinned at module level. Same cadence as Phase
  // 85 mcp-reconnect; adding fs-probe in parallel does NOT compound load
  // because the heartbeat runner runs each check sequentially per agent and
  // the 5s × N path budget per agent fits comfortably within the per-check
  // timeout cap below.
  interval: 60,
  // 30s cap per agent — runFsProbe has 5s per-path timeout via Promise.race,
  // and the inner Promise.all parallelizes path probes within an agent.
  // 30s comfortably covers a 5-path agent with full timeout exhaustion.
  timeout: 30,

  async execute(ctx: CheckContext): Promise<CheckResult> {
    const agentName = ctx.agentName;

    // -------------------------------------------------------------------
    // 1. Lookup agent config — required to resolve fileAccess paths.
    // -------------------------------------------------------------------
    const agentConfig = ctx.sessionManager.getAgentConfig(agentName);
    if (!agentConfig) {
      return {
        status: "warning",
        message: `fs-probe: no config for agent '${agentName}'`,
      };
    }

    // -------------------------------------------------------------------
    // 2. Lookup SessionHandle — required for prev snapshot + write-back.
    //    SessionManager exposes getSessionHandle(name) → handle | undefined.
    //    Missing handle = agent not running (graceful warning, no probe).
    // -------------------------------------------------------------------
    const handle = ctx.sessionManager.getSessionHandle(agentName);
    if (!handle) {
      return {
        status: "warning",
        message: `fs-probe: agent '${agentName}' not running (no session handle)`,
      };
    }

    // -------------------------------------------------------------------
    // 3. Resolve fileAccess paths via 96-01 loader helper.
    //    defaults+per-agent merge with {agent} token expansion + dedup.
    //    The cast widens the strict ResolvedAgentConfig to the narrow
    //    {fileAccess?} surface accepted by resolveFileAccess.
    // -------------------------------------------------------------------
    const paths = resolveFileAccess(
      agentName,
      agentConfig as unknown as { readonly fileAccess?: readonly string[] },
      // No defaults available at this layer — resolved config already
      // merged defaults at config-load time. resolveFileAccess gracefully
      // handles undefined defaults.
      undefined,
    );

    // -------------------------------------------------------------------
    // 4. Read prev snapshot for lastSuccessAt preservation across ticks.
    //    Map identity preserved — runFsProbe never mutates this argument.
    // -------------------------------------------------------------------
    const prevSnapshot = handle.getFsCapabilitySnapshot();

    // -------------------------------------------------------------------
    // 5. Invoke runFsProbe (96-01 primitive). Per-agent failure-isolation:
    //    catch rejections so the heartbeat runner can keep going for
    //    OTHER agents on its next per-agent iteration.
    // -------------------------------------------------------------------
    const probeLog = pino({ level: "silent" });
    let outcome;
    try {
      outcome = await runFsProbe(
        paths,
        {
          fsAccess: access,
          fsConstants: constants,
          realpath,
          resolve: pathResolve,
          now: () => new Date(),
          log: probeLog,
        },
        prevSnapshot,
      );
    } catch (err) {
      // Programmer-error path (runFsProbe normally swallows fs.access
      // failures internally; this catches sync throws inside the primitive
      // itself). Mirrors Phase 85 mcp-reconnect's defensive catch idiom.
      const errMsg = err instanceof Error ? err.message : String(err);
      return {
        status: "warning",
        message: `fs-probe: probe primitive crashed — ${errMsg}`,
      };
    }

    // -------------------------------------------------------------------
    // 6a. outcome.kind='failed' → graceful no-op (no persist, no in-memory
    //     mutation). Operator sees the warning in heartbeat.log + can run
    //     /clawcode-probe-fs <agent> manually for retry (96-05).
    // -------------------------------------------------------------------
    if (outcome.kind === "failed") {
      return {
        status: "warning",
        message: `fs-probe: probe failed — ${outcome.error}`,
      };
    }

    // -------------------------------------------------------------------
    // 6b. outcome.kind='completed' → atomic-write persist + in-memory mirror
    //     update. setFsCapabilitySnapshot triggers next turn's stable
    //     prefix re-render with fresh capability block (96-02 / D-13).
    //
    //     Persistence is best-effort (RESEARCH.md Pitfall 6): a writeFs-
    //     Snapshot failure (disk full, permissions race) does NOT block
    //     the in-memory update — operator inspection via /clawcode-status
    //     reads the in-memory mirror, not the file.
    // -------------------------------------------------------------------
    handle.setFsCapabilitySnapshot(outcome.snapshot);

    try {
      await writeFsSnapshot(
        agentName,
        outcome.snapshot,
        getFsCapabilityPath(agentName),
        {
          writeFile: (p, data, enc) => writeFile(p, data, enc),
          rename,
          // node:fs/promises.mkdir returns Promise<string | undefined>;
          // wrap to match the FsSnapshotStoreDeps Promise<void> signature.
          mkdir: async (p, options) => {
            await mkdir(p, options);
          },
          readFile: (p, enc) => readFile(p, enc),
          log: probeLog,
        },
      );
    } catch (err) {
      // Operator can run /clawcode-probe-fs to re-write; the in-memory
      // mirror has the fresh state regardless.
      const errMsg = err instanceof Error ? err.message : String(err);
      return {
        status: "warning",
        message: `fs-probe: in-memory snapshot updated, persist skipped — ${errMsg}`,
        metadata: {
          probed: outcome.snapshot.size,
          durationMs: outcome.durationMs,
        },
      };
    }

    // -------------------------------------------------------------------
    // 7. Tally status counts for the heartbeat result message.
    // -------------------------------------------------------------------
    let ready = 0;
    let degraded = 0;
    let unknown = 0;
    for (const entry of outcome.snapshot.values()) {
      if (entry.status === "ready") ready++;
      else if (entry.status === "degraded") degraded++;
      else unknown++;
    }

    const message = `${ready} ready, ${degraded} degraded, ${unknown} unknown (probed ${outcome.snapshot.size} paths in ${outcome.durationMs}ms)`;
    const metadata = {
      ready,
      degraded,
      unknown,
      probed: outcome.snapshot.size,
      durationMs: outcome.durationMs,
    };

    if (degraded > 0) {
      return { status: "warning", message, metadata };
    }
    return { status: "healthy", message, metadata };
  },
};

export default fsProbeCheck;
