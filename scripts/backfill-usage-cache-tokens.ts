#!/usr/bin/env -S npx tsx
/**
 * Backfill — cache input tokens for the CURRENT Pacific day (token-accuracy
 * companion to commits 3d8356c1 + 6e00a0ca, PR #53).
 *
 * WHY
 * ---
 * Before the capture fix, both token-capture sites recorded
 * `tokens_in = usage.input_tokens` only and dropped
 * `cache_read_input_tokens` + `cache_creation_input_tokens`. So today's
 * pre-deploy `usage_events` rows have `cache_read_tokens = 0` /
 * `cache_creation_tokens = 0`, and the new `/clawcode-usage` "In" headline
 * (= fresh + cache-read + cache-write) under-counts for those hours. Forward
 * capture only fixes turns AFTER the daemon restarts with the new code; the
 * gap is self-healing at the next PT midnight (a fresh, fully-correct "Today"
 * window), so this backfill is a single-day cosmetic correction.
 *
 * SOURCE
 * ------
 * The per-agent `traces.db` DID record the cache halves per turn
 * (`cache_read_input_tokens` / `cache_creation_input_tokens`). We sum them over
 * today's Pacific window via `TraceStore.getCacheTelemetry()` and insert ONE
 * tagged, reversible adjustment row into `usage_events` so the embed's window
 * SUM becomes correct. We do NOT rewrite historic per-turn rows.
 *
 *   CAVEAT — `getCacheTelemetry` sums only turns with `input_tokens > 0`
 *   (every real Anthropic turn qualifies, but a turn that somehow logged
 *   input_tokens = 0/NULL is skipped) → the backfill may marginally
 *   UNDER-count. It never over-counts.
 *
 * RUN PROCEDURE (operator-gated — this is a LIVE PROD WRITE)
 * ---------------------------------------------------------
 *   1. Run DURING the deploy, while the daemon is STOPPED. This is both
 *      lock-free (no second writer on the WAL) AND double-count-free (every
 *      one of today's rows is still pre-fix, so the trace-window sum IS the
 *      correct adjustment). The script also computes a delta against any
 *      already-captured cache, so a post-restart run stays correct — but
 *      stopped-daemon is the clean path.
 *   2. SNAPSHOT the usage DB first:  cp usage.db usage.db.pre-backfill
 *   3. DRY RUN (default — prints what it WOULD do, no data write):
 *        npx tsx scripts/backfill-usage-cache-tokens.ts \
 *          --agent fin-client \
 *          --usage-db  /path/to/fin-client/memory/usage.db \
 *          --traces-db /path/to/fin-client/traces.db
 *   4. APPLY (idempotent — re-running replaces today's adjustment row):
 *        ... same command ... --apply
 *   5. Start the daemon with the new code (forward capture active).
 *
 * REVERSIBLE: every row this writes is tagged `session_id` = the marker below.
 * Undo with:  DELETE FROM usage_events WHERE session_id = '__backfill_cache_adjustment__';
 *
 * DRY RUN is read-only with respect to usage DATA. It may apply the additive
 * cache-column schema migration (the exact same one the deployed daemon runs
 * on boot) when opening a not-yet-migrated DB — no rows are inserted/modified.
 */
import { UsageTracker } from "../src/usage/tracker.js";
import { TraceStore } from "../src/performance/trace-store.js";
import { pacificDayRangeUtc } from "../src/usage/pacific-window.js";

// Tag stamped on every adjustment row so the backfill is identifiable,
// idempotent (replace-on-rerun), and reversible (delete-by-marker).
const MARKER_SESSION_ID = "__backfill_cache_adjustment__";
const MARKER_MODEL = "__backfill_cache__";

type Args = {
  agent: string;
  usageDb: string;
  tracesDb: string;
  apply: boolean;
};

function parseArgs(argv: readonly string[]): Args {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
  };
  const agent = get("--agent");
  const usageDb = get("--usage-db");
  const tracesDb = get("--traces-db");
  const apply = argv.includes("--apply");
  if (!agent || !usageDb || !tracesDb) {
    throw new Error(
      "usage: backfill-usage-cache-tokens.ts --agent <name> --usage-db <path> --traces-db <path> [--apply]",
    );
  }
  return { agent, usageDb, tracesDb, apply };
}

/** Sum of the cache columns on EXISTING marker rows in [startIso, endIso). */
function existingMarkerCache(
  tracker: UsageTracker,
  agent: string,
  startIso: string,
  endIso: string,
): { read: number; write: number } {
  const row = tracker
    .getDatabase()
    .prepare(
      `SELECT COALESCE(SUM(cache_read_tokens), 0) AS read,
              COALESCE(SUM(cache_creation_tokens), 0) AS write
         FROM usage_events
        WHERE agent = ?
          AND session_id = ?
          AND timestamp >= ?
          AND timestamp < ?`,
    )
    .get(agent, MARKER_SESSION_ID, startIso, endIso) as
    | { read: number; write: number }
    | undefined;
  return { read: row?.read ?? 0, write: row?.write ?? 0 };
}

function fmt(n: number): string {
  return Math.round(n).toLocaleString("en-US");
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const now = new Date();
  const { startIso, endIso } = pacificDayRangeUtc(now);

  const traceStore = new TraceStore(args.tracesDb);
  const tracker = new UsageTracker(args.usageDb);

  try {
    // 1. Trace-store cache totals for today's PT window (the source of truth
    //    for what the cache halves SHOULD sum to).
    const tel = traceStore.getCacheTelemetry(args.agent, startIso);
    const traceReads = tel.totalCacheReads;
    const traceWrites = tel.totalCacheWrites;

    // 2. What usage_events already holds for the window. Subtract any prior
    //    marker row so we measure the REAL captured cache (post-restart turns,
    //    if the daemon was already running new code) and never double-count.
    const windowAgg = tracker.getUsageInRange(startIso, endIso);
    const marker = existingMarkerCache(tracker, args.agent, startIso, endIso);
    const realReads = Math.max(0, windowAgg.cache_read_tokens - marker.read);
    const realWrites = Math.max(0, windowAgg.cache_creation_tokens - marker.write);

    // 3. Adjustment = trace total − already-captured-real. Never negative.
    const adjReads = Math.max(0, traceReads - realReads);
    const adjWrites = Math.max(0, traceWrites - realWrites);

    console.log("─".repeat(64));
    console.log(`backfill-usage-cache-tokens · agent=${args.agent}`);
    console.log(`PT window (UTC): ${startIso}  →  ${endIso}`);
    console.log("─".repeat(64));
    console.log(`trace.db cache_read    (today): ${fmt(traceReads)}`);
    console.log(`trace.db cache_write   (today): ${fmt(traceWrites)}`);
    console.log(`usage.db real cache_read  (ex-marker): ${fmt(realReads)}`);
    console.log(`usage.db real cache_write (ex-marker): ${fmt(realWrites)}`);
    console.log(`existing marker row  read/write: ${fmt(marker.read)} / ${fmt(marker.write)}`);
    console.log("─".repeat(64));
    console.log(`ADJUSTMENT to insert  read/write: ${fmt(adjReads)} / ${fmt(adjWrites)}`);
    console.log(
      "caveat: trace sums cover only turns with input_tokens > 0 → may marginally UNDER-count (never over).",
    );
    console.log("─".repeat(64));

    if (!args.apply) {
      console.log("DRY RUN — no usage rows written. Re-run with --apply to commit.");
      return;
    }

    if (adjReads === 0 && adjWrites === 0) {
      console.log("APPLY: adjustment is zero — nothing to write (data already correct).");
      // Still clear any stale marker so the state is clean.
    }

    // 4. Atomic replace: drop any prior marker row in-window, then insert the
    //    fresh adjustment. Tagged so it is reversible + idempotent.
    const db = tracker.getDatabase();
    const tx = db.transaction(() => {
      db.prepare(
        `DELETE FROM usage_events
          WHERE agent = ? AND session_id = ? AND timestamp >= ? AND timestamp < ?`,
      ).run(args.agent, MARKER_SESSION_ID, startIso, endIso);

      if (adjReads > 0 || adjWrites > 0) {
        tracker.record({
          agent: args.agent,
          timestamp: now.toISOString(),
          tokens_in: 0,
          tokens_out: 0,
          cost_usd: 0,
          turns: 0,
          model: MARKER_MODEL,
          duration_ms: 0,
          session_id: MARKER_SESSION_ID,
          cache_read_tokens: adjReads,
          cache_creation_tokens: adjWrites,
        });
      }
    });
    tx();

    const after = tracker.getUsageInRange(startIso, endIso);
    console.log(
      `APPLIED. usage.db window cache now read/write: ${fmt(after.cache_read_tokens)} / ${fmt(after.cache_creation_tokens)}`,
    );
    console.log(`undo: DELETE FROM usage_events WHERE session_id = '${MARKER_SESSION_ID}';`);
  } finally {
    // TraceStore/UsageTracker hold better-sqlite3 handles; close so the WAL is
    // checkpointed before the daemon reopens the file.
    (traceStore as unknown as { close?: () => void }).close?.();
    (tracker as unknown as { close?: () => void }).close?.();
  }
}

main().catch((err) => {
  console.error("backfill failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
