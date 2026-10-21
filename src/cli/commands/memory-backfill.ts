/**
 * Phase 90 Plan 07 WIRE-06 — `clawcode memory backfill <agent>` CLI.
 *
 * Runs the Plan 90-02 MemoryScanner.backfill() pipeline against an agent's
 * workspace in one-shot mode. Idempotent — SHA256-based idempotency in
 * MemoryScanner.handleUpsert skips unchanged files on re-runs.
 *
 * Output shape (matches plan spec):
 *   [INFO] Indexed 62 memory/*.md files, 487 chunks (skipped 0 unchanged)
 *
 * Exit codes:
 *   0 — success
 *   1 — agent not in clawcode.yaml, workspace unset, or scanner threw
 */
import type { Command } from "commander";
import pino from "pino";
import type { Logger } from "pino";
import { loadConfig } from "../../config/loader.js";
import { getAgentMemoryDbPath } from "../../shared/agent-paths.js";
import { MemoryStore } from "../../memory/store.js";
import { EmbeddingService } from "../../memory/embedder.js";
import { MemoryScanner } from "../../memory/memory-scanner.js";
import type { BackfillResult } from "../../memory/memory-scanner.js";
import { cliError, cliLog } from "../output.js";

/**
 * Minimal shape of what the action needs from loadConfig — avoids pulling
 * the full ResolvedAgentConfig surface just for DI.
 */
type ConfigLike = {
  readonly agents: ReadonlyArray<{
    readonly name: string;
    readonly workspace?: string;
    readonly memoryPath?: string;
  }>;
};

/** Scanner surface used by the backfill action (DI'd for tests). */
export type BackfillScanner = {
  backfill: () => Promise<BackfillResult>;
};

/**
 * Factory for the real MemoryScanner. Exposed so the default path can be
 * swapped out in tests without spinning up SQLite + MiniLM.
 */
type MakeScannerFn = (
  agentName: string,
  workspace: string,
  dbPath: string,
  log: Logger,
) => BackfillScanner;

function defaultMakeScanner(
  _agentName: string,
  workspace: string,
  dbPath: string,
  log: Logger,
): BackfillScanner {
  const store = new MemoryStore(dbPath);
  const embedder = new EmbeddingService();
  const scanner = new MemoryScanner(
    {
      store,
      embed: (t: string) => embedder.embed(t),
      log,
    },
    workspace,
  );
  return {
    backfill: () => scanner.backfill(),
  };
}

export type RunMemoryBackfillArgs = Readonly<{
  agentName: string;
  configPath?: string;
  /** DI — override loadConfig for hermetic tests. */
  loadConfigDep?: (path: string) => Promise<ConfigLike>;
  /** DI — override scanner construction for hermetic tests. */
  makeScanner?: MakeScannerFn;
  /** DI — override logger (defaults to pino at info level). */
  log?: Logger;
}>;

/**
 * Run the backfill action. Returns the process exit code (0 on success, 1
 * on error) so tests can assert without spawning subprocesses or touching
 * process.exit.
 */
export async function runMemoryBackfillAction(
  args: RunMemoryBackfillArgs,
): Promise<number> {
  const log: Logger =
    args.log ?? (pino({ level: "info" }) as unknown as Logger);
  const loadConfigImpl =
    args.loadConfigDep ??
    (async (p: string) => (await loadConfig(p)) as unknown as ConfigLike);
  const makeScanner = args.makeScanner ?? defaultMakeScanner;
  const configPath = args.configPath ?? "clawcode.yaml";

  let config: ConfigLike;
  try {
    config = await loadConfigImpl(configPath);
  } catch (err) {
    cliError(
      `Failed to load ${configPath}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return 1;
  }

  const agent = config.agents.find((a) => a.name === args.agentName);
  if (!agent) {
    cliError(`Agent '${args.agentName}' not in clawcode.yaml`);
    return 1;
  }
  const workspace = agent.workspace;
  if (!workspace) {
    cliError(`Agent '${args.agentName}' has no workspace configured`);
    return 1;
  }

  const dbPath = getAgentMemoryDbPath(agent.memoryPath ?? workspace);

  const scanner = makeScanner(args.agentName, workspace, dbPath, log);

  let result: BackfillResult;
  try {
    result = await scanner.backfill();
  } catch (err) {
    cliError(
      `Backfill failed for '${args.agentName}': ${err instanceof Error ? err.message : String(err)}`,
    );
    return 1;
  }

  cliLog(
    `[INFO] Indexed ${result.indexed} memory/*.md files, ${result.chunks} chunks (skipped ${result.skipped} unchanged)`,
  );
  return 0;
}

export function registerMemoryBackfillCommand(parent: Command): void {
  parent
    .command("backfill <agent>")
    .description(
      "Index an agent's workspace memory/*.md files via the MemoryScanner (Plan 90-02)",
    )
    .option("-c, --config <path>", "Path to clawcode.yaml", "clawcode.yaml")
    .action(async (agentName: string, opts: { config?: string }) => {
      const code = await runMemoryBackfillAction({
        agentName,
        configPath: opts.config,
      });
      process.exit(code);
    });
}
