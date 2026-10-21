/**
 * Phase 91 Plan 03 — OpenClaw session jsonl → ClawCode ConversationStore
 * translator (SYNC-04).
 *
 * Reads `*.jsonl` session files produced by OpenClaw's fin-client agent
 * (one event per line, shape documented below) and re-materializes the
 * user/assistant TEXT turns into ClawCode's conversation_sessions +
 * conversation_turns tables. Runs hourly from its own systemd timer —
 * distinct unit from Plan 91-01's 5-minute workspace rsync timer.
 *
 * ---------------------------------------------------------------------------
 * OpenClaw session.jsonl format (verified against
 * `~/.openclaw/agents/fin-client/sessions/*.jsonl`)
 * ---------------------------------------------------------------------------
 *
 *   First line — session header (capture `id`, skip):
 *     {"type":"session","version":3,"id":"<uuid>","timestamp":"...","cwd":"..."}
 *
 *   Message lines — translate IFF role ∈ {user, assistant}:
 *     {"type":"message","id":"...","parentId":"...","timestamp":"...",
 *      "message":{"role":"user","content":[{"type":"text","text":"..."}]}}
 *     {"type":"message","message":{"role":"assistant",
 *      "content":[{"type":"text","text":"..."},{"type":"tool_use",...}]}}
 *
 *   Other event types — always skip (counted as turnsSkippedNonText):
 *     {"type":"model_change",...}
 *     {"type":"thinking_level_change",...}
 *     {"type":"custom","customType":"model-snapshot",...}
 *     {"type":"custom","customType":"openclaw.cache-ttl",...}
 *
 * ---------------------------------------------------------------------------
 * Idempotency (D-09 adaptation)
 * ---------------------------------------------------------------------------
 *
 * Phase 80's memory-translator uses `origin_id UNIQUE` on the `memories`
 * table. The `conversation_turns` table in ClawCode does NOT carry an
 * origin_id column, but has a UNIQUE index on `(session_id, turn_index,
 * role)` — `idx_turns_session_order` in store.ts:725. That composite key is
 * a NATURAL idempotency gate, so the translator uses it directly via
 * `INSERT OR IGNORE` against the raw sqlite handle exposed by
 * `ConversationStore.getDatabase()`.
 *
 * The `origin_id` string is still computed (shape:
 * `openclaw-session-<sha256(sessionId:turnIndex)-prefix16>`) and STORED in
 * the `origin` column so operators can trace a ClawCode turn back to its
 * OpenClaw source. On a second run, the UNIQUE constraint fires for every
 * already-imported (session_id, turn_index, role) triple and `changes === 0`
 * signals the duplicate — we count it in `turnsSkippedDuplicate`.
 *
 * We ALSO derive a deterministic conversation_sessions.id from the
 * OpenClaw session id (prefix + hash) so re-running the translator against
 * the same file hits the same session row (not a new one every cycle).
 *
 * ---------------------------------------------------------------------------
 * Mid-write protection (D-06)
 * ---------------------------------------------------------------------------
 *
 * If a jsonl file's `mtimeMs` is within 60 seconds of `now`, the file is
 * SKIPPED for this cycle — OpenClaw is likely still appending and a half-
 * written final line would otherwise trigger a JSON parse error. The next
 * hourly cycle retries.
 *
 * ---------------------------------------------------------------------------
 * Content scope (D-08)
 * ---------------------------------------------------------------------------
 *
 * Only `{type: "text", text: "..."}` blocks within role=user|assistant
 * messages are preserved. `tool_use`, `tool_result`, `thinking`,
 * `model-snapshot`, `openclaw.cache-ttl`, session headers, model_change /
 * thinking_level_change events are ALL dropped. Fin-client sessions
 * contain 500+ tool-call blocks each; storing them would bloat the DB
 * without aiding semantic recall.
 *
 * ---------------------------------------------------------------------------
 * Graceful degradation (D-10)
 * ---------------------------------------------------------------------------
 *
 * A single malformed JSONL line logs + skips that line; subsequent lines in
 * the same file are still processed. A file-level I/O error (unreadable,
 * disappeared mid-scan) logs + skips that file entirely; other files in the
 * directory proceed. The whole run NEVER throws — failures are counted in
 * the TranslatorRunOutcome so the caller (hourly systemd job) can log a
 * summary line.
 *
 * ---------------------------------------------------------------------------
 * Remote-to-local staging
 * ---------------------------------------------------------------------------
 *
 * OpenClaw session files live on `10.0.0.3` under
 * `~/.openclaw/agents/fin-client/sessions/`. This module reads a LOCAL
 * directory (DI'd via `sessionsDir`). The systemd wrapper script
 * (scripts/sync/clawcode-translator.sh) rsyncs the remote sessions dir to
 * a local staging path (`~/.clawcode/manager/openclaw-sessions-staging/`)
 * BEFORE invoking the translator — keeps the translator pure and testable
 * without SSH, reuses the 91-01 SSH infrastructure for transport.
 */

import { readFile, stat, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, basename } from "node:path";
import type { Logger } from "pino";
import type { ConversationStore } from "../memory/conversation-store.js";
import {
  readTranslatorCursor,
  writeTranslatorCursor,
  type TranslatorCursorFile,
  type PerFileCursorEntry,
} from "./translator-cursor-store.js";

/** D-06 — skip files whose mtime is within 60s of now (OpenClaw still writing). */
export const MID_WRITE_SKIP_MS = 60_000;

/** sha256 hex digest of a UTF-8 string (identical helper to Phase 80 memory-translator). */
export function sha256Hex(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

/**
 * D-09 origin_id shape:
 *   openclaw-session-<sha256(sessionId:turnIndex)-prefix16>
 *
 * Deterministic, prefix-16 for readability. Stored in the `origin` column of
 * conversation_turns; the true idempotency gate is the UNIQUE
 * (session_id, turn_index, role) constraint on `conversation_turns` —
 * origin_id is for human traceability, not UNIQUE enforcement.
 */
export function computeTurnOriginId(
  sessionId: string,
  turnIndex: number,
): string {
  const hashInput = `${sessionId}:${turnIndex}`;
  return `openclaw-session-${sha256Hex(hashInput).slice(0, 16)}`;
}

/**
 * Compute a deterministic ClawCode `conversation_sessions.id` from the
 * OpenClaw session uuid so re-running the translator lands in the same
 * session row rather than proliferating fresh rows.
 *
 * Prefix `openclaw-` plus first 20 hex chars of sha256(sessionId). Stays well
 * under nanoid()'s 21-char default so rows coexist in the same id column
 * without collision risk.
 */
export function computeClawcodeSessionId(openclawSessionId: string): string {
  return `openclaw-${sha256Hex(openclawSessionId).slice(0, 20)}`;
}

/**
 * Discriminated outcome shape returned by `translateAllSessions`. All fields
 * are counts so the CLI (Plan 91-04) can render a single-line summary.
 */
export type TranslatorRunOutcome = Readonly<{
  sessionsScanned: number;
  sessionsSkippedMidWrite: number;
  sessionsSkippedParseError: number;
  turnsInserted: number;
  turnsSkippedDuplicate: number;
  turnsSkippedNonText: number;
  durationMs: number;
}>;

/**
 * Deps injected into the translator — pure-function DI (project convention
 * from Phase 85). Caller (Plan 91-04 CLI) constructs ConversationStore
 * against the agent's memories.db and passes it here.
 */
export type TranslatorDeps = Readonly<{
  sessionsDir: string;
  conversationStore: ConversationStore;
  cursorPath: string;
  agentName: string;
  now?: () => Date;
  log: Logger;
}>;

/**
 * Extract the translatable text from a message.content payload.
 *
 * OpenClaw stores `content` as EITHER a plain string OR an array of blocks
 * `{type, text | content | ...}`. We honour D-08: preserve only
 * `{type:"text", text:"..."}` and drop everything else (tool_use,
 * tool_result, thinking, custom block types).
 *
 * Empty or all-non-text payloads return "" — the caller uses that as the
 * "skip this message, it's not user-facing text" signal.
 */
export function extractTextContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (
      block &&
      typeof block === "object" &&
      (block as { type?: unknown }).type === "text"
    ) {
      const text = (block as { text?: unknown }).text;
      if (typeof text === "string") parts.push(text);
    }
    // D-08 — tool_use, tool_result, thinking, and unknown block types
    // are intentionally DROPPED from the translated content.
  }
  return parts.join("\n");
}

/**
 * Internal helper: idempotent insert of a `conversation_sessions` row keyed
 * by the deterministic ClawCode session id. Uses INSERT OR IGNORE on the
 * PRIMARY KEY so concurrent/repeated runs converge on one row.
 *
 * Returns `true` if the row was freshly inserted, `false` if it already
 * existed (idempotent skip).
 */
function ensureSessionRow(
  deps: TranslatorDeps,
  clawcodeSessionId: string,
  openclawSessionId: string,
  fallbackStartedAt: string,
): boolean {
  const db = deps.conversationStore.getDatabase();
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO conversation_sessions
       (id, agent_name, started_at, ended_at, turn_count, total_tokens,
        summary_memory_id, status)
     VALUES (?, ?, ?, ?, 0, 0, NULL, 'ended')`,
  );
  // Translator imports historical sessions — they are by definition already
  // terminated from OpenClaw's perspective. Status=ended so gap-check /
  // resume-brief logic (Phase 67 SESS-03) can see the import as a prior
  // terminated session rather than a dangling 'active' row.
  const result = stmt.run(
    clawcodeSessionId,
    deps.agentName,
    fallbackStartedAt,
    fallbackStartedAt, // ended_at = started_at; we don't know true end time
  );
  // Stash the OpenClaw id in a summary_memory_id tag? No — that column is a
  // FK. Operators can reverse-derive via computeClawcodeSessionId. The
  // origin_id on each turn also contains the session hash.
  void openclawSessionId;
  return result.changes > 0;
}

/**
 * Internal helper: idempotent insert of a single translated turn. Uses
 * `INSERT OR IGNORE` against the UNIQUE index
 * `idx_turns_session_order(session_id, turn_index, role)` so a repeat run
 * no-ops. Returns `true` if a fresh row was written, `false` if the row
 * already existed.
 *
 * The deterministic `origin` column value is `computeTurnOriginId(...)` —
 * lets operators trace a ClawCode turn back to its OpenClaw source.
 */
function tryInsertTurn(
  deps: TranslatorDeps,
  args: Readonly<{
    turnId: string;
    sessionId: string;
    turnIndex: number;
    role: "user" | "assistant";
    content: string;
    originId: string;
    createdAt: string;
  }>,
): boolean {
  const db = deps.conversationStore.getDatabase();
  try {
    const stmt = db.prepare(
      `INSERT OR IGNORE INTO conversation_turns
         (id, session_id, turn_index, role, content, token_count,
          channel_id, discord_user_id, discord_message_id,
          is_trusted_channel, origin, instruction_flags, created_at)
       VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, 1, ?, NULL, ?)`,
    );
    // is_trusted_channel=1 — OpenClaw sessions pre-cutover are the
    // authoritative agent memory; treat as trusted for retrieval. Untrusted
    // filtering in searchTurns (SEC-01) remains fully functional for
    // LIVE turns captured post-cutover.
    const result = stmt.run(
      args.turnId,
      args.sessionId,
      args.turnIndex,
      args.role,
      args.content,
      args.originId,
      args.createdAt,
    );
    return result.changes > 0;
  } catch (err) {
    deps.log.warn(
      { err, originId: args.originId },
      "translator: turn insert failed (non-blocking)",
    );
    return false;
  }
}

/**
 * Translate every `*.jsonl` file under `sessionsDir` that has new content
 * since the last cursor position. Returns a TranslatorRunOutcome summary.
 *
 * Contract:
 *   - Never throws — all failures (missing dir, unreadable file, bad JSON)
 *     are counted + logged and the run continues.
 *   - Idempotent — re-running against the same staged files inserts zero
 *     new rows (UNIQUE(session_id, turn_index, role) fires).
 *   - Files with mtime < now - 60s (D-06) are SKIPPED.
 *   - Only role=user|assistant text content reaches the store (D-08).
 *   - Cursor is persisted via atomic temp+rename AFTER all files are
 *     processed (one write per run — keeps tests deterministic).
 */
export async function translateAllSessions(
  deps: TranslatorDeps,
): Promise<TranslatorRunOutcome> {
  const startEpoch = Date.now();
  const nowDate = deps.now?.() ?? new Date();
  const nowMs = nowDate.getTime();
  const nowIso = nowDate.toISOString();

  const cursor = await readTranslatorCursor(deps.cursorPath, deps.log);

  let sessionsScanned = 0;
  let sessionsSkippedMidWrite = 0;
  let sessionsSkippedParseError = 0;
  let turnsInserted = 0;
  let turnsSkippedDuplicate = 0;
  let turnsSkippedNonText = 0;

  // Build the next cursor as an immutable snapshot of existing entries —
  // per-file updates accumulate into a new object.
  const nextPerFileCursor: Record<string, PerFileCursorEntry> = {
    ...cursor.perFileCursor,
  };

  let entries: string[];
  try {
    const names = await readdir(deps.sessionsDir);
    entries = names.filter((n) => n.endsWith(".jsonl"));
  } catch (err) {
    deps.log.warn(
      { err, sessionsDir: deps.sessionsDir },
      "translator: sessions dir unreadable; returning empty outcome",
    );
    return Object.freeze({
      sessionsScanned: 0,
      sessionsSkippedMidWrite: 0,
      sessionsSkippedParseError: 0,
      turnsInserted: 0,
      turnsSkippedDuplicate: 0,
      turnsSkippedNonText: 0,
      durationMs: Date.now() - startEpoch,
    });
  }

  for (const name of entries.sort()) {
    const absPath = join(deps.sessionsDir, name);

    let st;
    try {
      st = await stat(absPath);
    } catch {
      continue; // disappeared between readdir + stat — next cycle
    }
    if (!st.isFile()) continue;

    // D-06 — mid-write protection
    if (st.mtimeMs > nowMs - MID_WRITE_SKIP_MS) {
      sessionsSkippedMidWrite++;
      continue;
    }

    const existingCursor = cursor.perFileCursor[absPath];
    // Fast-path: size + mtime unchanged → file is unchanged since last run
    if (
      existingCursor &&
      existingCursor.fileSize === st.size &&
      existingCursor.mtime === st.mtime.toISOString()
    ) {
      continue;
    }

    sessionsScanned++;

    let raw: string;
    try {
      raw = await readFile(absPath, "utf8");
    } catch (err) {
      deps.log.warn(
        { err, absPath },
        "translator: file read failed; skipping session",
      );
      sessionsSkippedParseError++;
      continue;
    }

    // If file got smaller than our cursor (truncate / reset), wipe per-file
    // cursor for this path — treat as fresh import.
    const startLine =
      existingCursor && existingCursor.fileSize <= st.size
        ? existingCursor.lineCount
        : 0;

    const lines = raw.split("\n");
    let openclawSessionId = basename(name, ".jsonl"); // fallback
    let clawcodeSessionId = computeClawcodeSessionId(openclawSessionId);
    let sessionRowEnsured = false;
    // turnIndex is the ORDINAL POSITION of the message within the session —
    // counts ONLY role=user|assistant messages (matches
    // conversation_turns.turn_index semantics). Resumes from the cursor.
    let turnIndex = startLine;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line || line.trim().length === 0) continue;

      let obj: unknown;
      try {
        obj = JSON.parse(line);
      } catch (err) {
        // D-10 — malformed line: log + skip, next line still processed.
        deps.log.warn(
          { err, absPath, lineIndex: i },
          "translator: JSONL parse error on single line; skipping line",
        );
        sessionsSkippedParseError++;
        continue;
      }

      const typed = obj as {
        type?: string;
        id?: string;
        message?: { role?: string; content?: unknown };
      };

      // Session-start line — capture `id` as the OpenClaw session uuid and
      // derive the deterministic clawcode session id. Session lines are
      // always ignored for turn-counting / translation.
      if (typed.type === "session" && typeof typed.id === "string") {
        openclawSessionId = typed.id;
        clawcodeSessionId = computeClawcodeSessionId(openclawSessionId);
        continue;
      }

      // Only `type="message"` with role=user|assistant is considered for
      // translation. Everything else is counted in turnsSkippedNonText
      // (including model_change / thinking_level_change / custom events).
      // We only count LINES STRICTLY AFTER the cursor for these counters
      // to keep idempotent re-runs from inflating the stats.
      const isAfterCursor = i >= startLine;

      if (typed.type !== "message" || !typed.message) {
        if (isAfterCursor) turnsSkippedNonText++;
        continue;
      }
      const role = typed.message.role;
      if (role !== "user" && role !== "assistant") {
        if (isAfterCursor) turnsSkippedNonText++;
        continue;
      }

      const text = extractTextContent(typed.message.content);
      if (text.length === 0) {
        if (isAfterCursor) turnsSkippedNonText++;
        continue;
      }

      if (!isAfterCursor) {
        // Lines before cursor: count turnIndex but do NOT re-insert. Fast-
        // forwards turnIndex to match the ConversationStore row that
        // already exists.
        turnIndex++;
        continue;
      }

      // Ensure the session row exists BEFORE we try to insert the first
      // turn for it. Idempotent — no-op on a pre-existing row.
      if (!sessionRowEnsured) {
        ensureSessionRow(
          deps,
          clawcodeSessionId,
          openclawSessionId,
          // Use the line's own timestamp if available, else the file mtime.
          // Turn timestamps from the jsonl are more accurate than mtime.
          extractTimestamp(obj) ?? st.mtime.toISOString(),
        );
        sessionRowEnsured = true;
      }

      const originId = computeTurnOriginId(openclawSessionId, turnIndex);
      const turnId = `openclaw-${sha256Hex(`${openclawSessionId}:${turnIndex}:${role}`).slice(0, 16)}`;
      const createdAt = extractTimestamp(obj) ?? st.mtime.toISOString();

      const inserted = tryInsertTurn(deps, {
        turnId,
        sessionId: clawcodeSessionId,
        turnIndex,
        role,
        content: text,
        originId,
        createdAt,
      });
      if (inserted) {
        turnsInserted++;
      } else {
        turnsSkippedDuplicate++;
      }
      turnIndex++;
    }

    // Cursor entry — records where we stopped so the next run can skip
    // previously-processed content in O(1).
    nextPerFileCursor[absPath] = {
      byteOffset: Buffer.byteLength(raw, "utf8"),
      lineCount: lines.length,
      fileSize: st.size,
      mtime: st.mtime.toISOString(),
    };
  }

  const nextCursor: TranslatorCursorFile = {
    version: 1,
    lastScanAt: nowIso,
    perFileCursor: nextPerFileCursor,
  };
  try {
    await writeTranslatorCursor(deps.cursorPath, nextCursor, deps.log);
  } catch (err) {
    // Cursor-write failure is non-fatal — the next run will re-scan and
    // INSERT OR IGNORE keeps DB in good shape. Log + continue.
    deps.log.warn(
      { err, cursorPath: deps.cursorPath },
      "translator: cursor persist failed (non-blocking; next run will re-scan)",
    );
  }

  return Object.freeze({
    sessionsScanned,
    sessionsSkippedMidWrite,
    sessionsSkippedParseError,
    turnsInserted,
    turnsSkippedDuplicate,
    turnsSkippedNonText,
    durationMs: Date.now() - startEpoch,
  });
}

/**
 * Extract the ISO8601 timestamp from a parsed jsonl event, if present.
 * Some lines have a top-level `timestamp` string field; others (nested
 * message-timestamp numbers) are not used here. Returns `null` when
 * unavailable so callers can fall back to file mtime.
 */
function extractTimestamp(obj: unknown): string | null {
  if (obj && typeof obj === "object") {
    const ts = (obj as { timestamp?: unknown }).timestamp;
    if (typeof ts === "string" && ts.length > 0) return ts;
  }
  return null;
}
