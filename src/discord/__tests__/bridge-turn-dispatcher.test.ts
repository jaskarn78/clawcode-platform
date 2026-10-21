import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import pino from "pino";
import { TraceStore } from "../../performance/trace-store.js";
import { TraceCollector } from "../../performance/trace-collector.js";
import { TurnDispatcher } from "../../manager/turn-dispatcher.js";
import {
  TurnOriginSchema,
  makeRootOriginWithTurnId,
  DISCORD_SNOWFLAKE_PREFIX,
} from "../../manager/turn-origin.js";

const silentLog = pino({ level: "silent" });

describe("Phase 57 Plan 03 — Discord turn origin persistence (daemon path)", () => {
  it("dispatchStream with Discord origin writes turn_origin JSON to traces.db", async () => {
    const dir = mkdtempSync(join(tmpdir(), "discord-origin-"));
    const dbPath = join(dir, "traces.db");
    try {
      const store = new TraceStore(dbPath);
      const collector = new TraceCollector(store, silentLog);

      const sessionManager = {
        dispatchTurn: vi.fn(),
        streamFromAgent: vi.fn(async () => "reply"),
        getTraceCollector: vi.fn(() => collector),
      };
      const dispatcher = new TurnDispatcher({
        sessionManager: sessionManager as never,
        log: silentLog,
      });

      // Simulate DiscordBridge's caller-owned Turn pattern: pre-open the Turn
      // with a receive span (bridge does this before dispatchStream so the
      // span is already inside the in-memory buffer when dispatch runs).
      const messageId = "000000000000000022"; // Discord snowflake
      const turnId = `${DISCORD_SNOWFLAKE_PREFIX}${messageId}`;
      const origin = makeRootOriginWithTurnId("discord", messageId, turnId);
      const turn = collector.startTurn(turnId, "alice", "chan_42");

      await dispatcher.dispatchStream(origin, "alice", "hi", () => {}, {
        turn,
        channelId: "chan_42",
      });

      // Caller owns Turn.end — simulate the bridge's try/catch end call
      turn.end("success");

      const db = new Database(dbPath, { readonly: true });
      const row = db
        .prepare("SELECT id, discord_channel_id, turn_origin FROM traces WHERE id = ?")
        .get(turnId) as {
          id: string;
          discord_channel_id: string | null;
          turn_origin: string;
        };
      expect(row.id).toBe(turnId);
      expect(row.discord_channel_id).toBe("chan_42");
      expect(row.turn_origin).toBeTypeOf("string");

      const parsed = TurnOriginSchema.parse(JSON.parse(row.turn_origin));
      expect(parsed.source.kind).toBe("discord");
      expect(parsed.source.id).toBe(messageId);
      expect(parsed.rootTurnId).toBe(turnId);
      expect(parsed.parentTurnId).toBeNull();
      expect(parsed.chain).toEqual([turnId]);

      store.close();
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fleet-audit H5 — v3 path records turn_origin without TurnDispatcher", () => {
    // The v3 dispatch branches (worker-pool + persistent push) bypass
    // TurnDispatcher, so before H5 their trace rows had a NULL turn_origin
    // (research's telemetry black hole). The H5 fix records the origin DIRECTLY
    // on the caller-owned Turn — `turn.recordOrigin(makeRootOriginWithTurnId(...))`
    // — exactly as exercised here. This pins that a directly-recorded origin
    // persists to traces.db with the same shape the SDK path produces, so a
    // v3 turn is no longer origin-invisible.
    const dir = mkdtempSync(join(tmpdir(), "discord-origin-v3-"));
    const dbPath = join(dir, "traces.db");
    try {
      const store = new TraceStore(dbPath);
      const collector = new TraceCollector(store, silentLog);

      const messageId = "000000000000000036"; // Discord snowflake
      const turnId = `${DISCORD_SNOWFLAKE_PREFIX}${messageId}`;
      const turn = collector.startTurn(turnId, "research", "chan_v3");

      // Mirror the H5 bridge.ts block: build the origin from the same turnId
      // the caller used for startTurn + record it directly (no dispatcher).
      turn.recordOrigin(
        makeRootOriginWithTurnId("discord", messageId, turnId),
      );
      turn.end("success");

      const db = new Database(dbPath, { readonly: true });
      const row = db
        .prepare("SELECT id, turn_origin FROM traces WHERE id = ?")
        .get(turnId) as { id: string; turn_origin: string };
      expect(row.id).toBe(turnId);
      expect(row.turn_origin).toBeTypeOf("string");

      const parsed = TurnOriginSchema.parse(JSON.parse(row.turn_origin));
      expect(parsed.source.kind).toBe("discord");
      expect(parsed.source.id).toBe(messageId);
      expect(parsed.rootTurnId).toBe(turnId);
      expect(parsed.parentTurnId).toBeNull();

      store.close();
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
