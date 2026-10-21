/**
 * Phase 999.154 — `clawcode vision canary` / `clawcode vision cleanup`.
 *
 *   clawcode vision canary                      run the real-provider fixture check now
 *   clawcode vision cleanup [--agent <name>]    DRY RUN: report stored fake analyses
 *   clawcode vision cleanup --apply [...]       back up each DB, then strip + re-embed
 *
 * Exit codes: 0 ok, 1 error / canary failed.
 */

import type { Command } from "commander";
import { sendIpcRequest } from "../../ipc/client.js";
import { SOCKET_PATH } from "../../manager/daemon.js";
import { IpcError, ManagerNotRunningError } from "../../shared/errors.js";

type Sender = (method: string, params: Record<string, unknown>) => Promise<unknown>;

const defaultSender: Sender = (method, params) => sendIpcRequest(SOCKET_PATH, method, params);

type TableReport = {
  readonly table: string;
  readonly scanned: number;
  readonly changed: number;
  readonly emptied: number;
  readonly residual: number;
};
type AgentReport =
  | { readonly agent: string; readonly skipped: string }
  | {
      readonly agent: string;
      readonly dbPath: string;
      readonly applied: boolean;
      readonly backupPath: string | null;
      readonly tables: readonly TableReport[];
      readonly reclassified: number;
      readonly samples: ReadonlyArray<{ readonly table: string; readonly id: string; readonly removed: string }>;
    };

function ipcFailure(prefix: string, err: unknown): number {
  if (err instanceof ManagerNotRunningError) {
    process.stderr.write(`${prefix}: clawcode daemon is not running.\n`);
  } else if (err instanceof IpcError) {
    process.stderr.write(`${prefix}: daemon-IPC error: ${err.message}\n`);
  } else {
    process.stderr.write(`${prefix}: ${err instanceof Error ? err.message : String(err)}\n`);
  }
  return 1;
}

export function formatCleanupReport(apply: boolean, reports: readonly AgentReport[]): string {
  const lines: string[] = [
    apply ? "VISION CLEANUP — APPLIED" : "VISION CLEANUP — DRY RUN (nothing changed; re-run with --apply)",
  ];
  for (const r of reports) {
    if ("skipped" in r) {
      lines.push(`\n${r.agent}: skipped — ${r.skipped}`);
      continue;
    }
    const touched = r.tables.reduce((n, t) => n + t.changed, 0) + r.reclassified;
    lines.push(`\n${r.agent}  (${r.dbPath})`);
    if (touched === 0) {
      lines.push("  clean — nothing to do");
      continue;
    }
    for (const t of r.tables) {
      if (t.scanned === 0) continue;
      lines.push(
        `  ${t.table.padEnd(20)} changed ${String(t.changed).padStart(5)}` +
          (t.emptied > 0 ? `  (emptied → deleted ${t.emptied})` : "") +
          (t.residual > 0 ? `  ⚠ ${t.residual} residual for manual review` : ""),
      );
    }
    if (r.reclassified > 0) lines.push(`  documents            reclassified ${r.reclassified}`);
    for (const s of r.samples.slice(0, 2)) lines.push(`    e.g. ${s.table}/${s.id}: − ${s.removed}`);
    if (r.backupPath) lines.push(`  backup: ${r.backupPath}`);
  }
  return lines.join("\n");
}

export async function runVisionCleanup(
  opts: { readonly agent?: string; readonly apply?: boolean },
  send: Sender = defaultSender,
): Promise<number> {
  try {
    const res = (await send("vision-cleanup", {
      ...(opts.agent ? { agent: opts.agent } : {}),
      apply: opts.apply === true,
      source: "cli",
    })) as { apply: boolean; reports: AgentReport[] };
    process.stdout.write(`${formatCleanupReport(res.apply, res.reports)}\n`);
    return 0;
  } catch (err) {
    return ipcFailure("vision cleanup", err);
  }
}

export async function runVisionCanary(send: Sender = defaultSender): Promise<number> {
  try {
    const res = (await send("vision-canary", {})) as {
      ok: boolean;
      reason?: string;
      providers?: Record<string, boolean>;
    };
    if (res.reason) {
      process.stderr.write(`vision canary: ${res.reason}\n`);
      return 1;
    }
    for (const [id, passed] of Object.entries(res.providers ?? {})) {
      process.stdout.write(`${passed ? "✅" : "❌"} ${id}\n`);
    }
    return res.ok ? 0 : 1;
  } catch (err) {
    return ipcFailure("vision canary", err);
  }
}

export function registerVisionCommand(parent: Command): void {
  const vision = parent
    .command("vision")
    .description("Vision pipeline tools (Phase 999.154): health canary + contamination cleanup");
  vision
    .command("canary")
    .description("Send the fixture image through each vision provider now and report pass/fail")
    .action(async () => process.exit(await runVisionCanary()));
  vision
    .command("cleanup")
    .description(
      "Find stored fake vision analyses (2026-05-19..09-22 refusals). Dry run unless --apply",
    )
    .option("--agent <name>", "Only this agent")
    .option("--apply", "Back up each DB, then strip refusal blocks, re-embed and reclassify")
    .action(async (o: { agent?: string; apply?: boolean }) =>
      process.exit(await runVisionCleanup({ agent: o.agent, apply: o.apply })),
    );
}
