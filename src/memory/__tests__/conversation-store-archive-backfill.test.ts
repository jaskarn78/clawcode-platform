/**
 * Phase 999.42 capability A (Plan 02 T-02) —
 * `ConversationStore.backfillSessionArchive` one-shot summary-only backfill.
 *
 * Proves: for every `status='summarized'` session with no `session_archive`
 * row, an archive row is written from the session-summary memory content
 * (`archived_from='summary-only'`, `has_untrusted_turn=0`). Sessions with
 * no resolvable summary memory are skipped; an already-archived session is
 * skipped; a second invocation short-circuits (`alreadyRun: true`).
 *
 * The end-to-end consolidation-surviving cross-session search proof (T-03)
 * lives in `conversation-store-archive-e2e.test.ts`.
 *
 * Uses a temp-file `memory.db` so FTS5 triggers fire against a real
 * better-sqlite3 connection.
 */

import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { nanoid } from "nanoid";
import { MemoryStore } from "../store.js";
import { ConversationStore } from "../conversation-store.js";

describe("ConversationStore.backfillSessionArchive (Phase 999.42 capability A, Plan 02)", () => {
  let dir: string;
  let memStore: MemoryStore;
  let convStore: ConversationStore;

  afterEach(() => {
    memStore?.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  function setup(): void {
    dir = mkdtempSync(join(tmpdir(), "conv-backfill-"));
    memStore = new MemoryStore(join(dir, "memory.db"), {
      enabled: false,
      similarityThreshold: 0.85,
    });
    convStore = new ConversationStore(memStore.getDatabase());
  }

  /** Insert a `memories` row directly; returns the generated id. */
  function seedMemory(content: string): string {
    const id = nanoid();
    const now = new Date().toISOString();
    memStore
      .getDatabase()
      .prepare(
        `INSERT INTO memories
           (id, content, source, importance, tags, created_at, updated_at, accessed_at)
         VALUES (?, ?, 'conversation', 0.78, '["session-summary"]', ?, ?, ?)`,
      )
      .run(id, content, now, now, now);
    return id;
  }

  /**
   * Seed a `status='summarized'` session. `summaryContent` null → the
   * session has no summary_memory_id (the skip case). Returns the session id.
   * The session is created via the real state machine
   * (start → end → markSummarized) so summary_memory_id wiring is realistic.
   */
  function seedSummarizedSession(summaryContent: string | null): string {
    const session = convStore.startSession("agent-a");
    convStore.endSession(session.id);
    if (summaryContent !== null) {
      const memId = seedMemory(summaryContent);
      convStore.markSummarized(session.id, memId);
    } else {
      // markSummarized requires a memory id; flip status directly so the
      // row lands in 'summarized' with summary_memory_id still NULL.
      memStore
        .getDatabase()
        .prepare(
          `UPDATE conversation_sessions SET status = 'summarized' WHERE id = ?`,
        )
        .run(session.id);
    }
    return session.id;
  }

  it("backfills a summary-only archive row for a summarized session with a valid summary memory", () => {
    setup();
    const sessionId = seedSummarizedSession(
      "## Decisions\n- Chose the gravastar config",
    );

    const result = convStore.backfillSessionArchive();

    expect(result).toEqual({ backfilled: 1, skipped: 0, alreadyRun: false });
    expect(convStore.hasArchive(sessionId)).toBe(true);

    const row = memStore
      .getDatabase()
      .prepare(
        `SELECT archived_from, has_untrusted_turn, full_text
         FROM session_archive WHERE session_id = ?`,
      )
      .get(sessionId) as {
      archived_from: string;
      has_untrusted_turn: number;
      full_text: string;
    };
    expect(row.archived_from).toBe("summary-only");
    expect(row.has_untrusted_turn).toBe(0);
    expect(row.full_text).toContain("gravastar");
  });

  it("skips a summarized session with a null summary_memory_id (counted, not inserted)", () => {
    setup();
    const sessionId = seedSummarizedSession(null);

    const result = convStore.backfillSessionArchive();

    expect(result).toEqual({ backfilled: 0, skipped: 1, alreadyRun: false });
    expect(convStore.hasArchive(sessionId)).toBe(false);
  });

  it("skips a summarized session whose referenced summary memory row is missing", () => {
    setup();
    const session = convStore.startSession("agent-a");
    convStore.endSession(session.id);
    const memId = seedMemory("temp summary");
    convStore.markSummarized(session.id, memId);
    // Delete the memory row so summary_memory_id now dangles. The
    // summary_memory_id FK (no ON DELETE action) would otherwise block this;
    // toggling foreign_keys off lets the test construct the dangling state
    // the backfill's defensive `!memRow` guard exists to handle (FK
    // enforcement can be off, or a memory can be removed out-of-band).
    const db = memStore.getDatabase();
    db.pragma("foreign_keys = OFF");
    db.prepare(`DELETE FROM memories WHERE id = ?`).run(memId);
    db.pragma("foreign_keys = ON");

    const result = convStore.backfillSessionArchive();

    expect(result).toEqual({ backfilled: 0, skipped: 1, alreadyRun: false });
    expect(convStore.hasArchive(session.id)).toBe(false);
  });

  it("skips a summarized session that already has a session_archive row", () => {
    setup();
    // A summarized session that was already archived (e.g. via the live
    // T-01 path) — the hasArchive guard must skip it.
    const session = convStore.startSession("agent-a");
    convStore.recordTurn({
      sessionId: session.id,
      role: "user",
      content: "live path turn",
      isTrustedChannel: true,
    });
    convStore.endSession(session.id);
    const memId = seedMemory("summary for the already-archived session");
    convStore.markSummarized(session.id, memId);
    convStore.archiveSession(session.id); // archived_from='full'

    const result = convStore.backfillSessionArchive();

    expect(result).toEqual({ backfilled: 0, skipped: 1, alreadyRun: false });
    // The existing 'full' row was NOT overwritten with a summary-only one.
    const row = memStore
      .getDatabase()
      .prepare(`SELECT archived_from FROM session_archive WHERE session_id = ?`)
      .get(session.id) as { archived_from: string };
    expect(row.archived_from).toBe("full");
  });

  it("is one-shot — a second call returns alreadyRun:true and inserts nothing", () => {
    setup();
    seedSummarizedSession("## Decisions\n- first run summary");

    const first = convStore.backfillSessionArchive();
    expect(first).toEqual({ backfilled: 1, skipped: 0, alreadyRun: false });

    // Seed a fresh summarized session AFTER the first backfill ran — the
    // one-shot guard must short-circuit and NOT pick it up.
    const lateSession = seedSummarizedSession("## Decisions\n- late session");

    const second = convStore.backfillSessionArchive();
    expect(second).toEqual({ backfilled: 0, skipped: 0, alreadyRun: true });
    expect(convStore.hasArchive(lateSession)).toBe(false);

    // Exactly one session_archive row total (the first run's).
    const count = memStore
      .getDatabase()
      .prepare(`SELECT COUNT(*) AS n FROM session_archive`)
      .get() as { n: number };
    expect(count.n).toBe(1);
  });

  it("handles a mixed batch — valid + null + missing — with correct counts in one run", () => {
    setup();
    const valid1 = seedSummarizedSession("## Decisions\n- valid one");
    const valid2 = seedSummarizedSession("## Decisions\n- valid two");
    const nullSummary = seedSummarizedSession(null);

    const result = convStore.backfillSessionArchive();

    expect(result).toEqual({ backfilled: 2, skipped: 1, alreadyRun: false });
    expect(convStore.hasArchive(valid1)).toBe(true);
    expect(convStore.hasArchive(valid2)).toBe(true);
    expect(convStore.hasArchive(nullSummary)).toBe(false);
  });

  it("records a session_archive_backfill_v1 migrations row after the run", () => {
    setup();
    seedSummarizedSession("## Decisions\n- summary");
    convStore.backfillSessionArchive();

    const migRow = memStore
      .getDatabase()
      .prepare(
        `SELECT phase, progress_processed, progress_total
         FROM migrations WHERE key = 'session_archive_backfill_v1'`,
      )
      .get() as
      | { phase: string; progress_processed: number; progress_total: number }
      | undefined;
    expect(migRow).toBeDefined();
    expect(migRow?.phase).toBe("999.42-02");
    expect(migRow?.progress_processed).toBe(1);
    expect(migRow?.progress_total).toBe(1);
  });
});
