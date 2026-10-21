/**
 * Phase 96 Plan 05 — `clawcode fs-status -a <agent>` CLI subcommand.
 *
 * Prints a per-agent filesystem-capability snapshot (ready / degraded /
 * unknown) as an aligned 5-column table: PATH / STATUS / MODE / LAST PROBE /
 * LAST ERROR. Reads from the daemon's `list-fs-status` IPC method which
 * serializes SessionHandle.getFsCapabilitySnapshot() — single source of
 * truth across both operator surfaces (this CLI + Discord /clawcode-status
 * Capability section which renders the SAME snapshot via
 * renderFilesystemCapabilityBlock).
 *
 * Naming rationale:
 *   Mirrors `clawcode mcp-status` (Phase 85 plan 03) byte-for-byte. Both
 *   answer "what's the latest snapshot?" — no probe spawn, just a read of
 *   the in-memory mirror. The complementary `clawcode probe-fs` (above)
 *   triggers a fresh probe; this command shows the cached state.
 *
 * Parity with `mcp-status`:
 *   - Same imports, same IPC pattern, same ManagerNotRunningError handling
 *   - Same cliLog / cliError surfaces
 *   - Same padding style
 *
 * Status emoji LOCKED ✓/⚠/? — matches probe-fs.ts + Discord slash convention.
 */

import type { Command } from "commander";

import { sendIpcRequest } from "../../ipc/client.js";
import { SOCKET_PATH } from "../../manager/daemon.js";
import { ManagerNotRunningError, IpcError } from "../../shared/errors.js";

/**
 * Wire shape of one row in the `list-fs-status` IPC response. Mirrors the
 * daemon-side serializer (entries flattened from
 * SessionHandle.getFsCapabilitySnapshot Map<canonicalPath, snapshot>).
 */
export type FsStatusEntry = {
  readonly path: string;
  readonly status: "ready" | "degraded" | "unknown";
  readonly mode: "rw" | "ro" | "denied";
  readonly lastProbeAt: string;
  readonly lastSuccessAt?: string;
  readonly error?: string;
};

export type FsStatusResponse = {
  readonly agent: string;
  readonly paths: readonly FsStatusEntry[];
};

export type RunFsStatusActionArgs = Readonly<{
  agent: string;
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
 * Format the IPC response as an aligned table. Empty-paths case returns a
 * single-line message (no empty table — consistent with mcp-status.ts).
 *
 * Columns: PATH / STATUS / MODE / LAST PROBE / LAST ERROR
 *
 * Status emoji prefixes the path: ✓ ready · ⚠ degraded · ? unknown.
 */
export function formatFsStatusTable(resp: FsStatusResponse): string {
  if (resp.paths.length === 0) {
    return `No fileAccess paths configured for ${resp.agent}`;
  }

  const lines: string[] = [];
  lines.push(`Filesystem capability — ${resp.agent}`);
  lines.push("");

  type Row = {
    readonly emoji: string;
    readonly path: string;
    readonly status: string;
    readonly mode: string;
    readonly lastProbeAt: string;
    readonly lastError: string;
  };

  const rows: readonly Row[] = resp.paths.map((p) => {
    const emoji =
      p.status === "ready" ? "✓" : p.status === "degraded" ? "⚠" : "?";
    return {
      emoji,
      path: p.path,
      status: p.status,
      mode: p.mode,
      lastProbeAt: p.lastProbeAt,
      lastError: p.error ?? "",
    };
  });

  const widths = {
    path: Math.max("PATH".length, ...rows.map((r) => r.path.length)),
    status: Math.max("STATUS".length, ...rows.map((r) => r.status.length)),
    mode: Math.max("MODE".length, ...rows.map((r) => r.mode.length)),
    lastProbeAt: Math.max(
      "LAST PROBE".length,
      ...rows.map((r) => r.lastProbeAt.length),
    ),
    lastError: Math.max(
      "LAST ERROR".length,
      ...rows.map((r) => r.lastError.length),
    ),
  };

  const header = [
    " ",
    "PATH".padEnd(widths.path),
    "STATUS".padEnd(widths.status),
    "MODE".padEnd(widths.mode),
    "LAST PROBE".padEnd(widths.lastProbeAt),
    "LAST ERROR".padEnd(widths.lastError),
  ].join("  ");

  const totalWidth =
    1 +
    widths.path +
    widths.status +
    widths.mode +
    widths.lastProbeAt +
    widths.lastError +
    10; // 5 separators of 2 spaces each
  const separator = "-".repeat(totalWidth);

  const body = rows.map((r) =>
    [
      r.emoji,
      r.path.padEnd(widths.path),
      r.status.padEnd(widths.status),
      r.mode.padEnd(widths.mode),
      r.lastProbeAt.padEnd(widths.lastProbeAt),
      r.lastError.padEnd(widths.lastError),
    ].join("  "),
  );

  lines.push(header);
  lines.push(separator);
  lines.push(...body);

  return lines.join("\n");
}

/**
 * Read the cached filesystem-capability snapshot via the daemon's
 * `list-fs-status` IPC method.
 *
 * Returns the process exit code. Always 0 on a successful read (informational
 * — even when ALL paths are degraded, the read itself succeeded). Non-zero
 * only on daemon/IPC failures.
 */
export async function runFsStatusAction(
  args: RunFsStatusActionArgs,
): Promise<number> {
  const sender =
    args.sendIpc ??
    ((method: string, params: Record<string, unknown>) =>
      sendIpcRequest(SOCKET_PATH, method, params));

  let response: FsStatusResponse;
  try {
    const raw = await sender("list-fs-status", { agent: args.agent });
    response = raw as FsStatusResponse;
  } catch (err) {
    if (err instanceof ManagerNotRunningError) {
      process.stderr.write(
        "fs-status: clawcode daemon is not running. Start it with `clawcode start-all`.\n",
      );
      return 1;
    }
    if (err instanceof IpcError) {
      process.stderr.write(`fs-status: daemon-IPC error: ${err.message}\n`);
      return 1;
    }
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`fs-status: ${msg}\n`);
    return 1;
  }

  process.stdout.write(formatFsStatusTable(response) + "\n");
  return 0;
}

/**
 * Register the `clawcode fs-status` subcommand.
 *
 * Mirrors `clawcode mcp-status` (Phase 85 plan 03):
 *   - `--agent` (required, -a alias) — the CLI has no channel binding to
 *     infer from (unlike the Discord slash path)
 */
export function registerFsStatusCommand(parent: Command): void {
  parent
    .command("fs-status")
    .description(
      "Show per-agent filesystem capability snapshot (paths / status / mode / lastProbeAt)",
    )
    .requiredOption("-a, --agent <name>", "Agent to query")
    .action(async (opts: { agent: string }) => {
      const code = await runFsStatusAction({ agent: opts.agent });
      process.exit(code);
    });
}
