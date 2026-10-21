import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import pino from "pino";
import { TraceCollector } from "../trace-collector.js";
import { TraceStore } from "../trace-store.js";
import { TurnOriginSchema, makeRootOrigin } from "../../manager/turn-origin.js";

const silentLog = pino({ level: "silent" });

function newCollector(): {
  collector: TraceCollector;
  store: TraceStore;
  dbPath: string;
  dir: string;
} {
  const dir = mkdtempSync(join(tmpdir(), "trace-collector-origin-"));
  const dbPath = join(dir, "traces.db");
  const store = new TraceStore(dbPath);
  const collector = new TraceCollector(store, silentLog);
  return { collector, store, dbPath, dir };
}

function readOriginColumn(dbPath: string, turnId: string): string | null {
  const db = new Database(dbPath, { readonly: true });
  const row = db
    .prepare("SELECT turn_origin FROM traces WHERE id = ?")
    .get(turnId) as { turn_origin: string | null } | undefined;
  db.close();
  return row?.turn_origin ?? null;
}

describe("Turn.recordOrigin", () => {
  it("persists origin JSON when recordOrigin called before end()", () => {
    const { collector, store, dbPath, dir } = newCollector();
    try {
      const origin = makeRootOrigin("discord", "msg_1");
      const turn = collector.startTurn(origin.rootTurnId, "alice", "chan_1");
      turn.recordOrigin(origin);
      turn.end("success");

      const raw = readOriginColumn(dbPath, origin.rootTurnId);
      expect(raw).toBeTypeOf("string");
      const parsed = JSON.parse(raw!);
      expect(parsed).toEqual(origin);
      const revalidated = TurnOriginSchema.parse(parsed);
      expect(revalidated).toEqual(origin);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("writes NULL when recordOrigin was never called (legacy path)", () => {
    const { collector, store, dbPath, dir } = newCollector();
    try {
      const turn = collector.startTurn("discord:legacyxxxxxxx", "alice", null);
      turn.end("success");
      expect(readOriginColumn(dbPath, "discord:legacyxxxxxxx")).toBeNull();
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("recordOrigin after end() is a no-op", () => {
    const { collector, store, dbPath, dir } = newCollector();
    try {
      const turn = collector.startTurn("discord:afterendxxxxxx", "alice", null);
      turn.end("success");
      const origin = makeRootOrigin("discord", "msg_late");
      turn.recordOrigin(origin); // committed — should be ignored
      expect(readOriginColumn(dbPath, "discord:afterendxxxxxx")).toBeNull();
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("second recordOrigin wins (overwrite semantics match recordCacheUsage)", () => {
    const { collector, store, dbPath, dir } = newCollector();
    try {
      const first = makeRootOrigin("discord", "first");
      const second = makeRootOrigin("scheduler", "second");
      const turn = collector.startTurn("discord:overwriteorig1", "alice", null);
      turn.recordOrigin(first);
      turn.recordOrigin(second);
      turn.end("success");

      const raw = readOriginColumn(dbPath, "discord:overwriteorig1");
      const parsed = JSON.parse(raw!);
      expect(parsed.source.kind).toBe("scheduler");
      expect(parsed.source.id).toBe("second");
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("persisted record round-trips through TurnOriginSchema for every SourceKind", () => {
    const { collector, store, dbPath, dir } = newCollector();
    try {
      for (const kind of ["discord", "scheduler", "task", "trigger"] as const) {
        const origin = makeRootOrigin(kind, `src_${kind}`);
        const turn = collector.startTurn(origin.rootTurnId, "alice", null);
        turn.recordOrigin(origin);
        turn.end("success");

        const raw = readOriginColumn(dbPath, origin.rootTurnId);
        expect(raw).toBeTypeOf("string");
        const parsed = TurnOriginSchema.parse(JSON.parse(raw!));
        expect(parsed.source.kind).toBe(kind);
      }
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
