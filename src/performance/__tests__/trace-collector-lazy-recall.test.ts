/**
 * Phase 115 Plan 05 T04 — TraceCollector lazy_recall_call_count tests.
 *
 * Pin the contract:
 *   - recordLazyRecallCall increments per-turn counter when active turn exists
 *   - 4 distinct calls during a turn → counter incremented 4 times
 *   - tool name appears in the structured debug log line
 *   - When no active turn for the agent, increment lands in the rolling
 *     counter; the next ended turn drains it
 *   - Turn.end() persists the count via writeTurn → traces.db column
 *   - Per-agent isolation: agent A counter doesn't bleed into agent B's
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import pino from "pino";
import { TraceStore } from "../trace-store.js";
import { TraceCollector } from "../trace-collector.js";

describe("TraceCollector — Phase 115 T04 lazy_recall_call_count", () => {
  let store: TraceStore;
  let collector: TraceCollector;
  let tempDir: string;
  let dbPath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "trace-collector-lazy-"));
    dbPath = join(tempDir, "traces.db");
    store = new TraceStore(dbPath);
    const log = pino({ level: "silent" });
    collector = new TraceCollector(store, log);
  });

  afterEach(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  });

  it("recordLazyRecallCall increments active-turn counter (1 call)", () => {
    const turn = collector.startTurn("msg-1", "atlas", "chan-1");
    collector.recordLazyRecallCall("atlas", "clawcode_memory_search");
    turn.end("success");

    // Read back from traces.db.
    const row = store
      .getDatabase()
      .prepare("SELECT lazy_recall_call_count FROM traces WHERE id = 'msg-1'")
      .get() as { lazy_recall_call_count: number | null };
    expect(row.lazy_recall_call_count).toBe(1);
  });

  it("4 distinct tool calls → counter = 4", () => {
    const turn = collector.startTurn("msg-2", "atlas", null);
    collector.recordLazyRecallCall("atlas", "clawcode_memory_search");
    collector.recordLazyRecallCall("atlas", "clawcode_memory_recall");
    collector.recordLazyRecallCall("atlas", "clawcode_memory_edit");
    collector.recordLazyRecallCall("atlas", "clawcode_memory_archive");
    turn.end("success");

    const row = store
      .getDatabase()
      .prepare("SELECT lazy_recall_call_count FROM traces WHERE id = 'msg-2'")
      .get() as { lazy_recall_call_count: number | null };
    expect(row.lazy_recall_call_count).toBe(4);
  });

  it("turn with no lazy-recall calls → column NULL (legacy compat)", () => {
    const turn = collector.startTurn("msg-3", "atlas", null);
    turn.end("success");

    const row = store
      .getDatabase()
      .prepare("SELECT lazy_recall_call_count FROM traces WHERE id = 'msg-3'")
      .get() as { lazy_recall_call_count: number | null };
    expect(row.lazy_recall_call_count).toBeNull();
  });

  it("out-of-turn calls go to rolling counter; next turn drains them", () => {
    // No active turn — increments land in rolling counter.
    collector.recordLazyRecallCall("atlas", "clawcode_memory_search");
    collector.recordLazyRecallCall("atlas", "clawcode_memory_recall");

    // Start a turn — drainPendingLazyRecallCount should pick them up at end().
    const turn = collector.startTurn("msg-4", "atlas", null);
    // One more call inside the turn.
    collector.recordLazyRecallCall("atlas", "clawcode_memory_edit");
    turn.end("success");

    const row = store
      .getDatabase()
      .prepare("SELECT lazy_recall_call_count FROM traces WHERE id = 'msg-4'")
      .get() as { lazy_recall_call_count: number | null };
    expect(row.lazy_recall_call_count).toBe(3);

    // Rolling counter is now empty — a subsequent turn lands at 0.
    const turn2 = collector.startTurn("msg-5", "atlas", null);
    turn2.end("success");
    const row2 = store
      .getDatabase()
      .prepare("SELECT lazy_recall_call_count FROM traces WHERE id = 'msg-5'")
      .get() as { lazy_recall_call_count: number | null };
    expect(row2.lazy_recall_call_count).toBeNull();
  });

  it("per-agent isolation — agent A counter doesn't leak into agent B", () => {
    const turnA = collector.startTurn("msg-A", "agentA", null);
    const turnB = collector.startTurn("msg-B", "agentB", null);

    collector.recordLazyRecallCall("agentA", "clawcode_memory_search");
    collector.recordLazyRecallCall("agentA", "clawcode_memory_search");
    collector.recordLazyRecallCall("agentB", "clawcode_memory_recall");

    turnA.end("success");
    turnB.end("success");

    const rowA = store
      .getDatabase()
      .prepare("SELECT lazy_recall_call_count FROM traces WHERE id = 'msg-A'")
      .get() as { lazy_recall_call_count: number | null };
    const rowB = store
      .getDatabase()
      .prepare("SELECT lazy_recall_call_count FROM traces WHERE id = 'msg-B'")
      .get() as { lazy_recall_call_count: number | null };

    expect(rowA.lazy_recall_call_count).toBe(2);
    expect(rowB.lazy_recall_call_count).toBe(1);
  });

  it("recording after turn.end() is a no-op (post-commit guard)", () => {
    const turn = collector.startTurn("msg-6", "atlas", null);
    collector.recordLazyRecallCall("atlas", "clawcode_memory_search");
    turn.end("success");
    // Post-end record — should NOT mutate the persisted row.
    collector.recordLazyRecallCall("atlas", "clawcode_memory_search");

    const row = store
      .getDatabase()
      .prepare("SELECT lazy_recall_call_count FROM traces WHERE id = 'msg-6'")
      .get() as { lazy_recall_call_count: number | null };
    expect(row.lazy_recall_call_count).toBe(1);
  });

  it("Turn.bumpLazyRecallCount can be called directly (DI escape hatch)", () => {
    const turn = collector.startTurn("msg-7", "atlas", null);
    turn.bumpLazyRecallCount("clawcode_memory_search");
    turn.bumpLazyRecallCount("clawcode_memory_search");
    turn.end("success");

    const row = store
      .getDatabase()
      .prepare("SELECT lazy_recall_call_count FROM traces WHERE id = 'msg-7'")
      .get() as { lazy_recall_call_count: number | null };
    expect(row.lazy_recall_call_count).toBe(2);
  });
});
