import type { Database as DatabaseType, Statement } from "better-sqlite3";

/**
 * Phase 117 Plan 117-11 — SQLite-backed per-channel verbose-level state.
 *
 * Drives the level-aware advisor visibility seam in `src/discord/bridge.ts`
 * (the single mutation point seeded by Plan 117-09 at ~:809). When the
 * channel is `"verbose"` AND the advisor result is `advisor_result`, the
 * bridge replaces the plain footer with a fenced advice block. Default
 * level `"normal"` falls through to the 💭 reaction + plain footer.
 *
 * Shape mirrors RESEARCH §4.1 verbatim; pattern reference is
 * `src/usage/advisor-budget.ts:1–92` (prepared statements, sync API,
 * constructor-time table creation). Daemon boot owns the backing file
 * path — `~/.clawcode/manager/verbose-state.db` (separate file from
 * advisor-budget.db per RESEARCH §6 Pitfall 4 + §7 Q2 RESOLVED).
 */

export type VerboseLevel = "normal" | "verbose";

export type VerboseStatus = {
  readonly channelId: string;
  readonly level: VerboseLevel;
  readonly updatedAt: string; // ISO 8601 or placeholder for never-set rows
};

/** Prepared statements for verbose-state operations. */
type Statements = {
  readonly getRow: Statement;
  readonly upsert: Statement;
};

/** Raw row from the verbose_channels table. */
type Row = {
  readonly channel_id: string;
  readonly level: string;
  readonly updated_at: string;
};

/**
 * VerboseState — SQLite-backed channel-level verbose toggle.
 *
 * Synchronous (better-sqlite3). One row per channel; default `"normal"` is
 * implicit (no row → no override). `setLevel` is an upsert keyed on
 * `channel_id`; row count never grows past distinct-channel-with-override.
 */
export class VerboseState {
  private readonly stmts: Statements;

  constructor(db: DatabaseType) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS verbose_channels (
        channel_id TEXT PRIMARY KEY,
        level TEXT NOT NULL DEFAULT 'normal',
        updated_at TEXT NOT NULL
      );
    `);
    this.stmts = {
      getRow: db.prepare(
        "SELECT channel_id, level, updated_at FROM verbose_channels WHERE channel_id = ?",
      ),
      upsert: db.prepare(`
        INSERT INTO verbose_channels (channel_id, level, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT (channel_id) DO UPDATE SET
          level = excluded.level,
          updated_at = excluded.updated_at
      `),
    };
  }

  /**
   * Returns the channel's level. Defaults to `"normal"` when no row exists.
   * Defensive: any unrecognized stored value is coerced to `"normal"`.
   */
  getLevel(channelId: string): VerboseLevel {
    const row = this.stmts.getRow.get(channelId) as Row | undefined;
    if (!row) return "normal";
    return row.level === "verbose" ? "verbose" : "normal";
  }

  /**
   * Upsert the channel's level. `updated_at` set to `new Date().toISOString()`.
   */
  setLevel(channelId: string, level: VerboseLevel): void {
    this.stmts.upsert.run(channelId, level, new Date().toISOString());
  }

  /**
   * Returns `{channelId, level, updatedAt}`. When no row exists for the
   * channel, `level` is the `"normal"` default and `updatedAt` is the
   * sentinel `"(never set — using default)"` so the `/clawcode-verbose
   * level:status` reply can disambiguate "explicitly set normal" vs
   * "never touched".
   */
  getStatus(channelId: string): VerboseStatus {
    const row = this.stmts.getRow.get(channelId) as Row | undefined;
    if (!row) {
      return {
        channelId,
        level: "normal",
        updatedAt: "(never set — using default)",
      };
    }
    return {
      channelId: row.channel_id,
      level: row.level === "verbose" ? "verbose" : "normal",
      updatedAt: row.updated_at,
    };
  }
}
