/**
 * Phase 92 Plan 05 — `clawcode cutover canary` subcommand (CUT-08, D-08).
 *
 * Reads AGENT-PROFILE.json (Plan 92-01 emission) for `--agent`, takes the
 * top 20 entries from `topIntents[]`, synthesizes ONE prompt per intent
 * via `synthesizeCanaryPrompts`, and runs each prompt through BOTH
 * production entry points (Discord bot path + API path) via `runCanary`.
 * Emits CANARY-REPORT.md to the output directory and exits with 0 only
 * if `passRate >= 100`.
 *
 * Standalone CLI invocation requires a wired TurnDispatcher dependency
 * for the synthesizer's LLM pass. Plan 92-06 lands the daemon-side IPC
 * that wires this against a live clawdy session. Until then, this
 * command is callable only from hermetic tests OR daemon contexts that
 * inject the dispatcher.
 *
 * Production fetchApi uses Node 22's native `fetch` to POST OpenAI-shape
 * JSON to `http://localhost:3101/v1/chat/completions` (Phase 73). Loopback
 * only — pinned by static-grep regression rejecting external URLs.
 */

import type { Command } from "commander";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import pino, { type Logger } from "pino";

import {
  synthesizeCanaryPrompts,
  type SynthesizerDeps,
} from "../../cutover/canary-synthesizer.js";
import {
  runCanary,
  type CanaryRunnerDeps,
} from "../../cutover/canary-runner.js";
import {
  CANARY_API_ENDPOINT,
  CANARY_CHANNEL_ID,
  CANARY_TIMEOUT_MS,
  type CanaryRunOutcome,
  type CanarySynthesizeOutcome,
} from "../../cutover/types.js";
import { cliError, cliLog } from "../output.js";

export type RunCutoverCanaryArgs = Readonly<{
  agent: string;
  /** Override AGENT-PROFILE.json path. Default: ~/.clawcode/manager/cutover-reports/<agent>/latest/AGENT-PROFILE.json. */
  profilePath?: string;
  /** Override report output directory. Default: ~/.clawcode/manager/cutover-reports/<agent>/<timestamp>/. */
  outputDir?: string;
  /** Override canary channel ID. Default: CANARY_CHANNEL_ID. */
  canaryChannelId?: string;
  /** Override API endpoint. Default: CANARY_API_ENDPOINT (loopback). */
  apiEndpoint?: string;
  /** Override per-path timeout. Default: CANARY_TIMEOUT_MS (30s). */
  timeoutMs?: number;
  log?: Logger;
  /** DI — required for synthesizer's LLM pass. Daemon context wires the real dispatcher. */
  dispatcher?: SynthesizerDeps["dispatcher"];
  /** DI — required for Discord bot path. Daemon context wires turnDispatcher.dispatchStream. */
  dispatchStream?: CanaryRunnerDeps["dispatchStream"];
  /** DI — optional override for API path. Default: native fetch wrapper below. */
  fetchApi?: CanaryRunnerDeps["fetchApi"];
}>;

/**
 * Default fetchApi implementation. Node 22 native fetch + JSON POST + extract
 * OpenAI-shape `choices[0].message.content` if present, else fall back to raw
 * body text.
 *
 * NOTE: AbortController-based per-request timeout is layered ON TOP by
 * `runCanary`'s `raceWithTimeout`; this default fetcher does not impose its
 * own timeout — the caller's race is authoritative.
 */
const defaultFetchApi: CanaryRunnerDeps["fetchApi"] = async (
  url,
  body,
) => {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const rawText = await res.text();
  let json: unknown;
  try {
    json = JSON.parse(rawText);
  } catch {
    /* keep rawText only */
  }
  const responseText =
    (json as { choices?: { message?: { content?: string } }[] } | undefined)
      ?.choices?.[0]?.message?.content ?? rawText;
  return { status: res.status, text: responseText, json };
};

/**
 * Run one cutover canary cycle. Returns the process exit code.
 *
 * Exit code policy:
 *   - ran with passRate >= 100              → 0
 *   - ran with passRate < 100               → 1 (canary failed; cutover-not-ready)
 *   - no-prompts / no-intents               → 1 (operator-recoverable: re-run profile first)
 *   - dispatcher-failed / schema-validation → 1
 *   - missing dispatcher dep                → 1
 */
export async function runCutoverCanaryAction(
  args: RunCutoverCanaryArgs,
): Promise<number> {
  const log = args.log ?? (pino({ level: "info" }) as unknown as Logger);

  if (args.dispatcher === undefined) {
    cliError(
      "cutover canary requires a TurnDispatcher dependency for the synthesizer LLM pass — invoke via daemon IPC (Plan 92-06) or pass dispatcher in tests",
    );
    return 1;
  }
  if (args.dispatchStream === undefined) {
    cliError(
      "cutover canary requires a dispatchStream dependency for the Discord bot path — invoke via daemon IPC (Plan 92-06) or pass dispatchStream in tests",
    );
    return 1;
  }

  const profilePath =
    args.profilePath ??
    join(
      homedir(),
      ".clawcode",
      "manager",
      "cutover-reports",
      args.agent,
      "latest",
      "AGENT-PROFILE.json",
    );

  if (!existsSync(profilePath)) {
    cliError(`cutover canary: AGENT-PROFILE.json not found at ${profilePath}`);
    return 1;
  }

  let topIntents: readonly { intent: string; count: number }[];
  try {
    const raw = await readFile(profilePath, "utf8");
    const parsed = JSON.parse(raw) as {
      topIntents?: { intent: string; count: number }[];
    };
    topIntents = parsed.topIntents ?? [];
  } catch (err) {
    cliError(
      `cutover canary: failed to parse ${profilePath}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return 1;
  }

  // Synthesize prompts.
  const synthOutcome: CanarySynthesizeOutcome =
    await synthesizeCanaryPrompts({
      agent: args.agent,
      topIntents,
      dispatcher: args.dispatcher,
      log,
    });
  if (synthOutcome.kind !== "synthesized") {
    cliLog(JSON.stringify(synthOutcome, null, 2));
    return 1;
  }

  const outputDir =
    args.outputDir ??
    join(
      homedir(),
      ".clawcode",
      "manager",
      "cutover-reports",
      args.agent,
      new Date().toISOString().replace(/[:.]/g, "-"),
    );

  const runOutcome: CanaryRunOutcome = await runCanary({
    agent: args.agent,
    prompts: synthOutcome.prompts,
    canaryChannelId: args.canaryChannelId ?? CANARY_CHANNEL_ID,
    apiEndpoint: args.apiEndpoint ?? CANARY_API_ENDPOINT,
    timeoutMs: args.timeoutMs ?? CANARY_TIMEOUT_MS,
    outputDir,
    dispatchStream: args.dispatchStream,
    fetchApi: args.fetchApi ?? defaultFetchApi,
    log,
  });

  cliLog(JSON.stringify(runOutcome, null, 2));

  if (runOutcome.kind !== "ran") return 1;
  return runOutcome.passRate >= 100 ? 0 : 1;
}

export function registerCutoverCanaryCommand(parent: Command): void {
  parent
    .command("canary")
    .description(
      "Run the dual-entry-point canary battery (Discord bot + API) against the cutover candidate. Synthesizes 20 prompts from AGENT-PROFILE.json topIntents[] and runs each through both paths with a 30s per-path timeout. Emits CANARY-REPORT.md.",
    )
    .requiredOption("--agent <name>", "Agent under canary")
    .option(
      "--profile <path>",
      "Override AGENT-PROFILE.json path (default: ~/.clawcode/manager/cutover-reports/<agent>/latest/AGENT-PROFILE.json)",
    )
    .option("--output-dir <path>", "Override report output directory")
    .option(
      "--canary-channel-id <id>",
      `Override canary Discord channel ID (default: ${CANARY_CHANNEL_ID})`,
    )
    .option(
      "--api-endpoint <url>",
      `Override API endpoint (default: ${CANARY_API_ENDPOINT})`,
    )
    .option(
      "--timeout-ms <ms>",
      `Override per-path timeout in milliseconds (default: ${CANARY_TIMEOUT_MS})`,
      (v) => parseInt(v, 10),
    )
    .action(
      async (opts: {
        agent: string;
        profile?: string;
        outputDir?: string;
        canaryChannelId?: string;
        apiEndpoint?: string;
        timeoutMs?: number;
      }) => {
        const code = await runCutoverCanaryAction({
          agent: opts.agent,
          ...(opts.profile !== undefined ? { profilePath: opts.profile } : {}),
          ...(opts.outputDir !== undefined ? { outputDir: opts.outputDir } : {}),
          ...(opts.canaryChannelId !== undefined
            ? { canaryChannelId: opts.canaryChannelId }
            : {}),
          ...(opts.apiEndpoint !== undefined
            ? { apiEndpoint: opts.apiEndpoint }
            : {}),
          ...(opts.timeoutMs !== undefined
            ? { timeoutMs: opts.timeoutMs }
            : {}),
        });
        process.exit(code);
      },
    );
}
