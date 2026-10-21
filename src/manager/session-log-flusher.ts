/**
 * Daily-session-log flusher (2026-06-18).
 *
 * Materialises the per-day `<memoryDir>/YYYY-MM-DD.md` daily session logs from
 * the authoritative ConversationStore, DECOUPLED from compaction.
 *
 * WHY: daily session logs are the INPUT to memory consolidation
 * (`detectUnconsolidatedWeeks` scans `<memoryDir>/YYYY-MM-DD.md`). Historically
 * they were written only as a side effect of daemon compaction
 * (`CompactionManager.flushBeforeCompact → SessionLogger.flushConversation`),
 * which auto-fires from the context-fill heartbeat check at
 * `fill >= autoCompactAt` (~0.7). The SDK-session fleet reports ~0% daemon-side
 * fill (the SDK manages context; resumes keep the daemon ConversationStore
 * small), so that compaction never fires — daily logs stopped being written
 * (last ones Feb/March) and consolidation has been starved of input ever since.
 *
 * This module appends NEW turns (cursor-gated, exactly-once) from the
 * ConversationStore into the daily log on a cadence owned by the heartbeat —
 * independent of whether compaction ever fires.
 *
 * NOT recorded into the `session_logs` table here: consolidation detects logs
 * by scanning files (`readdirSync`), not that table, and `recordSessionLog`
 * INSERTs a fresh row per call (no upsert) — calling it every tick would create
 * duplicate rows. The daily-log FILE is the contract; `session_logs` stays a
 * compaction-owned tracker.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Minimal turn shape the flusher needs (subset of ConversationTurn). */
export type FlushableTurn = {
  readonly role: string;
  readonly content: string;
  readonly createdAt: string;
};

export type SessionLogFlushDeps = {
  /** Active ConversationStore session id; undefined → nothing to flush. */
  readonly activeSessionId: string | undefined;
  /** Reads all turns for a session (ConversationStore.getTurnsForSession). */
  readonly getTurns: (sessionId: string) => readonly FlushableTurn[];
  /** Appends one entry to the daily log (SessionLogger.appendEntry). */
  readonly appendEntry: (
    timestamp: string,
    role: "user" | "assistant",
    content: string,
  ) => Promise<void>;
  /** Directory holding the daily logs + the flush cursor file. */
  readonly memoryDir: string;
  /** DI override for tests (defaults to the fs cursor reader). */
  readonly readCursor?: (memoryDir: string) => string | null;
  /** DI override for tests (defaults to the fs cursor writer). */
  readonly writeCursor?: (memoryDir: string, iso: string) => void;
};

export type SessionLogFlushResult = {
  readonly flushed: number;
  readonly dates: readonly string[];
};

/** Cursor filename — the ISO timestamp of the last turn already flushed. */
export const CURSOR_FILENAME = ".session-log-cursor";

/** Read the last-flushed ISO timestamp, or null if absent/unreadable. */
export function readSessionLogCursor(memoryDir: string): string | null {
  try {
    const p = join(memoryDir, CURSOR_FILENAME);
    if (!existsSync(p)) return null;
    const raw = readFileSync(p, "utf-8").trim();
    return raw.length > 0 ? raw : null;
  } catch {
    return null;
  }
}

/** Persist the last-flushed ISO timestamp. */
export function writeSessionLogCursor(memoryDir: string, iso: string): void {
  writeFileSync(join(memoryDir, CURSOR_FILENAME), iso, "utf-8");
}

/**
 * Append every conversation turn newer than the cursor into the daily log,
 * then advance the cursor to the newest flushed turn. Idempotent across ticks
 * (cursor-gated) and across restarts (cursor persisted on disk).
 *
 * Only `user` / `assistant` turns are logged (system turns are excluded, matching
 * the compaction flush path). Turns are sorted by `createdAt` so the daily log
 * is chronological even if the store returns them otherwise.
 */
export async function flushNewTurnsToSessionLog(
  deps: SessionLogFlushDeps,
): Promise<SessionLogFlushResult> {
  if (!deps.activeSessionId) return { flushed: 0, dates: [] };

  const readCursor = deps.readCursor ?? readSessionLogCursor;
  const writeCursor = deps.writeCursor ?? writeSessionLogCursor;

  const turns = deps
    .getTurns(deps.activeSessionId)
    .filter((t) => t.role === "user" || t.role === "assistant");
  if (turns.length === 0) return { flushed: 0, dates: [] };

  const cursor = readCursor(deps.memoryDir);
  const cursorMs = cursor ? Date.parse(cursor) : 0;

  const newTurns = turns
    .filter((t) => {
      const ms = Date.parse(t.createdAt);
      return Number.isFinite(ms) && ms > cursorMs;
    })
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  if (newTurns.length === 0) return { flushed: 0, dates: [] };

  const dates = new Set<string>();
  for (const t of newTurns) {
    await deps.appendEntry(
      t.createdAt,
      t.role === "user" ? "user" : "assistant",
      t.content,
    );
    dates.add(t.createdAt.slice(0, 10));
  }

  writeCursor(deps.memoryDir, newTurns[newTurns.length - 1]!.createdAt);

  return { flushed: newTurns.length, dates: [...dates] };
}
