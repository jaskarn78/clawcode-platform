import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { TraceStore } from "../trace-store.js";
import { TurnOriginSchema, makeRootOrigin } from "../../manager/turn-origin.js";
import type { TurnRecord } from "../types.js";

function newStore(): { store: TraceStore; dir: string; dbPath: string } {
  const dir = mkdtempSync(join(tmpdir(), "trace-store-origin-"));
  const dbPath = join(dir, "traces.db");
  return { store: new TraceStore(dbPath), dir, dbPath };
}

function makeTurn(
  id: string,
  overrides: Partial<TurnRecord> = {},
): TurnRecord {
  const now = new Date().toISOString();
  return Object.freeze({
    id,
    agent: "alice",
    channelId: null,
    startedAt: now,
    endedAt: now,
    totalMs: 10,
    status: "success" as const,
    spans: Object.freeze([]),
    ...overrides,
  });
}

describe("TraceStore — turn_origin column", () => {
  it("creates the turn_origin TEXT column on fresh store", () => {
    const { store, dir, dbPath } = newStore();
    try {
      const db = new Database(dbPath, { readonly: true });
      const cols = db
        .prepare("PRAGMA table_info(traces)")
        .all() as ReadonlyArray<{ name: string; type: string }>;
      const turnOriginCol = cols.find((c) => c.name === "turn_origin");
      expect(turnOriginCol).toBeDefined();
      expect(turnOriginCol?.type).toBe("TEXT");
      db.close();
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("migration is idempotent — reopening does not duplicate the column or throw", () => {
    const dir = mkdtempSync(join(tmpdir(), "trace-store-origin-idem-"));
    const dbPath = join(dir, "traces.db");
    try {
      const first = new TraceStore(dbPath);
      first.close();
      const second = new TraceStore(dbPath); // must not throw
      const db = new Database(dbPath, { readonly: true });
      const matches = (
        db.prepare("PRAGMA table_info(traces)").all() as ReadonlyArray<{ name: string }>
      ).filter((c) => c.name === "turn_origin");
      expect(matches).toHaveLength(1);
      db.close();
      second.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("writeTurn persists turnOrigin as JSON and round-trips", () => {
    const { store, dir, dbPath } = newStore();
    try {
      const origin = makeRootOrigin("discord", "msg_abc");
      const turn = makeTurn("discord:aaabbbccc111", {
        id: origin.rootTurnId,
        turnOrigin: origin,
      });
      store.writeTurn(turn);

      const db = new Database(dbPath, { readonly: true });
      const row = db
        .prepare("SELECT turn_origin FROM traces WHERE id = ?")
        .get(origin.rootTurnId) as { turn_origin: string | null };
      expect(row).toBeDefined();
      expect(row.turn_origin).toBeTypeOf("string");
      const parsed = JSON.parse(row.turn_origin!);
      expect(parsed).toEqual(origin);
      // Schema round-trip proves the serialized form is valid
      const revalidated = TurnOriginSchema.parse(parsed);
      expect(revalidated).toEqual(origin);
      db.close();
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("writeTurn without turnOrigin (legacy callers) stores NULL", () => {
    const { store, dir, dbPath } = newStore();
    try {
      const turn = makeTurn("discord:nooriginabc");
      store.writeTurn(turn);
      const db = new Database(dbPath, { readonly: true });
      const row = db
        .prepare("SELECT turn_origin FROM traces WHERE id = ?")
        .get("discord:nooriginabc") as { turn_origin: string | null };
      expect(row.turn_origin).toBeNull();
      db.close();
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("writeTurn with explicit turnOrigin: undefined stores NULL (not 'undefined' string)", () => {
    const { store, dir, dbPath } = newStore();
    try {
      const turn = makeTurn("discord:undefinedorigin", { turnOrigin: undefined });
      store.writeTurn(turn);
      const db = new Database(dbPath, { readonly: true });
      const row = db
        .prepare("SELECT turn_origin FROM traces WHERE id = ?")
        .get("discord:undefinedorigin") as { turn_origin: string | null };
      expect(row.turn_origin).toBeNull();
      db.close();
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
