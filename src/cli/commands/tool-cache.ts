/**
 * Phase 115 Plan 07 sub-scope 15 — `clawcode tool-cache` operator CLI.
 *
 * Three subcommands:
 *   status                     — print size + row count + top tools
 *   clear [tool]               — drop all rows, or only rows for `tool`
 *   inspect [tool] [agent]     — list cached rows (filterable, max 100)
 *
 * IPC routes to:
 *   tool-cache-status   { sizeMb, rows, topTools, path, enabled, maxSizeMb }
 *   tool-cache-clear    { cleared, tool|null }
 *   tool-cache-inspect  { rows, count }
 *
 * Wired in src/cli/index.ts at the same nesting level as `clawcode cache`
 * (Phase 52 prompt-cache CLI). The two are intentionally separate — `cache`
 * inspects the LLM prompt-cache hit rate; `tool-cache` inspects the
 * daemon-side MCP tool-response cache (folds Phase 999.40).
 */

import { Command } from "commander";
import { sendIpcRequest } from "../../ipc/client.js";
import { SOCKET_PATH } from "../../manager/daemon.js";
import { ManagerNotRunningError } from "../../shared/errors.js";
import { cliError, cliLog } from "../output.js";

interface ToolCacheStatusResponse {
  readonly sizeMb: number;
  readonly rows: number;
  readonly topTools: ReadonlyArray<{
    readonly tool: string;
    readonly rows: number;
    readonly bytes: number;
  }>;
  readonly path: string;
  readonly enabled: boolean;
  readonly maxSizeMb: number;
}

interface ToolCacheClearResponse {
  readonly cleared: number;
  readonly tool: string | null;
}

interface ToolCacheInspectRow {
  readonly key: string;
  readonly tool: string;
  readonly agent_or_null: string | null;
  readonly response_json: string;
  readonly created_at: number;
  readonly expires_at: number;
  readonly bytes: number;
  readonly last_accessed_at: number;
}

interface ToolCacheInspectResponse {
  readonly rows: ReadonlyArray<ToolCacheInspectRow>;
  readonly count: number;
}

async function callIpc<T>(method: string, params: Record<string, unknown>): Promise<T> {
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

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function formatTime(ms: number): string {
  return new Date(ms).toISOString();
}

function renderStatusTable(res: ToolCacheStatusResponse): string {
  const lines: string[] = [];
  lines.push(`Path: ${res.path}`);
  lines.push(
    `Enabled: ${res.enabled ? "true" : "false (defaults.toolCache.enabled=false)"}`,
  );
  lines.push(
    `Size: ${res.sizeMb.toFixed(2)} MB / ${res.maxSizeMb} MB cap (${(
      (res.sizeMb / Math.max(res.maxSizeMb, 1)) *
      100
    ).toFixed(1)}%)`,
  );
  lines.push(`Rows: ${res.rows.toLocaleString()}`);
  lines.push("");
  if (res.topTools.length === 0) {
    lines.push("No cached entries yet.");
    return lines.join("\n");
  }
  lines.push("Top tools by row count:");
  lines.push(
    `${"tool".padEnd(32)}${"rows".padStart(10)}${"bytes".padStart(14)}`,
  );
  for (const t of res.topTools) {
    lines.push(
      `${t.tool.padEnd(32)}${t.rows.toLocaleString().padStart(10)}${formatBytes(t.bytes).padStart(14)}`,
    );
  }
  return lines.join("\n");
}

function renderInspectTable(rows: ReadonlyArray<ToolCacheInspectRow>): string {
  if (rows.length === 0) {
    return "(no rows match the filter)";
  }
  const lines: string[] = [];
  lines.push(
    `${"tool".padEnd(28)}${"agent".padEnd(20)}${"bytes".padStart(10)}${"  age (s)".padStart(12)}${"  expires_in (s)".padStart(18)}`,
  );
  const now = Date.now();
  for (const r of rows) {
    const age = Math.round((now - r.created_at) / 1000);
    const expiresIn = Math.round((r.expires_at - now) / 1000);
    lines.push(
      `${r.tool.padEnd(28)}${(r.agent_or_null ?? "(cross-agent)").padEnd(20)}${formatBytes(r.bytes).padStart(10)}${(age >= 0 ? `${age}s` : `${age}s`).padStart(12)}${(expiresIn >= 0 ? `${expiresIn}s` : `EXPIRED`).padStart(18)}`,
    );
  }
  lines.push("");
  lines.push(
    "Note: cached responses for `mysql_query` may include credential rows. Operators querying secret tables with cacheable data should pass `bypass_cache: true` in tool args.",
  );
  return lines.join("\n");
}

/**
 * Register the `tool-cache` top-level command. Called from src/cli/index.ts
 * at the same level as `cache`, `latency`, etc.
 */
export function registerToolCacheCommand(program: Command): void {
  const cmd = program
    .command("tool-cache")
    .description(
      "Phase 115 sub-scope 15 — inspect / manage the daemon-side MCP tool-response cache",
    );

  cmd
    .command("status")
    .description("Print cache size + row count + top tools by row count")
    .option("--json", "Emit JSON instead of human-readable table")
    .action(async (opts: { json?: boolean }) => {
      try {
        const res = await callIpc<ToolCacheStatusResponse>(
          "tool-cache-status",
          {},
        );
        if (opts.json) {
          cliLog(JSON.stringify(res, null, 2));
        } else {
          cliLog(renderStatusTable(res));
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        cliError(`Error: ${msg}`);
        process.exit(1);
      }
    });

  cmd
    .command("clear [tool]")
    .description(
      "Drop all cached rows. With [tool], drops only rows for that tool (e.g. 'web_search').",
    )
    .action(async (tool?: string) => {
      try {
        const params: Record<string, unknown> = {};
        if (tool) params.tool = tool;
        const res = await callIpc<ToolCacheClearResponse>(
          "tool-cache-clear",
          params,
        );
        cliLog(
          `cleared ${res.cleared} entries${res.tool ? ` (tool=${res.tool})` : ""}`,
        );
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        cliError(`Error: ${msg}`);
        process.exit(1);
      }
    });

  cmd
    .command("inspect [tool] [agent]")
    .description(
      "List cached rows (filterable by tool and/or agent). Most recently accessed first.",
    )
    .option("--limit <n>", "Max rows to return (1..500, default 100)", "100")
    .option("--json", "Emit JSON instead of human-readable table")
    .action(
      async (
        tool: string | undefined,
        agent: string | undefined,
        opts: { limit?: string; json?: boolean },
      ) => {
        try {
          const limit = parseInt(opts.limit ?? "100", 10);
          if (!Number.isFinite(limit) || limit < 1 || limit > 500) {
            cliError("--limit must be an integer between 1 and 500");
            process.exit(1);
            return;
          }
          const params: Record<string, unknown> = { limit };
          if (tool) params.tool = tool;
          if (agent) params.agent = agent;
          const res = await callIpc<ToolCacheInspectResponse>(
            "tool-cache-inspect",
            params,
          );
          if (opts.json) {
            cliLog(JSON.stringify(res, null, 2));
          } else {
            cliLog(renderInspectTable(res.rows));
            cliLog(`\n${res.count} row(s)`);
          }
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          cliError(`Error: ${msg}`);
          process.exit(1);
        }
      },
    );
}
