/**
 * Phase 115-postdeploy 2026-05-12 — daemon-side embedding-v2 migration cron.
 *
 * THE BUG THIS FIXES:
 *   Phase 115 Plan 06 shipped the embedding-v2 migration in three parts —
 *     (a) state machine `EmbeddingV2Migrator` (transitions),
 *     (b) batch runner `runReEmbedBatch` (processes one batch when called),
 *     (c) IPC handlers in daemon.ts (CLI / UI can transition states).
 *   It NEVER shipped a scheduler that actually CALLS the runner. An
 *   operator who clicked "Start re-embedding" in the dashboard saw the
 *   phase flip to `re-embedding`, then the progress sat at 0% forever
 *   because nothing on the daemon side ever invoked `runReEmbedBatch`.
 *   Operator's words: "I tried to start re-embedding on admin clawdy
 *   but its been stuck at 0%".
 *
 *   This is the silent-path-bifurcation anti-pattern (memory note
 *   `feedback_silent_path_bifurcation.md`) — code shipped that looks
 *   reachable but production never actually invokes it. The sentinel
 *   test at `src/memory/migrations/__tests__/migration-cron-wiring.test.ts`
 *   is the structural guard against this exact bug class recurring.
 *
 * THE FIX:
 *   Run a croner-driven tick every 30 seconds. On each tick, iterate
 *   `manager.getRunningAgents()`. For each agent:
 *     - Skip if no memory store (agent mid-startup; tick fires again).
 *     - Skip if agent is in the operator-controlled paused set
 *       (`config.defaults.embeddingMigration.pausedAgents`).
 *     - Otherwise call `runReEmbedBatch` once. The runner itself gates on
 *       phase (returns `skippedReason: "phase=..."` for any phase outside
 *       `dual-write` / `re-embedding`) and on agent activity (returns
 *       `skippedReason: "agent-active"` when the agent is mid-turn).
 *
 *   ONE-SHOT KICK ON TRANSITION (separate from the cron):
 *     `kickEmbeddingMigrationBatch(...)` is exported for the IPC
 *     transition handler in daemon.ts. After a transition to
 *     `dual-write` or `re-embedding` lands, the handler fires ONE batch
 *     immediately so the operator sees `progressProcessed` jump within
 *     seconds instead of waiting up to 30s for the cron tick. Fire-and-
 *     forget — the IPC response is NOT blocked on the batch.
 *
 * PER-AGENT ISOLATION:
 *   Each tick constructs a fresh `EmbeddingV2Migrator` against the
 *   agent's per-agent DB (Phase 90 invariant — no shared state between
 *   agent migration runners). Errors in one agent's batch are caught
 *   and logged, never propagated to the next agent.
 *
 * CONFIG:
 *   - cadence: every 30s (croner 6-field syntax `*​/30 * * * * *`).
 *   - batch size: defaults from `defaults.embeddingMigration.batchSize`
 *     (Phase 115 D-08 default 50). Sane for a 30s tick.
 *   - CPU budget pct: passed through from
 *     `defaults.embeddingMigration.cpuBudgetPct` (Phase 115 D-09
 *     default 5) — runner uses it for log diagnostics; actual rate
 *     limiting is the tick cadence.
 *
 * SHUTDOWN:
 *   Returns a handle with `.stop()` (mirrors `DailySummaryCronHandle`).
 *   The daemon shutdown sequence calls `.stop()` alongside the other
 *   crons so SIGTERM cleanly exits.
 */

import { Cron } from "croner";
import type { Logger } from "pino";
import type { SessionManager } from "./session-manager.js";
import type { EmbeddingMigrationPhase } from "../memory/migrations/embedding-v2.js";
import { EmbeddingV2Migrator } from "../memory/migrations/embedding-v2.js";
import { runReEmbedBatch } from "../memory/migrations/embedding-v2-runner.js";
import type { Config } from "../config/schema.js";

/**
 * Minimal Cron-like handle — trims croner's surface to the one method
 * the daemon touches (`.stop()` from the SIGTERM shutdown sequence).
 * Mirrors `DailySummaryCronHandle` for consistency.
 */
export type MigrationCronHandle = {
  readonly stop: () => void;
};

/**
 * Factory for the underlying scheduler. Production passes a wrapper
 * over croner's `new Cron(...)`; tests pass a stub that captures the
 * callback for synchronous invocation.
 */
export type CronFactory = (
  pattern: string,
  opts: { readonly name: string },
  callback: () => unknown | Promise<unknown>,
) => MigrationCronHandle;

/** Default production cron factory — thin wrapper over `new Cron(...)`. */
const DEFAULT_CRON_FACTORY: CronFactory = (pattern, opts, callback) => {
  const cron = new Cron(pattern, { name: opts.name }, async () => {
    await callback();
  });
  return {
    stop: () => cron.stop(),
  };
};

/**
 * Subset of `SessionManager` the migration cron actually depends on.
 * Keeps the cron decoupled from the bulk of the manager surface so unit
 * tests can stand up a tiny fake.
 */
export type MigrationCronManager = Pick<
  SessionManager,
  "getRunningAgents" | "getMemoryStore" | "getEmbedder" | "hasActiveTurn"
>;

export type ScheduleMigrationCronArgs = {
  readonly manager: MigrationCronManager;
  readonly config: Config;
  readonly log: Logger;
  /** Override for tests — defaults to real croner. */
  readonly cronFactory?: CronFactory;
  /** Override for tests — defaults to every 30 seconds. */
  readonly pattern?: string;
};

/**
 * Phases for which the runner does any actual work. The runner itself
 * gates on these via `shouldRunReEmbedBatch()`, but exposing the set
 * here lets the one-shot kick path skip the call entirely for clearly
 * non-working phases (idle / cutover / v1-dropped / rolled-back). The
 * cron tick path leaves the gating to the runner — the cron iterates
 * every running agent, since most agents will be in a working phase
 * during the migration window.
 */
// Phase 999.119 v2 switch — every phase in which v2 vectors are written.
// The runner is a no-op once nothing is missing, so keeping it live through
// `cutover` means a dual-write miss (embed failure, merged content, a row
// written by a CLI path without the hook) heals itself within 30 s.
const WORKING_PHASES: ReadonlySet<EmbeddingMigrationPhase> = new Set([
  "dual-write",
  "re-embedding",
  "re-embed-complete",
  "cutover",
]);

/**
 * Read the operator-controlled paused-agents set from live config. We
 * read on every tick (not once at startup) so `embedding-migration-pause`
 * IPC mutations take effect on the NEXT tick — no daemon restart needed.
 */
function getPausedAgents(config: Config): ReadonlySet<string> {
  const em = (config.defaults as {
    embeddingMigration?: { pausedAgents?: readonly string[] };
  }).embeddingMigration;
  return new Set(em?.pausedAgents ?? []);
}

/**
 * Read batch-size + cpuBudgetPct from live config with the Phase 115
 * D-08/D-09 defaults. The schema makes the whole `embeddingMigration`
 * block optional; defaults are applied here at the consumption
 * boundary (matches the schema comment at line 1828-1834).
 */
function getRunnerConfig(config: Config): {
  readonly cpuBudgetPct: number;
  readonly batchSize: number;
} {
  const em = (config.defaults as {
    embeddingMigration?: { cpuBudgetPct?: number; batchSize?: number };
  }).embeddingMigration;
  return {
    cpuBudgetPct: em?.cpuBudgetPct ?? 5,
    batchSize: em?.batchSize ?? 50,
  };
}

/**
 * Run one batch for one agent. Pure helper — no scheduling, no
 * iteration. Used by both the cron tick (in a per-agent loop) and the
 * one-shot kick from the IPC transition handler.
 *
 * Returns silently on every skip condition (no store, paused, etc).
 * The runner returns a structured `skippedReason` for phase/active
 * skips; we log INFO for actual work, DEBUG for skips, WARN on caught
 * errors.
 */
export async function runBatchForAgent(args: {
  readonly agent: string;
  readonly manager: MigrationCronManager;
  readonly config: Config;
  readonly log: Logger;
}): Promise<void> {
  const { agent, manager, config, log } = args;
  const paused = getPausedAgents(config);
  if (paused.has(agent)) {
    log.debug(
      { agent, action: "embedding-v2-cron-skip-paused" },
      "[diag] embedding-v2 cron skipped agent (paused)",
    );
    return;
  }
  const store = manager.getMemoryStore(agent);
  if (!store) {
    log.debug(
      { agent, action: "embedding-v2-cron-skip-no-store" },
      "[diag] embedding-v2 cron skipped agent (no memory store)",
    );
    return;
  }
  const migrator = new EmbeddingV2Migrator(store.getDatabase(), agent);
  // Cheap pre-check: skip the runner call entirely for non-working
  // phases. Saves a few SQL queries the runner would otherwise do
  // (countMemoriesMissingV2Embedding, etc) just to discover idle. The
  // runner still has its own `shouldRunReEmbedBatch` guard for callers
  // that don't pre-check; the cron pre-checks because it fires every
  // 30s across every agent.
  const state = migrator.getState();
  if (!WORKING_PHASES.has(state.phase)) {
    log.debug(
      { agent, phase: state.phase, action: "embedding-v2-cron-skip-phase" },
      "[diag] embedding-v2 cron skipped agent (non-working phase)",
    );
    return;
  }
  const embedder = manager.getEmbedder();
  const runnerCfg = getRunnerConfig(config);
  const isAgentActive = (): boolean => {
    try {
      return manager.hasActiveTurn(agent);
    } catch {
      // Defensive — never let a session-manager hiccup crash the cron.
      return false;
    }
  };
  // 116-postdeploy 2026-05-12 — capture phase BEFORE runBatch so we can
  // detect an in-batch auto-transition to `re-embed-complete` and fire a
  // one-shot orphan cleanup for this agent. The runner flips
  // `re-embedding → re-embed-complete` from TWO sites (runner.ts
  // lines 113-121 + 155-165) when the v2 backfill cursor finishes;
  // observing phase before/after catches both naturally without
  // entangling the runner with cleanup concerns.
  //
  // Why cleanup at this exact edge: orphan `vec_memories` rows
  // (memory_id present in v1/v2 vec table but absent from `memories`)
  // are counted in the v2 dashboard total alongside real memories. An
  // agent that's actually 100% migrated will display "59%" or similar
  // because the orphan denominator never moves. The cleanupOrphansSplit
  // call removes the orphan v1+v2 rows so the percent display snaps to
  // 100% — and the dashboard's v1 / v2 numbers reflect real memories
  // only. Idempotent; safe to fire even if no orphans exist.
  //
  // We choose `cleanupOrphansSplit` over `cleanupOrphans` so the log
  // line exposes per-version counts (v1 vs v2 removed). The dashboard
  // refresh path will pick the same shape when sub-scope 16c lands.
  const phaseBefore = state.phase;
  try {
    const result = await runReEmbedBatch(
      migrator,
      store,
      embedder,
      runnerCfg,
      isAgentActive,
      log,
    );
    if (result.processed > 0 || result.skippedReason === undefined) {
      log.debug(
        {
          agent,
          phase: result.phase,
          processed: result.processed,
          remaining: result.remaining,
          skippedReason: result.skippedReason ?? null,
          action: "embedding-v2-cron-batch",
        },
        "[diag] embedding-v2 cron batch outcome",
      );
    } else {
      log.debug(
        {
          agent,
          phase: result.phase,
          skippedReason: result.skippedReason,
          action: "embedding-v2-cron-skip-runner",
        },
        "[diag] embedding-v2 cron batch skipped by runner",
      );
    }
    // Auto-fire orphan cleanup on re-embed-complete transition. We read
    // the migrator state fresh here (not result.phase) because phase
    // mutations land in the migrator via store.getDatabase() writes —
    // result.phase is sourced from the same migrator and matches, but
    // a fresh getState() is defensive against future runner refactors
    // that might return a stale phase snapshot.
    const phaseAfter = migrator.getState().phase;
    if (
      phaseBefore !== "re-embed-complete" &&
      phaseAfter === "re-embed-complete"
    ) {
      try {
        const cleanup = store.cleanupOrphansSplit();
        log.info(
          {
            agent,
            action: "embedding-v2-cron-orphan-cleanup-on-complete",
            v1Removed: cleanup.v1Removed,
            v2Removed: cleanup.v2Removed,
            v1Total: cleanup.v1Total,
            v2Total: cleanup.v2Total,
          },
          "[diag] embedding-v2 fired orphan cleanup on re-embed-complete transition",
        );
      } catch (cleanupErr) {
        const msg =
          cleanupErr instanceof Error
            ? cleanupErr.message
            : String(cleanupErr);
        log.warn(
          {
            agent,
            action: "embedding-v2-cron-orphan-cleanup-failed",
            err: msg,
          },
          "[diag] embedding-v2 orphan cleanup on re-embed-complete failed (non-fatal)",
        );
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(
      { agent, action: "embedding-v2-cron-batch-failed", err: msg },
      "[diag] embedding-v2 cron batch threw (non-fatal)",
    );
  }
}

/**
 * Schedule the migration cron. Returns a handle whose `.stop()` is
 * called from the daemon's SIGTERM shutdown sequence.
 *
 * The callback is async per-tick; per-agent errors are caught inside
 * `runBatchForAgent` so a single misbehaving agent cannot prevent the
 * tick from continuing with the next agent.
 */
export function scheduleMigrationCron(
  args: ScheduleMigrationCronArgs,
): MigrationCronHandle {
  const factory = args.cronFactory ?? DEFAULT_CRON_FACTORY;
  // croner 10.x 6-field syntax — seconds-precision tick every 30s.
  const pattern = args.pattern ?? "*/30 * * * * *";

  const callback = async (): Promise<void> => {
    const agents = args.manager.getRunningAgents();
    if (agents.length === 0) return;
    args.log.debug(
      { agents: agents.length, action: "embedding-v2-cron-tick" },
      "[diag] embedding-v2 cron tick — checking agents for batch work",
    );
    for (const agent of agents) {
      await runBatchForAgent({
        agent,
        manager: args.manager,
        config: args.config,
        log: args.log,
      });
    }
  };

  return factory(pattern, { name: "embedding-v2-migration" }, callback);
}

/**
 * One-shot kick: fire a single batch for ONE agent immediately. Called
 * from the `embedding-migration-transition` IPC handler in daemon.ts
 * AFTER a transition to a working phase lands, so the operator sees
 * `progressProcessed` start climbing within seconds instead of waiting
 * up to 30s for the next cron tick.
 *
 * Fire-and-forget. Returns a `Promise<void>` so callers can `void`-fix
 * it without awaiting. The IPC handler MUST NOT block on this — the
 * operator should see `{ ok: true, phase }` immediately.
 *
 * Internally identical to one iteration of the cron tick for that
 * agent (same skip rules, same error handling).
 */
export async function kickEmbeddingMigrationBatch(args: {
  readonly agent: string;
  readonly manager: MigrationCronManager;
  readonly config: Config;
  readonly log: Logger;
}): Promise<void> {
  await runBatchForAgent(args);
}
