/**
 * Phase 92 Plan 01 — `clawcode cutover ingest` subcommand (D-11 amended).
 *
 * Pulls conversation history into local JSONL staging:
 *   - PRIMARY: Mission Control REST API at `${mcBase}/api/*` (bearer-token
 *     auth via env MC_API_TOKEN — refused at CLI surface if missing for
 *     --source mc|both)
 *   - FALLBACK: plugin:discord:fetch_messages over the agent's configured
 *     Discord channels
 *
 * --source mc      → MC only; missing token → exit 1; 503 → exit 1
 * --source discord → Discord only; MC errors not surfaced
 * --source both    → MC first then Discord; partial failures non-fatal
 *                    (exit 0 if at least one source produced ingested|no-changes)
 *
 * Staging files:
 *   ~/.clawcode/manager/cutover-staging/<agent>/mc-history.jsonl
 *   ~/.clawcode/manager/cutover-staging/<agent>/discord-history.jsonl
 *   ~/.clawcode/manager/cutover-staging/<agent>/mc-cursor.json
 *
 * SECURITY: The MC bearer token is read from env MC_API_TOKEN at the CLI
 * surface ONLY. It is passed to `ingestMissionControlHistory` via
 * `deps.bearerToken` and never logged. The CLI surface refuses to start
 * if the token is unset for `--source mc|both`.
 */
import type { Command } from "commander";
import { homedir } from "node:os";
import { join } from "node:path";
import pino, { type Logger } from "pino";
import {
  ingestMissionControlHistory,
  type McFetchFn,
} from "../../cutover/mc-history-ingestor.js";
import {
  ingestDiscordHistory,
  type DiscordFetchMessagesFn,
} from "../../cutover/discord-ingestor.js";
import {
  MC_DEFAULT_BASE_URL,
  type DiscordIngestOutcome,
  type IngestOutcome,
  type McIngestOutcome,
} from "../../cutover/types.js";
import { loadConfig } from "../../config/loader.js";
import { cliError, cliLog } from "../output.js";

export type RunCutoverIngestArgs = Readonly<{
  agent: string;
  source?: "mc" | "discord" | "both";
  mcBase?: string;
  /** For tests; production reads `process.env.MC_API_TOKEN` at CLI surface. */
  mcToken?: string;
  depthMsgs?: number;
  depthDays?: number;
  stagingDir?: string;
  log?: Logger;
  /** DI for tests — production wraps Node 22 globalThis.fetch. */
  fetchFn?: McFetchFn;
  /** DI for tests — production wires the Discord SDK MCP tool. */
  fetchMessages?: DiscordFetchMessagesFn;
}>;

/**
 * Run one cutover ingest cycle. Returns the process exit code.
 *
 * Exit code policy (D-11):
 *   - --source mc + missing token            → 1
 *   - --source mc + mc-gateway-503           → 1
 *   - --source mc + agent-not-found-in-mc    → 1
 *   - --source mc + mc-fetch-failed          → 1
 *   - --source both + mc fails + discord ok  → 0
 *   - --source both + both fail              → 1
 *   - --source discord + discord-fetch-fail  → 1
 *   - happy path (any combo)                 → 0
 */
export async function runCutoverIngestAction(
  args: RunCutoverIngestArgs,
): Promise<number> {
  const log = args.log ?? (pino({ level: "info" }) as unknown as Logger);
  const source = args.source ?? "both";

  const wantMc = source === "mc" || source === "both";
  const wantDiscord = source === "discord" || source === "both";
  const bearerToken = args.mcToken ?? process.env.MC_API_TOKEN ?? "";

  // Refuse-to-start gate (D-11 invariant): missing token when source includes mc.
  if (wantMc && bearerToken.length === 0) {
    cliError(
      "MC_API_TOKEN env var required for --source mc; set it or use --source discord",
    );
    return 1;
  }

  // Resolve agent config to obtain its Discord channels (for the discord
  // ingestor) — happens once even when --source mc, so the operator gets a
  // clear "agent not found" error early.
  const config = await loadConfig("clawcode.yaml");
  const agentCfg = config.agents.find((a) => a.name === args.agent);
  if (!agentCfg) {
    cliError(`Agent '${args.agent}' not found in clawcode.yaml`);
    return 1;
  }

  const stagingDir =
    args.stagingDir ??
    join(homedir(), ".clawcode", "manager", "cutover-staging", args.agent);
  const mcBaseUrl = args.mcBase ?? process.env.MC_API_BASE ?? MC_DEFAULT_BASE_URL;

  let mcOutcome: McIngestOutcome | null = null;
  let discordOutcome: DiscordIngestOutcome | null = null;

  if (wantMc) {
    mcOutcome = await ingestMissionControlHistory({
      agent: args.agent,
      gatewayAgentId: args.agent,
      mcBaseUrl,
      bearerToken,
      stagingDir,
      ...(args.fetchFn !== undefined ? { fetchFn: args.fetchFn } : {}),
      log,
    });

    // Explicit-mc-mode fatal cases (D-11): the operator asked for MC
    // specifically — surface the failure as exit 1.
    if (source === "mc") {
      if (mcOutcome.kind === "missing-bearer-token") {
        cliError("MC_API_TOKEN env var required for --source mc");
        return 1;
      }
      if (mcOutcome.kind === "mc-gateway-503") {
        cliError(`MC gateway 503: ${mcOutcome.error}`);
        return 1;
      }
      if (mcOutcome.kind === "mc-fetch-failed") {
        cliError(`MC fetch failed (${mcOutcome.phase}): ${mcOutcome.error}`);
        return 1;
      }
      if (mcOutcome.kind === "agent-not-found-in-mc") {
        cliError(
          `Agent ${mcOutcome.gatewayAgentId} not found in Mission Control's /api/agents response`,
        );
        return 1;
      }
    }
    // In --source both, MC failures are non-fatal: log + continue to Discord.
    if (
      source === "both" &&
      (mcOutcome.kind === "mc-gateway-503" ||
        mcOutcome.kind === "mc-fetch-failed" ||
        mcOutcome.kind === "agent-not-found-in-mc")
    ) {
      log.warn(
        { agent: args.agent, kind: mcOutcome.kind },
        "MC ingest failed in --source both mode; continuing with Discord",
      );
    }
  }

  if (wantDiscord) {
    const channels: string[] = [...(agentCfg.channels ?? [])];

    const fetchMessages = args.fetchMessages ?? defaultFetchMessages;
    discordOutcome = await ingestDiscordHistory({
      agent: args.agent,
      channels,
      stagingDir,
      ...(args.depthMsgs !== undefined ? { depthMsgs: args.depthMsgs } : {}),
      ...(args.depthDays !== undefined ? { depthDays: args.depthDays } : {}),
      fetchMessages,
      log,
    });

    if (source === "discord" && discordOutcome.kind === "discord-fetch-failed") {
      cliError(
        `Discord fetch failed (channel ${discordOutcome.channelId}): ${discordOutcome.error}`,
      );
      return 1;
    }
  }

  // Build CLI-level combined outcome.
  const combined: IngestOutcome =
    mcOutcome !== null && discordOutcome !== null
      ? { kind: "ingested-both", agent: args.agent, mc: mcOutcome, discord: discordOutcome }
      : mcOutcome !== null
        ? { kind: "ingested-mc-only", agent: args.agent, mc: mcOutcome }
        : { kind: "ingested-discord-only", agent: args.agent, discord: discordOutcome! };

  cliLog(JSON.stringify(combined, null, 2));

  // Exit 0 if at least one requested source succeeded; 1 otherwise.
  const mcOk =
    mcOutcome === null ||
    mcOutcome.kind === "ingested" ||
    mcOutcome.kind === "no-changes";
  const discordOk =
    discordOutcome === null ||
    discordOutcome.kind === "ingested" ||
    discordOutcome.kind === "no-changes" ||
    discordOutcome.kind === "no-channels";

  if (source === "both") {
    // Either source succeeding is enough.
    return mcOk || discordOk ? 0 : 1;
  }
  return mcOk && discordOk ? 0 : 1;
}

/**
 * Default fetchMessages thunk — throws explicitly. The Discord SDK MCP
 * tool wiring lands in Plan 92-06 (daemon-side IPC). Until then, the bare
 * CLI invocation of `cutover ingest --source discord` requires a wired
 * caller (or `--source mc` only).
 */
const defaultFetchMessages: DiscordFetchMessagesFn = async () => {
  throw new Error(
    "defaultFetchMessages not yet wired — pass fetchMessages via DI from a SDK-aware caller (Plan 92-06)",
  );
};

export function registerCutoverIngestCommand(parent: Command): void {
  parent
    .command("ingest")
    .description(
      "Pull conversation history into local JSONL staging (MC API primary, Discord fallback per D-11)",
    )
    .requiredOption("--agent <name>", "Agent whose history to ingest")
    .option(
      "--source <which>",
      "Source: mc, discord, or both (default: both)",
      "both",
    )
    .option(
      "--mc-base <url>",
      "Mission Control base URL",
      MC_DEFAULT_BASE_URL,
    )
    .option(
      "--depth-msgs <n>",
      "Max messages per Discord channel (Discord only — MC pagination is cursor-driven)",
      (v) => parseInt(v, 10),
      10000,
    )
    .option(
      "--depth-days <n>",
      "Max age in days (Discord only)",
      (v) => parseInt(v, 10),
      90,
    )
    .option("--staging-dir <path>", "Override staging directory")
    .action(
      async (opts: {
        agent: string;
        source: "mc" | "discord" | "both";
        mcBase?: string;
        depthMsgs?: number;
        depthDays?: number;
        stagingDir?: string;
      }) => {
        const code = await runCutoverIngestAction({
          agent: opts.agent,
          source: opts.source,
          ...(opts.mcBase !== undefined ? { mcBase: opts.mcBase } : {}),
          ...(opts.depthMsgs !== undefined ? { depthMsgs: opts.depthMsgs } : {}),
          ...(opts.depthDays !== undefined ? { depthDays: opts.depthDays } : {}),
          ...(opts.stagingDir !== undefined ? { stagingDir: opts.stagingDir } : {}),
        });
        process.exit(code);
      },
    );
}
