#!/usr/bin/env npx tsx
/**
 * Phase 115 perf benchmark — CLI entrypoint.
 *
 * Wraps `runBenchScenario` (in 115-perf-runner.ts) in a minimal CLI shell.
 * Five canonical scenarios exposed:
 *
 *   - cold-start         (3 runs by convention, restarts the agent)
 *   - discord-ack        (10 runs by convention, "ok thx" short turn)
 *   - tool-heavy         (10 runs, mysql + web-search prompt)
 *   - memory-recall      (10 runs, recall-flavored prompt)
 *   - extended-thinking  (10 runs, long-form reasoning + thinking budget)
 *
 * Each run captures the scenario's canonical span(s) from the *production*
 * agent's `traces.db` (NOT wall-clock), so the numbers are byte-identical
 * to what the dashboard / `clawcode latency` CLI reports. This means a
 * fully running daemon is required — the bench will not synthesize traces.
 *
 * Usage:
 *
 *   npx tsx scripts/bench/115-perf.ts \
 *     --agent admin-clawdy \
 *     --scenario discord-ack \
 *     --runs 10 \
 *     --label pre-115-baseline-2026-05-08
 *
 * Output:
 *
 *   - Per-run JSONL → `~/.clawcode/bench/115/<label>/<agent>-<scenario>.jsonl`
 *   - Aggregate JSONL → `~/.clawcode/bench/115/<label>/summary.jsonl`
 *   - Final stdout JSON line (so callers can pipe):
 *       {"summary": [...]}
 *
 * For the production fleet baseline run (Plan 115-00 T03 / Plan 115-09
 * closeout), wrap this CLI in a per-agent + per-scenario shell loop and
 * point all invocations at the same `--label`.
 *
 * Operator gates:
 *
 *   - fin-client `cold-start` is hardcoded to a *skipped row* unless
 *     the operator passes `--allow-fin-client-cold-start` (Client A gate from
 *     CLAUDE.md). The bench logs the skip and writes a sentinel row in
 *     the JSONL artifact so post-run analysis sees the gap explicitly.
 *
 *   - The `discord-ack` / `tool-heavy` / `memory-recall` /
 *     `extended-thinking` scenarios send real Discord-shaped messages
 *     into the agent's channel via the daemon's `send-message` IPC. They
 *     do NOT bypass the operator's normal turn loop. Run them in
 *     operator-confirmed quiet windows, especially for fin-client
 *     (Client A gate) and any active operator threads.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import process from "node:process";

import {
  runBenchScenario,
  type BenchSummary,
  type ScenarioId,
} from "./115-perf-runner.js";

/**
 * Canonical scenario IDs accepted by `--scenario`. Each ID is a stable
 * contract with the post-115 closeout report (Plan 115-09): adding,
 * renaming, or removing one breaks comparison parity with the pre-115
 * baseline locked in `perf-comparisons/baseline-pre-115.md`.
 *
 * - scenario: cold-start         — first-turn first_token after `clawcode start`
 * - scenario: discord-ack        — short-message Discord ack ("ok thx")
 * - scenario: tool-heavy         — multi-tool turn (mysql + web search)
 * - scenario: memory-recall      — recall-flavored prompt against agent memory
 * - scenario: extended-thinking  — long-form thinking budget (30K tokens)
 */
const KNOWN_SCENARIOS = [
  "cold-start",
  "discord-ack",
  "tool-heavy",
  "memory-recall",
  "extended-thinking",
] as const satisfies readonly ScenarioId[];

const HELP_TEXT = `Phase 115 perf benchmark CLI

Usage:
  npx tsx scripts/bench/115-perf.ts --agent <name> --scenario <id> --runs <N> [--label <tag>]

Required flags:
  --agent <name>           Agent name (must match clawcode.yaml or be a daemon-known agent)
  --scenario <id>          One of: ${KNOWN_SCENARIOS.join(", ")}

Optional flags:
  --runs <N>               Run count (default: 10; cold-start convention is 3)
  --label <tag>            Artifact subdirectory (default: ad-hoc-<ISO8601>)
  --prompt-file <path>     Override the canonical fixture prompt for the scenario
  --memory-path <dir>      Override the agent's memoryPath (Phase 75 SHARED-01)
  --allow-fin-client-cold-start   Bypass the Client A gate on fin-client cold-start
  --help                   Show this help and exit 0
`;

type CliArgs = {
  readonly agent: string;
  readonly scenario: ScenarioId;
  readonly runs: number;
  readonly label: string;
  readonly promptFile?: string;
  readonly memoryPath?: string;
  readonly allowFinAcqColdStart: boolean;
};

function parseArgs(argv: readonly string[]): CliArgs {
  const args = new Map<string, string>();
  const flags = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (typeof tok !== "string") continue;
    if (!tok.startsWith("--")) continue;
    const key = tok.slice(2);
    const next = argv[i + 1];
    if (typeof next === "string" && !next.startsWith("--")) {
      args.set(key, next);
      i++;
    } else {
      flags.add(key);
    }
  }

  const agent = args.get("agent");
  const scenarioRaw = args.get("scenario");
  const runsRaw = args.get("runs");

  if (!agent || !scenarioRaw) {
    process.stderr.write("Missing required --agent or --scenario.\n\n");
    process.stderr.write(HELP_TEXT);
    process.exit(2);
  }
  if (!KNOWN_SCENARIOS.includes(scenarioRaw as ScenarioId)) {
    process.stderr.write(
      `Unknown scenario: ${scenarioRaw}. Allowed: ${KNOWN_SCENARIOS.join(", ")}\n`,
    );
    process.exit(2);
  }

  const runs = runsRaw ? Number(runsRaw) : 10;
  if (!Number.isInteger(runs) || runs <= 0) {
    process.stderr.write(`--runs must be a positive integer, got: ${runsRaw}\n`);
    process.exit(2);
  }

  const label =
    args.get("label") ?? `ad-hoc-${new Date().toISOString().replace(/[:.]/g, "-")}`;

  return {
    agent,
    scenario: scenarioRaw as ScenarioId,
    runs,
    label,
    promptFile: args.get("prompt-file"),
    memoryPath: args.get("memory-path"),
    allowFinAcqColdStart: flags.has("allow-fin-client-cold-start"),
  };
}

function isFinAcqColdStartGated(args: CliArgs): boolean {
  return (
    args.agent === "fin-client" &&
    args.scenario === "cold-start" &&
    !args.allowFinAcqColdStart
  );
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h") || argv.length === 0) {
    process.stdout.write(HELP_TEXT);
    process.exit(0);
  }

  const args = parseArgs(argv);

  // Client A gate: fin-client cold-start is restricted unless explicit override.
  if (isFinAcqColdStartGated(args)) {
    const skipSummary: BenchSummary = {
      agent: args.agent,
      scenario: args.scenario,
      span: "first_token",
      runs: 0,
      p50_ms: null,
      p95_ms: null,
      p99_ms: null,
      mean_ms: null,
      min_ms: null,
      max_ms: null,
      label: args.label,
      ts: new Date().toISOString(),
      skipped: args.runs,
    };
    process.stderr.write(
      "fin-client cold-start: SKIPPED (Client A active gate).\n" +
        "  Pass --allow-fin-client-cold-start to override (operator-confirmed quiet window only).\n",
    );
    // Still write the skip-sentinel summary so post-run analysis sees the gap.
    process.stdout.write(`${JSON.stringify({ summary: [skipSummary] })}\n`);
    process.exit(0);
  }

  const { summary } = await runBenchScenario({
    agent: args.agent,
    scenario: args.scenario,
    runs: args.runs,
    label: args.label,
    promptFile: args.promptFile,
    memoryPath: args.memoryPath,
  });

  process.stdout.write(`${JSON.stringify({ summary })}\n`);
  // Best-effort log of where the artifacts landed.
  const artifactDir = join(homedir(), ".clawcode", "bench", "115", args.label);
  process.stderr.write(`Artifacts: ${artifactDir}\n`);
}

void main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : "unknown";
  process.stderr.write(`bench failed: ${msg}\n`);
  process.exit(1);
});
