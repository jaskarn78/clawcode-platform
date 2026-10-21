/**
 * Phase 109-C — `clawcode preflight` checks before any restart.
 *
 * Read-only command. Aborts (exit 1) when restarting the daemon would be
 * risky given current cgroup memory pressure or in-flight broker tool calls;
 * exits 0 with "OK" otherwise. Operators run this before
 * `systemctl restart clawcode` to catch the today-fire pattern (cgroup at
 * 97.8%, restart-induced boot-storm, fleet OOM) before it happens.
 *
 * Never auto-restarts — output only. Operator decides what to do with the
 * abort.
 *
 * Sources of truth:
 *   - cgroup memory.{current,max} — readCgroupMemoryStats from
 *     manager/cgroup-stats.ts (Phase 109-D).
 *   - broker pool inflight count — `broker-status` IPC (Phase 109-A).
 *   - daemon socket reachable — sendIpcRequest helper.
 */

import type { Command } from "commander";
import { sendIpcRequest } from "../../ipc/client.js";
import { SOCKET_PATH } from "../../manager/daemon.js";
import { ManagerNotRunningError } from "../../shared/errors.js";
import { cliLog, cliError } from "../output.js";
import { readCgroupMemoryStats } from "../../manager/cgroup-stats.js";

export type PreflightResult = {
  readonly ok: boolean;
  readonly aborts: readonly string[];
  readonly warnings: readonly string[];
  readonly memoryPercent: number | null;
  readonly inflightCount: number | null;
};

export type PreflightInputs = {
  readonly cgroup: {
    readonly memoryPercent: number | null;
  } | null;
  readonly broker: {
    readonly inflightCount: number;
  } | null;
  readonly memoryAbortPercent: number;
};

/**
 * Pure decision function — produces the abort/warning list from inputs.
 * Tested in isolation; the CLI action is the thin shell that gathers
 * inputs.
 */
export function evaluatePreflight(inputs: PreflightInputs): PreflightResult {
  const aborts: string[] = [];
  const warnings: string[] = [];
  const memPct = inputs.cgroup?.memoryPercent ?? null;
  if (memPct !== null && memPct > inputs.memoryAbortPercent) {
    aborts.push(
      `cgroup memory at ${memPct.toFixed(1)}% (>${inputs.memoryAbortPercent}% threshold) — ` +
        "restart risks fleet OOM. Stop one or more agents first.",
    );
  } else if (memPct === null) {
    warnings.push(
      "cgroup memory unavailable (non-Linux host or cgroup v2 not mounted) — proceeding without memory pre-check",
    );
  }

  const inflight = inputs.broker?.inflightCount ?? null;
  if (inflight !== null && inflight > 0) {
    aborts.push(
      `${inflight} 1Password broker tool call(s) in-flight — restart will fail them. Wait for completion or run with --force.`,
    );
  }

  return {
    ok: aborts.length === 0,
    aborts,
    warnings,
    memoryPercent: memPct,
    inflightCount: inflight,
  };
}

export function formatPreflight(r: PreflightResult): string {
  const lines: string[] = [];
  if (r.ok) lines.push("OK — daemon restart appears safe");
  else lines.push("ABORT — restart not safe right now");
  if (r.memoryPercent !== null) {
    lines.push(`  cgroup memory: ${r.memoryPercent.toFixed(1)}%`);
  }
  if (r.inflightCount !== null) {
    lines.push(`  broker inflight: ${r.inflightCount}`);
  }
  for (const a of r.aborts) lines.push(`  ✗ ${a}`);
  for (const w of r.warnings) lines.push(`  ⚠ ${w}`);
  return lines.join("\n");
}

export function registerPreflightCommand(program: Command): void {
  program
    .command("preflight")
    .description(
      "Check whether restarting the daemon is safe right now (cgroup memory + broker inflight)",
    )
    .option(
      "--memory-abort <percent>",
      "Abort threshold for cgroup memory percent",
      "80",
    )
    .action(async (opts: { memoryAbort: string }) => {
      const memoryAbortPercent = Number(opts.memoryAbort);
      if (!Number.isFinite(memoryAbortPercent)) {
        cliError(`Invalid --memory-abort value: ${opts.memoryAbort}`);
        process.exit(1);
        return;
      }
      const cgroup = await readCgroupMemoryStats();
      let broker: { inflightCount: number } | null = null;
      try {
        const status = (await sendIpcRequest(SOCKET_PATH, "broker-status", {})) as {
          pools: ReadonlyArray<{ inflightCount: number }>;
        };
        broker = {
          inflightCount: status.pools.reduce(
            (sum, p) => sum + p.inflightCount,
            0,
          ),
        };
      } catch (err) {
        if (err instanceof ManagerNotRunningError) {
          cliError("Manager is not running. Nothing to preflight.");
          process.exit(1);
          return;
        }
        // Broker IPC unreachable for some other reason — surface as warning,
        // don't abort the preflight.
      }

      const result = evaluatePreflight({
        cgroup: cgroup
          ? { memoryPercent: cgroup.memoryPercent }
          : null,
        broker,
        memoryAbortPercent,
      });
      cliLog(formatPreflight(result));
      process.exit(result.ok ? 0 : 1);
    });
}
