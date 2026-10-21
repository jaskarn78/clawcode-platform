import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import pino from "pino";
import { TraceStore } from "../../performance/trace-store.js";
import { TraceCollector } from "../../performance/trace-collector.js";
import { TurnDispatcher } from "../../manager/turn-dispatcher.js";
import { TurnOriginSchema, TURN_ID_REGEX } from "../../manager/turn-origin.js";
import { TaskScheduler } from "../scheduler.js";

const silentLog = pino({ level: "silent" });

describe("Phase 57 Plan 03 — Scheduler turn origin persistence", () => {
  it("fires a cron via _triggerForTest and persists scheduler-kind origin", async () => {
    const dir = mkdtempSync(join(tmpdir(), "scheduler-origin-"));
    const dbPath = join(dir, "traces.db");
    try {
      const store = new TraceStore(dbPath);
      const collector = new TraceCollector(store, silentLog);

      const sessionManager = {
        dispatchTurn: vi.fn(async () => "scheduled-reply"),
        streamFromAgent: vi.fn(),
        getTraceCollector: vi.fn(() => collector),
      };
      const turnDispatcher = new TurnDispatcher({
        sessionManager: sessionManager as never,
        log: silentLog,
      });
      const scheduler = new TaskScheduler({
        sessionManager: sessionManager as never,
        turnDispatcher,
        log: silentLog,
      });

      scheduler.addAgent("alice", [
        { name: "daily-report", cron: "0 9 * * *", prompt: "Generate report", enabled: true },
      ]);
      await scheduler._triggerForTest("alice", "daily-report");

      const db = new Database(dbPath, { readonly: true });
      const rows = db
        .prepare("SELECT id, turn_origin FROM traces WHERE agent = ?")
        .all("alice") as ReadonlyArray<{ id: string; turn_origin: string }>;
      expect(rows.length).toBe(1);
      const row = rows[0];

      expect(row.id).toMatch(TURN_ID_REGEX);
      expect(row.id.startsWith("scheduler:")).toBe(true);
      expect(row.turn_origin).toBeTypeOf("string");

      const parsed = TurnOriginSchema.parse(JSON.parse(row.turn_origin));
      expect(parsed.source.kind).toBe("scheduler");
      expect(parsed.source.id).toBe("daily-report");
      expect(parsed.rootTurnId).toBe(row.id);
      expect(parsed.parentTurnId).toBeNull();
      expect(parsed.chain).toEqual([row.id]);

      expect(sessionManager.dispatchTurn).toHaveBeenCalledTimes(1);
      expect(sessionManager.dispatchTurn).toHaveBeenCalledWith(
        "alice",
        "Generate report",
        expect.objectContaining({ id: row.id }),
        { signal: undefined },
      );

      store.close();
      db.close();
      scheduler.stop();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
