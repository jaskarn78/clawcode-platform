import type { Command } from "commander";
import { sendIpcRequest } from "../../ipc/client.js";
import { SOCKET_PATH } from "../../manager/daemon.js";
import { ManagerNotRunningError } from "../../shared/errors.js";
import { cliLog, cliError } from "../output.js";
import { confirmPrompt } from "../prompts.js";
import { isSubagentOrThreadSession } from "../../manager/subagent-name.js";

/**
 * A single thread binding entry from the IPC response.
 */
type ThreadBindingEntry = {
  readonly threadId: string;
  readonly parentChannelId: string;
  readonly agentName: string;
  readonly sessionName: string;
  readonly createdAt: number;
  readonly lastActivity: number;
};

/**
 * Shape of the "threads" IPC response.
 */
type ThreadsResponse = {
  readonly bindings: readonly ThreadBindingEntry[];
};

/**
 * Format a past timestamp as a relative time string.
 * Examples: "5m ago", "2h 15m ago", "3d ago"
 *
 * @param timestamp - Past timestamp in ms
 * @param now - Current time in ms (for testability)
 * @returns Human-readable relative time string
 */
export function formatTimeAgo(timestamp: number, now?: number): string {
  const currentTime = now ?? Date.now();
  const diffMs = currentTime - timestamp;

  if (diffMs < 0) {
    return "just now";
  }

  const totalMinutes = Math.floor(diffMs / 60_000);
  const totalHours = Math.floor(totalMinutes / 60);
  const totalDays = Math.floor(totalHours / 24);

  if (totalMinutes < 1) {
    return "just now";
  }
  if (totalMinutes < 60) {
    return `${totalMinutes}m ago`;
  }
  if (totalHours < 24) {
    const remainingMinutes = totalMinutes % 60;
    if (remainingMinutes === 0) {
      return `${totalHours}h ago`;
    }
    return `${totalHours}h ${remainingMinutes}m ago`;
  }
  return `${totalDays}d ago`;
}

/**
 * Truncate a string to maxLen characters, appending "..." if truncated.
 */
function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) {
    return text;
  }
  return text.slice(0, maxLen) + "...";
}

/**
 * Format threads IPC response as a table.
 * Columns: AGENT, THREAD ID, SESSION NAME, PARENT CHANNEL, AGE, LAST ACTIVE
 *
 * @param data - The threads IPC response
 * @param now - Current time in ms (for testability)
 * @returns Formatted table string
 */
export function formatThreadsTable(
  data: ThreadsResponse,
  now?: number,
): string {
  if (data.bindings.length === 0) {
    return "No active thread bindings";
  }

  type Row = {
    readonly agent: string;
    readonly threadId: string;
    readonly sessionName: string;
    readonly source: string;
    readonly parentChannel: string;
    readonly age: string;
    readonly lastActive: string;
  };

  const rows: readonly Row[] = data.bindings.map((entry) => ({
    agent: entry.agentName,
    threadId: truncate(entry.threadId, 20),
    sessionName: truncate(entry.sessionName, 30),
    // Phase 999.19 — central predicate classifies the -via- delegated
    // pattern as "subagent" too (pre-fix .includes("-sub-") missed it).
    source: isSubagentOrThreadSession(entry.sessionName)
      ? "subagent"
      : "user-created",
    parentChannel: truncate(entry.parentChannelId, 20),
    age: formatTimeAgo(entry.createdAt, now),
    lastActive: formatTimeAgo(entry.lastActivity, now),
  }));

  // Calculate column widths dynamically
  const agentWidth = Math.max(5, ...rows.map((r) => r.agent.length));
  const threadIdWidth = Math.max(9, ...rows.map((r) => r.threadId.length));
  const sessionWidth = Math.max(12, ...rows.map((r) => r.sessionName.length));
  const sourceWidth = Math.max(6, ...rows.map((r) => r.source.length));
  const parentWidth = Math.max(14, ...rows.map((r) => r.parentChannel.length));
  const ageWidth = Math.max(3, ...rows.map((r) => r.age.length));
  const lastActiveWidth = Math.max(11, ...rows.map((r) => r.lastActive.length));

  // Header
  const header = [
    "AGENT".padEnd(agentWidth),
    "THREAD ID".padEnd(threadIdWidth),
    "SESSION NAME".padEnd(sessionWidth),
    "SOURCE".padEnd(sourceWidth),
    "PARENT CHANNEL".padEnd(parentWidth),
    "AGE".padEnd(ageWidth),
    "LAST ACTIVE".padEnd(lastActiveWidth),
  ].join("  ");

  const separator = "-".repeat(
    agentWidth + threadIdWidth + sessionWidth + sourceWidth + parentWidth + ageWidth + lastActiveWidth + 12,
  );

  // Format rows
  const formattedRows = rows.map((row) =>
    [
      row.agent.padEnd(agentWidth),
      row.threadId.padEnd(threadIdWidth),
      row.sessionName.padEnd(sessionWidth),
      row.source.padEnd(sourceWidth),
      row.parentChannel.padEnd(parentWidth),
      row.age.padEnd(ageWidth),
      row.lastActive.padEnd(lastActiveWidth),
    ].join("  "),
  );

  return ["Active Thread Bindings", "", header, separator, ...formattedRows].join("\n");
}

/**
 * Shape of the archive-discord-thread IPC response (Wave 1 routes through
 * cleanupThreadWithClassifier so classification is always present).
 */
type ArchiveResponse = {
  readonly ok?: boolean;
  readonly archived?: boolean;
  readonly bindingPruned?: boolean;
  readonly classification?: "success" | "prune" | "retain" | "unknown";
};

/**
 * Shape of the threads-prune-stale IPC response.
 */
type PruneStaleResponse = {
  readonly staleCount?: number;
  readonly prunedCount?: number;
  readonly agents?: Readonly<Record<string, number>>;
};

/**
 * Shape of the threads-prune-agent IPC response.
 */
type PruneAgentResponse = {
  readonly prunedCount?: number;
};

/**
 * Generic IPC error handler — translates ManagerNotRunningError into a
 * friendly message, exits 1 on other errors. Returns true if the caller
 * should continue (no error), false if exit 1 was triggered.
 */
function handleIpcError(error: unknown): never {
  if (error instanceof ManagerNotRunningError) {
    cliError("Manager is not running. Start it with: clawcode start-all");
    process.exit(1);
  }
  const message = error instanceof Error ? error.message : String(error);
  cliError(`Error: ${message}`);
  process.exit(1);
}

/**
 * Register the `clawcode threads` command and its subcommands.
 * Sends a "threads" IPC request and displays a formatted table by default.
 *
 * Subcommands (Phase 999.14 MCP-10):
 *   - `threads archive <id> [--lock]`  → archive-discord-thread IPC
 *   - `threads prune --stale-after <duration>`  → threads-prune-stale IPC
 *   - `threads prune --agent <name> [--yes]`    → threads-prune-agent IPC
 */
export function registerThreadsCommand(program: Command): void {
  // Phase 999.14 MCP-10 — enable positional options so the parent
  // `threads --agent` filter doesn't collide with `threads prune --agent`
  // subcommand option (Commander option-collision resolution).
  program.enablePositionalOptions();
  const threads = program
    .command("threads")
    .description("Show active Discord thread bindings")
    .passThroughOptions()
    .option("-a, --agent <name>", "Filter by agent name")
    .action(async (opts: { agent?: string }) => {
      try {
        const params: Record<string, unknown> = {};
        if (opts.agent) {
          params.agent = opts.agent;
        }
        const result = (await sendIpcRequest(
          SOCKET_PATH,
          "threads",
          params,
        )) as ThreadsResponse;
        cliLog(formatThreadsTable(result));
      } catch (error) {
        handleIpcError(error);
      }
    });

  // MCP-10: archive subcommand — archives a Discord thread + prunes the
  // registry binding. On Discord 50001/10003/404 the daemon's classifier
  // returns success-with-classification (no throw), so we exit 0 with a
  // friendly message instead of erroring (operator-pain regression).
  threads
    .command("archive <threadId>")
    .description("Archive a Discord thread and prune its registry binding")
    .option("--lock", "Lock the thread (prevent further messages)")
    .action(async (threadId: string, opts: { lock?: boolean }) => {
      try {
        const params: Record<string, unknown> = { threadId };
        if (opts.lock) params.lock = true;
        const result = (await sendIpcRequest(
          SOCKET_PATH,
          "archive-discord-thread",
          params,
        )) as ArchiveResponse;
        const cls = result.classification ?? "unknown";
        if (cls === "success") {
          const suffix = result.bindingPruned ? " (registry pruned)" : "";
          cliLog(`Archived ${threadId}${suffix}`);
        } else if (cls === "prune") {
          cliLog(
            `Discord thread already gone server-side; registry pruned for ${threadId}`,
          );
        } else if (cls === "retain") {
          cliLog(
            `Transient Discord error for ${threadId}; binding retained for next sweep`,
          );
        } else {
          cliLog(
            `Unknown Discord error for ${threadId}; binding retained (manual investigation may be needed)`,
          );
        }
      } catch (error) {
        handleIpcError(error);
      }
    });

  // MCP-10: prune subcommand — two mutually-exclusive modes:
  //   --stale-after <duration>  → run sweep on demand
  //   --agent <name> [--yes]    → force-prune all bindings for an agent
  threads
    .command("prune")
    .description(
      "Prune stale or per-agent thread bindings (operator escape hatch)",
    )
    .option(
      "--stale-after <duration>",
      "Prune bindings idle longer than duration (e.g. '24h', '6h')",
    )
    .option(
      "--agent <name>",
      "Force-prune ALL bindings for the named agent (no Discord call)",
    )
    .option("--yes", "Skip confirmation prompt for --agent")
    .action(
      async (opts: {
        staleAfter?: string;
        agent?: string;
        yes?: boolean;
      }) => {
        if (!opts.staleAfter && !opts.agent) {
          cliError(
            "Specify either --stale-after <duration> or --agent <name>",
          );
          process.exit(1);
          return;
        }
        if (opts.staleAfter && opts.agent) {
          cliError("--stale-after and --agent are mutually exclusive");
          process.exit(1);
          return;
        }

        if (opts.staleAfter) {
          try {
            const result = (await sendIpcRequest(
              SOCKET_PATH,
              "threads-prune-stale",
              { staleAfter: opts.staleAfter },
            )) as PruneStaleResponse;
            const stale = result.staleCount ?? 0;
            const pruned = result.prunedCount ?? 0;
            cliLog(
              `Stale-binding sweep complete: ${pruned} of ${stale} stale bindings pruned`,
            );
            const agents = result.agents ?? {};
            const agentNames = Object.keys(agents);
            if (agentNames.length > 0) {
              cliLog("");
              cliLog("Per-agent breakdown:");
              for (const name of agentNames) {
                cliLog(`  ${name}: ${agents[name]}`);
              }
            }
          } catch (error) {
            handleIpcError(error);
          }
          return;
        }

        // --agent path
        const agentName = opts.agent!;
        if (!opts.yes) {
          const ok = await confirmPrompt(
            `Will remove ALL bindings for agent '${agentName}' without calling Discord. Confirm? (y/N)`,
          );
          if (!ok) {
            cliLog("Aborted by user");
            return;
          }
        }
        try {
          const result = (await sendIpcRequest(
            SOCKET_PATH,
            "threads-prune-agent",
            { agent: agentName },
          )) as PruneAgentResponse;
          const pruned = result.prunedCount ?? 0;
          cliLog(`Pruned ${pruned} bindings for agent ${agentName}`);
        } catch (error) {
          handleIpcError(error);
        }
      },
    );
}
