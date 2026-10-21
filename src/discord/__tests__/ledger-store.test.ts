import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import type { Logger } from "pino";
import {
  LEDGER_LINK_LATEST_WINDOW_MS,
  LEDGER_MAX_AGE_MS,
  LEDGER_MAX_ENTRIES,
  VerificationLedgerStore,
  type LedgerPersistenceLike,
  type TurnLedger,
} from "../ledger-store.js";
import {
  LEDGER_PERSIST_MAX_AGE_MS,
  LedgerPersistence,
  type LedgerPersistenceLog,
} from "../ledger-store-sqlite.js";
import type { ClaimEntry } from "../../manager/claim-ledger.js";
import type { EvidenceEntry } from "../../manager/evidence-ledger.js";

const mk = (turnId: string, at: number, ids: string[] = [], agent = "a"): TurnLedger => ({
  turnId, agent, channelId: "c", evidence: [], claims: [], deliveredAt: at, messageIds: ids, clientFacing: false,
});

// Compile-time only: the bridge's pino logger must satisfy the persistence log dep.
const logShapeCheck: LedgerPersistenceLog = {} as Logger;
void logShapeCheck;

const DAY_MS = 24 * 60 * 60 * 1000;

const evidenceFixture: EvidenceEntry[] = [
  { kind: "read", tool: "WebFetch", toolUseId: "tu-1", at: 1000, url: "https://example.invalid/rates", host: "example.invalid", tier: "primary" },
  { kind: "document", tool: "Read", toolUseId: "tu-2", at: 1001, file: "plan-summary-2026-08-01.pdf", asOf: "2026-08-01", tier: "client" },
];

const claimFixture = (id: string, verdict: ClaimEntry["verdict"] = "verified"): ClaimEntry => ({
  id, turnId: "t1", claim: `Contribution room is ${id === "c1" ? "7,000" : "7,500"} this year`, class: "figure", audience: "client",
  verdict, effectiveVerdict: verdict, source: "https://example.invalid/rates", sourceHost: "example.invalid",
  sourceStatus: "in-ledger", sourceTier: "primary", quote: "the annual limit is 7,000", quoteStatus: "verbatim",
  origin: "tool", at: 1002, ledgerBacked: true,
});

const rich = (at = 1000): TurnLedger => ({
  turnId: "t1", agent: "fin", channelId: "chan-1", promptExcerpt: "what is the room this year",
  evidence: evidenceFixture, claims: [claimFixture("c1")], deliveredAt: at, messageIds: ["m1", "m2"], clientFacing: true,
});

describe("VerificationLedgerStore", () => {
  it("records, resolves by turn and by message id, links later ids", () => {
    const s = new VerificationLedgerStore();
    s.record(mk("t1", 1000, ["m1"]), 1000);
    expect(s.get("t1", 1000)?.turnId).toBe("t1");
    expect(s.byMessageId("m1", 1000)?.turnId).toBe("t1");
    s.linkMessages("t1", ["m2", "m3"]);
    expect(s.byMessageId("m3", 1000)?.messageIds).toEqual(["m1", "m2", "m3"]);
  });
  it("expires after the max age and caps entries (oldest dropped)", () => {
    const s = new VerificationLedgerStore();
    s.record(mk("old", 1000, ["m"]), 1000);
    expect(s.get("old", 1000 + LEDGER_MAX_AGE_MS + 1)).toBeUndefined();
    expect(s.byMessageId("m", 1000 + LEDGER_MAX_AGE_MS + 1)).toBeUndefined();
    for (let i = 0; i < LEDGER_MAX_ENTRIES + 5; i++) s.record(mk(`t${i}`, 2000 + i), 2000 + i);
    expect(s.size()).toBeLessThanOrEqual(LEDGER_MAX_ENTRIES);
    expect(s.get("t0", 3000)).toBeUndefined();
  });
  it("recent() is per agent, newest first; card dedupe window", () => {
    const s = new VerificationLedgerStore();
    s.record(mk("a1", 1000, [], "a"), 1000);
    s.record(mk("a2", 2000, [], "a"), 2000);
    s.record(mk("b1", 3000, [], "b"), 3000);
    expect(s.recent("a", 5, 3000).map((l) => l.turnId)).toEqual(["a2", "a1"]);
    expect(s.markCardPosted("m", 1000)).toBe(true);
    expect(s.markCardPosted("m", 1000 + 60_000)).toBe(false);
    expect(s.markCardPosted("m", 1000 + 11 * 60_000)).toBe(true);
  });
  it("linkLatest() adopts ids into the newest id-less ledger only within the 5-minute window", () => {
    expect(LEDGER_LINK_LATEST_WINDOW_MS).toBe(5 * 60_000);
    const s = new VerificationLedgerStore();
    s.record(mk("old", 1000, [], "a"), 1000);
    s.record(mk("new", 5000, [], "a"), 5000);
    s.record(mk("b", 6000, [], "b"), 6000);
    expect(s.linkLatest("a", ["m9"], 5500)).toBe(true);
    expect(s.byMessageId("m9", 5500)?.turnId).toBe("new");
    // 2 min later "old" is still inside the 5-min window but "new" already has ids → "old" adopts.
    expect(s.linkLatest("a", ["m10"], 5000 + 2 * 60_000)).toBe(true);
    expect(s.byMessageId("m10", 5000 + 2 * 60_000)?.turnId).toBe("old");
    s.record(mk("late", 7000, [], "a"), 7000);
    expect(s.linkLatest("a", ["m11"], 7000 + 6 * 60_000)).toBe(false); // > 5 min: outside the window
    expect(s.linkLatest("zzz", ["m12"], 5500)).toBe(false);
  });
  it("updateClaims() replaces the snapshot in memory; unknown turn is a no-op", () => {
    const s = new VerificationLedgerStore();
    s.record(rich(), 1000);
    s.updateClaims("t1", [claimFixture("c1", "corrected"), claimFixture("c2")]);
    expect(s.get("t1", 1000)?.claims.map((c) => `${c.id}:${c.effectiveVerdict}`)).toEqual(["c1:corrected", "c2:verified"]);
    expect(() => s.updateClaims("nope", [])).not.toThrow();
  });
  it("a throwing persistence backing never reaches the caller", () => {
    const boom = (): never => { throw new Error("disk on fire"); };
    const persist: LedgerPersistenceLike = { upsert: boom, link: boom, byMessageId: boom, updateClaims: boom };
    const s = new VerificationLedgerStore({ persist });
    expect(() => s.record(mk("t1", 1000, ["m1"]), 1000)).not.toThrow();
    expect(() => s.linkMessages("t1", ["m2"])).not.toThrow();
    expect(() => s.updateClaims("t1", [])).not.toThrow();
    expect(s.byMessageId("m1", 1000)?.turnId).toBe("t1"); // memory still wins
    expect(s.byMessageId("missing", 1000)).toBeUndefined();
  });
});

describe("VerificationLedgerStore + LedgerPersistence (sqlite)", () => {
  // Real-clock base: every open sweeps rows older than 7 days, so fixtures
  // must not sit at the 1970 epoch.
  const T0 = Date.now() - 60_000;
  let dir: string;
  let dbPath: string;
  let open: LedgerPersistence[];
  const warn = vi.fn();
  const log: LedgerPersistenceLog = { warn };

  const openPersistence = (): LedgerPersistence => {
    const p = new LedgerPersistence(dbPath, { log });
    open.push(p);
    return p;
  };
  /** Simulated restart: close the current handle, open a fresh one over the same file. */
  const restart = (p: LedgerPersistence): { p: LedgerPersistence; s: VerificationLedgerStore } => {
    p.close();
    const next = openPersistence();
    return { p: next, s: new VerificationLedgerStore({ persist: next }) };
  };

  beforeEach(() => {
    warn.mockClear();
    dir = mkdtempSync(join(tmpdir(), "ledger-store-sqlite-"));
    dbPath = join(dir, "nested", "verification-ledger.db"); // exercises mkdir -p
    open = [];
  });
  afterEach(() => {
    for (const p of open) p.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("round-trips a full ledger across a restart, without re-caching in memory", () => {
    const p1 = openPersistence();
    const s1 = new VerificationLedgerStore({ persist: p1 });
    s1.record(rich(T0), T0);
    const { p: p2, s: s2 } = restart(p1);
    const hit = s2.byMessageId("m2", T0);
    expect(hit).toEqual(rich(T0));
    expect(s2.size()).toBe(0);
    expect(p2.byTurnId("t1")).toEqual(rich(T0));
    expect(p2.byTurnId("nope")).toBeUndefined();
    expect(p2.byMessageId("nope")).toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });

  it("omits promptExcerpt when it was never set; a re-record replaces the row", () => {
    const p = openPersistence();
    p.upsert(mk("t1", T0, ["m1"]));
    expect("promptExcerpt" in (p.byTurnId("t1") as object)).toBe(false);
    p.upsert({ ...mk("t1", T0 + 1000, ["m1", "m9"]), promptExcerpt: "again", clientFacing: true });
    const row = p.byTurnId("t1");
    expect(row?.deliveredAt).toBe(T0 + 1000);
    expect(row?.promptExcerpt).toBe("again");
    expect(row?.clientFacing).toBe(true);
    expect(row?.messageIds).toEqual(["m1", "m9"]);
  });

  it("serves a ledger that expired from memory but is still on disk", () => {
    const p = openPersistence();
    const s = new VerificationLedgerStore({ persist: p });
    s.record(mk("t1", T0, ["m1"]), T0);
    const later = T0 + LEDGER_MAX_AGE_MS + 1;
    expect(s.byMessageId("m1", later)?.turnId).toBe("t1");
    expect(s.size()).toBe(0); // dropped from memory, answered from disk
  });

  it("links ids after a restart (memory miss still reaches the db); unknown turn is a no-op", () => {
    const p1 = openPersistence();
    const s1 = new VerificationLedgerStore({ persist: p1 });
    s1.record(mk("t1", T0, []), T0);
    const { p: p2, s: s2 } = restart(p1);
    s2.linkMessages("t1", ["m7", "m8"]);
    expect(s2.byMessageId("m8", T0)?.messageIds).toEqual(["m7", "m8"]);
    s2.linkMessages("ghost", ["m9"]);
    expect(p2.byMessageId("m9")).toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });

  it("linkLatest() adoptions are durable", () => {
    const p1 = openPersistence();
    const s1 = new VerificationLedgerStore({ persist: p1 });
    s1.record(mk("t1", T0, [], "fin"), T0);
    expect(s1.linkLatest("fin", ["m1"], T0 + 500)).toBe(true);
    const { s: s2 } = restart(p1);
    expect(s2.byMessageId("m1", T0 + 500)?.turnId).toBe("t1");
  });

  it("sweep() drops 8-day-old rows (links cascade) and keeps 6-day-old ones; runs at open", () => {
    const now = Date.now();
    const p1 = openPersistence();
    p1.upsert(mk("old", now - 8 * DAY_MS, ["m-old"]));
    p1.upsert(mk("fresh", now - 6 * DAY_MS, ["m-fresh"]));
    expect(p1.sweep(now)).toBe(1);
    expect(p1.byTurnId("old")).toBeUndefined();
    expect(p1.byMessageId("m-old")).toBeUndefined();
    expect(p1.byTurnId("fresh")?.turnId).toBe("fresh");
    expect(p1.sweep(now)).toBe(0);
    expect(LEDGER_PERSIST_MAX_AGE_MS).toBe(7 * DAY_MS);

    // Sweep at open uses the wall clock: plant an 8-day-old row, reopen, gone.
    p1.upsert(mk("stale", now - 8 * DAY_MS, ["m-stale"]));
    const { p: p2 } = restart(p1);
    expect(p2.byTurnId("stale")).toBeUndefined();
    expect(p2.byTurnId("fresh")?.turnId).toBe("fresh");
    expect(p2.byMessageId("m-fresh")?.turnId).toBe("fresh");
  });

  it("updateClaims() is visible after a restart", () => {
    const p1 = openPersistence();
    const s1 = new VerificationLedgerStore({ persist: p1 });
    s1.record(rich(T0), T0);
    s1.updateClaims("t1", [claimFixture("c1", "corrected"), claimFixture("c2")]);
    const { p: p2, s: s2 } = restart(p1);
    const claims = s2.byMessageId("m1", T0)?.claims ?? [];
    expect(claims.map((c) => `${c.id}:${c.effectiveVerdict}`)).toEqual(["c1:corrected", "c2:verified"]);
    expect(p2.byTurnId("t1")?.evidence).toEqual(evidenceFixture); // untouched
    p2.updateClaims("ghost", []); // unknown turn: silent
    expect(warn).not.toHaveBeenCalled();
  });

  it("creates the db file (and WAL sidecar) owner-only", () => {
    const p = openPersistence();
    p.upsert(mk("t1", T0, ["m1"]));
    expect(statSync(dbPath).mode & 0o777).toBe(0o600);
    const wal = `${dbPath}-wal`;
    expect(existsSync(wal)).toBe(true);
    expect(statSync(wal).mode & 0o777).toBe(0o600);
  });

  it("never throws after close — record/link/lookup/sweep degrade to memory-only and warn", () => {
    const p = openPersistence();
    const s = new VerificationLedgerStore({ persist: p });
    p.close();
    expect(() => p.close()).not.toThrow(); // idempotent
    expect(() => s.record(mk("t1", T0, ["m1"]), T0)).not.toThrow();
    expect(s.get("t1", T0)?.turnId).toBe("t1");
    expect(() => s.linkMessages("t1", ["m2"])).not.toThrow();
    expect(() => s.updateClaims("t1", [])).not.toThrow();
    expect(s.byMessageId("missing", T0)).toBeUndefined();
    expect(p.byTurnId("t1")).toBeUndefined();
    expect(p.sweep()).toBe(0);
    expect(warn).toHaveBeenCalled();
    expect(warn.mock.calls[0]![0]).toMatchObject({ op: "upsert", turnId: "t1" });
  });

  it("a corrupt row is skipped with a warning instead of throwing", () => {
    const p = openPersistence();
    p.upsert(mk("t1", T0, ["m1"]));
    const raw = new Database(dbPath);
    raw.prepare("UPDATE turn_ledgers SET claims_json = ? WHERE turn_id = ?").run("{not json", "t1");
    raw.close();
    expect(p.byMessageId("m1")).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ turnId: "t1" }), expect.stringMatching(/corrupt row/));
  });

  it("construction throws when the path is unusable (caller decides the fallback)", () => {
    expect(() => new LedgerPersistence(join(dir, "as-dir"), { log })).not.toThrow();
    expect(() => new LedgerPersistence(join(dir, "as-dir", "child.db"), { log })).toThrow();
  });
});

// ── Phase 999.133 — recall persists, and an old DB gains the column ──────
describe("recall persistence (Phase 999.133)", () => {
  it("round-trips the recall record through sqlite and survives a restart", () => {
    const dir2 = mkdtempSync(join(tmpdir(), "ledger-recall-"));
    const path = join(dir2, "verification-ledger.db");
    const recall = { at: 1, memories: [{ id: "m1", createdAt: "2026-06-12T17:00:00.000Z", snippet: "Zaid wants 40% SGOV" }], notes: [], documents: [] };
    const p1 = new LedgerPersistence(path, {});
    p1.upsert({ turnId: "t1", agent: "a", channelId: "c", evidence: [], claims: [], deliveredAt: Date.now(), messageIds: ["m-1"], clientFacing: false, recall });
    p1.close();
    const p2 = new LedgerPersistence(path, {});
    expect(p2.byMessageId("m-1")?.recall).toEqual(recall);
    p2.close();
    rmSync(dir2, { recursive: true, force: true });
  });

  it("adds recall_json to a database created before the column existed", () => {
    const dir2 = mkdtempSync(join(tmpdir(), "ledger-migrate-"));
    const path = join(dir2, "verification-ledger.db");
    const old = new Database(path);
    old.exec(`CREATE TABLE turn_ledgers (turn_id TEXT PRIMARY KEY, agent TEXT NOT NULL, channel_id TEXT, prompt_excerpt TEXT, evidence_json TEXT NOT NULL, claims_json TEXT NOT NULL, delivered_at INTEGER NOT NULL, client_facing INTEGER NOT NULL);
      CREATE TABLE ledger_messages (message_id TEXT PRIMARY KEY, turn_id TEXT NOT NULL REFERENCES turn_ledgers(turn_id) ON DELETE CASCADE);
      INSERT INTO turn_ledgers VALUES ('t0','a','c',NULL,'[]','[]',${Date.now()},0);
      INSERT INTO ledger_messages VALUES ('m-0','t0');`);
    old.close();
    const p = new LedgerPersistence(path, {});
    const cols = (p as unknown as { db: Database.Database }).db.prepare("PRAGMA table_info(turn_ledgers)").all() as { name: string }[];
    expect(cols.map((c) => c.name)).toContain("recall_json");
    expect(p.byMessageId("m-0")?.recall).toBeUndefined();
    p.close();
    rmSync(dir2, { recursive: true, force: true });
  });
});
