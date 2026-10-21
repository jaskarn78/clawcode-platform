/**
 * Phase 999.42 capability A (Plan 02 T-03) — end-to-end archive coverage:
 * the CONSOLIDATION-SURVIVING CROSS-SESSION SEARCH proof.
 *
 * This is capability A's reason to exist. ClawCode's turn-level
 * `conversation_turns_fts` index is wiped at consolidation — the
 * `conversation_turns_ad` trigger drops the FTS rows when
 * `deleteTurnsForSession` prunes a summarized session's turns. So before
 * this capability, cross-session full-text search saw only NON-summarized
 * (live) sessions. The `session_archive` + `session_archive_fts` layer
 * makes content from a consolidated session STILL findable.
 *
 * Two scenarios, both proven at the store layer over a real temp-file
 * `better-sqlite3` db so the FTS5 triggers fire:
 *  - Scenario A (full fidelity): a session summarized via the T-01 live
 *    path (raw turns pruned) — a raw-turn word is still matchable via
 *    `session_archive_fts MATCH`, `archived_from='full'`.
 *  - Scenario B (summary-only): a pre-existing summarized session
 *    backfilled by `backfillSessionArchive` — a SUMMARY word is matchable,
 *    `archived_from='summary-only'`.
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { nanoid } from "nanoid";
import pino from "pino";
import { MemoryStore } from "../store.js";
import { ConversationStore } from "../conversation-store.js";
import type { EmbeddingService } from "../embedder.js";
import type {
  SummarizeFn,
  SummarizeSessionDeps,
} from "../session-summarizer.types.js";
import { summarizeSession } from "../session-summarizer.js";

function createMockEmbedder(): EmbeddingService {
  return {
    embed: vi.fn().mockResolvedValue(new Float32Array(384).fill(0.1)),
    warmup: vi.fn().mockResolvedValue(undefined),
    isReady: vi.fn().mockReturnValue(true),
  } as unknown as EmbeddingService;
}

describe("session_archive end-to-end — consolidation-surviving cross-session search (Plan 02 T-03)", () => {
  let dir: string;
  let memStore: MemoryStore;
  let convStore: ConversationStore;

  afterEach(() => {
    memStore?.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  function setup(): void {
    dir = mkdtempSync(join(tmpdir(), "conv-archive-e2e-"));
    memStore = new MemoryStore(join(dir, "memory.db"), {
      enabled: false,
      similarityThreshold: 0.85,
    });
    convStore = new ConversationStore(memStore.getDatabase());
  }

  /** FTS5 MATCH over session_archive_fts → joined archive row, or undefined. */
  function ftsLookup(
    word: string,
  ): { sessionId: string; archivedFrom: string } | undefined {
    return memStore
      .getDatabase()
      .prepare(
        `SELECT sa.session_id AS sessionId, sa.archived_from AS archivedFrom
         FROM session_archive_fts
         JOIN session_archive sa ON sa.rowid = session_archive_fts.rowid
         WHERE session_archive_fts MATCH ?`,
      )
      .get(word) as { sessionId: string; archivedFrom: string } | undefined;
  }

  it("Scenario A — full fidelity: a consolidated session's raw-turn content stays findable via session_archive_fts", async () => {
    setup();

    // Record a real session with a distinctive raw-turn token.
    const session = convStore.startSession("agent-a");
    for (let i = 0; i < 4; i++) {
      convStore.recordTurn({
        sessionId: session.id,
        role: i % 2 === 0 ? "user" : "assistant",
        content: `Turn ${i} mentions the phlogiston extractor design.`,
        isTrustedChannel: true,
      });
    }
    convStore.endSession(session.id);

    const llmSummarize: SummarizeFn = vi
      .fn()
      .mockResolvedValue("## Decisions\n- Built it\n");
    const deps: SummarizeSessionDeps = {
      conversationStore: convStore,
      memoryStore: memStore,
      embedder: createMockEmbedder(),
      summarize: llmSummarize,
      log: pino({ level: "silent" }),
    };

    const result = await summarizeSession(
      { agentName: "agent-a", sessionId: session.id },
      deps,
    );
    expect(result).toMatchObject({ success: true });

    // The session was consolidated — raw turns pruned.
    expect(convStore.getTurnsForSession(session.id)).toHaveLength(0);

    // ...yet the raw-turn word is STILL findable via the archive FTS index.
    // This is the consolidation-surviving cross-session search proof.
    const hit = ftsLookup("phlogiston");
    expect(hit).toBeDefined();
    expect(hit?.sessionId).toBe(session.id);
    expect(hit?.archivedFrom).toBe("full");
  });

  it("Scenario B — summary-only: a pre-existing summarized session's summary text is findable after backfill", () => {
    setup();

    // A session summarized BEFORE this plan — turns already absent — with a
    // summary memory carrying a distinctive word.
    const session = convStore.startSession("agent-a");
    convStore.endSession(session.id);
    const memId = nanoid();
    const now = new Date().toISOString();
    memStore
      .getDatabase()
      .prepare(
        `INSERT INTO memories
           (id, content, source, importance, tags, created_at, updated_at, accessed_at)
         VALUES (?, ?, 'conversation', 0.78, '["session-summary"]', ?, ?, ?)`,
      )
      .run(
        memId,
        "## Decisions\n- Adopted the chronosynclastic infundibulum approach",
        now,
        now,
        now,
      );
    convStore.markSummarized(session.id, memId);

    const result = convStore.backfillSessionArchive();
    expect(result.backfilled).toBe(1);

    // The summary word is findable via the archive FTS index — the
    // consolidation-surviving cross-session search proof for the
    // summary-only (pre-existing-session) path.
    const hit = ftsLookup("chronosynclastic");
    expect(hit).toBeDefined();
    expect(hit?.sessionId).toBe(session.id);
    expect(hit?.archivedFrom).toBe("summary-only");
  });
});
