/**
 * Phase 999.42 capability A (Plan 02 T-01) — `archiveSession` wired into
 * `summarizeSession`.
 *
 * Proves the archive-before-prune contract:
 *  1. A successful summarization writes a `full`-fidelity `session_archive`
 *     row containing the raw turn text — captured BEFORE `deleteTurnsForSession`
 *     prunes the turns.
 *  2. The archive write is NON-FATAL: a thrown `archiveSession` does not
 *     propagate out of `summarizeSession` (the line-178 "never throws"
 *     invariant holds), the prune still runs, and a warn log fires.
 *  3. When `markSummarized` fails, `archiveSession` is NOT called and the
 *     turns are NOT pruned — the operator-reconcile path is preserved.
 *
 * Uses a real `MemoryStore` + `ConversationStore` over an in-memory db;
 * the only injected failure points are `archiveSession` / `markSummarized`
 * via `vi.spyOn`.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { Logger } from "pino";
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

/** A pino-shaped logger whose info/warn calls are captured for assertions. */
function captureLog(): {
  log: Logger;
  info: ReturnType<typeof vi.fn>;
  warn: ReturnType<typeof vi.fn>;
} {
  const info = vi.fn();
  const warn = vi.fn();
  const log = {
    info,
    warn,
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
    child: () => log,
  } as unknown as Logger;
  return { log, info, warn };
}

describe("summarizeSession — archiveSession wiring (Phase 999.42 capability A)", () => {
  let memStore: MemoryStore;
  let convStore: ConversationStore;

  beforeEach(() => {
    memStore = new MemoryStore(":memory:", {
      enabled: false,
      similarityThreshold: 0.85,
    });
    convStore = new ConversationStore(memStore.getDatabase());
  });

  afterEach(() => {
    memStore?.close();
  });

  /** Seed a 5-turn ended session whose turns carry a distinctive token. */
  function seedEndedSession(): string {
    const session = convStore.startSession("agent-a");
    for (let i = 0; i < 5; i++) {
      convStore.recordTurn({
        sessionId: session.id,
        role: i % 2 === 0 ? "user" : "assistant",
        content: `Turn ${i} discussing the zephyrwidget deployment plan.`,
        isTrustedChannel: true,
      });
    }
    convStore.endSession(session.id);
    return session.id;
  }

  const llmSummarize: SummarizeFn = vi
    .fn()
    .mockResolvedValue(
      "## User Preferences\n(none)\n\n## Decisions\n- Shipped\n\n## Open Threads\n(none)\n\n## Commitments\n(none)\n",
    );

  it("writes a full-fidelity session_archive row with the raw turn text before the turns are pruned", async () => {
    const sessionId = seedEndedSession();
    const deps: SummarizeSessionDeps = {
      conversationStore: convStore,
      memoryStore: memStore,
      embedder: createMockEmbedder(),
      summarize: llmSummarize,
      log: captureLog().log,
    };

    const result = await summarizeSession(
      { agentName: "agent-a", sessionId },
      deps,
    );

    expect(result).toMatchObject({ success: true });

    // The archive row exists, is full-fidelity, and carries the raw text.
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
    expect(row.archived_from).toBe("full");
    expect(row.has_untrusted_turn).toBe(0);
    // The raw turn token survives in the archive even though...
    expect(row.full_text).toContain("zephyrwidget");

    // ...the prune removed every raw turn — the archive captured them first.
    expect(convStore.getTurnsForSession(sessionId)).toHaveLength(0);
  });

  it("is non-fatal when archiveSession throws — summarizeSession still succeeds, the prune still runs, a warn log fires", async () => {
    const sessionId = seedEndedSession();
    const { log, warn } = captureLog();

    const archiveSpy = vi
      .spyOn(convStore, "archiveSession")
      .mockImplementation(() => {
        throw new Error("injected archive failure");
      });

    const deps: SummarizeSessionDeps = {
      conversationStore: convStore,
      memoryStore: memStore,
      embedder: createMockEmbedder(),
      summarize: llmSummarize,
      log,
    };

    const result = await summarizeSession(
      { agentName: "agent-a", sessionId },
      deps,
    );

    // summarizeSession never throws — it still returns a success result.
    expect(result).toMatchObject({ success: true });
    expect(archiveSpy).toHaveBeenCalledOnce();

    // The prune still ran despite the archive failure — turns are gone.
    expect(convStore.getTurnsForSession(sessionId)).toHaveLength(0);
    // No archive row was written (the only call threw).
    expect(convStore.hasArchive(sessionId)).toBe(false);

    // A warn log explicitly flagged the non-fatal archive failure.
    const warnedArchiveFailure = warn.mock.calls.some(
      (call) =>
        typeof call[1] === "string" &&
        call[1].includes("session archival failed before prune"),
    );
    expect(warnedArchiveFailure).toBe(true);

    archiveSpy.mockRestore();
  });

  it("does NOT call archiveSession and does NOT prune turns when markSummarized fails", async () => {
    const sessionId = seedEndedSession();

    const markSpy = vi
      .spyOn(convStore, "markSummarized")
      .mockImplementation(() => {
        throw new Error("race: session already summarized");
      });
    const archiveSpy = vi.spyOn(convStore, "archiveSession");
    const deleteSpy = vi.spyOn(convStore, "deleteTurnsForSession");

    const deps: SummarizeSessionDeps = {
      conversationStore: convStore,
      memoryStore: memStore,
      embedder: createMockEmbedder(),
      summarize: llmSummarize,
      log: captureLog().log,
    };

    const result = await summarizeSession(
      { agentName: "agent-a", sessionId },
      deps,
    );

    // markSummarized failure is swallowed — the memory row still exists.
    expect(result).toMatchObject({ success: true });
    expect(markSpy).toHaveBeenCalledOnce();

    // The archive + prune are both gated on markSummarizedSucceeded — neither ran.
    expect(archiveSpy).not.toHaveBeenCalled();
    expect(deleteSpy).not.toHaveBeenCalled();

    // The turns are kept for operator reconcile; nothing was archived.
    expect(convStore.getTurnsForSession(sessionId)).toHaveLength(5);
    expect(convStore.hasArchive(sessionId)).toBe(false);

    markSpy.mockRestore();
    archiveSpy.mockRestore();
    deleteSpy.mockRestore();
  });
});
