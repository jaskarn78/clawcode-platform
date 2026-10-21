/**
 * Verification ledger persistence — SQLite behind `VerificationLedgerStore`
 * (WS-4). The in-memory store dies with the daemon, so until now the 🧾
 * Sources button answered "no longer available" after every deploy. This
 * module keeps each delivered turn's evidence + claims snapshot for 7 days
 * (`verification-ledger.db`) and is consulted by the store on a memory miss.
 *
 * Posture:
 *   - Claims may carry client quotes → the db file is chmod 0600 right after
 *     open and BEFORE `journal_mode=WAL` so the -wal/-shm sidecars inherit it.
 *   - Construction may throw (the caller wraps it); every method afterwards is
 *     try/catch'd and never throws — a persistence failure degrades to the
 *     2h in-memory behaviour, it never breaks delivery.
 *   - Same better-sqlite3 conventions as `src/tasks/store.ts` (WAL,
 *     synchronous=NORMAL, foreign_keys=ON, idempotent DDL) with a short
 *     `busy_timeout` — the bridge calls these synchronously on the delivery
 *     path and must not stall on a lock.
 */

import Database from "better-sqlite3";
import type { Database as DatabaseType, Statement } from "better-sqlite3";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

import type { ClaimEntry } from "../manager/claim-ledger.js";
import type { EvidenceEntry } from "../manager/evidence-ledger.js";
import type { LedgerPersistenceLike, TurnLedger } from "./ledger-store.js";
import type { RecallRecord } from "../manager/recall-footer.js";

/** Rows older than this are swept (7 days). */
export const LEDGER_PERSIST_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/** Background sweep cadence (hourly). */
export const LEDGER_PERSIST_SWEEP_INTERVAL_MS = 60 * 60 * 1000;
/** Owner-only: the ledger can hold client quotes. */
export const LEDGER_DB_FILE_MODE = 0o600;

/** Minimal logger dep — structurally satisfied by a pino `Logger`. */
export interface LedgerPersistenceLog {
  warn(obj: Record<string, unknown>, msg: string): void;
}

export interface LedgerPersistenceDeps {
  readonly log?: LedgerPersistenceLog;
}

type LedgerRow = {
  readonly turn_id: string;
  readonly agent: string;
  readonly channel_id: string | null;
  readonly prompt_excerpt: string | null;
  readonly evidence_json: string;
  readonly claims_json: string;
  readonly delivered_at: number;
  readonly client_facing: number;
  /** Phase 999.133 — JSON RecallRecord or null (column added by migration). */
  readonly recall_json: string | null;
};

type Statements = {
  readonly upsertLedger: Statement;
  readonly upsertMessage: Statement;
  readonly hasTurn: Statement;
  readonly byTurnId: Statement;
  readonly byMessageId: Statement;
  readonly messageIdsForTurn: Statement;
  readonly updateClaims: Statement;
  readonly sweep: Statement;
};

const DDL = `
  CREATE TABLE IF NOT EXISTS turn_ledgers (
    turn_id        TEXT PRIMARY KEY,
    agent          TEXT NOT NULL,
    channel_id     TEXT,
    prompt_excerpt TEXT,
    evidence_json  TEXT NOT NULL,
    claims_json    TEXT NOT NULL,
    delivered_at   INTEGER NOT NULL,
    client_facing  INTEGER NOT NULL,
    recall_json    TEXT
  );

  CREATE TABLE IF NOT EXISTS ledger_messages (
    message_id TEXT PRIMARY KEY,
    turn_id    TEXT NOT NULL REFERENCES turn_ledgers(turn_id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_turn_ledgers_delivered_at ON turn_ledgers(delivered_at);
  CREATE INDEX IF NOT EXISTS idx_ledger_messages_turn_id ON ledger_messages(turn_id);
`;

export class LedgerPersistence implements LedgerPersistenceLike {
  private readonly db: DatabaseType;
  private readonly stmts: Statements;
  private readonly log: LedgerPersistenceLog | undefined;
  private readonly dbPath: string;
  private sweepTimer: ReturnType<typeof setInterval> | undefined;
  private closed = false;

  /** May throw (unwritable dir, corrupt file) — the caller decides the fallback. */
  constructor(dbPath: string, deps: LedgerPersistenceDeps = {}) {
    this.dbPath = dbPath;
    this.log = deps.log;
    mkdirSync(dirname(dbPath), { recursive: true });
    const db = new Database(dbPath);
    try {
      // 0600 BEFORE switching to WAL: SQLite creates -wal/-shm with the main
      // file's mode, so the sidecars inherit owner-only access.
      chmodSync(dbPath, LEDGER_DB_FILE_MODE);
      restoreSidecarMode(dbPath);
      db.pragma("journal_mode = WAL");
      db.pragma("busy_timeout = 250");
      db.pragma("synchronous = NORMAL");
      db.pragma("foreign_keys = ON");
      db.exec(DDL);
      // Phase 999.133 — additive column for DBs created before it existed.
      const cols = (db.prepare("PRAGMA table_info(turn_ledgers)").all() as { name: string }[]).map((c) => c.name);
      if (!cols.includes("recall_json")) db.exec("ALTER TABLE turn_ledgers ADD COLUMN recall_json TEXT");
      this.stmts = prepareStatements(db);
    } catch (err) {
      db.close();
      throw err;
    }
    this.db = db;
    this.sweep();
    this.sweepTimer = setInterval(() => this.sweep(), LEDGER_PERSIST_SWEEP_INTERVAL_MS);
    this.sweepTimer.unref();
  }

  /** Insert or fully replace a turn's snapshot, plus its message links. */
  upsert(ledger: TurnLedger): void {
    this.guard("upsert", { turnId: ledger.turnId }, () => {
      const tx = this.db.transaction((l: TurnLedger) => {
        this.stmts.upsertLedger.run({
          turn_id: l.turnId,
          agent: l.agent,
          channel_id: l.channelId,
          prompt_excerpt: l.promptExcerpt ?? null,
          evidence_json: JSON.stringify(l.evidence),
          claims_json: JSON.stringify(l.claims),
          delivered_at: l.deliveredAt,
          client_facing: l.clientFacing ? 1 : 0,
          recall_json: l.recall ? JSON.stringify(l.recall) : null,
        });
        for (const id of l.messageIds) this.stmts.upsertMessage.run(id, l.turnId);
      });
      tx(ledger);
    });
  }

  /** Link more message ids to a turn. Unknown turn → silent no-op. */
  link(turnId: string, messageIds: readonly string[]): void {
    if (messageIds.length === 0) return;
    this.guard("link", { turnId }, () => {
      const tx = this.db.transaction((ids: readonly string[]) => {
        if (!this.stmts.hasTurn.get(turnId)) return;
        for (const id of ids) this.stmts.upsertMessage.run(id, turnId);
      });
      tx(messageIds);
    });
  }

  byMessageId(messageId: string): TurnLedger | undefined {
    return this.guard("byMessageId", { messageId }, () => {
      const row = this.stmts.byMessageId.get(messageId) as LedgerRow | undefined;
      return row ? this.hydrate(row) : undefined;
    });
  }

  byTurnId(turnId: string): TurnLedger | undefined {
    return this.guard("byTurnId", { turnId }, () => {
      const row = this.stmts.byTurnId.get(turnId) as LedgerRow | undefined;
      return row ? this.hydrate(row) : undefined;
    });
  }

  /** Replace the claims snapshot wholesale (post-hoc hop refresh). Unknown turn → no-op. */
  updateClaims(turnId: string, claims: readonly ClaimEntry[]): void {
    this.guard("updateClaims", { turnId }, () => {
      this.stmts.updateClaims.run(JSON.stringify(claims), turnId);
    });
  }

  /** Delete ledgers older than 7 days (message links cascade). Returns the row count. */
  sweep(now: number = Date.now()): number {
    return (
      this.guard("sweep", {}, () => {
        const result = this.stmts.sweep.run(now - LEDGER_PERSIST_MAX_AGE_MS);
        return Number(result.changes);
      }) ?? 0
    );
  }

  /** Idempotent. Clears the sweep timer and closes the connection. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = undefined;
    }
    try {
      this.db.close();
    } catch (err) {
      this.warn("close", {}, err);
    }
  }

  private hydrate(row: LedgerRow): TurnLedger | undefined {
    const evidence = parseJsonArray<EvidenceEntry>(row.evidence_json);
    const claims = parseJsonArray<ClaimEntry>(row.claims_json);
    if (!evidence || !claims) {
      this.log?.warn(
        { turnId: row.turn_id, dbPath: this.dbPath },
        "verification ledger persistence: corrupt row skipped",
      );
      return undefined;
    }
    const messageIds = (this.stmts.messageIdsForTurn.all(row.turn_id) as { message_id: string }[]).map(
      (m) => m.message_id,
    );
    // Phase 999.133 — a torn recall blob drops only the recall, never the row.
    let recall: RecallRecord | undefined;
    if (row.recall_json) {
      try {
        const parsed: unknown = JSON.parse(row.recall_json);
        if (parsed && typeof parsed === "object" && Array.isArray((parsed as RecallRecord).memories)) {
          recall = parsed as RecallRecord;
        }
      } catch {
        recall = undefined;
      }
    }
    return {
      turnId: row.turn_id,
      agent: row.agent,
      channelId: row.channel_id,
      ...(row.prompt_excerpt !== null ? { promptExcerpt: row.prompt_excerpt } : {}),
      evidence,
      claims,
      deliveredAt: row.delivered_at,
      messageIds,
      clientFacing: row.client_facing === 1,
      ...(recall ? { recall } : {}),
    };
  }

  /** Run `fn`; on any failure warn and return `undefined` — never throw past here. */
  private guard<T>(op: string, ctx: Record<string, unknown>, fn: () => T): T | undefined {
    try {
      return fn();
    } catch (err) {
      this.warn(op, ctx, err);
      return undefined;
    }
  }

  private warn(op: string, ctx: Record<string, unknown>, err: unknown): void {
    this.log?.warn(
      { ...ctx, op, dbPath: this.dbPath, error: err instanceof Error ? err.message : String(err) },
      "verification ledger persistence: operation failed",
    );
  }
}

function prepareStatements(db: DatabaseType): Statements {
  return {
    upsertLedger: db.prepare(`
      INSERT INTO turn_ledgers
        (turn_id, agent, channel_id, prompt_excerpt, evidence_json, claims_json, delivered_at, client_facing, recall_json)
      VALUES
        (@turn_id, @agent, @channel_id, @prompt_excerpt, @evidence_json, @claims_json, @delivered_at, @client_facing, @recall_json)
      ON CONFLICT(turn_id) DO UPDATE SET
        agent = excluded.agent,
        channel_id = excluded.channel_id,
        prompt_excerpt = excluded.prompt_excerpt,
        evidence_json = excluded.evidence_json,
        claims_json = excluded.claims_json,
        delivered_at = excluded.delivered_at,
        client_facing = excluded.client_facing,
        recall_json = excluded.recall_json
    `),
    // DO UPDATE (not OR REPLACE) keeps the rowid, so insertion order survives.
    upsertMessage: db.prepare(`
      INSERT INTO ledger_messages (message_id, turn_id) VALUES (?, ?)
      ON CONFLICT(message_id) DO UPDATE SET turn_id = excluded.turn_id
    `),
    hasTurn: db.prepare("SELECT 1 FROM turn_ledgers WHERE turn_id = ?"),
    byTurnId: db.prepare("SELECT * FROM turn_ledgers WHERE turn_id = ?"),
    byMessageId: db.prepare(`
      SELECT t.* FROM turn_ledgers t
      JOIN ledger_messages m ON m.turn_id = t.turn_id
      WHERE m.message_id = ?
    `),
    messageIdsForTurn: db.prepare("SELECT message_id FROM ledger_messages WHERE turn_id = ? ORDER BY rowid"),
    updateClaims: db.prepare("UPDATE turn_ledgers SET claims_json = ? WHERE turn_id = ?"),
    sweep: db.prepare("DELETE FROM turn_ledgers WHERE delivered_at < ?"),
  };
}

/** Parse a JSON array column; `undefined` when it is not a well-formed array. */
function parseJsonArray<T>(json: string): readonly T[] | undefined {
  try {
    const parsed: unknown = JSON.parse(json);
    return Array.isArray(parsed) ? (parsed as T[]) : undefined;
  } catch {
    return undefined;
  }
}

/** Posture restore for sidecars left by an earlier boot; ENOENT is the normal case. */
function restoreSidecarMode(dbPath: string): void {
  for (const suffix of ["-wal", "-shm"]) {
    try {
      chmodSync(`${dbPath}${suffix}`, LEDGER_DB_FILE_MODE);
    } catch {
      // Missing sidecar (usual) or not ours to chmod — best-effort only.
    }
  }
}
