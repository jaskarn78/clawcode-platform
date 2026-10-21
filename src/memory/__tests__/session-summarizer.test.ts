/**
 * SessionSummarizer unit tests.
 *
 * Covers: happy path, skip conditions (<3 turns, already-summarized,
 * session-not-terminal, session-not-found), timeout/error fallback,
 * pure helper shapes. Uses real MemoryStore(":memory:") + real
 * ConversationStore (mirrors conversation-store.test.ts harness) with
 * mocked embedder and summarize function.
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
  buildRawTurnFallback,
  DEFAULT_IMPORTANCE,
  DEFAULT_FLUSH_IMPORTANCE,
  DEFAULT_TIMEOUT_MS,
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

/** Build a ConversationTurn fixture (for pure-helper tests). */
function makeTurn(
  overrides: Partial<ConversationTurn> & Pick<ConversationTurn, "role" | "content" | "turnIndex">,
): ConversationTurn {
  return Object.freeze({
    id: overrides.id ?? "t-fixture",
    sessionId: overrides.sessionId ?? "s-fixture",
    turnIndex: overrides.turnIndex,
    role: overrides.role,
    content: overrides.content,
    tokenCount: overrides.tokenCount ?? null,
    channelId: overrides.channelId ?? null,
    discordUserId: overrides.discordUserId ?? null,
    discordMessageId: overrides.discordMessageId ?? null,
    isTrustedChannel: overrides.isTrustedChannel ?? false,
    origin: overrides.origin ?? null,
    instructionFlags: overrides.instructionFlags ?? null,
    createdAt: overrides.createdAt ?? "2026-04-18T00:00:00Z",
  });
}

describe("SessionSummarizer", () => {
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

  /** Seed a session with N turns, then end it so it is terminal. */
  function seedEndedSession(turnCount: number): {
    sessionId: string;
    turnIds: string[];
  } {
    const session = convStore.startSession("agent-a");
    const turnIds: string[] = [];
    for (let i = 0; i < turnCount; i++) {
      const turn = convStore.recordTurn({
        sessionId: session.id,
        role: i % 2 === 0 ? "user" : "assistant",
        content: `Turn ${i} content with enough text to be meaningful.`,
      });
      turnIds.push(turn.id);
    }
    convStore.endSession(session.id);
    return { sessionId: session.id, turnIds };
  }

  describe("happy path", () => {
    it("writes MemoryEntry with correct source, tags, importance, and sourceTurnIds", async () => {
      const { sessionId, turnIds } = seedEndedSession(5);
      const mockSummarize: SummarizeFn = vi
        .fn()
        .mockResolvedValue(
          "## User Preferences\n- Prefers terse responses\n\n## Decisions\n- Used SQLite\n\n## Open Threads\n(none)\n\n## Commitments\n(none)\n",
        );
      const deps: SummarizeSessionDeps = {
        conversationStore: convStore,
        memoryStore: memStore,
        embedder: createMockEmbedder(),
        summarize: mockSummarize,
        log: silentLog(),
      };

      const result = await summarizeSession(
        { agentName: "agent-a", sessionId },
        deps,
      );

      expect(result).toMatchObject({
        success: true,
        fallback: "llm",
        turnCount: 5,
      });
      if ("success" in result && result.success) {
        const entry = memStore.getById(result.memoryId);
        expect(entry).not.toBeNull();
        expect(entry!.source).toBe("conversation");
        expect(entry!.tags).toContain("session-summary");
        expect(entry!.tags).toContain(`session:${sessionId}`);
        expect(entry!.tags).not.toContain("raw-fallback");
        expect(entry!.importance).toBe(DEFAULT_IMPORTANCE);
        expect(entry!.sourceTurnIds).toEqual(turnIds);
      }
      expect(mockSummarize).toHaveBeenCalledTimes(1);
    });

    it("links summary to session via markSummarized (status=summarized, summary_memory_id set)", async () => {
      const { sessionId } = seedEndedSession(3);
      const mockSummarize: SummarizeFn = vi
        .fn()
        .mockResolvedValue("## User Preferences\n(none)\n");
      const deps: SummarizeSessionDeps = {
        conversationStore: convStore,
        memoryStore: memStore,
        embedder: createMockEmbedder(),
        summarize: mockSummarize,
        log: silentLog(),
      };

      const result = await summarizeSession(
        { agentName: "agent-a", sessionId },
        deps,
      );
      expect("success" in result && result.success).toBe(true);

      const updated = convStore.getSession(sessionId);
      expect(updated!.status).toBe("summarized");
      if ("success" in result && result.success) {
        expect(updated!.summaryMemoryId).toBe(result.memoryId);
      }
    });

    it("success result is frozen", async () => {
      const { sessionId } = seedEndedSession(3);
      const deps: SummarizeSessionDeps = {
        conversationStore: convStore,
        memoryStore: memStore,
        embedder: createMockEmbedder(),
        summarize: vi.fn().mockResolvedValue("## User Preferences\n(none)\n"),
        log: silentLog(),
      };
      const result = await summarizeSession(
        { agentName: "agent-a", sessionId },
        deps,
      );
      expect(Object.isFrozen(result)).toBe(true);
    });

    it("passes AbortSignal to the summarize function", async () => {
      const { sessionId } = seedEndedSession(3);
      const mockSummarize = vi
        .fn()
        .mockResolvedValue("## User Preferences\n(none)\n");
      const deps: SummarizeSessionDeps = {
        conversationStore: convStore,
        memoryStore: memStore,
        embedder: createMockEmbedder(),
        summarize: mockSummarize as unknown as SummarizeFn,
        log: silentLog(),
      };

      await summarizeSession({ agentName: "agent-a", sessionId }, deps);

      expect(mockSummarize).toHaveBeenCalledTimes(1);
      const call = mockSummarize.mock.calls[0];
      expect(call[0]).toContain("User Preferences"); // prompt arg
      expect(call[1]).toHaveProperty("signal");
      expect(call[1].signal).toBeInstanceOf(AbortSignal);
    });
  });

  describe("skip conditions", () => {
    // 260419-q2z Fix A — sessions below minTurns now produce a deterministic
    // short-summary instead of being silently skipped. The Haiku call is
    // still bypassed (zero LLM spend for 1-2 turn sessions), but a
    // MemoryEntry IS written so no conversation is lost.
    it("short-session path: <minTurns sessions produce a short-summary MemoryEntry (no Haiku call)", async () => {
      const { sessionId } = seedEndedSession(2);
      const mockSummarize: SummarizeFn = vi.fn();
      const deps: SummarizeSessionDeps = {
        conversationStore: convStore,
        memoryStore: memStore,
        embedder: createMockEmbedder(),
        summarize: mockSummarize,
        log: silentLog(),
      };

      const result = await summarizeSession(
        { agentName: "agent-a", sessionId },
        deps,
      );

      expect(result).toMatchObject({
        success: true,
        fallback: "short-session",
        turnCount: 2,
      });
      expect(mockSummarize).not.toHaveBeenCalled();

      // Session transitions to summarized via short-session path.
      const session = convStore.getSession(sessionId);
      expect(session!.status).toBe("summarized");
    });

    it("respects custom minTurns via config (still short-session when below cutoff)", async () => {
      const { sessionId } = seedEndedSession(5);
      const mockSummarize: SummarizeFn = vi.fn();
      const deps: SummarizeSessionDeps = {
        conversationStore: convStore,
        memoryStore: memStore,
        embedder: createMockEmbedder(),
        summarize: mockSummarize,
        log: silentLog(),
        config: { minTurns: 10 },
      };

      const result = await summarizeSession(
        { agentName: "agent-a", sessionId },
        deps,
      );
      expect(result).toMatchObject({
        success: true,
        fallback: "short-session",
        turnCount: 5,
      });
      expect(mockSummarize).not.toHaveBeenCalled();
    });

    it("is idempotent: already-summarized session returns skipped with no side effects", async () => {
      const { sessionId } = seedEndedSession(3);
      const mockSummarize: SummarizeFn = vi
        .fn()
        .mockResolvedValue("## User Preferences\n(none)\n");
      const deps: SummarizeSessionDeps = {
        conversationStore: convStore,
        memoryStore: memStore,
        embedder: createMockEmbedder(),
        summarize: mockSummarize,
        log: silentLog(),
      };

      // First call summarizes
      await summarizeSession({ agentName: "agent-a", sessionId }, deps);
      expect(mockSummarize).toHaveBeenCalledTimes(1);

      // Second call short-circuits
      const result2 = await summarizeSession(
        { agentName: "agent-a", sessionId },
        deps,
      );
      expect(result2).toMatchObject({
        skipped: true,
        reason: "already-summarized",
      });
      expect(mockSummarize).toHaveBeenCalledTimes(1); // still 1, no second call
    });

    it("rejects active sessions with session-not-terminal", async () => {
      const session = convStore.startSession("agent-a");
      for (let i = 0; i < 5; i++) {
        convStore.recordTurn({
          sessionId: session.id,
          role: "user",
          content: `Turn ${i}`,
        });
      }
      // NOT ending the session — still active
      const mockSummarize: SummarizeFn = vi.fn();
      const deps: SummarizeSessionDeps = {
        conversationStore: convStore,
        memoryStore: memStore,
        embedder: createMockEmbedder(),
        summarize: mockSummarize,
        log: silentLog(),
      };

      const result = await summarizeSession(
        { agentName: "agent-a", sessionId: session.id },
        deps,
      );
      expect(result).toMatchObject({
        skipped: true,
        reason: "session-not-terminal",
      });
      expect(mockSummarize).not.toHaveBeenCalled();
    });

    it("returns session-not-found for nonexistent session ID", async () => {
      const deps: SummarizeSessionDeps = {
        conversationStore: convStore,
        memoryStore: memStore,
        embedder: createMockEmbedder(),
        summarize: vi.fn(),
        log: silentLog(),
      };
      const result = await summarizeSession(
        { agentName: "agent-a", sessionId: "nonexistent" },
        deps,
      );
      expect(result).toMatchObject({
        skipped: true,
        reason: "session-not-found",
      });
    });

    it("works on crashed sessions (ended or crashed both trigger summarization)", async () => {
      const session = convStore.startSession("agent-a");
      for (let i = 0; i < 3; i++) {
        convStore.recordTurn({
          sessionId: session.id,
          role: i % 2 === 0 ? "user" : "assistant",
          content: `Turn ${i}`,
        });
      }
      convStore.crashSession(session.id);

      const deps: SummarizeSessionDeps = {
        conversationStore: convStore,
        memoryStore: memStore,
        embedder: createMockEmbedder(),
        summarize: vi.fn().mockResolvedValue("## User Preferences\n(none)\n"),
        log: silentLog(),
      };

      const result = await summarizeSession(
        { agentName: "agent-a", sessionId: session.id },
        deps,
      );
      expect("success" in result && result.success).toBe(true);
      expect(convStore.getSession(session.id)!.status).toBe("summarized");
    });
  });

  describe("timeout and error fallback", () => {
    it("timeout falls back to raw-turn markdown and tags raw-fallback", async () => {
      const { sessionId, turnIds } = seedEndedSession(3);
      // Summarize hangs forever — abort controller must fire
      const mockSummarize: SummarizeFn = (_prompt, opts) =>
        new Promise((_, reject) => {
          opts.signal?.addEventListener("abort", () =>
            reject(new Error("AbortError")),
          );
        });
      const deps: SummarizeSessionDeps = {
        conversationStore: convStore,
        memoryStore: memStore,
        embedder: createMockEmbedder(),
        summarize: mockSummarize,
        log: silentLog(),
        config: { timeoutMs: 50 }, // very short for test
      };

      const result = await summarizeSession(
        { agentName: "agent-a", sessionId },
        deps,
      );

      expect(result).toMatchObject({
        success: true,
        fallback: "raw-turn",
        turnCount: 3,
      });
      if ("success" in result && result.success) {
        const entry = memStore.getById(result.memoryId);
        expect(entry).not.toBeNull();
        expect(entry!.tags).toContain("raw-fallback");
        expect(entry!.content).toContain("## Raw Turns");
        expect(entry!.sourceTurnIds).toEqual(turnIds);
      }
    });

    it("LLM error falls back to raw turns with raw-fallback tag", async () => {
      const { sessionId } = seedEndedSession(3);
      const mockSummarize: SummarizeFn = vi
        .fn()
        .mockRejectedValue(new Error("Anthropic 500"));
      const deps: SummarizeSessionDeps = {
        conversationStore: convStore,
        memoryStore: memStore,
        embedder: createMockEmbedder(),
        summarize: mockSummarize,
        log: silentLog(),
      };

      const result = await summarizeSession(
        { agentName: "agent-a", sessionId },
        deps,
      );
      expect(result).toMatchObject({ success: true, fallback: "raw-turn" });
      if ("success" in result && result.success) {
        const entry = memStore.getById(result.memoryId);
        expect(entry!.tags).toContain("raw-fallback");
      }
    });

    it("empty LLM response triggers fallback", async () => {
      const { sessionId } = seedEndedSession(3);
      const mockSummarize: SummarizeFn = vi
        .fn()
        .mockResolvedValue("   \n  \n");
      const deps: SummarizeSessionDeps = {
        conversationStore: convStore,
        memoryStore: memStore,
        embedder: createMockEmbedder(),
        summarize: mockSummarize,
        log: silentLog(),
      };

      const result = await summarizeSession(
        { agentName: "agent-a", sessionId },
        deps,
      );
      expect(result).toMatchObject({ success: true, fallback: "raw-turn" });
    });

    it("session still transitions to summarized even on fallback path", async () => {
      const { sessionId } = seedEndedSession(3);
      const mockSummarize: SummarizeFn = vi
        .fn()
        .mockRejectedValue(new Error("LLM error"));
      const deps: SummarizeSessionDeps = {
        conversationStore: convStore,
        memoryStore: memStore,
        embedder: createMockEmbedder(),
        summarize: mockSummarize,
        log: silentLog(),
      };

      await summarizeSession({ agentName: "agent-a", sessionId }, deps);
      const updated = convStore.getSession(sessionId);
      expect(updated!.status).toBe("summarized");
      expect(updated!.summaryMemoryId).not.toBeNull();
    });
  });

  describe("pure helpers", () => {
    it("buildSessionSummarizationPrompt includes all 4 section headers", () => {
      const turns = [
        makeTurn({ id: "t1", turnIndex: 0, role: "user", content: "hello" }),
      ];
      const prompt = buildSessionSummarizationPrompt(turns);
      expect(prompt).toContain("## User Preferences");
      expect(prompt).toContain("## Decisions");
      expect(prompt).toContain("## Open Threads");
      expect(prompt).toContain("## Commitments");
      expect(prompt).toContain("user");
      expect(prompt).toContain("hello");
    });

    it("buildSessionSummarizationPrompt truncates content over MAX_PROMPT_CHARS", () => {
      const hugeTurn = "x".repeat(50_000);
      const turns = [
        makeTurn({ id: "t1", turnIndex: 0, role: "user", content: hugeTurn }),
      ];
      const prompt = buildSessionSummarizationPrompt(turns);
      expect(prompt).toContain("[...truncated due to length]");
      expect(prompt.length).toBeLessThan(50_000);
    });

    it("buildSessionSummarizationPrompt handles empty turns without crashing", () => {
      const prompt = buildSessionSummarizationPrompt([]);
      expect(prompt).toContain("## User Preferences");
      expect(prompt).toContain("## Commitments");
      expect(typeof prompt).toBe("string");
    });

    it("buildRawTurnFallback returns (no turns) for empty input", () => {
      const result = buildRawTurnFallback([]);
      expect(result).toContain("## Raw Turns");
      expect(result).toContain("(no turns)");
    });

    it("buildRawTurnFallback includes role, turn index, and content for each turn", () => {
      const turns = [
        makeTurn({ id: "t1", turnIndex: 0, role: "user", content: "alpha" }),
        makeTurn({
          id: "t2",
          turnIndex: 1,
          role: "assistant",
          content: "beta",
        }),
      ];
      const result = buildRawTurnFallback(turns);
      expect(result).toContain("### user (turn 0)");
      expect(result).toContain("alpha");
      expect(result).toContain("### assistant (turn 1)");
      expect(result).toContain("beta");
    });
  });

  // -------------------------------------------------------------------------
  // 260419-q2z Fix A — always-summarize short sessions. Zero-turn sessions are
  // now a distinct skip reason; 1-2 turn sessions produce a deterministic
  // short-summary MemoryEntry instead of being silently skipped.
  // -------------------------------------------------------------------------
  describe("260419-q2z — short-session branch", () => {
    /** Seed an ENDED session containing exactly `n` turns with explicit roles. */
    function seedWithRoles(
      roles: ReadonlyArray<{ role: "user" | "assistant"; content: string }>,
    ): { sessionId: string; turnIds: string[] } {
      const session = convStore.startSession("agent-a");
      const turnIds: string[] = [];
      for (const { role, content } of roles) {
        const turn = convStore.recordTurn({
          sessionId: session.id,
          role,
          content,
        });
        turnIds.push(turn.id);
      }
      convStore.endSession(session.id);
      return { sessionId: session.id, turnIds };
    }

    it("zero-turn session skips with reason 'zero-turns' and NO MemoryEntry inserted", async () => {
      const session = convStore.startSession("agent-a");
      convStore.endSession(session.id);

      const mockSummarize: SummarizeFn = vi.fn();
      const mockEmbedder = createMockEmbedder();
      const deps: SummarizeSessionDeps = {
        conversationStore: convStore,
        memoryStore: memStore,
        embedder: mockEmbedder,
        summarize: mockSummarize,
        log: silentLog(),
      };

      const result = await summarizeSession(
        { agentName: "agent-a", sessionId: session.id },
        deps,
      );

      expect(result).toMatchObject({
        skipped: true,
        reason: "zero-turns",
      });
      expect(mockSummarize).not.toHaveBeenCalled();
      expect(mockEmbedder.embed).not.toHaveBeenCalled();
    });

    it("1-turn session builds a short-session summary with sourceTurnIds=[t1], short tag, fallback='short-session'", async () => {
      const { sessionId, turnIds } = seedWithRoles([
        { role: "user", content: "Hey clawdy can you remind me to buy eggs tomorrow?" },
      ]);

      const mockSummarize: SummarizeFn = vi.fn();
      const mockEmbedder = createMockEmbedder();
      const deps: SummarizeSessionDeps = {
        conversationStore: convStore,
        memoryStore: memStore,
        embedder: mockEmbedder,
        summarize: mockSummarize,
        log: silentLog(),
      };

      const result = await summarizeSession(
        { agentName: "agent-a", sessionId },
        deps,
      );

      expect(result).toMatchObject({
        success: true,
        fallback: "short-session",
        turnCount: 1,
      });
      expect(mockSummarize).not.toHaveBeenCalled(); // no Haiku spend
      expect(mockEmbedder.embed).toHaveBeenCalledTimes(1);

      if ("success" in result && result.success) {
        const entry = memStore.getById(result.memoryId);
        expect(entry).not.toBeNull();
        expect(entry!.source).toBe("conversation");
        expect(entry!.tags).toContain("session-summary");
        expect(entry!.tags).toContain("short");
        expect(entry!.tags).toContain(`session:${sessionId}`);
        expect(entry!.sourceTurnIds).toEqual(turnIds);
        expect(entry!.content).toContain("1 turn(s)");
        expect(entry!.content).toContain("Last user:");
        expect(entry!.content).toContain("Last agent:");
        expect(entry!.content).toContain("Tags: [session-summary, short].");
      }
    });

    it("2-turn session: both turn IDs in sourceTurnIds; user+agent content referenced", async () => {
      const { sessionId, turnIds } = seedWithRoles([
        { role: "user", content: "What's the status of the registry fix?" },
        { role: "assistant", content: "Task 1 committed — atomic write live." },
      ]);

      const deps: SummarizeSessionDeps = {
        conversationStore: convStore,
        memoryStore: memStore,
        embedder: createMockEmbedder(),
        summarize: vi.fn() as unknown as SummarizeFn,
        log: silentLog(),
      };

      const result = await summarizeSession(
        { agentName: "agent-a", sessionId },
        deps,
      );

      expect(result).toMatchObject({
        success: true,
        fallback: "short-session",
        turnCount: 2,
      });
      if ("success" in result && result.success) {
        const entry = memStore.getById(result.memoryId);
        expect(entry!.sourceTurnIds).toEqual(turnIds);
        expect(entry!.content).toContain("2 turn(s).");
        expect(entry!.content).toContain('"What\'s the status of the registry fix?"');
        expect(entry!.content).toContain('"Task 1 committed — atomic write live."');
        expect(entry!.content).toContain("Tags: [session-summary, short].");
      }
    });

    it("minTurns regression: >=minTurns still calls Haiku (fallback='llm')", async () => {
      const { sessionId } = seedEndedSession(3);
      const mockSummarize: SummarizeFn = vi
        .fn()
        .mockResolvedValue("## User Preferences\n(none)\n");
      const deps: SummarizeSessionDeps = {
        conversationStore: convStore,
        memoryStore: memStore,
        embedder: createMockEmbedder(),
        summarize: mockSummarize,
        log: silentLog(),
      };

      const result = await summarizeSession(
        { agentName: "agent-a", sessionId },
        deps,
      );

      expect(result).toMatchObject({
        success: true,
        fallback: "llm",
        turnCount: 3,
      });
      expect(mockSummarize).toHaveBeenCalledTimes(1);
    });

    it("truncates user/agent content to 80 chars with '...' suffix when too long", async () => {
      const longUser = "x".repeat(500);
      const { sessionId } = seedWithRoles([{ role: "user", content: longUser }]);

      const deps: SummarizeSessionDeps = {
        conversationStore: convStore,
        memoryStore: memStore,
        embedder: createMockEmbedder(),
        summarize: vi.fn() as unknown as SummarizeFn,
        log: silentLog(),
      };

      const result = await summarizeSession(
        { agentName: "agent-a", sessionId },
        deps,
      );

      expect("success" in result && result.success).toBe(true);
      if ("success" in result && result.success) {
        const entry = memStore.getById(result.memoryId);
        // Truncated to 80 chars + "..." inside the quotes — NOT the full 500.
        expect(entry!.content).toContain('"' + "x".repeat(80) + '..."');
        expect(entry!.content).not.toContain("x".repeat(200));
      }
    });

    it("short-session tolerates markSummarized failure (still returns success)", async () => {
      const { sessionId } = seedWithRoles([
        { role: "user", content: "hi" },
      ]);

      // Wrap convStore to throw on markSummarized, but delegate everything else.
      const delegating = new Proxy(convStore, {
        get(target, prop) {
          if (prop === "markSummarized") {
            return () => {
              throw new Error("race: session already summarized");
            };
          }
          return (target as unknown as Record<string | symbol, unknown>)[prop];
        },
      });

      const deps: SummarizeSessionDeps = {
        conversationStore: delegating as typeof convStore,
        memoryStore: memStore,
        embedder: createMockEmbedder(),
        summarize: vi.fn() as unknown as SummarizeFn,
        log: silentLog(),
      };

      const result = await summarizeSession(
        { agentName: "agent-a", sessionId },
        deps,
      );

      // Row was inserted; markSummarized race is swallowed.
      expect(result).toMatchObject({
        success: true,
        fallback: "short-session",
      });
    });

    it("logs info with event 'short-session summary built' and the fallback+turnCount payload", async () => {
      const { sessionId } = seedWithRoles([{ role: "user", content: "hello" }]);

      const infoSpy = vi.fn();
      const warnSpy = vi.fn();
      const log = {
        info: infoSpy,
        warn: warnSpy,
        error: vi.fn(),
        debug: vi.fn(),
        trace: vi.fn(),
        fatal: vi.fn(),
        child: () => log,
      } as unknown as import("pino").Logger;

      const deps: SummarizeSessionDeps = {
        conversationStore: convStore,
        memoryStore: memStore,
        embedder: createMockEmbedder(),
        summarize: vi.fn() as unknown as SummarizeFn,
        log,
      };

      await summarizeSession({ agentName: "agent-a", sessionId }, deps);

      // At least one info call with the expected shape + message.
      const infoCalls = infoSpy.mock.calls as Array<[Record<string, unknown>, string]>;
      const match = infoCalls.find(
        (c) =>
          typeof c[1] === "string" &&
          c[1].includes("short-session summary built") &&
          c[0]["fallback"] === "short-session" &&
          c[0]["turnCount"] === 1,
      );
      expect(match).toBeDefined();
    });
  });

  // ---------------------------------------------------------------------------
  // Gap 2 (memory-persistence-gaps) — raw conversation turns must be deleted
  // after a successful summarization so the turn table does not grow
  // unbounded. Failure paths (embed failure, insert failure) MUST NOT delete.
  // ---------------------------------------------------------------------------
  describe("raw-turn pruning after summarization (Gap 2)", () => {
    it("deletes raw turns after a successful LLM-path summarization", async () => {
      const { sessionId, turnIds } = seedEndedSession(4);

      // Sanity check: turns exist pre-summarize.
      expect(convStore.getTurnsForSession(sessionId)).toHaveLength(4);

      const mockSummarize: SummarizeFn = vi
        .fn()
        .mockResolvedValue("## User Preferences\n(none)\n");
      const deps: SummarizeSessionDeps = {
        conversationStore: convStore,
        memoryStore: memStore,
        embedder: createMockEmbedder(),
        summarize: mockSummarize,
        log: silentLog(),
      };

      const result = await summarizeSession(
        { agentName: "agent-a", sessionId },
        deps,
      );
      expect("success" in result && result.success).toBe(true);

      // Raw turns gone.
      expect(convStore.getTurnsForSession(sessionId)).toHaveLength(0);

      // Session row survives (needed for resume-brief gap accounting).
      const session = convStore.getSession(sessionId);
      expect(session).not.toBeNull();
      expect(session!.status).toBe("summarized");

      // Summary memory row also survives and still references the pre-delete turnIds.
      if ("success" in result && result.success) {
        const entry = memStore.getById(result.memoryId);
        expect(entry).not.toBeNull();
        expect(entry!.sourceTurnIds).toEqual(turnIds);
      }
    });

    it("deletes raw turns after a short-session summarization", async () => {
      const { sessionId } = seedEndedSession(2);
      expect(convStore.getTurnsForSession(sessionId)).toHaveLength(2);

      const deps: SummarizeSessionDeps = {
        conversationStore: convStore,
        memoryStore: memStore,
        embedder: createMockEmbedder(),
        summarize: vi.fn(),
        log: silentLog(),
      };

      const result = await summarizeSession(
        { agentName: "agent-a", sessionId },
        deps,
      );

      expect("success" in result && result.success).toBe(true);
      expect(convStore.getTurnsForSession(sessionId)).toHaveLength(0);
    });

    it("deletes raw turns after raw-turn fallback (LLM error)", async () => {
      const { sessionId } = seedEndedSession(3);
      expect(convStore.getTurnsForSession(sessionId)).toHaveLength(3);

      const deps: SummarizeSessionDeps = {
        conversationStore: convStore,
        memoryStore: memStore,
        embedder: createMockEmbedder(),
        summarize: vi.fn().mockRejectedValue(new Error("LLM error")),
        log: silentLog(),
      };

      const result = await summarizeSession(
        { agentName: "agent-a", sessionId },
        deps,
      );
      expect(result).toMatchObject({ success: true, fallback: "raw-turn" });
      // Session still summarized (for idempotency), so pruning IS correct here —
      // the raw-turn fallback already embedded the turn text verbatim into
      // the memory row's content, so the raw rows are redundant.
      expect(convStore.getTurnsForSession(sessionId)).toHaveLength(0);
    });

    it("does NOT delete turns when memoryStore.insert fails", async () => {
      const { sessionId } = seedEndedSession(3);
      expect(convStore.getTurnsForSession(sessionId)).toHaveLength(3);

      // Force insert to throw.
      const insertSpy = vi
        .spyOn(memStore, "insert")
        .mockImplementation(() => {
          throw new Error("forced insert failure");
        });

      const deps: SummarizeSessionDeps = {
        conversationStore: convStore,
        memoryStore: memStore,
        embedder: createMockEmbedder(),
        summarize: vi.fn().mockResolvedValue("## User Preferences\n(none)\n"),
        log: silentLog(),
      };

      const result = await summarizeSession(
        { agentName: "agent-a", sessionId },
        deps,
      );
      expect(result).toMatchObject({ skipped: true });
      // Turns still present — we haven't summarized yet, so pruning would be destructive.
      expect(convStore.getTurnsForSession(sessionId)).toHaveLength(3);

      insertSpy.mockRestore();
    });

    it("does NOT delete turns when embedding fails", async () => {
      const { sessionId } = seedEndedSession(3);
      expect(convStore.getTurnsForSession(sessionId)).toHaveLength(3);

      const failingEmbedder: EmbeddingService = {
        embed: vi.fn().mockRejectedValue(new Error("embed failure")),
        warmup: vi.fn().mockResolvedValue(undefined),
        isReady: vi.fn().mockReturnValue(true),
      } as unknown as EmbeddingService;

      const deps: SummarizeSessionDeps = {
        conversationStore: convStore,
        memoryStore: memStore,
        embedder: failingEmbedder,
        summarize: vi.fn().mockResolvedValue("## User Preferences\n(none)\n"),
        log: silentLog(),
      };

      const result = await summarizeSession(
        { agentName: "agent-a", sessionId },
        deps,
      );
      expect(result).toMatchObject({ skipped: true });
      expect(convStore.getTurnsForSession(sessionId)).toHaveLength(3);
    });
  });

  // ---------------------------------------------------------------------------
  // Gap 3 (memory-persistence-gaps) — flushSessionMidway: non-terminating
  // periodic summary. Writes a MemoryEntry tagged "mid-session" without
  // ending the conversation session or deleting its turns.
  // ---------------------------------------------------------------------------
  describe("flushSessionMidway (Gap 3)", () => {
    /** Seed an ACTIVE session with N turns — do NOT end it. */
    function seedActiveSession(turnCount: number): {
      sessionId: string;
      turnIds: string[];
    } {
      const session = convStore.startSession("agent-a");
      const turnIds: string[] = [];
      for (let i = 0; i < turnCount; i++) {
        const turn = convStore.recordTurn({
          sessionId: session.id,
          role: i % 2 === 0 ? "user" : "assistant",
          content: `Flush-turn ${i} content with some substance.`,
        });
        turnIds.push(turn.id);
      }
      return { sessionId: session.id, turnIds };
    }

    it("writes a MemoryEntry with mid-session + flush:N tags and leaves the session active", async () => {
      const { sessionId, turnIds } = seedActiveSession(4);

      const mockSummarize: SummarizeFn = vi
        .fn()
        .mockResolvedValue("## User Preferences\n(none)\n");
      const deps: SummarizeSessionDeps = {
        conversationStore: convStore,
        memoryStore: memStore,
        embedder: createMockEmbedder(),
        summarize: mockSummarize,
        log: silentLog(),
      };

      const result = await flushSessionMidway(
        { agentName: "agent-a", sessionId, flushSequence: 1 },
        deps,
      );

      expect(result).toMatchObject({
        success: true,
        fallback: "llm",
        turnCount: 4,
        flushSequence: 1,
      });

      if ("success" in result && result.success) {
        const entry = memStore.getById(result.memoryId);
        expect(entry).not.toBeNull();
        expect(entry!.tags).toContain("mid-session");
        expect(entry!.tags).toContain(`session:${sessionId}`);
        expect(entry!.tags).toContain("flush:1");
        expect(entry!.tags).not.toContain("session-summary");
        expect(entry!.importance).toBe(DEFAULT_FLUSH_IMPORTANCE);
        expect(entry!.sourceTurnIds).toEqual(turnIds);
        expect(entry!.source).toBe("conversation");
      }

      // Session stays active; raw turns stay intact.
      const session = convStore.getSession(sessionId);
      expect(session!.status).toBe("active");
      expect(convStore.getTurnsForSession(sessionId)).toHaveLength(4);
    });

    it("encodes flushSequence into the flush:N tag across multiple flushes", async () => {
      const { sessionId } = seedActiveSession(3);

      const deps: SummarizeSessionDeps = {
        conversationStore: convStore,
        memoryStore: memStore,
        embedder: createMockEmbedder(),
        summarize: vi.fn().mockResolvedValue("## User Preferences\n(none)\n"),
        log: silentLog(),
      };

      const r1 = await flushSessionMidway(
        { agentName: "agent-a", sessionId, flushSequence: 1 },
        deps,
      );
      const r2 = await flushSessionMidway(
        { agentName: "agent-a", sessionId, flushSequence: 2 },
        deps,
      );

      expect("success" in r1 && r1.success).toBe(true);
      expect("success" in r2 && r2.success).toBe(true);
      if ("success" in r1 && r1.success && "success" in r2 && r2.success) {
        expect(r1.memoryId).not.toBe(r2.memoryId);
        const e1 = memStore.getById(r1.memoryId);
        const e2 = memStore.getById(r2.memoryId);
        expect(e1!.tags).toContain("flush:1");
        expect(e2!.tags).toContain("flush:2");
      }
    });

    it("uses short-session fallback for sessions below minTurns (no Haiku call)", async () => {
      const { sessionId } = seedActiveSession(2);

      const mockSummarize: SummarizeFn = vi.fn();
      const deps: SummarizeSessionDeps = {
        conversationStore: convStore,
        memoryStore: memStore,
        embedder: createMockEmbedder(),
        summarize: mockSummarize,
        log: silentLog(),
      };

      const result = await flushSessionMidway(
        { agentName: "agent-a", sessionId, flushSequence: 1 },
        deps,
      );

      expect(result).toMatchObject({
        success: true,
        fallback: "short-session",
        turnCount: 2,
      });
      expect(mockSummarize).not.toHaveBeenCalled();
    });

    it("skips when the session has zero turns", async () => {
      const session = convStore.startSession("agent-a");

      const deps: SummarizeSessionDeps = {
        conversationStore: convStore,
        memoryStore: memStore,
        embedder: createMockEmbedder(),
        summarize: vi.fn(),
        log: silentLog(),
      };

      const result = await flushSessionMidway(
        { agentName: "agent-a", sessionId: session.id, flushSequence: 1 },
        deps,
      );
      expect(result).toMatchObject({ skipped: true, reason: "zero-turns" });
    });

    it("skips when the session is not active (ended)", async () => {
      const { sessionId } = seedActiveSession(3);
      convStore.endSession(sessionId);

      const deps: SummarizeSessionDeps = {
        conversationStore: convStore,
        memoryStore: memStore,
        embedder: createMockEmbedder(),
        summarize: vi.fn(),
        log: silentLog(),
      };

      const result = await flushSessionMidway(
        { agentName: "agent-a", sessionId, flushSequence: 1 },
        deps,
      );
      expect(result).toMatchObject({
        skipped: true,
        reason: "session-not-active",
      });
    });

    it("skips when the session does not exist", async () => {
      const deps: SummarizeSessionDeps = {
        conversationStore: convStore,
        memoryStore: memStore,
        embedder: createMockEmbedder(),
        summarize: vi.fn(),
        log: silentLog(),
      };

      const result = await flushSessionMidway(
        { agentName: "agent-a", sessionId: "no-such-session", flushSequence: 1 },
        deps,
      );
      expect(result).toMatchObject({
        skipped: true,
        reason: "session-not-found",
      });
    });

    it("does not delete turns after a successful flush", async () => {
      const { sessionId } = seedActiveSession(4);

      const deps: SummarizeSessionDeps = {
        conversationStore: convStore,
        memoryStore: memStore,
        embedder: createMockEmbedder(),
        summarize: vi.fn().mockResolvedValue("## User Preferences\n(none)\n"),
        log: silentLog(),
      };

      await flushSessionMidway(
        { agentName: "agent-a", sessionId, flushSequence: 1 },
        deps,
      );

      expect(convStore.getTurnsForSession(sessionId)).toHaveLength(4);
    });
  });

  // ── 99-mdrop: Admin Clawdy memory drop fix (audit 2026-04-27) ──────────────
  // See .planning/phases/99-memory-translator-and-sync-hygiene/
  //     ADMIN-CLAWDY-MEMORY-DROP-2026-04-27.md
  //
  // The summarizer's 10s timeout fired mid-Haiku-call on a 96-turn session,
  // dropping a 19.6KB raw-turn dump into the next session's resume-brief and
  // silently truncating it under the 2K token budget. Two changes:
  //   1. Bump DEFAULT_TIMEOUT_MS from 10_000 → 30_000 (Fix 1).
  //   2. Confirm the raw-turn fallback memory carries the `raw-fallback` tag
  //      so the conversation-brief module can downgrade it (Fix 2).
  // 2026-06-18: bumped again 30_000 → 120_000 — the haiku-via-bridge spawn
  // measured 30–64s on prod for real summarizer/consolidation payloads and the
  // 30s ceiling SIGTERM'd them (exitCode 143) → empty summaries. See
  // session-summarizer.ts DEFAULT_TIMEOUT_MS comment.
  describe("99-mdrop: timeout extension + raw-turn tag", () => {
    it("TIMEOUT — DEFAULT_TIMEOUT_MS is 120_000 (30→120s for the slow bridge spawn)", () => {
      expect(DEFAULT_TIMEOUT_MS).toBe(120_000);
    });

    it("RAW-TAG — fallback memory carries `raw-fallback` tag for downstream detection", async () => {
      const session = convStore.startSession("agent-a");
      for (let i = 0; i < 5; i++) {
        convStore.recordTurn({
          sessionId: session.id,
          role: i % 2 === 0 ? "user" : "assistant",
          content: `turn ${i} body`,
        });
      }
      convStore.endSession(session.id);

      // Force the summarize path to time out so we exercise raw-turn fallback.
      const mockSummarize: SummarizeFn = (_prompt, opts) =>
        new Promise((_, reject) => {
          opts.signal?.addEventListener("abort", () =>
            reject(new Error("AbortError")),
          );
        });
      const deps: SummarizeSessionDeps = {
        conversationStore: convStore,
        memoryStore: memStore,
        embedder: createMockEmbedder(),
        summarize: mockSummarize,
        log: silentLog(),
        config: { timeoutMs: 25 }, // tiny test-only override
      };

      const result = await summarizeSession(
        { agentName: "agent-a", sessionId: session.id },
        deps,
      );

      expect("success" in result && result.success).toBe(true);
      if ("success" in result && result.success) {
        const entry = memStore.getById(result.memoryId);
        expect(entry).not.toBeNull();
        expect(entry!.tags).toContain("raw-fallback");
        expect(entry!.tags).toContain("session-summary");
      }
    });
  });
});
