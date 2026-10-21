/**
 * Phase 96 Plan 05 — `clawcode probe-fs <agent> [--diff]` CLI subcommand.
 *
 * Operator-driven manual filesystem-capability re-probe backed by the daemon's
 * `probe-fs` IPC method. Reuses the Phase 95 dream + Phase 91-04 sync-status
 * pattern: an exported pure async action returns the process exit code, so
 * tests can assert without spawning subprocesses.
 *
 * Discord/CLI parity invariant (RESEARCH.md Validation Architecture Dim 6):
 * Both `/clawcode-probe-fs` Discord slash and this `clawcode probe-fs` CLI
 * MUST call the SAME daemon IPC primitive `probe-fs` and render identical
 * snapshots. Drift between surfaces is a regression — pinned by integration
 * test asserting both code paths produce the same FsProbeOutcome.
 *
 * D-03 refresh trigger: operator runs `clawcode probe-fs <agent>` after
 * ACL/group/systemd change to force re-probe BEFORE asking user to retry —
 * eliminates the 60s heartbeat-stale window per RESEARCH.md Pitfall 7.
 *
 * Status emoji LOCKED ✓/⚠/? — matches /clawcode-probe-fs slash convention.
 *
 * Exit codes (operator-script contract):
 *   0 — outcome.kind = 'completed'
 *   1 — outcome.kind = 'failed' OR daemon not running OR IPC error
 */

import type { Command } from "commander";

import { sendIpcRequest } from "../../ipc/client.js";
import { SOCKET_PATH } from "../../manager/daemon.js";
import { ManagerNotRunningError, IpcError } from "../../shared/errors.js";

/**
 * Wire shape of a single FsCapabilitySnapshot entry returned by the daemon's
 * `probe-fs` IPC handler. Mirrors src/manager/persistent-session-handle.ts
 * FsCapabilitySnapshot but re-declared here so this CLI doesn't reach into
 * the manager's type graph (decoupling discipline matching mcp-status.ts).
 */
export type FsCapabilitySnapshotWire = {
  readonly status: "ready" | "degraded" | "unknown";
  readonly mode: "rw" | "ro" | "denied";
  readonly lastProbeAt: string;
  readonly lastSuccessAt?: string;
  readonly error?: string;
};

/**
 * Wire shape of FsProbeOutcome (mirror of src/manager/fs-probe.ts). The
 * snapshot is JSON-serialized as an array of [path, state] tuples (Maps don't
 * round-trip through JSON-RPC).
 */
export type FsProbeOutcomeWire =
  | {
      readonly kind: "completed";
      readonly snapshot: ReadonlyArray<readonly [string, FsCapabilitySnapshotWire]>;
      readonly durationMs: number;
      readonly changes?: ReadonlyArray<{
        readonly path: string;
        readonly from: string;
        readonly to: string;
      }>;
    }
  | { readonly kind: "failed"; readonly error: string };

export type RunProbeFsActionArgs = Readonly<{
  agent: string;
  diff?: boolean;
  /**
   * DI hook for hermetic tests. Production callers omit this and the action
   * wires `sendIpcRequest` against the canonical daemon socket.
   */
  sendIpc?: (
    method: string,
    params: Record<string, unknown>,
  ) => Promise<unknown>;
}>;

/**
 * Format the FsProbeOutcome as a human-friendly multi-line string.
 *
 * Pure function — takes outcome + agent name, returns string. NO process.stdout
 * writes; callers (the action below) handle I/O.
 *
 * Status emoji map (LOCKED — matches Discord slash + status-render.ts):
 *   ✓ ready · ⚠ degraded · ? unknown
 */
export function formatProbeFsTable(
  agent: string,
  outcome: FsProbeOutcomeWire,
): string {
  const lines: string[] = [];
  lines.push(`Filesystem capability — ${agent}`);

  if (outcome.kind === "failed") {
    lines.push("");
    lines.push(`probe failed: ${outcome.error}`);
    return lines.join("\n");
  }

  // outcome.kind === "completed"
  const entries = outcome.snapshot;
  const readyCount = entries.filter(([, s]) => s.status === "ready").length;
  const degradedCount = entries.filter(
    ([, s]) => s.status === "degraded",
  ).length;
  const unknownCount = entries.filter(
    ([, s]) => s.status === "unknown",
  ).length;

  lines.push(`Probed ${entries.length} path(s) in ${outcome.durationMs}ms`);
  const summary: string[] = [`${readyCount} ready`];
  if (degradedCount > 0) summary.push(`${degradedCount} degraded`);
  if (unknownCount > 0) summary.push(`${unknownCount} unknown`);
  lines.push(summary.join(" / "));
  lines.push("");

  // Per-path lines: emoji + mode + path; error sub-line indented when present
  for (const [path, state] of entries) {
    const emoji =
      state.status === "ready" ? "✓" : state.status === "degraded" ? "⚠" : "?";
    const mode = state.mode.padEnd(8);
    lines.push(`${emoji}  ${mode} ${path}`);
    if (state.error !== undefined) {
      lines.push(`   error: ${state.error}`);
    }
  }

  // --diff option: outcome.changes (transitions since last probe). Top 3 to
  // match the Discord slash embed convention.
  if (outcome.changes && outcome.changes.length > 0) {
    lines.push("");
    lines.push("Changes since last probe:");
    for (const c of outcome.changes.slice(0, 3)) {
      lines.push(`  ${c.path}: ${c.from} → ${c.to}`);
    }
  }

  return lines.join("\n");
}

/**
 * Run one filesystem probe via the daemon `probe-fs` IPC method.
 *
 * Returns the process exit code so tests can assert without spawning
 * subprocesses (mirrors runDreamAction / runSyncRunOnceAction /
 * runCutoverVerifyAction).
 */
export async function runProbeFsAction(
  args: RunProbeFsActionArgs,
): Promise<number> {
  const sender =
    args.sendIpc ??
    ((method: string, params: Record<string, unknown>) =>
      sendIpcRequest(SOCKET_PATH, method, params));

  const params: Record<string, unknown> = {
    agent: args.agent,
    diff: args.diff === true,
  };

  let outcome: FsProbeOutcomeWire;
  try {
    const raw = await sender("probe-fs", params);
    outcome = raw as FsProbeOutcomeWire;
  } catch (err) {
    if (err instanceof ManagerNotRunningError) {
      process.stderr.write(
        "probe-fs: clawcode daemon is not running. Start it with `clawcode start-all`.\n",
      );
      return 1;
    }
    if (err instanceof IpcError) {
      process.stderr.write(`probe-fs: daemon-IPC error: ${err.message}\n`);
      return 1;
    }
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`probe-fs: ${msg}\n`);
    return 1;
  }

  process.stdout.write(formatProbeFsTable(args.agent, outcome) + "\n");

  return outcome.kind === "completed" ? 0 : 1;
}

/**
 * Register the `clawcode probe-fs <agent>` subcommand.
 *
 * Validation:
 *   - <agent> required (commander emits usage error if omitted)
 *   - --diff is an optional boolean flag
 */
export function registerProbeFsCommand(parent: Command): void {
  parent
    .command("probe-fs <agent>")
    .description(
      "Force re-probe of an agent's filesystem capability (operator-driven manual refresh)",
    )
    .option("--diff", "Show changes since last probe")
    .action(async (agent: string, opts: { diff?: boolean }) => {
      const code = await runProbeFsAction({
        agent,
        diff: opts.diff,
      });
      process.exit(code);
    });
}
