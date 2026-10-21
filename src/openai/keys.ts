/**
 * Phase 69 Plan 01 — OpenAI-compatible endpoint API-key store (OPENAI-04).
 *
 * Provides four standalone crypto helpers plus a `better-sqlite3`-backed
 * `ApiKeysStore` that manages the daemon-level `~/.clawcode/manager/api-keys.db`.
 * Zero imports from `src/manager/` or `src/memory/` — the CLI in Plan 03 must
 * be able to load this module without booting the daemon.
 *
 * Schema (locked per 69-CONTEXT.md "Auth & Session Mapping"):
 *
 *   api_keys (
 *     key_hash      TEXT PRIMARY KEY,   -- 64-char SHA-256 hex
 *     agent_name    TEXT NOT NULL,
 *     label         TEXT,
 *     created_at    INTEGER NOT NULL,   -- epoch ms
 *     last_used_at  INTEGER,
 *     expires_at    INTEGER,
 *     disabled_at   INTEGER
 *   )
 *
 * Keys are stored as SHA-256 hashes only. The plaintext key is revealed once
 * at create-time and never re-queryable — standard OpenAI-style bearer model.
 *
 * Crypto:
 *   - `hashApiKey` — SHA-256 → 32-byte Buffer.
 *   - `verifyKey`  — length-guarded `crypto.timingSafeEqual` (Pitfall 6 from
 *     69-RESEARCH.md: timingSafeEqual throws on mismatched lengths, so we
 *     reject short/malformed hex BEFORE the compare).
 *   - `generateApiKey` — `ck_<slug>_<base64url>` where slug is the first 6
 *     chars of the slugified agent name; random segment is 24 bytes of
 *     `crypto.randomBytes` encoded base64url (≥32 chars). Fingerprint is the
 *     first 8 hex chars of the SHA-256 hash — Plan 02 uses it as
 *     `TurnOrigin.source.id` (OPENAI-07).
 */

import crypto from "node:crypto";
import Database from "better-sqlite3";
import type { Database as Db } from "better-sqlite3";

/** SHA-256 hash of a bearer key as a raw 32-byte Buffer. */
export function hashApiKey(key: string): Buffer {
  return crypto.createHash("sha256").update(key, "utf8").digest();
}

/**
 * Length-guarded constant-time comparison between an incoming bearer key and
 * a stored SHA-256 hex digest.
 *
 * Returns `false` on any structural mismatch — non-string inputs, hex strings
 * not exactly 64 chars, non-hex chars — WITHOUT throwing. Only invokes
 * `crypto.timingSafeEqual` once both buffers have been confirmed to be the
 * same length (timingSafeEqual throws `RangeError` on length mismatch —
 * Pitfall 6 from 69-RESEARCH.md).
 */
export function verifyKey(incoming: string, storedHashHex: string): boolean {
  if (typeof incoming !== "string" || typeof storedHashHex !== "string") {
    return false;
  }
  if (storedHashHex.length !== 64) return false;
  if (!/^[0-9a-fA-F]{64}$/.test(storedHashHex)) return false;
  const incomingHash = hashApiKey(incoming);
  let storedHash: Buffer;
  try {
    storedHash = Buffer.from(storedHashHex, "hex");
  } catch {
    return false;
  }
  if (storedHash.byteLength !== incomingHash.byteLength) return false;
  return crypto.timingSafeEqual(incomingHash, storedHash);
}

/**
 * Generate a fresh bearer key for an agent.
 *
 * Format: `ck_<slug>_<random>` where:
 *   - `slug` = first 6 chars of lowercase alphanumeric-only agent name, or
 *     `"agent"` if the agent name contains no alphanumerics.
 *   - `random` = 24 bytes of `crypto.randomBytes` encoded as base64url
 *     (32 chars, URL-safe: `[A-Za-z0-9_-]`).
 *
 * Returns:
 *   - `key`         — plaintext bearer (show once, never store).
 *   - `hashHex`     — 64-char SHA-256 hex digest (persist this).
 *   - `keyPrefix8`  — first 8 hex chars of `hashHex`, used by Plan 02 as the
 *     TurnOrigin source id fingerprint (OPENAI-07).
 */
export function generateApiKey(agentName: string): {
  key: string;
  hashHex: string;
  keyPrefix8: string;
} {
  const slugRaw = agentName
    .slice(0, 20)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .slice(0, 6);
  const slug = slugRaw.length > 0 ? slugRaw : "agent";
  const random = crypto.randomBytes(24).toString("base64url");
  const key = `ck_${slug}_${random}`;
  const hashHex = hashApiKey(key).toString("hex");
  const keyPrefix8 = hashHex.slice(0, 8);
  return { key, hashHex, keyPrefix8 };
}

/** Persisted row shape for the `api_keys` table. Never contains plaintext. */
export interface ApiKeyRow {
  key_hash: string;
  agent_name: string;
  label: string | null;
  created_at: number;
  last_used_at: number | null;
  expires_at: number | null;
  disabled_at: number | null;
  /**
   * Quick task 260419-p51 — scope row (P51-MULTI-AGENT-KEY). One of:
   *   - `"agent:<name>"` — legacy pinned key; allowed only on the bound agent.
   *   - `"all"`          — multi-agent key; allowed on any configured agent.
   *
   * NEVER null on post-migration reads. On pre-v2 DBs this row may transiently
   * be NULL between the column-add step and the backfill step of a single
   * migration transaction; the store never surfaces NULL to callers.
   *
   * Legacy-DB backfill runs exactly once — guarded by `api_keys_schema_version`
   * row (v1 → v2 triggers the one-time `UPDATE api_keys SET scope = 'agent:'||agent_name`).
   */
  scope: string;
}

/** Options for `ApiKeysStore.createKey` / `createAllKey`. */
export interface CreateKeyOptions {
  label?: string;
  expiresAt?: number;
}

/** Raw row shape returned by better-sqlite3 before it's re-asserted as ApiKeyRow. */
interface ApiKeyRawRow {
  readonly key_hash: string;
  readonly agent_name: string;
  readonly label: string | null;
  readonly created_at: number;
  readonly last_used_at: number | null;
  readonly expires_at: number | null;
  readonly disabled_at: number | null;
  readonly scope: string | null;
}

/**
 * Current schema version tracked in `api_keys_schema_version`. Bumped whenever
 * the `api_keys` DDL changes — matches the migration-idempotency pattern used
 * in `src/tasks/store.ts` (Phase 58).
 *
 * v1: initial schema.
 * v2 (quick task 260419-p51): added `scope TEXT` column + one-shot backfill
 *     for legacy rows (`scope = "agent:" || agent_name`).
 */
const SCHEMA_VERSION = 2;

/**
 * Sentinel `agent_name` value for scope='all' rows. Users never see the raw
 * character — the CLI print path renders it as "(all)". We pick "*" because
 * it satisfies the NOT NULL constraint on agent_name without introducing a
 * separate CHECK.
 */
const ALL_AGENT_SENTINEL = "*";

/**
 * Minimum plausible bearer-key length. Guards `lookupByIncomingKey` against
 * trivial inputs (empty string, tiny probes) before we even hash them.
 * Our own `generateApiKey` output is far longer (~45 chars); this is a
 * soft sanity floor.
 */
const MIN_INCOMING_KEY_LEN = 10;

/**
 * Minimum hex prefix accepted by `revokeKey` when matching against a
 * `key_hash` prefix. 8 hex chars = 32 bits, collision-safe for the expected
 * fleet size while still being operator-readable.
 */
const MIN_HASH_PREFIX_LEN = 8;

/**
 * Daemon-level API-keys store. Single SQLite database (`api-keys.db`) living
 * under `~/.clawcode/manager/`. Synchronous, single-writer — mirrors the
 * TaskStore / TraceStore patterns from earlier phases.
 *
 * Constructor side-effects:
 *   - opens the DB (creates if missing),
 *   - switches to WAL journaling,
 *   - runs the idempotent migration,
 *   - seeds the schema-version row on first open.
 *
 * All public methods are synchronous (better-sqlite3 is sync by design).
 */
export class ApiKeysStore {
  private readonly db: Db;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.migrate();
  }

  /** Idempotent schema setup — safe to call on every open. */
  private migrate(): void {
    // Step 1 — Base schema + greenfield scope column (CREATE IF NOT EXISTS
    // is a no-op on existing DBs, so the inline `scope TEXT` only lands on
    // brand-new files; legacy DBs pick it up via the ALTER below).
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS api_keys_schema_version (
        version INTEGER PRIMARY KEY
      );
      CREATE TABLE IF NOT EXISTS api_keys (
        key_hash      TEXT PRIMARY KEY,
        agent_name    TEXT NOT NULL,
        label         TEXT,
        created_at    INTEGER NOT NULL,
        last_used_at  INTEGER,
        expires_at    INTEGER,
        disabled_at   INTEGER,
        scope         TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_api_keys_agent ON api_keys(agent_name);
      CREATE INDEX IF NOT EXISTS idx_api_keys_label ON api_keys(label);
    `);

    // Step 2 — Idempotent ALTER to add `scope` to pre-v2 DBs. Mirrors the
    // Plan 72-01 UsageTracker pattern: try the ALTER, swallow `duplicate
    // column` errors, re-throw anything unexpected.
    try {
      this.db.exec("ALTER TABLE api_keys ADD COLUMN scope TEXT");
    } catch (err) {
      const msg = String(err);
      if (!msg.includes("duplicate column")) throw err;
    }

    // Step 3 — Version-gated one-time backfill. Legacy rows (pre-v2) have
    // NULL scope; we set `scope = "agent:" || agent_name`. Guarded by the
    // `api_keys_schema_version` row — runs EXACTLY once per DB file.
    const versionRow = this.db
      .prepare("SELECT version FROM api_keys_schema_version")
      .get() as { version: number } | undefined;
    const currentVersion = versionRow?.version ?? 0;

    if (currentVersion < SCHEMA_VERSION) {
      if (currentVersion === 1) {
        // Upgrade path: v1 → v2. Backfill legacy rows.
        this.db
          .prepare(
            "UPDATE api_keys SET scope = 'agent:' || agent_name WHERE scope IS NULL",
          )
          .run();
      }
      if (!versionRow) {
        // Greenfield (no version row yet) — stamp current version.
        this.db
          .prepare("INSERT INTO api_keys_schema_version (version) VALUES (?)")
          .run(SCHEMA_VERSION);
      } else {
        // Upgrade — replace the stored version.
        this.db
          .prepare("DELETE FROM api_keys_schema_version")
          .run();
        this.db
          .prepare("INSERT INTO api_keys_schema_version (version) VALUES (?)")
          .run(SCHEMA_VERSION);
      }
    }
  }

  /**
   * Insert a fresh pinned key for `agentName` (scope = "agent:<name>").
   * Returns the plaintext key (show once) and the persisted row. Legacy
   * back-compat path — CLI callers without `--all` still land here.
   */
  createKey(
    agentName: string,
    opts: CreateKeyOptions = {},
  ): { key: string; row: ApiKeyRow } {
    const { key, hashHex } = generateApiKey(agentName);
    const row: ApiKeyRow = {
      key_hash: hashHex,
      agent_name: agentName,
      label: opts.label ?? null,
      created_at: Date.now(),
      last_used_at: null,
      expires_at: opts.expiresAt ?? null,
      disabled_at: null,
      scope: `agent:${agentName}`,
    };
    this.insertRow(row);
    return { key, row };
  }

  /**
   * Quick task 260419-p51 — insert a multi-agent (`scope = "all"`) key.
   * `agent_name` is stamped as the sentinel `"*"` (rendered as "(all)" in
   * the CLI). The bearer accepted on ANY configured agent at auth time
   * (server.ts does the scope-aware check).
   */
  createAllKey(opts: CreateKeyOptions = {}): { key: string; row: ApiKeyRow } {
    // Slug becomes "all" because generateApiKey strips non-alphanumerics;
    // users see `ck_all_...` so the key is self-documenting.
    const { key, hashHex } = generateApiKey("all");
    const row: ApiKeyRow = {
      key_hash: hashHex,
      agent_name: ALL_AGENT_SENTINEL,
      label: opts.label ?? null,
      created_at: Date.now(),
      last_used_at: null,
      expires_at: opts.expiresAt ?? null,
      disabled_at: null,
      scope: "all",
    };
    this.insertRow(row);
    return { key, row };
  }

  /** Shared INSERT path — single source of truth for both create paths. */
  private insertRow(row: ApiKeyRow): void {
    this.db
      .prepare(
        "INSERT INTO api_keys (key_hash, agent_name, label, created_at, last_used_at, expires_at, disabled_at, scope) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        row.key_hash,
        row.agent_name,
        row.label,
        row.created_at,
        row.last_used_at,
        row.expires_at,
        row.disabled_at,
        row.scope,
      );
  }

  /** Return every row, most-recent first. Hashes only — plaintext never present. */
  listKeys(): ReadonlyArray<ApiKeyRow> {
    const rows = this.db
      .prepare("SELECT * FROM api_keys ORDER BY created_at DESC")
      .all() as ApiKeyRawRow[];
    return rows.map((r) => rawToRow(r));
  }

  /**
   * Revoke a key. Accepts three identifier shapes (in order):
   *   1. Full plaintext key — we hash and match by `key_hash`.
   *   2. Hex prefix ≥8 chars — we match by `key_hash LIKE prefix%`.
   *   3. Label — we match by exact label equality.
   *
   * Only the first matching strategy that yields ≥1 row mutation wins;
   * downstream strategies are skipped. Returns `true` if any row was
   * revoked, `false` if no match (or key already revoked).
   */
  revokeKey(identifier: string): boolean {
    if (typeof identifier !== "string" || identifier.length === 0) return false;
    const now = Date.now();
    const fullKeyHash = hashApiKey(identifier).toString("hex");
    const byFullKey = this.db
      .prepare(
        "UPDATE api_keys SET disabled_at = ? WHERE key_hash = ? AND disabled_at IS NULL",
      )
      .run(now, fullKeyHash);
    if (byFullKey.changes > 0) return true;
    if (/^[0-9a-f]{8,}$/i.test(identifier)) {
      const byPrefix = this.db
        .prepare(
          "UPDATE api_keys SET disabled_at = ? WHERE key_hash LIKE ? AND disabled_at IS NULL",
        )
        .run(now, identifier.toLowerCase() + "%");
      if (byPrefix.changes > 0) return true;
    }
    const byLabel = this.db
      .prepare(
        "UPDATE api_keys SET disabled_at = ? WHERE label = ? AND disabled_at IS NULL",
      )
      .run(now, identifier);
    return byLabel.changes > 0;
  }

  /**
   * HOT PATH — called on every OpenAI-endpoint request by Plan 02.
   *
   * Hashes the incoming bearer token, looks up the row by `key_hash`, and
   * filters out disabled / expired rows. Returns `null` on any miss —
   * Plan 02 maps `null` to HTTP 401.
   *
   * Note: we intentionally DO NOT use `verifyKey` here because the SHA-256
   * hex is the primary key and `=` on an indexed column is already
   * constant-time at the DB level. No timing oracle exists unless we start
   * doing row-level scans, which we don't.
   */
  lookupByIncomingKey(incoming: string): ApiKeyRow | null {
    if (typeof incoming !== "string" || incoming.length < MIN_INCOMING_KEY_LEN) {
      return null;
    }
    const hashHex = hashApiKey(incoming).toString("hex");
    const row = this.db
      .prepare("SELECT * FROM api_keys WHERE key_hash = ?")
      .get(hashHex) as ApiKeyRawRow | undefined;
    if (!row) return null;
    if (row.disabled_at !== null) return null;
    if (row.expires_at !== null && row.expires_at <= Date.now()) return null;
    return rawToRow(row);
  }

  /**
   * Stamp `last_used_at = Date.now()` on a row. Called by Plan 02 AFTER a
   * successful dispatch — lets operators see which keys are actually live.
   * Silent no-op if the hash doesn't exist.
   */
  touchLastUsed(keyHash: string): void {
    this.db
      .prepare("UPDATE api_keys SET last_used_at = ? WHERE key_hash = ?")
      .run(Date.now(), keyHash);
  }

  /** Close the underlying SQLite handle. Tests call this in `afterEach`. */
  close(): void {
    this.db.close();
  }
}

/**
 * Normalize a raw SQLite row into the public `ApiKeyRow` shape. Defends
 * against the transient null-scope window between the ALTER and the backfill
 * on a mid-migration read: if `scope` is NULL we synthesize `agent:<name>`
 * on the fly — matches the backfill rule so subsequent reads converge.
 */
function rawToRow(r: ApiKeyRawRow): ApiKeyRow {
  return {
    key_hash: r.key_hash,
    agent_name: r.agent_name,
    label: r.label,
    created_at: r.created_at,
    last_used_at: r.last_used_at,
    expires_at: r.expires_at,
    disabled_at: r.disabled_at,
    scope: r.scope ?? `agent:${r.agent_name}`,
  };
}

/** Re-export the hash-prefix floor for Plan 03's CLI parser. */
export { MIN_HASH_PREFIX_LEN };
