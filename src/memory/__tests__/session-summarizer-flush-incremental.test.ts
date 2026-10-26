/**
 * Memory overhaul 2026-10-25 (WP1) — flush flood fixes in the session
 * summarizer.
 *
 * Live facts the fixes were designed against: on the production host 95
 * percent of memory rows were mid-session flush rows (8,892 of 9,270 for
 * one agent), 28 to 50 per session, because every 15-minute tick
 * re-summarized the whole session and nothing ever removed the rows.
 *
 * Covers:
 *   - flushSessionMidway summarizes only the turns recorded since the
 *     previous flush, skips under 4 new turns, writes importance 0.4 and
 *     a `flush-through:N` cursor tag, recovers the cursor from existing
 *     rows (tag or legacy sourceTurnIds) and honours an explicit cursor
 *   - summarizeSession deletes the session's mid-session rows (vectors
 *     included) and leaves other sessions' rows alone
 *   - buildSessionSummarizationPrompt keeps the head AND the tail of a
 *     truncated turn and drops whole oldest turns instead of starving all
 *
 * Same harness as session-summarizer.test.ts: real MemoryStore(":memory:")
 * plus real ConversationStore, mocked embedder and summarize function.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import pino from "pino";
import { MemoryStore } from "../store.js";
import { ConversationStore } from "../conversation-store.js";
import type { EmbeddingService } from "../embedder.js";
import type {
  SummarizeFn,
  SummarizeSessionDeps,
} from "../session-summarizer.types.js";
import {
  summarizeSession,
  flushSessionMidway,
  buildSessionSummarizationPrompt,
  truncateHeadTail,
  findLastFlushedTurnIndex,
  listMidSessionRows,
  deleteMidSessionRows,
  DEFAULT_FLUSH_IMPORTANCE,
  DEFAULT_FLUSH_MIN_NEW_TURNS,
  FLUSH_THROUGH_TAG_PREFIX,
  MAX_PROMPT_CHARS,
  MIN_CHARS_PER_TURN,
} from "../session-summarizer.js";
import type { ConversationTurn } from "../conversation-types.js";

function createMockEmbedder(): EmbeddingService {
  return {
    embed: vi.fn().mockResolvedValue(new Float32Array(384).fill(0.1)),
    warmup: vi.fn().mockResolvedValue(undefined),
    isReady: vi.fn().mockReturnValue(true),
  } as unknown as EmbeddingService;
}

function silentLog() {
  return pino({ level: "silent" });
}

function makeTurn(
  overrides: Partial<ConversationTurn> &
    Pick<ConversationTurn, "role" | "content" | "turnIndex">,
): ConversationTurn {
  return Object.freeze({
    id: overrides.id ?? `t-${overrides.turnIndex}`,
    sessionId: overrides.sessionId ?? "s-fixture",
    turnIndex: overrides.turnIndex,
    role: overrides.role,
    content: overrides.content,
    tokenCount: null,
    channelId: null,
    discordUserId: null,
    discordMessageId: null,
    isTrustedChannel: false,
    origin: null,
    instructionFlags: null,
    createdAt: "2026-10-25T00:00:00Z",
  });
}

describe("WP1: incremental mid-session flush", () => {
  let memStore: MemoryStore;
  let convStore: ConversationStore;
  let summarize: ReturnType<typeof vi.fn>;
  let deps: SummarizeSessionDeps;

  beforeEach(() => {
    memStore = new MemoryStore(":memory:", {
      enabled: false,
      similarityThreshold: 0.85,
    });
    convStore = new ConversationStore(memStore.getDatabase());
    summarize = vi.fn().mockResolvedValue("## User Preferences\n(none)\n");
    deps = {
      conversationStore: convStore,
      memoryStore: memStore,
      embedder: createMockEmbedder(),
      summarize: summarize as unknown as SummarizeFn,
      log: silentLog(),
    };
  });

  afterEach(() => {
    memStore?.close();
  });

  /** Record `count` turns on an active session; returns their ids. */
  function addTurns(sessionId: string, count: number, from = 0): string[] {
    const ids: string[] = [];
    for (let i = from; i < from + count; i++) {
      const turn = convStore.recordTurn({
        sessionId,
        role: i % 2 === 0 ? "user" : "assistant",
        content: `MARKER-TURN-${i} body with enough substance to matter.`,
      });
      ids.push(turn.id);
    }
    return ids;
  }

  function flush(sessionId: string, flushSequence: number, afterTurnIndex?: number) {
    return flushSessionMidway(
      { agentName: "agent-a", sessionId, flushSequence, afterTurnIndex },
      deps,
    );
  }

  it("defaults: importance 0.4 and a gate of 4 new turns", () => {
    expect(DEFAULT_FLUSH_IMPORTANCE).toBe(0.4);
    expect(DEFAULT_FLUSH_MIN_NEW_TURNS).toBe(4);
  });

  it("first flush covers every turn and carries the cursor tag", async () => {
    const session = convStore.startSession("agent-a");
    const ids = addTurns(session.id, 6);

    const result = await flush(session.id, 1);

    expect(result).toMatchObject({
      success: true,
      fallback: "llm",
      turnCount: 6,
      flushSequence: 1,
      lastTurnIndex: 5,
    });
    if (!("success" in result)) return;
    const entry = memStore.getById(result.memoryId)!;
    expect(entry.importance).toBe(DEFAULT_FLUSH_IMPORTANCE);
    expect(entry.tags).toContain("mid-session");
    expect(entry.tags).toContain(`session:${session.id}`);
    expect(entry.tags).toContain("flush:1");
    expect(entry.tags).toContain(`${FLUSH_THROUGH_TAG_PREFIX}5`);
    expect(entry.sourceTurnIds).toEqual(ids);
    // The prompt describes a segment of an ongoing session, not a completed one.
    const prompt = summarize.mock.calls[0][0] as string;
    expect(prompt).toContain("segment of an ongoing conversation session");
    expect(prompt).toContain("MARKER-TURN-0");
    expect(prompt).toContain("MARKER-TURN-5");
  });

  it("a tick with no new turns is a cheap skip: no Haiku call, no row", async () => {
    const session = convStore.startSession("agent-a");
    addTurns(session.id, 5);
    await flush(session.id, 1);
    summarize.mockClear();

    const result = await flush(session.id, 2);

    expect(result).toEqual({
      skipped: true,
      reason: "insufficient-new-turns",
      turnCount: 5,
      newTurnCount: 0,
    });
    expect(summarize).not.toHaveBeenCalled();
    expect(listMidSessionRows(memStore, session.id)).toHaveLength(1);
  });

  it("the second flush summarizes only the turns recorded since the first", async () => {
    const session = convStore.startSession("agent-a");
    addTurns(session.id, 4);
    await flush(session.id, 1);
    const newIds = addTurns(session.id, 4, 4);
    summarize.mockClear();

    const result = await flush(session.id, 2);

    expect(result).toMatchObject({ success: true, turnCount: 4, lastTurnIndex: 7 });
    if (!("success" in result)) return;
    const entry = memStore.getById(result.memoryId)!;
    expect(entry.sourceTurnIds).toEqual(newIds);
    expect(entry.tags).toContain(`${FLUSH_THROUGH_TAG_PREFIX}7`);
    const prompt = summarize.mock.calls[0][0] as string;
    expect(prompt).toContain("MARKER-TURN-4");
    expect(prompt).toContain("MARKER-TURN-7");
    expect(prompt).not.toContain("MARKER-TURN-0 ");
    expect(prompt).not.toContain("MARKER-TURN-3 ");
    expect(listMidSessionRows(memStore, session.id)).toHaveLength(2);
  });

  it("skips under 4 new turns and fires on the fourth", async () => {
    const session = convStore.startSession("agent-a");
    addTurns(session.id, 4);
    await flush(session.id, 1);
    addTurns(session.id, 3, 4);

    const skipped = await flush(session.id, 2);
    expect(skipped).toMatchObject({
      skipped: true,
      reason: "insufficient-new-turns",
      newTurnCount: 3,
    });

    addTurns(session.id, 1, 7);
    const written = await flush(session.id, 2);
    expect(written).toMatchObject({ success: true, turnCount: 4, lastTurnIndex: 7 });
  });

  it("an explicit afterTurnIndex overrides the recovered cursor", async () => {
    const session = convStore.startSession("agent-a");
    addTurns(session.id, 8);
    await flush(session.id, 1); // cursor now 7

    const result = await flush(session.id, 2, 3);

    expect(result).toMatchObject({ success: true, turnCount: 4, lastTurnIndex: 7 });
    if (!("success" in result)) return;
    const entry = memStore.getById(result.memoryId)!;
    expect(entry.sourceTurnIds).toHaveLength(4);
  });

  it("recovers the cursor from a legacy flush row that has sourceTurnIds but no cursor tag", async () => {
    const session = convStore.startSession("agent-a");
    const firstIds = addTurns(session.id, 4);
    // A row written before WP1: whole-session summary, no flush-through tag.
    memStore.insert(
      {
        content: "legacy flush",
        source: "conversation",
        importance: 0.65,
        tags: ["mid-session", `session:${session.id}`, "flush:1"],
        sourceTurnIds: firstIds,
        skipDedup: true,
      },
      new Float32Array(384).fill(0.2),
    );
    const turns = convStore.getTurnsForSession(session.id);
    expect(findLastFlushedTurnIndex(memStore, session.id, turns)).toBe(3);

    const newIds = addTurns(session.id, 4, 4);
    const result = await flush(session.id, 2);

    expect(result).toMatchObject({ success: true, turnCount: 4, lastTurnIndex: 7 });
    if (!("success" in result)) return;
    expect(memStore.getById(result.memoryId)!.sourceTurnIds).toEqual(newIds);
  });

  it("findLastFlushedTurnIndex is -1 with no flush rows and ignores other sessions", async () => {
    const a = convStore.startSession("agent-a");
    const b = convStore.startSession("agent-a");
    addTurns(a.id, 4);
    addTurns(b.id, 4);
    await flush(b.id, 1);

    expect(
      findLastFlushedTurnIndex(memStore, a.id, convStore.getTurnsForSession(a.id)),
    ).toBe(-1);
    expect(
      findLastFlushedTurnIndex(memStore, b.id, convStore.getTurnsForSession(b.id)),
    ).toBe(3);
  });

  it("flushMinNewTurns config lowers the gate", async () => {
    const session = convStore.startSession("agent-a");
    addTurns(session.id, 2);

    const result = await flushSessionMidway(
      { agentName: "agent-a", sessionId: session.id, flushSequence: 1 },
      { ...deps, config: { flushMinNewTurns: 1 } },
    );

    expect(result).toMatchObject({ success: true, turnCount: 2 });
  });
});

describe("WP1: the final summary deletes the session's mid-session rows", () => {
  let memStore: MemoryStore;
  let convStore: ConversationStore;
  let deps: SummarizeSessionDeps;

  beforeEach(() => {
    memStore = new MemoryStore(":memory:", {
      enabled: false,
      similarityThreshold: 0.85,
    });
    convStore = new ConversationStore(memStore.getDatabase());
    deps = {
      conversationStore: convStore,
      memoryStore: memStore,
      embedder: createMockEmbedder(),
      summarize: vi.fn().mockResolvedValue("## Decisions\n- kept\n"),
      log: silentLog(),
    };
  });

  afterEach(() => {
    memStore?.close();
  });

  function addTurns(sessionId: string, count: number, from = 0): void {
    for (let i = from; i < from + count; i++) {
      convStore.recordTurn({
        sessionId,
        role: i % 2 === 0 ? "user" : "assistant",
        content: `turn ${i} body`,
      });
    }
  }

  function vecCount(memoryId: string): number {
    return (
      memStore
        .getDatabase()
        .prepare("SELECT COUNT(*) AS n FROM vec_memories WHERE memory_id = ?")
        .get(memoryId) as { n: number }
    ).n;
  }

  it("removes the flush rows and their vectors, leaves other sessions' rows and the summary", async () => {
    const a = convStore.startSession("agent-a");
    const b = convStore.startSession("agent-a");
    addTurns(a.id, 4);
    addTurns(b.id, 4);
    const f1 = await flushSessionMidway({ agentName: "agent-a", sessionId: a.id, flushSequence: 1 }, deps);
    addTurns(a.id, 4, 4);
    const f2 = await flushSessionMidway({ agentName: "agent-a", sessionId: a.id, flushSequence: 2 }, deps);
    const fb = await flushSessionMidway({ agentName: "agent-a", sessionId: b.id, flushSequence: 1 }, deps);
    const flushIds = [f1, f2].map((r) => ("success" in r ? r.memoryId : ""));
    const flushB = "success" in fb ? fb.memoryId : "";
    expect(flushIds.every((id) => id.length > 0)).toBe(true);
    expect(listMidSessionRows(memStore, a.id)).toHaveLength(2);
    for (const id of flushIds) expect(vecCount(id)).toBe(1);

    convStore.endSession(a.id);
    const result = await summarizeSession({ agentName: "agent-a", sessionId: a.id }, deps);

    expect(result).toMatchObject({ success: true, fallback: "llm" });
    expect(listMidSessionRows(memStore, a.id)).toHaveLength(0);
    for (const id of flushIds) {
      expect(memStore.getById(id)).toBeNull();
      expect(vecCount(id)).toBe(0);
    }
    // Session B's checkpoint is untouched, and A's summary row exists.
    expect(memStore.getById(flushB)).not.toBeNull();
    if ("success" in result && result.success) {
      const summary = memStore.getById(result.memoryId)!;
      expect(summary.tags).toContain("session-summary");
      expect(convStore.getSession(a.id)!.summaryMemoryId).toBe(result.memoryId);
    }
  });

  it("deletes the flush rows on the raw-turn fallback path too", async () => {
    const a = convStore.startSession("agent-a");
    addTurns(a.id, 5);
    await flushSessionMidway({ agentName: "agent-a", sessionId: a.id, flushSequence: 1 }, deps);
    expect(listMidSessionRows(memStore, a.id)).toHaveLength(1);
    convStore.endSession(a.id);

    const failing: SummarizeSessionDeps = {
      ...deps,
      summarize: vi.fn().mockRejectedValue(new Error("haiku down")),
    };
    const result = await summarizeSession({ agentName: "agent-a", sessionId: a.id }, failing);

    expect(result).toMatchObject({ success: true, fallback: "raw-turn" });
    expect(listMidSessionRows(memStore, a.id)).toHaveLength(0);
  });

  it("deleteMidSessionRows counts rows and tolerates a failing delete", () => {
    const a = convStore.startSession("agent-a");
    const rows = [1, 2].map((n) =>
      memStore.insert(
        {
          content: `flush ${n}`,
          source: "conversation",
          tags: ["mid-session", `session:${a.id}`, `flush:${n}`],
          skipDedup: true,
        },
        new Float32Array(384).fill(0.1 * n),
      ),
    );
    const failingStore = {
      findByTag: (tag: string) => memStore.findByTag(tag),
      delete: (id: string) => {
        if (id === rows[0].id) throw new Error("locked");
        return memStore.delete(id);
      },
    };

    expect(deleteMidSessionRows(failingStore, a.id)).toEqual({ deleted: 1, failed: 1 });
    expect(memStore.getById(rows[0].id)).not.toBeNull();
    expect(memStore.getById(rows[1].id)).toBeNull();
  });
});

describe("WP1: prompt truncation keeps the head and the tail", () => {
  it("truncateHeadTail keeps roughly 60/40 around the marker and leaves short content alone", () => {
    const content = "A".repeat(100) + "B".repeat(100);
    const cut = truncateHeadTail(content, 50);
    expect(cut.startsWith("A".repeat(30))).toBe(true);
    expect(cut.endsWith("B".repeat(20))).toBe(true);
    expect(cut).toContain("[...truncated due to length]");
    expect(cut).not.toContain("AB");
    expect(truncateHeadTail("short", 50)).toBe("short");
    expect(truncateHeadTail("exactly", 7)).toBe("exactly");
  });

  it("the prompt keeps the conclusion of every truncated turn", () => {
    const turns = [0, 1].map((i) =>
      makeTurn({
        turnIndex: i,
        role: i === 0 ? "user" : "assistant",
        content: `OPENING-${i} ` + "x".repeat(25_000) + ` CONCLUSION-${i}`,
      }),
    );
    const prompt = buildSessionSummarizationPrompt(turns);
    expect(prompt.length).toBeLessThan(MAX_PROMPT_CHARS + 2_000);
    for (const i of [0, 1]) {
      expect(prompt).toContain(`OPENING-${i}`);
      expect(prompt).toContain(`CONCLUSION-${i}`);
    }
    expect(prompt).toContain("start and the end of each cut turn are kept");
  });

  it("drops whole oldest turns instead of starving every turn below the floor", () => {
    const total = 1_000;
    const turns = Array.from({ length: total }, (_, i) =>
      makeTurn({
        turnIndex: i,
        role: i % 2 === 0 ? "user" : "assistant",
        content: `TURN-${i}-BODY ` + "y".repeat(200),
      }),
    );
    const prompt = buildSessionSummarizationPrompt(turns);
    const maxTurns = Math.floor(MAX_PROMPT_CHARS / MIN_CHARS_PER_TURN);
    expect(prompt).toContain(`TURN-${total - 1}-BODY`);
    expect(prompt).toContain(`TURN-${total - maxTurns}-BODY`);
    expect(prompt).not.toContain(`TURN-${total - maxTurns - 1}-BODY`);
    expect(prompt).not.toContain("TURN-0-BODY");
    expect(prompt).toContain(`the ${total - maxTurns} earliest turn(s) were omitted`);
    // Each kept turn still has its full body: no per-turn starvation.
    expect(prompt).toContain(`TURN-${total - 1}-BODY ` + "y".repeat(200));
  });

  it("segment prompts describe an ongoing session, session prompts a completed one", () => {
    const turns = [makeTurn({ turnIndex: 0, role: "user", content: "hi" })];
    expect(buildSessionSummarizationPrompt(turns)).toContain("a completed conversation session");
    expect(buildSessionSummarizationPrompt(turns, { segment: true })).toContain(
      "a segment of an ongoing conversation session",
    );
  });
});
