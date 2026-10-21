import type { Database as DatabaseType } from "better-sqlite3";

/**
 * Phase 115 D-08 — embedding-v2 migration state machine.
 *
 * Phases (transitions are operator-driven via the
 * `clawcode memory migrate-embeddings` CLI subcommands):
 *
 *  1. `idle`              — no migration in progress; reads/writes use v1 only.
 *                           Initial state for any agent that hasn't been
 *                           started yet.
 *  2. `dual-write`        — T+0 → T+7d. New writes embed BOTH v1 (MiniLM) and
 *                           v2 (bge-small-int8). Reads still use v1.
 *  3. `re-embedding`      — T+7d → T+14d. Background batch re-embed of
 *                           historical memories at 5% CPU when daemon idle.
 *                           Resumable across daemon restarts via `last_cursor`.
 *  4. `re-embed-complete` — T+14d. All historical embeddings have v2
 *                           vectors. Ready for cutover; reads still v1.
 *  5. `cutover`           — Reads switch to v2; v1 column kept for 24h soak.
 *  6. `v1-dropped`        — v1 column dropped (post-24h-soak); migration
 *                           complete.
 *  7. `rolled-back`       — emergency rollback to phase 1; v2 reads disabled.
 *                           v2 column data is PRESERVED for re-attempt
 *                           (operator can flip back to dual-write to resume).
 *
 * Transition validity matrix (operator must use legal transitions):
 *   idle              -> dual-write | rolled-back
 *   dual-write        -> re-embedding | rolled-back
 *   re-embedding      -> re-embed-complete | rolled-back | dual-write (retry)
 *   re-embed-complete -> cutover | rolled-back
 *   cutover           -> v1-dropped | rolled-back
 *   v1-dropped        -> (terminal)
 *   rolled-back       -> dual-write (retry from start)
 *
 * Storage: per-agent `migrations` table in the agent's memories.db. The
 * migration `key` is `embeddingV2` (the agent prefix is implicit because
 * the DB IS per-agent). One row per agent.
 *
 * Per Phase 90 lock: every per-agent migration step is its own
 * `db.transaction()` against the agent's per-agent SQLite file. No
 * shared state. Migrator instances are per-agent.
 *
 * Per Phase 99-A lock: migration code MUST resolve agent DB paths via
 * `getAgentMemoryDbPath` in `shared/agent-paths.ts` (CI grep regression
 * pin). The migrator itself doesn't open DBs — it operates on a Database
 * instance the caller hands in.
 */

/** Phase identifiers — STATE MACHINE PHASES (Phase 115 D-08). */
export type EmbeddingMigrationPhase =
  | "idle"
  | "dual-write"
  | "re-embedding"
  | "re-embed-complete"
  | "cutover"
  | "v1-dropped"
  | "rolled-back";

/** All legal phase values, exposed for runtime validation. */
export const EMBEDDING_MIGRATION_PHASES: ReadonlyArray<EmbeddingMigrationPhase> =
  Object.freeze([
    "idle",
    "dual-write",
    "re-embedding",
    "re-embed-complete",
    "cutover",
    "v1-dropped",
    "rolled-back",
  ]);

/**
 * Snapshot of one agent's migration state. Returned by `getState()` and
 * mirrored over the IPC boundary by the daemon-side handler.
 */
export interface EmbeddingMigrationState {
  readonly key: string;
  readonly phase: EmbeddingMigrationPhase;
  readonly progressProcessed: number;
  readonly progressTotal: number;
  readonly lastCursor: string | null;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly metadata: string | null;
}

/**
 * Legal next-phase transitions. The migrator enforces these in
 * `transition()`; an illegal transition throws (operator-facing CLI
 * surfaces the error message).
 */
const LEGAL_TRANSITIONS: Readonly<
  Record<EmbeddingMigrationPhase, ReadonlyArray<EmbeddingMigrationPhase>>
> = Object.freeze({
  idle: Object.freeze<EmbeddingMigrationPhase[]>([
    "dual-write",
    "rolled-back",
  ]),
  "dual-write": Object.freeze<EmbeddingMigrationPhase[]>([
    "re-embedding",
    "rolled-back",
  ]),
  "re-embedding": Object.freeze<EmbeddingMigrationPhase[]>([
    "re-embed-complete",
    "rolled-back",
    "dual-write",
  ]),
  "re-embed-complete": Object.freeze<EmbeddingMigrationPhase[]>([
    "cutover",
    "rolled-back",
  ]),
  cutover: Object.freeze<EmbeddingMigrationPhase[]>([
    "v1-dropped",
    "rolled-back",
  ]),
  // Phase 999.119 pass 2 (2026-09-05) — `v1-dropped` was terminal, but the
  // phase name was never true in production: no read path ever switched to
  // v2 (SemanticSearch / searchMemoriesVec / the linker / tier-manager all
  // read `vec_memories`), and every "v1-dropped" agent still carried a
  // complete v1 table with v2 only 15–25 % full. Rolling back is the honest
  // state. `transition()` guards it: the v1 table must actually hold rows.
  "v1-dropped": Object.freeze<EmbeddingMigrationPhase[]>(["rolled-back"]),
  "rolled-back": Object.freeze<EmbeddingMigrationPhase[]>(["dual-write"]),
});

/** Default key (single migration per per-agent DB). */
const MIGRATION_KEY = "embeddingV2";

/**
 * Per-agent migration state machine.
 *
 * Constructed with the agent's `Database` instance + agent name (only used
 * for log breadcrumbs / IPC metadata; the DB IS per-agent so all queries
 * are implicitly scoped). All public methods are synchronous because
 * better-sqlite3 is synchronous.
 *
 * Used by:
 *   - The IPC handlers in `daemon.ts` (start / pause / resume / status /
 *     force-cutover / rollback).
 *   - The heartbeat-driven batch runner in `embedding-v2-runner.ts` to
 *     determine `currentReadVersion` / `currentWriteVersions` for the
 *     dual-write hook + the runner's "should we be processing?" guard.
 */
export class EmbeddingV2Migrator {
  private readonly db: DatabaseType;
  private readonly agentName: string;
  private readonly key: string;

  constructor(db: DatabaseType, agentName: string) {
    this.db = db;
    this.agentName = agentName;
    this.key = MIGRATION_KEY;
  }

  /** Agent name (for log breadcrumbs / IPC). */
  get agent(): string {
    return this.agentName;
  }

  /**
   * Read the current migration state from the per-agent `migrations`
   * table. Returns a frozen snapshot. If no row exists for this agent
   * (initial state) returns a synthetic `idle` state — the row is
   * lazily created on first `transition()` call to avoid populating
   * the table for every agent that never starts a migration.
   */
  getState(): EmbeddingMigrationState {
    const row = this.db
      .prepare(
        `SELECT key, phase, progress_processed, progress_total, last_cursor,
                started_at, completed_at, metadata
         FROM migrations WHERE key = ?`,
      )
      .get(this.key) as
      | {
          key: string;
          phase: string;
          progress_processed: number;
          progress_total: number;
          last_cursor: string | null;
          started_at: string | null;
          completed_at: string | null;
          metadata: string | null;
        }
      | undefined;

    if (!row) {
      return Object.freeze({
        key: this.key,
        phase: "idle" as const,
        progressProcessed: 0,
        progressTotal: 0,
        lastCursor: null,
        startedAt: null,
        completedAt: null,
        metadata: null,
      });
    }

    return Object.freeze({
      key: row.key,
      phase: row.phase as EmbeddingMigrationPhase,
      progressProcessed: row.progress_processed,
      progressTotal: row.progress_total,
      lastCursor: row.last_cursor,
      startedAt: row.started_at,
      completedAt: row.completed_at,
      metadata: row.metadata,
    });
  }

  /**
   * Move the migration to a new phase. Validates the transition against
   * `LEGAL_TRANSITIONS`; throws if illegal. Stamps `started_at` on the
   * first transition (out of `idle`), `completed_at` on transition into
   * `v1-dropped` or `rolled-back`.
   *
   * On transition INTO `dual-write` from `idle` (or `rolled-back`),
   * resets `progress_processed` to 0 so the runner re-counts work. On
   * transition INTO `rolled-back`, KEEPS `progress_processed` so a
   * re-attempt's dashboard shows where the previous attempt got to.
   *
   * Throws if the transition is illegal — operator-facing CLI surfaces
   * the error message.
   *
   * @param toPhase target phase
   * @param progressTotal optional initial total to set on transition
   *                      INTO `re-embedding` (typically the result of
   *                      `MemoryStore.countMemoriesMissingV2Embedding()`).
   */
  transition(
    toPhase: EmbeddingMigrationPhase,
    progressTotal?: number,
  ): void {
    const current = this.getState();
    const legalNext = LEGAL_TRANSITIONS[current.phase];
    if (!legalNext.includes(toPhase)) {
      throw new Error(
        `Illegal embedding-v2 migration transition: ${current.phase} -> ${toPhase} ` +
          `(legal targets from ${current.phase}: ${legalNext.length === 0 ? "(terminal)" : legalNext.join(", ")})`,
      );
    }
    // Phase 999.119 pass 2 — leaving `v1-dropped` for v1 reads is only safe
    // when the v1 vectors are actually still there.
    if (current.phase === "v1-dropped" && toPhase === "rolled-back") {
      const v1Rows = (
        this.db.prepare("SELECT COUNT(*) AS n FROM vec_memories").get() as { n: number }
      ).n;
      if (v1Rows === 0) {
        throw new Error(
          `Refusing embedding-v2 rollback for ${this.agent}: vec_memories is empty, ` +
            "so v1 reads would find nothing — re-embed v1 first",
        );
      }
    }

    const now = new Date().toISOString();
    this.db.transaction(() => {
      // Lazy-init the row if it doesn't exist (first transition out of idle).
      if (current.phase === "idle" && !this.rowExists()) {
        this.db
          .prepare(
            `INSERT INTO migrations (key, phase, progress_processed, progress_total, last_cursor, started_at, completed_at, metadata)
             VALUES (?, ?, 0, 0, NULL, ?, NULL, NULL)`,
          )
          .run(this.key, toPhase, now);
      } else {
        // Update existing row.
        const isStartOfWork = toPhase === "dual-write" && (current.phase === "idle" || current.phase === "rolled-back");
        const isReEmbedStart = toPhase === "re-embedding";
        const isCompletion = toPhase === "v1-dropped" || toPhase === "rolled-back";

        // Upsert phase + conditional resets/stamps.
        const newProgressProcessed = isStartOfWork ? 0 : current.progressProcessed;
        const newProgressTotal =
          isReEmbedStart && progressTotal !== undefined
            ? progressTotal
            : isStartOfWork
              ? 0
              : current.progressTotal;
        const newCompletedAt = isCompletion ? now : current.completedAt;
        const newStartedAt = current.startedAt ?? now;

        this.db
          .prepare(
            `INSERT INTO migrations
              (key, phase, progress_processed, progress_total, last_cursor, started_at, completed_at, metadata)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(key) DO UPDATE SET
               phase = excluded.phase,
               progress_processed = excluded.progress_processed,
               progress_total = excluded.progress_total,
               last_cursor = excluded.last_cursor,
               started_at = excluded.started_at,
               completed_at = excluded.completed_at,
               metadata = excluded.metadata`,
          )
          .run(
            this.key,
            toPhase,
            newProgressProcessed,
            newProgressTotal,
            isStartOfWork ? null : current.lastCursor,
            newStartedAt,
            newCompletedAt,
            current.metadata,
          );
      }
    })();
  }

  /**
   * Update `last_cursor` + `progress_processed`. Called by the batch
   * runner after each successful batch to make resume across daemon
   * restarts correct. progressProcessed is monotonic increasing — the
   * runner passes the cumulative count, NOT a delta.
   *
   * Phase guard: silently no-op if the migration is not in a phase
   * where re-embed work is happening (`dual-write`, `re-embedding`,
   * `re-embed-complete`). Saves the runner from having to know about
   * legal phases.
   */
  saveCursor(memoryId: string, processedCumulative: number): void {
    const current = this.getState();
    if (
      // Phase 999.119 v2 switch — the runner stays live through cutover so
      // a dual-write miss heals; its cursor bookkeeping must follow.
      current.phase !== "dual-write" &&
      current.phase !== "re-embedding" &&
      current.phase !== "re-embed-complete" &&
      current.phase !== "cutover"
    ) {
      // Operator has paused / cutover / rolled back since the runner
      // started this batch — drop the cursor write silently.
      return;
    }
    this.db
      .prepare(
        `UPDATE migrations SET last_cursor = ?, progress_processed = ? WHERE key = ?`,
      )
      .run(memoryId, processedCumulative, this.key);
  }

  /**
   * Update `progress_total`. Called once at start of `re-embedding`
   * phase by the runner (or whoever has the
   * `MemoryStore.countMemoriesMissingV2Embedding()` count). Idempotent.
   */
  setProgressTotal(total: number): void {
    this.db
      .prepare(`UPDATE migrations SET progress_total = ? WHERE key = ?`)
      .run(total, this.key);
  }

  /**
   * 116-postdeploy 2026-05-13 — reset `last_cursor` to NULL so the next
   * batch starts scanning from the beginning of the memories table again.
   *
   * Why this exists: memory IDs are nanoid-generated (random ordering, NOT
   * monotonic). The runner's batch query filters `id > last_cursor`, so if
   * the cursor advances past the lexicographic position of subsequent
   * inserts, those entries become invisible to the runner — it returns
   * `batch.length === 0` forever while `countMemoriesMissingV2Embedding()`
   * still reports the orphan rows. Production bug 2026-05-13:
   * fin-client stuck at 1407/1408 (then 1407/1415 as new memories
   * landed behind the cursor) for ~5 days.
   *
   * Distinct from `saveCursor(id, n)` which only writes a non-null id.
   * Optionally updates `progress_total` so the dashboard's percent display
   * snaps to a meaningful denominator after the reset (the original total
   * was set once at re-embedding entry and never tracks new inserts).
   *
   * Same phase guard as `saveCursor` — no-ops outside working phases so a
   * concurrent pause/cutover/rollback can't be steamrolled by a stale
   * runner tick that started before the operator's transition landed.
   */
  resetCursor(opts?: { readonly newProgressTotal?: number }): void {
    const current = this.getState();
    if (
      // Phase 999.119 v2 switch — the runner stays live through cutover so
      // a dual-write miss heals; its cursor bookkeeping must follow.
      current.phase !== "dual-write" &&
      current.phase !== "re-embedding" &&
      current.phase !== "re-embed-complete" &&
      current.phase !== "cutover"
    ) {
      return;
    }
    if (typeof opts?.newProgressTotal === "number") {
      this.db
        .prepare(
          `UPDATE migrations SET last_cursor = NULL, progress_total = ? WHERE key = ?`,
        )
        .run(opts.newProgressTotal, this.key);
    } else {
      this.db
        .prepare(`UPDATE migrations SET last_cursor = NULL WHERE key = ?`)
        .run(this.key);
    }
  }

  /**
   * Phase 115 D-08 — current READ version selection logic. Used by the
   * retrieval path (memory-retrieval.ts in a future plan-115-09) to
   * route KNN queries to vec_memories or vec_memories_v2.
   *
   * Returns "v2" only post-cutover. All earlier phases (including
   * dual-write + re-embedding) read v1 — the v2 vectors are written
   * but not yet trusted for retrieval until cutover.
   */
  currentReadVersion(): "v1" | "v2" {
    const phase = this.getState().phase;
    return phase === "cutover" || phase === "v1-dropped" ? "v2" : "v1";
  }

  /**
   * Phase 115 D-08 — current WRITE version(s). Returns a frozen array
   * because dual-write + re-embedding write to BOTH v1 and v2.
   *
   *   idle / rolled-back              -> ["v1"]
   *   dual-write / re-embedding /
   *   re-embed-complete               -> ["v1", "v2"]
   *   cutover / v1-dropped            -> ["v2"]
   */
  currentWriteVersions(): ReadonlyArray<"v1" | "v2"> {
    const phase = this.getState().phase;
    switch (phase) {
      case "idle":
      case "rolled-back":
        return Object.freeze(["v1" as const]);
      case "dual-write":
      case "re-embedding":
      case "re-embed-complete":
        return Object.freeze(["v1" as const, "v2" as const]);
      case "cutover":
      case "v1-dropped":
        return Object.freeze(["v2" as const]);
    }
  }

  /**
   * Convenience predicate — used by the runner to decide whether to
   * process this agent at all.
   */
  shouldRunReEmbedBatch(): boolean {
    // Phase 999.119 v2 switch — every phase that writes v2. The runner is
    // a no-op once nothing is missing, so staying live through `cutover`
    // lets a dual-write miss heal itself within one cron tick.
    const phase = this.getState().phase;
    return (
      phase === "dual-write" ||
      phase === "re-embedding" ||
      phase === "re-embed-complete" ||
      phase === "cutover"
    );
  }

  private rowExists(): boolean {
    const row = this.db
      .prepare(`SELECT 1 FROM migrations WHERE key = ?`)
      .get(this.key);
    return row !== undefined;
  }
}
