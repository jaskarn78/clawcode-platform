/**
 * Phase 115 perf-runner — benchmark scenario executor.
 *
 * Runs one (agent, scenario, run-count) tuple against a *live* clawcode
 * daemon and emits per-run + aggregate rows. Read-only against the
 * production turn loop:
 *
 *   1. For each run, call `clawcode start <agent>` (cold-start) or
 *      `clawcode send <agent> "<prompt>"` via the IPC socket.
 *   2. Wait for the turn's traces row to land in
 *      `<agentMemoryPath>/traces.db`. The benchmark NEVER measures
 *      wall-clock from outside — it reads `trace_spans.duration_ms`
 *      directly so the numbers match what the dashboard / `clawcode
 *      latency` CLI reports. This is the same span data Phase 50/51/52/55
 *      surface, just queried back here.
 *   3. Compute p50/p95/p99 across the run set using the nearest-rank
 *      method (no interpolation): `sorted[ceil(percentile * n) - 1]`.
 *
 * Why this lives in `scripts/bench/` and not `src/benchmarks/`: the
 * Phase 51 `src/benchmarks/runner.ts` runs an *isolated* daemon with a
 * synthetic `bench-agent` configuration. Phase 115's baseline must lock
 * the *production* fleet's broken numbers — so this harness invokes the
 * production daemon's IPC socket and reads the production agents'
 * traces.db files. They are intentionally separate tools with separate
 * paths; we do not collapse them.
 *
 * NEVER mocks dispatchTurn. NEVER mutates production agent state beyond
 * what `clawcode send` / `clawcode start` already does. The agent under
 * test sees a real Discord-shaped turn; the trace it emits is the
 * production trace.
 *
 * Usage (from CLI wrapper `scripts/bench/115-perf.ts`):
 *
 *   import { runBenchScenario } from './115-perf-runner.js';
 *
 *   const { rows, summary } = await runBenchScenario({
 *     agent: 'admin-clawdy',
 *     scenario: 'discord-ack',
 *     runs: 10,
 *     label: 'pre-115-baseline-2026-05-08',
 *   });
 */

import Database from "better-sqlite3";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { sendIpcRequest } from "../../src/ipc/client.js";
import { SOCKET_PATH } from "../../src/manager/daemon.js";

/** Five canonical Phase 115 scenario IDs. */
export type ScenarioId =
  | "cold-start"
  | "discord-ack"
  | "tool-heavy"
  | "memory-recall"
  | "extended-thinking";

/** Span name(s) the runner pulls from traces.db for each scenario. */
const SCENARIO_SPAN_NAMES: Readonly<Record<ScenarioId, readonly string[]>> = {
  "cold-start": ["first_token"],
  "discord-ack": ["first_token"],
  "tool-heavy": ["end_to_end", "tool_call"],
  "memory-recall": ["end_to_end"],
  "extended-thinking": ["first_visible_token", "end_to_end"],
};

/** Default fixture prompts per scenario. Operator can override via `--prompt-file`. */
const DEFAULT_FIXTURE_PROMPTS: Readonly<Record<ScenarioId, string>> = {
  "cold-start": "(no prompt — cold-start scenario invokes `clawcode start`)",
  "discord-ack": "ok thx",
  "tool-heavy":
    "Query mysql for the latest 5 rows in acme_clients then summarize and search the web for related news",
  "memory-recall": "What did we discuss about Ana Bencker on May 6 2026?",
  "extended-thinking":
    "Think step by step about the architecture of this multi-agent system and propose three improvements.",
};

/** One per-run row written to the JSONL artifact. */
export type BenchRow = {
  readonly agent: string;
  readonly scenario: ScenarioId;
  readonly runIndex: number; // 0-based
  readonly turnId: string | null; // null if the IPC call did not surface a turn
  readonly span: string;
  readonly durationMs: number | null; // null if the span was not found in traces.db
  readonly skipped: boolean; // true when a guard (e.g., Client A gate) skipped the run
  readonly skipReason?: string;
  readonly ts: string; // ISO 8601 wall-clock when the row was captured
};

/** Aggregate row written to summary.jsonl. */
export type BenchSummary = {
  readonly agent: string;
  readonly scenario: ScenarioId;
  readonly span: string;
  readonly runs: number; // count of rows that produced a non-null durationMs
  readonly p50_ms: number | null;
  readonly p95_ms: number | null;
  readonly p99_ms: number | null;
  readonly mean_ms: number | null;
  readonly min_ms: number | null;
  readonly max_ms: number | null;
  readonly label: string;
  readonly ts: string;
  readonly skipped: number; // count of rows flagged skipped
};

/** Options accepted by `runBenchScenario`. */
export type RunBenchScenarioOpts = {
  readonly agent: string;
  readonly scenario: ScenarioId;
  readonly runs: number;
  readonly label: string;
  readonly promptFile?: string;
  /**
   * Per-agent memory path. Optional — defaults to `~/.clawcode/agents/<agent>`.
   * Phase 75 SHARED-01 introduced workspace-shared memoryPath; this lets the
   * caller point the runner at the actual location for acme-family
   * agents whose memoryPath ≠ default.
   */
  readonly memoryPath?: string;
  /**
   * If true, write per-run JSONL + aggregate JSONL to
   * `~/.clawcode/bench/115/<label>/`.
   * Defaults to true. Set false in tests to keep the harness pure.
   */
  readonly writeArtifacts?: boolean;
  /**
   * Inter-run pacing in milliseconds. Default 500ms.
   * Long enough for dispatchTurn to flush its trace transaction; short
   * enough that 10 runs complete in ~6 seconds for short scenarios.
   */
  readonly interRunPaceMs?: number;
  /**
   * Maximum wall-clock to wait for a turn's traces row to land before
   * giving up (and recording durationMs=null). Default 60_000ms.
   */
  readonly traceWaitTimeoutMs?: number;
};

const DEFAULT_INTER_RUN_PACE_MS = 500;
const DEFAULT_TRACE_WAIT_TIMEOUT_MS = 60_000;
const TRACE_POLL_INTERVAL_MS = 250;

/**
 * Resolve the on-disk traces.db path for an agent.
 *
 * Mirrors `src/manager/session-memory.ts:122` —
 *   `join(config.memoryPath, "traces.db")`.
 *
 * Default `memoryPath` is `~/.clawcode/agents/<agent>`. Caller may override
 * via `opts.memoryPath` for acme-family agents whose memoryPath is set
 * to a workspace-shared location.
 */
function resolveTracesDbPath(agent: string, memoryPathOverride?: string): string {
  const memoryPath =
    memoryPathOverride ?? join(homedir(), ".clawcode", "agents", agent);
  return join(memoryPath, "traces.db");
}

/**
 * Resolve the artifact directory for a label.
 *
 * Layout: `~/.clawcode/bench/115/<label>/`. Directory is created if it does
 * not already exist (recursive mkdir).
 */
function resolveArtifactDir(label: string): string {
  const dir = join(homedir(), ".clawcode", "bench", "115", label);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Read the most-recent trace row whose started_at is >= `sinceIso` and whose
 * agent matches. Polls every 250ms up to `timeoutMs`.
 *
 * Returns the turn id + a map of span-name → durationMs for the row's
 * trace_spans, or null if no row landed within the timeout window.
 */
function awaitNewTurnTrace(
  tracesDbPath: string,
  agent: string,
  sinceIso: string,
  timeoutMs: number,
): Promise<{ turnId: string; spans: Map<string, number> } | null> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const tick = () => {
      if (!existsSync(tracesDbPath)) {
        if (Date.now() >= deadline) {
          resolve(null);
          return;
        }
        setTimeout(tick, TRACE_POLL_INTERVAL_MS);
        return;
      }
      let db: Database.Database | null = null;
      try {
        db = new Database(tracesDbPath, { readonly: true });
        db.pragma("busy_timeout = 5000");
        const turnRow = db
          .prepare(
            `
              SELECT id
              FROM traces
              WHERE agent = ? AND started_at >= ?
              ORDER BY started_at DESC
              LIMIT 1
            `,
          )
          .get(agent, sinceIso) as { readonly id: string } | undefined;
        if (turnRow && typeof turnRow.id === "string") {
          // Read the spans for this turn.
          const spanRows = db
            .prepare(
              `
                SELECT name, duration_ms
                FROM trace_spans
                WHERE turn_id = ?
              `,
            )
            .all(turnRow.id) as ReadonlyArray<{
            readonly name: string;
            readonly duration_ms: number;
          }>;
          const spans = new Map<string, number>();
          for (const row of spanRows) {
            // Phase 55: tool_call.<name> spans are aggregated under "tool_call"
            // for scenario reporting (the canonical segment).
            if (row.name.startsWith("tool_call.")) {
              const prev = spans.get("tool_call") ?? 0;
              spans.set("tool_call", prev + row.duration_ms);
            } else {
              spans.set(row.name, row.duration_ms);
            }
          }
          db.close();
          resolve({ turnId: turnRow.id, spans });
          return;
        }
      } catch {
        // Swallow read errors and keep polling — db may be momentarily locked
        // by the daemon writer.
      } finally {
        try {
          db?.close();
        } catch {
          // ignore close errors
        }
      }
      if (Date.now() >= deadline) {
        resolve(null);
        return;
      }
      setTimeout(tick, TRACE_POLL_INTERVAL_MS);
    };
    tick();
  });
}

/**
 * Issue a single scenario invocation against the running daemon.
 *
 * For `cold-start`: send the `start` IPC method.
 * For all other scenarios: send the `send-message` IPC method (alias for
 *   the canonical `ask-agent`) with the scenario fixture prompt.
 *
 * Returns the messageId / turnId hint emitted by the IPC response, or null
 * if the daemon did not respond with one.
 */
async function invokeScenario(
  agent: string,
  scenario: ScenarioId,
  prompt: string,
): Promise<{ messageId: string | null }> {
  if (scenario === "cold-start") {
    // Best-effort: stop the agent first so `start` actually cold-starts.
    // The daemon returns ok=false if the agent wasn't running, which we
    // treat as a non-error (idempotent stop).
    try {
      await sendIpcRequest(SOCKET_PATH, "stop", { name: agent });
    } catch {
      // ignore — stop is idempotent from the bench's perspective
    }
    // Brief pause to let the daemon release the agent's session before restart.
    await sleep(500);
    await sendIpcRequest(SOCKET_PATH, "start", {
      name: agent,
      config: "clawcode.yaml",
    });
    return { messageId: null }; // start does not generate a turnId — first_token comes from the agent's first inbound message after start
  }
  const result = (await sendIpcRequest(SOCKET_PATH, "send-message", {
    from: "bench-115",
    to: agent,
    content: prompt,
    priority: "normal",
  })) as { readonly messageId?: string };
  return { messageId: result.messageId ?? null };
}

/**
 * Compute p50/p95/p99 using the nearest-rank method (no interpolation):
 *
 *   p_index = ceil(percentile * n) - 1  (1-based rank converted to 0-based index)
 *
 * Returns null when `values` is empty. Pre-sorts a copy — does not mutate input.
 */
function nearestRankPercentile(values: readonly number[], percentile: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  // Nearest-rank: index = ceil(percentile * n) - 1, clamped to [0, n-1].
  const idx = Math.max(0, Math.min(Math.ceil(percentile * n) - 1, n - 1));
  return sorted[idx] ?? null;
}

/**
 * Resolve the prompt for a scenario. If `promptFile` is supplied, read its
 * contents (trimmed); otherwise fall back to the canonical fixture prompt.
 */
function resolvePrompt(scenario: ScenarioId, promptFile: string | undefined): string {
  if (promptFile) {
    return readFileSync(promptFile, "utf-8").trim();
  }
  return DEFAULT_FIXTURE_PROMPTS[scenario];
}

/**
 * Run a benchmark scenario `runs` times against the live daemon.
 *
 * Returns the per-run rows + aggregate summaries (one summary per span
 * the scenario tracks — `tool-heavy` and `extended-thinking` track two).
 *
 * Side effects (when `writeArtifacts` is left default):
 *   - Appends rows to `~/.clawcode/bench/115/<label>/<agent>-<scenario>.jsonl`
 *   - Appends summaries to `~/.clawcode/bench/115/<label>/summary.jsonl`
 */
export async function runBenchScenario(
  opts: RunBenchScenarioOpts,
): Promise<{ rows: readonly BenchRow[]; summary: readonly BenchSummary[] }> {
  const {
    agent,
    scenario,
    runs,
    label,
    promptFile,
    memoryPath: memoryPathOverride,
    writeArtifacts = true,
    interRunPaceMs = DEFAULT_INTER_RUN_PACE_MS,
    traceWaitTimeoutMs = DEFAULT_TRACE_WAIT_TIMEOUT_MS,
  } = opts;

  const tracesDbPath = resolveTracesDbPath(agent, memoryPathOverride);
  const prompt = resolvePrompt(scenario, promptFile);
  const spanNames = SCENARIO_SPAN_NAMES[scenario];

  const rows: BenchRow[] = [];

  for (let i = 0; i < runs; i++) {
    const sinceIso = new Date().toISOString();
    let turnId: string | null = null;
    let spans = new Map<string, number>();

    try {
      await invokeScenario(agent, scenario, prompt);
      const traceResult = await awaitNewTurnTrace(
        tracesDbPath,
        agent,
        sinceIso,
        traceWaitTimeoutMs,
      );
      if (traceResult) {
        turnId = traceResult.turnId;
        spans = traceResult.spans;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "unknown";
      // Record a skipped row so the summary's `skipped` count surfaces this.
      for (const span of spanNames) {
        rows.push({
          agent,
          scenario,
          runIndex: i,
          turnId: null,
          span,
          durationMs: null,
          skipped: true,
          skipReason: `invoke failed: ${msg}`,
          ts: new Date().toISOString(),
        });
      }
      // Continue to next run rather than aborting the whole scenario.
      if (interRunPaceMs > 0) await sleep(interRunPaceMs);
      continue;
    }

    for (const span of spanNames) {
      const durationMs = spans.get(span);
      rows.push({
        agent,
        scenario,
        runIndex: i,
        turnId,
        span,
        durationMs: typeof durationMs === "number" ? durationMs : null,
        skipped: false,
        ts: new Date().toISOString(),
      });
    }

    if (interRunPaceMs > 0 && i < runs - 1) {
      await sleep(interRunPaceMs);
    }
  }

  // Aggregate per span.
  const summary: BenchSummary[] = [];
  for (const span of spanNames) {
    const spanRows = rows.filter((r) => r.span === span);
    const validDurations = spanRows
      .filter((r) => !r.skipped && r.durationMs !== null)
      .map((r) => r.durationMs as number);
    const skippedCount = spanRows.filter((r) => r.skipped).length;
    summary.push({
      agent,
      scenario,
      span,
      runs: validDurations.length,
      p50_ms: nearestRankPercentile(validDurations, 0.5),
      p95_ms: nearestRankPercentile(validDurations, 0.95),
      p99_ms: nearestRankPercentile(validDurations, 0.99),
      mean_ms:
        validDurations.length === 0
          ? null
          : validDurations.reduce((a, b) => a + b, 0) / validDurations.length,
      min_ms: validDurations.length === 0 ? null : Math.min(...validDurations),
      max_ms: validDurations.length === 0 ? null : Math.max(...validDurations),
      label,
      ts: new Date().toISOString(),
      skipped: skippedCount,
    });
  }

  if (writeArtifacts) {
    const dir = resolveArtifactDir(label);
    const perRunPath = join(dir, `${agent}-${scenario}.jsonl`);
    const summaryPath = join(dir, "summary.jsonl");
    const perRunBlob = `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`;
    const summaryBlob = `${summary.map((s) => JSON.stringify(s)).join("\n")}\n`;
    // Append-style writes via writeFileSync with flag 'a' so reruns under the
    // same label accumulate rather than truncate.
    writeFileSync(perRunPath, perRunBlob, { flag: "a" });
    writeFileSync(summaryPath, summaryBlob, { flag: "a" });
  }

  return { rows, summary };
}
