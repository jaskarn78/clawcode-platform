/**
 * Phase 109-A — `clawcode broker-status` CLI subcommand.
 *
 * Prints the live OnePasswordMcpBroker pool snapshot as an aligned table:
 * one row per pool with tokenHash + alive + agentRefCount + inflightCount
 * + queueDepth + rpsLastMin + throttleEvents24h + lastRetryAfterSec +
 * respawnCount + childPid. Empty-pool case prints a single-line message.
 *
 * Mirrors the shape of `clawcode mcp-status` (single IPC call, table
 * formatter, ManagerNotRunningError handling). Read-only.
 */

import type { Command } from "commander";
import { sendIpcRequest } from "../../ipc/client.js";
import { SOCKET_PATH } from "../../manager/daemon.js";
import { ManagerNotRunningError } from "../../shared/errors.js";
import { cliLog, cliError } from "../output.js";

/** Mirror of broker.ts:`PoolStatus` — keep the shapes in sync at compile time. */
type BrokerStatusPool = {
  readonly tokenHash: string;
  readonly alive: boolean;
  readonly agentRefCount: number;
  readonly inflightCount: number;
  readonly queueDepth: number;
  readonly respawnCount: number;
  readonly childPid: number | null;
  readonly rpsLastMin?: number;
  readonly throttleEvents24h?: number;
  readonly lastRetryAfterSec?: number | null;
};

type BrokerStatusResponse = {
  readonly pools: readonly BrokerStatusPool[];
  readonly totalRps: number;
  readonly totalThrottles24h: number;
};

/** Format a number-or-undefined cell, defaulting to "-". */
function fmtNum(n: number | undefined | null): string {
  return n === undefined || n === null ? "-" : String(n);
}

export function formatBrokerStatusTable(resp: BrokerStatusResponse): string {
  if (resp.pools.length === 0) {
    return "No 1Password broker pools active (no agents have connected yet)";
  }

  type Row = {
    readonly tokenHash: string;
    readonly alive: string;
    readonly agentRefs: string;
    readonly inflight: string;
    readonly queue: string;
    readonly rps: string;
    readonly throttles: string;
    readonly retryAfter: string;
    readonly respawns: string;
    readonly pid: string;
  };

  const rows: Row[] = resp.pools.map((p) => ({
    tokenHash: p.tokenHash,
    alive: p.alive ? "yes" : "no",
    agentRefs: String(p.agentRefCount),
    inflight: String(p.inflightCount),
    queue: String(p.queueDepth),
    rps: fmtNum(p.rpsLastMin),
    throttles: fmtNum(p.throttleEvents24h),
    retryAfter: fmtNum(p.lastRetryAfterSec),
    respawns: String(p.respawnCount),
    pid: p.childPid !== null ? String(p.childPid) : "-",
  }));

  const widths = {
    tokenHash: Math.max("TOKEN".length, ...rows.map((r) => r.tokenHash.length)),
    alive: Math.max("ALIVE".length, ...rows.map((r) => r.alive.length)),
    agentRefs: Math.max("AGENTS".length, ...rows.map((r) => r.agentRefs.length)),
    inflight: Math.max("IN-FLIGHT".length, ...rows.map((r) => r.inflight.length)),
    queue: Math.max("QUEUE".length, ...rows.map((r) => r.queue.length)),
    rps: Math.max("RPS/60S".length, ...rows.map((r) => r.rps.length)),
    throttles: Math.max("THROTTLES/24H".length, ...rows.map((r) => r.throttles.length)),
    retryAfter: Math.max("RETRY-AFTER(S)".length, ...rows.map((r) => r.retryAfter.length)),
    respawns: Math.max("RESPAWNS".length, ...rows.map((r) => r.respawns.length)),
    pid: Math.max("PID".length, ...rows.map((r) => r.pid.length)),
  };

  const header = [
    "TOKEN".padEnd(widths.tokenHash),
    "ALIVE".padEnd(widths.alive),
    "AGENTS".padEnd(widths.agentRefs),
    "IN-FLIGHT".padEnd(widths.inflight),
    "QUEUE".padEnd(widths.queue),
    "RPS/60S".padEnd(widths.rps),
    "THROTTLES/24H".padEnd(widths.throttles),
    "RETRY-AFTER(S)".padEnd(widths.retryAfter),
    "RESPAWNS".padEnd(widths.respawns),
    "PID".padEnd(widths.pid),
  ].join("  ");

  const totalWidth =
    Object.values(widths).reduce((a, b) => a + b, 0) + 2 * 9;
  const sep = "-".repeat(totalWidth);

  const body = rows.map((r) =>
    [
      r.tokenHash.padEnd(widths.tokenHash),
      r.alive.padEnd(widths.alive),
      r.agentRefs.padEnd(widths.agentRefs),
      r.inflight.padEnd(widths.inflight),
      r.queue.padEnd(widths.queue),
      r.rps.padEnd(widths.rps),
      r.throttles.padEnd(widths.throttles),
      r.retryAfter.padEnd(widths.retryAfter),
      r.respawns.padEnd(widths.respawns),
      r.pid.padEnd(widths.pid),
    ].join("  "),
  );

  const summary = `Totals: ${resp.totalRps} rps (60s) | ${resp.totalThrottles24h} throttle events (24h)`;
  return [header, sep, ...body, "", summary].join("\n");
}

export function registerBrokerStatusCommand(program: Command): void {
  program
    .command("broker-status")
    .description(
      "Show 1Password broker pool snapshot (rps + throttle counters)",
    )
    .action(async () => {
      try {
        const result = (await sendIpcRequest(
          SOCKET_PATH,
          "broker-status",
          {},
        )) as BrokerStatusResponse;
        cliLog(formatBrokerStatusTable(result));
      } catch (error) {
        if (error instanceof ManagerNotRunningError) {
          cliError("Manager is not running. Start it with: clawcode start-all");
          process.exit(1);
          return;
        }
        const msg = error instanceof Error ? error.message : String(error);
        cliError(`Error: ${msg}`);
        process.exit(1);
      }
    });
}
