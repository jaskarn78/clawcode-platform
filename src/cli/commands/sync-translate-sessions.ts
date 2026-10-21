/**
 * Phase 91 Plan 04 — `clawcode sync translate-sessions --agent <name>` subcommand.
 *
 * Invokes the Plan 91-03 translator (`translateAllSessions`) against the
 * named agent's OpenClaw session-jsonl staging directory, re-materializing
 * user/assistant text turns into ClawCode's ConversationStore with
 * INSERT OR IGNORE idempotency. Typically run by
 * scripts/sync/clawcode-translator.sh from the hourly systemd timer, but
 * operators can also invoke this directly for ad-hoc re-imports.
 *
 * Staging directory (written by the wrapper script's rsync step, read here):
 *   ~/.clawcode/manager/openclaw-sessions-staging/<agent>/
 *
 * ConversationStore wiring:
 *   - MemoryStore opened at the agent's memories.db path (derived from
 *     clawcode.yaml → agent.memoryPath || agent.workspace → memories.db)
 *   - ConversationStore wrapping that MemoryStore's sqlite handle
 *
 * Exit codes:
 *   0 — translator ran (even if zero sessions scanned)
 *   1 — agent not in clawcode.yaml, workspace/memoryPath unset, or translator threw
 */
import type { Command } from "commander";
import { homedir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import type { Logger } from "pino";
import { loadConfig } from "../../config/loader.js";
import { getAgentMemoryDbPath } from "../../shared/agent-paths.js";
import { MemoryStore } from "../../memory/store.js";
import { ConversationStore } from "../../memory/conversation-store.js";
import {
  translateAllSessions,
  type TranslatorDeps,
  type TranslatorRunOutcome,
} from "../../sync/conversation-turn-translator.js";
import { DEFAULT_TRANSLATOR_CURSOR_PATH } from "../../sync/translator-cursor-store.js";
import { cliError, cliLog } from "../output.js";

/** Minimal shape of the clawcode.yaml entries we read. */
type ConfigLike = {
  readonly agents: ReadonlyArray<{
    readonly name: string;
    readonly workspace?: string;
    readonly memoryPath?: string;
  }>;
};

/**
 * Default staging directory where the wrapper script rsyncs OpenClaw's
 * sessions/*.jsonl before the translator runs. Mirrors D-07 + 91-03 summary.
 */
export function defaultStagingDir(agentName: string): string {
  const home = process.env.HOME ?? homedir();
  return join(home, ".clawcode", "manager", "openclaw-sessions-staging", agentName);
}

export type RunSyncTranslateSessionsArgs = Readonly<{
  agentName: string;
  configPath?: string;
  sessionsDir?: string;
  cursorPath?: string;
  log?: Logger;
  /** DI — override config load for hermetic tests. */
  loadConfigDep?: (path: string) => Promise<ConfigLike>;
  /**
   * DI — override translator dep construction + invocation for hermetic
   * tests. Given the agent name + resolved paths, returns the outcome
   * without touching SQLite / the real translator.
   */
  runTranslatorDep?: (deps: TranslatorDeps) => Promise<TranslatorRunOutcome>;
  /** DI — override ConversationStore construction (defaults to real MemoryStore path). */
  makeConversationStore?: (dbPath: string) => {
    store: ConversationStore;
    close: () => void;
  };
}>;

function defaultMakeConversationStore(dbPath: string): {
  store: ConversationStore;
  close: () => void;
} {
  const memStore = new MemoryStore(dbPath);
  const convStore = new ConversationStore(memStore.getDatabase());
  return { store: convStore, close: () => memStore.close() };
}

export async function runSyncTranslateSessionsAction(
  args: RunSyncTranslateSessionsArgs,
): Promise<number> {
  const log: Logger =
    args.log ?? (pino({ level: "info" }) as unknown as Logger);
  const loadConfigImpl =
    args.loadConfigDep ??
    (async (p: string) => (await loadConfig(p)) as unknown as ConfigLike);
  const configPath = args.configPath ?? "clawcode.yaml";

  let config: ConfigLike;
  try {
    config = await loadConfigImpl(configPath);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    cliError(`Failed to load ${configPath}: ${msg}`);
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
  const sessionsDir = args.sessionsDir ?? defaultStagingDir(args.agentName);
  const cursorPath = args.cursorPath ?? DEFAULT_TRANSLATOR_CURSOR_PATH;

  const runTranslator = args.runTranslatorDep ?? translateAllSessions;
  const makeConvStore = args.makeConversationStore ?? defaultMakeConversationStore;

  const { store, close } = makeConvStore(dbPath);
  try {
    const deps: TranslatorDeps = {
      sessionsDir,
      conversationStore: store,
      cursorPath,
      agentName: args.agentName,
      log,
    };
    const outcome = await runTranslator(deps);
    cliLog(JSON.stringify(outcome, null, 2));
    return 0;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    cliError(`translate-sessions failed for '${args.agentName}': ${msg}`);
    return 1;
  } finally {
    try {
      close();
    } catch {
      // Best-effort close; swallow secondary errors.
    }
  }
}

export function registerSyncTranslateSessionsCommand(parent: Command): void {
  parent
    .command("translate-sessions")
    .description(
      "Translate OpenClaw sessions/*.jsonl into ClawCode's ConversationStore (Plan 91-03 entry point)",
    )
    .requiredOption("--agent <name>", "Agent name (e.g. fin-client)")
    .option("-c, --config <path>", "Path to clawcode.yaml", "clawcode.yaml")
    .option("--sessions-dir <path>", "Override session-jsonl staging dir")
    .option("--cursor-path <path>", "Override translator cursor path")
    .action(
      async (opts: {
        agent: string;
        config?: string;
        sessionsDir?: string;
        cursorPath?: string;
      }) => {
        const code = await runSyncTranslateSessionsAction({
          agentName: opts.agent,
          configPath: opts.config,
          sessionsDir: opts.sessionsDir,
          cursorPath: opts.cursorPath,
        });
        process.exit(code);
      },
    );
}
