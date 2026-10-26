/**
 * Memory overhaul 2026-10-25 (WP1): `clawcode memory prune-flush <agent>`.
 *
 * One-shot operator cleanup for the mid-session flush flood. On the
 * production host 95 percent of memory rows were mid-session flush rows
 * (8,892 of 9,270 for one agent): every 15-minute tick re-summarized the
 * whole session and nothing ever removed the rows. The flush is
 * incremental now and the final session summary deletes its own flush
 * rows, but the backlog written before that change stays until an
 * operator runs this command.
 *
 * Dry run by default: prints what would be deleted and exits. With
 * `--apply` it deletes every mid-session row whose session already has a
 * final summary, through `MemoryStore.delete` so vectors, links and FTS
 * rows go with it, then runs `TierManager.runMaintenance()` so the hot
 * tier is rebuilt without the flush rows. A session counts as summarized
 * when `conversation_sessions.summary_memory_id` is set, or when it has
 * ended and a `session-summary` row tagged `session:<id>` still exists
 * (summary-dedupe detaches the pointer when it removes a duplicate).
 * Rows of active or not-yet-summarized sessions, and rows with no session
 * tag, are always kept; `--keep-days N` additionally keeps rows younger
 * than N days.
 *
 * This is never automatic: no heartbeat, no daemon path, no schedule calls
 * it. It opens the agent's memories.db directly, the way
 * `clawcode memory backfill` does (loadConfig, getAgentMemoryDbPath, new
 * MemoryStore), so it works with the daemon stopped; SQLite WAL and the
 * store's busy timeout let it run beside a live daemon too. It refuses to
 * create a database that does not exist.
 *
 * Exit codes:
 *   0: success (dry run printed, or apply finished with no failed deletes)
 *   1: agent not in clawcode.yaml, no workspace, no database, store failed
 *      to open, or at least one delete failed
 */
import type { Command } from "commander";
import { existsSync } from "node:fs";
import { join } from "node:path";
import pino from "pino";
import type { Logger } from "pino";
import { loadConfig } from "../../config/loader.js";
import { expandHome } from "../../config/defaults.js";
import { getAgentMemoryDbPath } from "../../shared/agent-paths.js";
import { MemoryStore } from "../../memory/store.js";
import { ConversationStore } from "../../memory/conversation-store.js";
import { EmbeddingService } from "../../memory/embedder.js";
import { TierManager } from "../../memory/tier-manager.js";
import type { MaintenanceResult } from "../../memory/tier-manager.js";
import { DEFAULT_TIER_CONFIG } from "../../memory/tiers.js";
import type { TierConfig } from "../../memory/tiers.js";
import type { ScoringConfig } from "../../memory/relevance.js";
import { MID_SESSION_TAG } from "../../memory/session-summarizer.js";
import type { MemoryEntry } from "../../memory/types.js";
import { cliError, cliLog } from "../output.js";

type MemoryConfigLike = {
  readonly tiers?: Partial<TierConfig>;
  readonly decay?: {
    readonly halfLifeDays?: number;
    readonly semanticWeight?: number;
    readonly decayWeight?: number;
  };
};

/**
 * Minimal shape of what the action needs from loadConfig (mirrors
 * memory-backfill.ts). Paths and the memory block are resolved the way
 * the config loader resolves them for the daemon: workspace falls back to
 * `<defaults.basePath>/<name>`, memoryPath to the workspace, and an agent
 * memory block replaces the defaults block as a whole.
 */
type ConfigLike = {
  readonly defaults?: {
    readonly basePath?: string;
    readonly memory?: MemoryConfigLike;
  };
  readonly agents: ReadonlyArray<{
    readonly name: string;
    readonly workspace?: string;
    readonly memoryPath?: string;
    readonly memory?: MemoryConfigLike;
  }>;
};

/** Store surface the action needs (DI'd for tests). */
export type PruneFlushStores = {
  readonly memoryStore: Pick<MemoryStore, "findByTag" | "delete">;
  readonly conversationStore: Pick<ConversationStore, "getSession">;
  readonly tierManager: Pick<TierManager, "runMaintenance">;
  /** Called once the action is done, success or not. */
  readonly close: () => void;
};

type OpenStoresArgs = Readonly<{
  agentName: string;
  memoryPath: string;
  dbPath: string;
  tierConfig: TierConfig;
  scoringConfig: ScoringConfig;
  log: Logger;
}>;

type OpenStoresFn = (args: OpenStoresArgs) => PruneFlushStores;

function defaultOpenStores(args: OpenStoresArgs): PruneFlushStores {
  // new MemoryStore would create an empty database at a wrong path and
  // report "0 rows", which reads like success. Refuse instead.
  if (!existsSync(args.dbPath)) {
    throw new Error(`no memory database at ${args.dbPath}`);
  }
  const store = new MemoryStore(args.dbPath);
  try {
    const conversationStore = new ConversationStore(store.getDatabase());
    // runMaintenance never embeds; the service is only constructed to
    // satisfy the TierManager deps and loads no model unless asked to.
    const tierManager = new TierManager({
      store,
      embedder: new EmbeddingService(),
      memoryDir: join(args.memoryPath, "memory"),
      tierConfig: args.tierConfig,
      scoringConfig: args.scoringConfig,
      log: args.log,
      agentName: args.agentName,
    });
    return {
      memoryStore: store,
      conversationStore,
      tierManager,
      close: () => store.close(),
    };
  } catch (err) {
    store.close();
    throw err;
  }
}

/** What a run would delete and what it keeps, with the reasons. */
export type PruneFlushPlan = Readonly<{
  /** Every row tagged mid-session. */
  totalRows: number;
  /** Distinct sessions those rows belong to. */
  totalSessions: number;
  /** Rows whose session has a final summary and that are older than keepDays. */
  prunable: readonly MemoryEntry[];
  prunableSessions: number;
  /** Rows of sessions that are still active or not yet summarized. */
  keptUnsummarized: number;
  keptUnsummarizedSessions: number;
  /** Rows kept only because of --keep-days. */
  keptRecent: number;
  /** Rows with no session tag, or whose session row no longer exists. */
  keptNoSession: number;
}>;

const SESSION_TAG_PREFIX = "session:";
const SESSION_SUMMARY_TAG = "session-summary";

/** The `<id>` of the first `session:<id>` tag, or null. */
function sessionIdOf(tags: readonly string[]): string | null {
  const tag = tags.find((t) => t.startsWith(SESSION_TAG_PREFIX));
  const id = tag ? tag.slice(SESSION_TAG_PREFIX.length) : "";
  return id.length > 0 ? id : null;
}

/**
 * Pure planning step: classify every mid-session row. Exported for tests.
 * `keepDays <= 0` disables the age protection.
 */
export function planPruneFlush(
  stores: Pick<PruneFlushStores, "memoryStore" | "conversationStore">,
  opts: Readonly<{ keepDays: number; now?: Date }>,
): PruneFlushPlan {
  const now = opts.now ?? new Date();
  const cutoffMs =
    opts.keepDays > 0 ? now.getTime() - opts.keepDays * 24 * 60 * 60 * 1000 : null;

  // Sessions that still have a session-summary row, whatever the pointer
  // on conversation_sessions says.
  const sessionsWithSummaryRow = new Set<string>();
  for (const row of stores.memoryStore.findByTag(SESSION_SUMMARY_TAG)) {
    const id = sessionIdOf(row.tags);
    if (id !== null) sessionsWithSummaryRow.add(id);
  }

  const rows = stores.memoryStore.findByTag(MID_SESSION_TAG);
  /** true = summarized, false = not yet, null = session row missing. */
  const stateBySession = new Map<string, boolean | null>();
  const allSessions = new Set<string>();
  const prunableSessions = new Set<string>();
  const unsummarizedSessions = new Set<string>();
  const prunable: MemoryEntry[] = [];
  let keptUnsummarized = 0;
  let keptRecent = 0;
  let keptNoSession = 0;

  for (const row of rows) {
    const sessionId = sessionIdOf(row.tags);
    if (sessionId === null) {
      keptNoSession++;
      continue;
    }
    allSessions.add(sessionId);

    let summarized = stateBySession.get(sessionId);
    if (summarized === undefined) {
      const session = stores.conversationStore.getSession(sessionId);
      summarized = session
        ? session.summaryMemoryId !== null ||
          (session.status !== "active" && sessionsWithSummaryRow.has(sessionId))
        : null;
      stateBySession.set(sessionId, summarized);
    }

    if (summarized === null) {
      keptNoSession++;
      continue;
    }
    if (!summarized) {
      keptUnsummarized++;
      unsummarizedSessions.add(sessionId);
      continue;
    }
    if (cutoffMs !== null && Date.parse(row.createdAt) >= cutoffMs) {
      keptRecent++;
      continue;
    }
    prunable.push(row);
    prunableSessions.add(sessionId);
  }

  return Object.freeze({
    totalRows: rows.length,
    totalSessions: allSessions.size,
    prunable: Object.freeze(prunable),
    prunableSessions: prunableSessions.size,
    keptUnsummarized,
    keptUnsummarizedSessions: unsummarizedSessions.size,
    keptRecent,
    keptNoSession,
  });
}

/** Render the plan as the dry-run / pre-apply report. Pure, exported for tests. */
export function formatPruneFlushPlan(
  agentName: string,
  plan: PruneFlushPlan,
  opts: Readonly<{ apply: boolean; keepDays: number }>,
): string {
  const mode = opts.apply ? "APPLY" : "DRY RUN";
  const lines = [
    `[${mode}] ${agentName}: ${plan.totalRows} mid-session flush row(s) across ${plan.totalSessions} session(s)`,
    `  prunable (session already summarized): ${plan.prunable.length} row(s) in ${plan.prunableSessions} session(s)`,
    `  kept (session active or not yet summarized): ${plan.keptUnsummarized} row(s) in ${plan.keptUnsummarizedSessions} session(s)`,
    `  kept (younger than --keep-days ${opts.keepDays}): ${plan.keptRecent} row(s)`,
    `  kept (no session tag or session row missing): ${plan.keptNoSession} row(s)`,
  ];
  if (!opts.apply) {
    lines.push(
      plan.prunable.length > 0
        ? "Re-run with --apply to delete the prunable rows and run tier maintenance."
        : "Nothing to prune.",
    );
  }
  return lines.join("\n");
}

/** Render the apply outcome. Pure, exported for tests. */
export function formatPruneFlushApplied(
  outcome: Readonly<{ deleted: number; missing: number; failed: number }>,
  maintenance: MaintenanceResult,
): string {
  const extras: string[] = [];
  if (outcome.missing > 0) extras.push(`${outcome.missing} already gone`);
  if (outcome.failed > 0) extras.push(`${outcome.failed} failed`);
  const lines = [
    `Deleted ${outcome.deleted} mid-session flush row(s)${extras.length > 0 ? ` (${extras.join(", ")})` : ""}.`,
    `Tier maintenance: promoted ${maintenance.promoted}, demoted ${maintenance.demoted}, cooled ${maintenance.archived}, rewarmed ${maintenance.rewarmed}, errors ${maintenance.errors}.`,
  ];
  if (maintenance.errors > 0 && maintenance.firstError) {
    lines.push(`  first maintenance error: ${maintenance.firstError}`);
  }
  return lines.join("\n");
}

export type RunMemoryPruneFlushArgs = Readonly<{
  agentName: string;
  /** Delete the prunable rows and run tier maintenance. Default false (dry run). */
  apply?: boolean;
  /** Keep rows younger than this many days even when their session is summarized. Default 0. */
  keepDays?: number;
  configPath?: string;
  /** DI: override loadConfig for hermetic tests. */
  loadConfigDep?: (path: string) => Promise<ConfigLike>;
  /** DI: override store construction for hermetic tests. */
  openStores?: OpenStoresFn;
  /** DI: override logger (defaults to pino at warn level so maintenance stays quiet). */
  log?: Logger;
  /** DI: clock for the keep-days cutoff. */
  now?: Date;
}>;

/**
 * Run the prune-flush action. Returns the process exit code (0 on success,
 * 1 on error) so tests can assert without spawning subprocesses or touching
 * process.exit.
 */
export async function runMemoryPruneFlushAction(
  args: RunMemoryPruneFlushArgs,
): Promise<number> {
  const log: Logger =
    args.log ?? (pino({ level: "warn" }) as unknown as Logger);
  const loadConfigImpl =
    args.loadConfigDep ??
    (async (p: string) => (await loadConfig(p)) as unknown as ConfigLike);
  const openStores = args.openStores ?? defaultOpenStores;
  const configPath = args.configPath ?? "clawcode.yaml";
  const apply = args.apply === true;
  const keepDays =
    args.keepDays !== undefined && Number.isFinite(args.keepDays)
      ? Math.max(0, args.keepDays)
      : 0;

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
  const basePath = config.defaults?.basePath;
  const workspace =
    agent.workspace ??
    (basePath ? join(expandHome(basePath), agent.name) : undefined);
  if (!workspace) {
    cliError(`Agent '${args.agentName}' has no workspace configured`);
    return 1;
  }

  const memoryPath = agent.memoryPath ? expandHome(agent.memoryPath) : workspace;
  const dbPath = getAgentMemoryDbPath(memoryPath);
  const memoryConfig = agent.memory ?? config.defaults?.memory;
  const tierConfig: TierConfig = {
    ...DEFAULT_TIER_CONFIG,
    ...(memoryConfig?.tiers ?? {}),
  };
  const scoringConfig: ScoringConfig = {
    semanticWeight: memoryConfig?.decay?.semanticWeight ?? 0.7,
    decayWeight: memoryConfig?.decay?.decayWeight ?? 0.3,
    halfLifeDays: memoryConfig?.decay?.halfLifeDays ?? 30,
  };

  let stores: PruneFlushStores;
  try {
    stores = openStores({
      agentName: args.agentName,
      memoryPath,
      dbPath,
      tierConfig,
      scoringConfig,
      log,
    });
  } catch (err) {
    cliError(
      `Failed to open memory store at ${dbPath}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return 1;
  }

  try {
    const plan = planPruneFlush(stores, { keepDays, now: args.now });
    cliLog(formatPruneFlushPlan(args.agentName, plan, { apply, keepDays }));
    if (!apply) return 0;

    let deleted = 0;
    let missing = 0;
    let failed = 0;
    for (const row of plan.prunable) {
      try {
        // false means the row is already gone (for example the daemon's
        // summarizer removed it between the plan and now): not a failure.
        if (stores.memoryStore.delete(row.id)) deleted++;
        else missing++;
      } catch (err) {
        failed++;
        log.warn(
          { agent: args.agentName, id: row.id, error: (err as Error).message },
          "prune-flush: delete failed",
        );
      }
    }

    const maintenance = stores.tierManager.runMaintenance();
    cliLog(formatPruneFlushApplied({ deleted, missing, failed }, maintenance));
    return failed > 0 ? 1 : 0;
  } catch (err) {
    cliError(
      `prune-flush failed for '${args.agentName}': ${err instanceof Error ? err.message : String(err)}`,
    );
    return 1;
  } finally {
    try {
      stores.close();
    } catch {
      // closing is best effort
    }
  }
}

export function registerMemoryPruneFlushCommand(parent: Command): void {
  parent
    .command("prune-flush <agent>")
    .description(
      "Delete mid-session flush rows whose session already has a final summary, then run tier maintenance (dry run unless --apply)",
    )
    .option("--apply", "Delete the prunable rows and run tier maintenance (default: dry run)")
    .option(
      "--keep-days <n>",
      "Keep flush rows younger than N days even when their session is summarized",
      "0",
    )
    .option("-c, --config <path>", "Path to clawcode.yaml", "clawcode.yaml")
    .action(
      async (
        agentName: string,
        opts: { apply?: boolean; keepDays?: string; config?: string },
      ) => {
        const keepDays = Number.parseInt(opts.keepDays ?? "0", 10);
        if (Number.isNaN(keepDays) || keepDays < 0) {
          cliError(`--keep-days must be a non-negative integer, got '${opts.keepDays}'`);
          process.exit(1);
          return;
        }
        const code = await runMemoryPruneFlushAction({
          agentName,
          apply: opts.apply === true,
          keepDays,
          configPath: opts.config,
        });
        process.exit(code);
      },
    );
}
