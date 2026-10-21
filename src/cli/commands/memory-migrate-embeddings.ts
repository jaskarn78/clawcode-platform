/**
 * Phase 115 D-08 — `clawcode memory migrate-embeddings <subcommand>` CLI.
 *
 * Operator-facing subcommands for driving the embedding-v2 migration
 * timeline post-deploy:
 *   - status [agent]              — print phase + progress + paused
 *                                   for one agent or all.
 *   - start <agent>               — transition to dual-write (T+0).
 *   - re-embed <agent>            — transition dual-write -> re-embedding
 *                                   (T+7d). Reads remaining work count.
 *   - pause <agent>               — pause the background batch worker
 *                                   (state machine stays at current phase).
 *   - resume <agent>              — un-pause the background batch worker.
 *   - force-cutover <agent>       — DANGER: switch reads to v2 even if
 *                                   re-embed incomplete. Confirms.
 *   - rollback <agent>            — DANGER: revert reads to v1; v2 column
 *                                   data preserved for re-attempt.
 *
 * Backed by the IPC methods registered in src/ipc/protocol.ts and
 * dispatched in src/manager/daemon.ts:
 *   - embedding-migration-status
 *   - embedding-migration-transition
 *   - embedding-migration-pause
 *   - embedding-migration-resume
 *
 * Migration timeline (T+0/T+7d/T+14d) runs POST-DEPLOY in production —
 * this CLI is the operator surface; this plan ships the machinery only.
 */

import type { Command } from "commander";
import { createInterface } from "node:readline/promises";
import { sendIpcRequest } from "../../ipc/client.js";
import { SOCKET_PATH } from "../../manager/daemon.js";
import { ManagerNotRunningError } from "../../shared/errors.js";
import { cliError, cliLog } from "../output.js";

/** Shape returned by `embedding-migration-status` IPC. */
interface MigrationStatusEntry {
  readonly agent: string;
  readonly phase: string;
  readonly progressProcessed: number;
  readonly progressTotal: number;
  readonly lastCursor: string | null;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly paused: boolean;
  readonly error?: string;
  /** Phase 999.119 v2 switch — which space reads run against right now. */
  readonly readVersion?: "v1" | "v2";
  /** Phase 999.119 v2 switch — v2 coverage (rows with a v2 vector / rows with a v1 vector). */
  readonly coverage?: Readonly<{
    memories: number;
    memoriesV2: number;
    chunks: number;
    chunksV2: number;
  }>;
}

interface MigrationStatusResponse {
  readonly results: ReadonlyArray<MigrationStatusEntry>;
}

interface TransitionResponse {
  readonly ok: boolean;
  readonly phase?: string;
  readonly error?: string;
}

interface PauseResumeResponse {
  readonly ok: boolean;
  readonly paused?: ReadonlyArray<string>;
  readonly error?: string;
}

/**
 * Format the status response as a human-readable table.
 */
function formatStatus(data: MigrationStatusResponse): string {
  if (data.results.length === 0) {
    return "No agents found.";
  }
  const rows = data.results.map((r) => ({
    agent: r.agent,
    phase: r.phase,
    progress:
      r.progressTotal > 0
        ? `${r.progressProcessed}/${r.progressTotal} (${Math.floor((r.progressProcessed / r.progressTotal) * 100)}%)`
        : `${r.progressProcessed}/--`,
    paused: r.paused ? "yes" : "no",
    started: r.startedAt ? r.startedAt.slice(0, 19).replace("T", " ") : "--",
    cursor: r.lastCursor ? r.lastCursor.slice(0, 16) : "--",
    // Phase 999.119 v2 switch — read space + coverage columns.
    reads: r.readVersion ?? "--",
    coverage: r.coverage
      ? `${r.coverage.memoriesV2}/${r.coverage.memories} mem, ${r.coverage.chunksV2}/${r.coverage.chunks} chunks`
      : "--",
  }));

  const widths = {
    agent: Math.max(5, ...rows.map((r) => r.agent.length)),
    phase: Math.max(5, ...rows.map((r) => r.phase.length)),
    progress: Math.max(8, ...rows.map((r) => r.progress.length)),
    paused: 6,
    started: Math.max(7, ...rows.map((r) => r.started.length)),
    cursor: Math.max(6, ...rows.map((r) => r.cursor.length)),
    reads: 5,
    coverage: Math.max(11, ...rows.map((r) => r.coverage.length)),
  };

  const header = [
    "AGENT".padEnd(widths.agent),
    "PHASE".padEnd(widths.phase),
    "PROGRESS".padEnd(widths.progress),
    "PAUSED".padEnd(widths.paused),
    "STARTED".padEnd(widths.started),
    "CURSOR".padEnd(widths.cursor),
    "READS".padEnd(widths.reads),
    "V2 COVERAGE".padEnd(widths.coverage),
  ].join("  ");
  const sep = "-".repeat(
    widths.agent +
      widths.phase +
      widths.progress +
      widths.paused +
      widths.started +
      widths.cursor +
      widths.reads +
      widths.coverage +
      14,
  );
  const formatted = rows.map((r) =>
    [
      r.agent.padEnd(widths.agent),
      r.phase.padEnd(widths.phase),
      r.progress.padEnd(widths.progress),
      r.paused.padEnd(widths.paused),
      r.started.padEnd(widths.started),
      r.cursor.padEnd(widths.cursor),
      r.reads.padEnd(widths.reads),
      r.coverage.padEnd(widths.coverage),
    ].join("  "),
  );
  // Append any per-agent errors at the bottom for visibility.
  const errors = data.results
    .filter((r) => r.error)
    .map((r) => `  [${r.agent}] error: ${r.error!}`);
  return [
    "Embedding-v2 migration status (Phase 115 D-08)",
    "",
    header,
    sep,
    ...formatted,
    ...(errors.length ? ["", "Errors:", ...errors] : []),
  ].join("\n");
}

/**
 * Read y/n confirmation from operator (DANGER subcommands).
 */
async function confirmInteractive(prompt: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(`${prompt} [y/N]: `)).trim().toLowerCase();
    return answer === "y" || answer === "yes";
  } finally {
    rl.close();
  }
}

/**
 * Wrap an IPC call with the standard ManagerNotRunningError -> exit 1
 * pattern other CLI subcommands use.
 */
async function callIpc<T>(
  method: Parameters<typeof sendIpcRequest>[1],
  params: Record<string, unknown>,
): Promise<T> {
  try {
    return (await sendIpcRequest(SOCKET_PATH, method, params)) as T;
  } catch (error) {
    if (error instanceof ManagerNotRunningError) {
      cliError("Manager is not running. Start it with: clawcode start-all");
      process.exit(1);
    }
    throw error;
  }
}

/**
 * Register the `migrate-embeddings` subcommand under the parent `memory`
 * command. Called from src/cli/commands/memory.ts alongside
 * registerMemoryBackfillCommand.
 */
export function registerMigrateEmbeddingsCommand(parent: Command): void {
  const cmd = parent
    .command("migrate-embeddings")
    .description(
      "Phase 115 D-08 — operator controls for embedding-v2 (bge-small + int8) migration",
    );

  cmd
    .command("status [agent]")
    .description("Print current migration phase + progress for one agent or all")
    .action(async (agent?: string) => {
      try {
        const params: Record<string, unknown> = {};
        if (agent) params.agent = agent;
        const result = await callIpc<MigrationStatusResponse>(
          "embedding-migration-status",
          params,
        );
        cliLog(formatStatus(result));
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        cliError(`Error: ${msg}`);
        process.exit(1);
      }
    });

  cmd
    .command("start <agent>")
    .description(
      "Transition agent to dual-write phase (T+0). Begins writing v1 + v2 vectors on every new memory.",
    )
    .action(async (agent: string) => {
      try {
        const result = await callIpc<TransitionResponse>(
          "embedding-migration-transition",
          { agent, toPhase: "dual-write" },
        );
        if (!result.ok) {
          cliError(`Failed: ${result.error ?? "unknown error"}`);
          process.exit(1);
          return;
        }
        cliLog(`agent ${agent} -> phase ${result.phase}`);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        cliError(`Error: ${msg}`);
        process.exit(1);
      }
    });

  cmd
    .command("switch <agent>")
    .description(
      "Phase 999.119 — start the v2 backfill in one step: dual-write (if not already) then re-embedding. The daemon's 30 s runner fills memories then chunks; when both are complete the phase auto-advances to re-embed-complete. Run `force-cutover` after that to flip reads to v2 (instant; `rollback` flips back).",
    )
    .action(async (agent: string) => {
      try {
        const status = await callIpc<MigrationStatusResponse>(
          "embedding-migration-status",
          { agent },
        );
        const current = status.results[0]?.phase ?? "idle";
        if (current === "idle" || current === "rolled-back") {
          const r1 = await callIpc<TransitionResponse>(
            "embedding-migration-transition",
            { agent, toPhase: "dual-write" },
          );
          if (!r1.ok) {
            cliError(`Failed: ${r1.error ?? "unknown error"}`);
            process.exit(1);
            return;
          }
          cliLog(`agent ${agent} -> phase dual-write`);
        }
        if (current === "idle" || current === "rolled-back" || current === "dual-write") {
          const r2 = await callIpc<TransitionResponse>(
            "embedding-migration-transition",
            { agent, toPhase: "re-embedding" },
          );
          if (!r2.ok) {
            cliError(`Failed: ${r2.error ?? "unknown error"}`);
            process.exit(1);
            return;
          }
          cliLog(`agent ${agent} -> phase ${r2.phase} (runner will fill memories, then chunks)`);
        } else {
          cliLog(`agent ${agent} is already in phase ${current} — nothing to start`);
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        cliError(`Error: ${msg}`);
        process.exit(1);
      }
    });

  cmd
    .command("re-embed <agent>")
    .description(
      "Transition agent to re-embedding phase (T+7d). Background batch runner starts re-embedding historical memories.",
    )
    .action(async (agent: string) => {
      try {
        const result = await callIpc<TransitionResponse>(
          "embedding-migration-transition",
          { agent, toPhase: "re-embedding" },
        );
        if (!result.ok) {
          cliError(`Failed: ${result.error ?? "unknown error"}`);
          process.exit(1);
          return;
        }
        cliLog(`agent ${agent} -> phase ${result.phase}`);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        cliError(`Error: ${msg}`);
        process.exit(1);
      }
    });

  cmd
    .command("pause <agent>")
    .description(
      "Pause the background re-embed batch runner for this agent (state machine phase unchanged)",
    )
    .action(async (agent: string) => {
      try {
        const result = await callIpc<PauseResumeResponse>(
          "embedding-migration-pause",
          { agent },
        );
        if (!result.ok) {
          cliError(`Failed: ${result.error ?? "unknown error"}`);
          process.exit(1);
          return;
        }
        cliLog(`paused ${agent}; pausedAgents = ${JSON.stringify(result.paused ?? [])}`);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        cliError(`Error: ${msg}`);
        process.exit(1);
      }
    });

  cmd
    .command("resume <agent>")
    .description("Un-pause the background re-embed batch runner")
    .action(async (agent: string) => {
      try {
        const result = await callIpc<PauseResumeResponse>(
          "embedding-migration-resume",
          { agent },
        );
        if (!result.ok) {
          cliError(`Failed: ${result.error ?? "unknown error"}`);
          process.exit(1);
          return;
        }
        cliLog(
          `resumed ${agent}; pausedAgents = ${JSON.stringify(result.paused ?? [])}`,
        );
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        cliError(`Error: ${msg}`);
        process.exit(1);
      }
    });

  cmd
    .command("force-cutover <agent>")
    .description(
      "DANGER: Force agent reads to switch to v2 immediately. Operator confirms. Requires re-embed-complete.",
    )
    .option("-y, --yes", "Skip interactive confirmation")
    .action(async (agent: string, opts: { yes?: boolean }) => {
      const ok =
        opts.yes ??
        (await confirmInteractive(
          `Force cutover to v2 for ${agent}? (Reads switch to v2; v1 column kept for 24h soak.)`,
        ));
      if (!ok) {
        cliLog("Cancelled.");
        return;
      }
      try {
        const result = await callIpc<TransitionResponse>(
          "embedding-migration-transition",
          { agent, toPhase: "cutover" },
        );
        if (!result.ok) {
          cliError(`Failed: ${result.error ?? "unknown error"}`);
          process.exit(1);
          return;
        }
        cliLog(`agent ${agent} -> phase ${result.phase} (cutover)`);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        cliError(`Error: ${msg}`);
        process.exit(1);
      }
    });

  cmd
    .command("rollback <agent>")
    .description(
      "DANGER: Roll back agent to v1 reads. v2 column data preserved for re-attempt.",
    )
    .option("-y, --yes", "Skip interactive confirmation")
    .action(async (agent: string, opts: { yes?: boolean }) => {
      const ok =
        opts.yes ??
        (await confirmInteractive(
          `Roll back ${agent} to v1? (Reads revert to v1; v2 column data kept for re-attempt.)`,
        ));
      if (!ok) {
        cliLog("Cancelled.");
        return;
      }
      try {
        const result = await callIpc<TransitionResponse>(
          "embedding-migration-transition",
          { agent, toPhase: "rolled-back" },
        );
        if (!result.ok) {
          cliError(`Failed: ${result.error ?? "unknown error"}`);
          process.exit(1);
          return;
        }
        cliLog(`agent ${agent} -> phase ${result.phase} (rolled back)`);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        cliError(`Error: ${msg}`);
        process.exit(1);
      }
    });

  cmd
    .command("v1-dropped <agent>")
    .description(
      "Operator-confirmed terminal step: v1 column dropped after 24h cutover soak. Migration complete.",
    )
    .option("-y, --yes", "Skip interactive confirmation")
    .action(async (agent: string, opts: { yes?: boolean }) => {
      const ok =
        opts.yes ??
        (await confirmInteractive(
          `Mark v1 dropped for ${agent}? (Terminal — agent is fully on v2.)`,
        ));
      if (!ok) {
        cliLog("Cancelled.");
        return;
      }
      try {
        const result = await callIpc<TransitionResponse>(
          "embedding-migration-transition",
          { agent, toPhase: "v1-dropped" },
        );
        if (!result.ok) {
          cliError(`Failed: ${result.error ?? "unknown error"}`);
          process.exit(1);
          return;
        }
        cliLog(`agent ${agent} -> phase ${result.phase}`);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        cliError(`Error: ${msg}`);
        process.exit(1);
      }
    });
}
