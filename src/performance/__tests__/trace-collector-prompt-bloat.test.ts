/**
 * Phase 115 post-deploy patch (2026-05-08) — TraceCollector
 * prompt_bloat_warnings_24h producer tests.
 *
 * Pin the contract:
 *   - bumpPromptBloatWarning increments per-turn counter when active turn
 *   - 3 distinct fires within a turn → counter = 3
 *   - turn with no fires → column NULL (legacy compat)
 *   - out-of-turn fires roll up via pendingPromptBloatWarningsByAgent and
 *     drain into next ended turn (mirrors lazy-recall pattern)
 *   - Turn.end() persists the count via writeTurn → traces.db column
 *   - Per-agent isolation
 *   - bump after end() is a no-op (post-commit guard)
 *   - 24h dashboard SUM aggregator picks up the counts (verifies the
 *     producer + reader path together)
 *
 * Mirrors trace-collector-lazy-recall.test.ts patterns; the prompt-bloat
 * producer was wired via the SAME plumbing because the
 * `PromptBloatTraceSink` interface in session-adapter.ts was designed
 * specifically to be filled by the TraceCollector duck-typed method.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import pino from "pino";
import { TraceStore } from "../trace-store.js";
import { TraceCollector } from "../trace-collector.js";

describe("TraceCollector — Phase 115 post-deploy patch prompt_bloat_warnings_24h", () => {
  let store: TraceStore;
  let collector: TraceCollector;
  let tempDir: string;
  let dbPath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "trace-collector-bloat-"));
    dbPath = join(tempDir, "traces.db");
    store = new TraceStore(dbPath);
    const log = pino({ level: "silent" });
    collector = new TraceCollector(store, log);
  });

  afterEach(() => {
    try {
      store.close();
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  });

  it("incrementPromptBloatWarning during active turn → counter = 1", () => {
    const turn = collector.startTurn("msg-1", "atlas", "chan-1");
    collector.incrementPromptBloatWarning("atlas");
    turn.end("error");

    const row = store
      .getDatabase()
      .prepare(
        "SELECT prompt_bloat_warnings_24h FROM traces WHERE id = 'msg-1'",
      )
      .get() as { prompt_bloat_warnings_24h: number | null };
    expect(row.prompt_bloat_warnings_24h).toBe(1);
  });

  it("3 distinct classifier fires within a turn → counter = 3", () => {
    const turn = collector.startTurn("msg-2", "atlas", null);
    collector.incrementPromptBloatWarning("atlas");
    collector.incrementPromptBloatWarning("atlas");
    collector.incrementPromptBloatWarning("atlas");
    turn.end("error");

    const row = store
      .getDatabase()
      .prepare(
        "SELECT prompt_bloat_warnings_24h FROM traces WHERE id = 'msg-2'",
      )
      .get() as { prompt_bloat_warnings_24h: number | null };
    expect(row.prompt_bloat_warnings_24h).toBe(3);
  });

  it("turn with no classifier fires → column NULL (legacy compat)", () => {
    const turn = collector.startTurn("msg-3", "atlas", null);
    turn.end("success");

    const row = store
      .getDatabase()
      .prepare(
        "SELECT prompt_bloat_warnings_24h FROM traces WHERE id = 'msg-3'",
      )
      .get() as { prompt_bloat_warnings_24h: number | null };
    expect(row.prompt_bloat_warnings_24h).toBeNull();
  });

  it("out-of-turn fires roll up; next turn drains them", () => {
    // No active turn — increments land in rolling counter.
    collector.incrementPromptBloatWarning("atlas");
    collector.incrementPromptBloatWarning("atlas");

    // Start a turn — drainPendingPromptBloatWarnings should pick them up at end().
    const turn = collector.startTurn("msg-4", "atlas", null);
    // One more fire inside the turn.
    collector.incrementPromptBloatWarning("atlas");
    turn.end("error");

    const row = store
      .getDatabase()
      .prepare(
        "SELECT prompt_bloat_warnings_24h FROM traces WHERE id = 'msg-4'",
      )
      .get() as { prompt_bloat_warnings_24h: number | null };
    expect(row.prompt_bloat_warnings_24h).toBe(3);

    // Rolling counter is now empty — a subsequent turn lands at NULL.
    const turn2 = collector.startTurn("msg-5", "atlas", null);
    turn2.end("success");
    const row2 = store
      .getDatabase()
      .prepare(
        "SELECT prompt_bloat_warnings_24h FROM traces WHERE id = 'msg-5'",
      )
      .get() as { prompt_bloat_warnings_24h: number | null };
    expect(row2.prompt_bloat_warnings_24h).toBeNull();
  });

  it("per-agent isolation — agent A bloat doesn't leak into agent B", () => {
    const turnA = collector.startTurn("msg-A", "agentA", null);
    const turnB = collector.startTurn("msg-B", "agentB", null);

    collector.incrementPromptBloatWarning("agentA");
    collector.incrementPromptBloatWarning("agentA");
    collector.incrementPromptBloatWarning("agentB");

    turnA.end("error");
    turnB.end("error");

    const rowA = store
      .getDatabase()
      .prepare(
        "SELECT prompt_bloat_warnings_24h FROM traces WHERE id = 'msg-A'",
      )
      .get() as { prompt_bloat_warnings_24h: number | null };
    const rowB = store
      .getDatabase()
      .prepare(
        "SELECT prompt_bloat_warnings_24h FROM traces WHERE id = 'msg-B'",
      )
      .get() as { prompt_bloat_warnings_24h: number | null };

    expect(rowA.prompt_bloat_warnings_24h).toBe(2);
    expect(rowB.prompt_bloat_warnings_24h).toBe(1);
  });

  it("recording after turn.end() is a no-op (post-commit guard)", () => {
    const turn = collector.startTurn("msg-6", "atlas", null);
    collector.incrementPromptBloatWarning("atlas");
    turn.end("error");
    // Post-end record — should NOT mutate the persisted row.
    // (Lands in rolling counter for next turn, NOT this turn.)
    collector.incrementPromptBloatWarning("atlas");

    const row = store
      .getDatabase()
      .prepare(
        "SELECT prompt_bloat_warnings_24h FROM traces WHERE id = 'msg-6'",
      )
      .get() as { prompt_bloat_warnings_24h: number | null };
    expect(row.prompt_bloat_warnings_24h).toBe(1);

    // Drain it on the next turn to confirm the rolling counter is healthy.
    const turn2 = collector.startTurn("msg-7", "atlas", null);
    turn2.end("success");
    const row2 = store
      .getDatabase()
      .prepare(
        "SELECT prompt_bloat_warnings_24h FROM traces WHERE id = 'msg-7'",
      )
      .get() as { prompt_bloat_warnings_24h: number | null };
    expect(row2.prompt_bloat_warnings_24h).toBe(1);
  });

  it("Turn.bumpPromptBloatWarning() can be called directly (DI escape hatch)", () => {
    const turn = collector.startTurn("msg-8", "atlas", null);
    turn.bumpPromptBloatWarning();
    turn.bumpPromptBloatWarning();
    turn.end("error");

    const row = store
      .getDatabase()
      .prepare(
        "SELECT prompt_bloat_warnings_24h FROM traces WHERE id = 'msg-8'",
      )
      .get() as { prompt_bloat_warnings_24h: number | null };
    expect(row.prompt_bloat_warnings_24h).toBe(2);
  });

  it("dashboard 24h SUM aggregator picks up counts across multiple turns", () => {
    // Turn 1 — 1 bloat warning
    const turn1 = collector.startTurn("msg-d1", "atlas", null);
    collector.incrementPromptBloatWarning("atlas");
    turn1.end("error");

    // Turn 2 — no bloat warnings (success turn)
    const turn2 = collector.startTurn("msg-d2", "atlas", null);
    turn2.end("success");

    // Turn 3 — 2 bloat warnings (multiple classifier fires)
    const turn3 = collector.startTurn("msg-d3", "atlas", null);
    collector.incrementPromptBloatWarning("atlas");
    collector.incrementPromptBloatWarning("atlas");
    turn3.end("error");

    // Dashboard SUM over the window should be 1 + 0 + 2 = 3.
    const r = store.getPhase115DashboardMetrics(
      "atlas",
      "2020-01-01T00:00:00.000Z",
    );
    expect(r.promptBloatWarnings24h).toBe(3);
  });

  it("matches the PromptBloatTraceSink contract (duck-typed by session-manager.ts)", () => {
    // session-manager.ts:2392-2406 builds the sink with this exact
    // interface — the test asserts the public method shape so a
    // future rename of the method on TraceCollector breaks this test
    // BEFORE it dark-ships to production.
    const sink: { incrementPromptBloatWarning?: (agent: string) => void } =
      collector as unknown as {
        incrementPromptBloatWarning?: (agent: string) => void;
      };
    expect(typeof sink.incrementPromptBloatWarning).toBe("function");

    // Sanity: invoking via the duck-typed interface works.
    const turn = collector.startTurn("msg-sink", "atlas", null);
    sink.incrementPromptBloatWarning?.("atlas");
    turn.end("error");

    const row = store
      .getDatabase()
      .prepare(
        "SELECT prompt_bloat_warnings_24h FROM traces WHERE id = 'msg-sink'",
      )
      .get() as { prompt_bloat_warnings_24h: number | null };
    expect(row.prompt_bloat_warnings_24h).toBe(1);
  });
});
