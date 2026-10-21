import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MemoryStore } from "../store.js";
import {
  ConversationStore,
  escapeFtsQuery as escapeFtsQueryUnderTest,
} from "../conversation-store.js";

/** Create a real memory entry and return its ID (for FK-safe summary references). */
function createMemoryEntry(memStore: MemoryStore, label: string): string {
  const embedding = new Float32Array(384);
  for (let i = 0; i < 384; i++) embedding[i] = Math.sin(i + label.length);
  let norm = 0;
  for (let i = 0; i < 384; i++) norm += embedding[i] * embedding[i];
  norm = Math.sqrt(norm);
  for (let i = 0; i < 384; i++) embedding[i] /= norm;

  const entry = memStore.insert(
    { content: `Summary: ${label}`, source: "conversation", skipDedup: true },
    embedding,
  );
  return entry.id;
}

describe("ConversationStore", () => {
  let memStore: MemoryStore;
  let convStore: ConversationStore;

  afterEach(() => {
    memStore?.close();
  });

  function setup(): void {
    memStore = new MemoryStore(":memory:", {
      enabled: false,
      similarityThreshold: 0.85,
    });
    convStore = new ConversationStore(memStore.getDatabase());
  }

  describe("session lifecycle", () => {
    it("startSession creates an active session with zeroed counters", () => {
      setup();
      const session = convStore.startSession("agent-a");

      expect(session.agentName).toBe("agent-a");
      expect(session.status).toBe("active");
      expect(session.turnCount).toBe(0);
      expect(session.totalTokens).toBe(0);
      expect(session.endedAt).toBeNull();
      expect(session.summaryMemoryId).toBeNull();
      expect(session.id).toBeTruthy();
      expect(session.startedAt).toBeTruthy();
    });

    it("endSession transitions active to ended with endedAt set", () => {
      setup();
      const session = convStore.startSession("agent-a");
      const ended = convStore.endSession(session.id);

      expect(ended.status).toBe("ended");
      expect(ended.endedAt).toBeTruthy();
      expect(ended.id).toBe(session.id);
    });

    it("crashSession transitions active to crashed with endedAt set", () => {
      setup();
      const session = convStore.startSession("agent-a");
      const crashed = convStore.crashSession(session.id);

      expect(crashed.status).toBe("crashed");
      expect(crashed.endedAt).toBeTruthy();
      expect(crashed.id).toBe(session.id);
    });

    it("markSummarized transitions ended to summarized with summaryMemoryId", () => {
      setup();
      const memId = createMemoryEntry(memStore, "ended-summary");
      const session = convStore.startSession("agent-a");
      convStore.endSession(session.id);
      const summarized = convStore.markSummarized(session.id, memId);

      expect(summarized.status).toBe("summarized");
      expect(summarized.summaryMemoryId).toBe(memId);
    });

    it("markSummarized transitions crashed to summarized", () => {
      setup();
      const memId = createMemoryEntry(memStore, "crashed-summary");
      const session = convStore.startSession("agent-a");
      convStore.crashSession(session.id);
      const summarized = convStore.markSummarized(session.id, memId);

      expect(summarized.status).toBe("summarized");
      expect(summarized.summaryMemoryId).toBe(memId);
    });

    it("getSession returns session by id", () => {
      setup();
      const session = convStore.startSession("agent-a");
      const retrieved = convStore.getSession(session.id);

      expect(retrieved).not.toBeNull();
      expect(retrieved!.id).toBe(session.id);
      expect(retrieved!.agentName).toBe("agent-a");
    });

    it("getSession returns null for nonexistent id", () => {
      setup();
      const result = convStore.getSession("nonexistent");
      expect(result).toBeNull();
    });

    it("listRecentSessions returns sessions ordered by started_at DESC", () => {
      setup();
      const s1 = convStore.startSession("agent-a");
      const s2 = convStore.startSession("agent-a");
      const s3 = convStore.startSession("agent-a");

      const recent = convStore.listRecentSessions("agent-a", 5);

      expect(recent).toHaveLength(3);
      // Most recent first
      expect(recent[0].id).toBe(s3.id);
      expect(recent[1].id).toBe(s2.id);
      expect(recent[2].id).toBe(s1.id);
    });

    it("listRecentSessions respects limit", () => {
      setup();
      convStore.startSession("agent-a");
      convStore.startSession("agent-a");
      convStore.startSession("agent-a");

      const recent = convStore.listRecentSessions("agent-a", 2);
      expect(recent).toHaveLength(2);
    });

    it("listRecentSessions filters by agent name", () => {
      setup();
      convStore.startSession("agent-a");
      convStore.startSession("agent-b");

      const aRecent = convStore.listRecentSessions("agent-a", 10);
      const bRecent = convStore.listRecentSessions("agent-b", 10);

      expect(aRecent).toHaveLength(1);
      expect(bRecent).toHaveLength(1);
      expect(aRecent[0].agentName).toBe("agent-a");
      expect(bRecent[0].agentName).toBe("agent-b");
    });

    // ── agents-forget-across-sessions debug (2026-04-19) ─────────────────
    // 2026-04-25 evening hotfix added an EXISTS(conversation_turns) filter to
    // listRecentTerminatedSessions so empty restart cycles don't shadow real
    // history; these tests record one turn per session to satisfy that filter.
    it("listRecentTerminatedSessions excludes active sessions", () => {
      setup();
      const s1 = convStore.startSession("agent-a");
      convStore.recordTurn({ sessionId: s1.id, role: "user", content: "1" });
      convStore.endSession(s1.id);
      const s2 = convStore.startSession("agent-a");
      convStore.recordTurn({ sessionId: s2.id, role: "user", content: "2" });
      convStore.crashSession(s2.id);
      const s3 = convStore.startSession("agent-a"); // left active

      const terminated = convStore.listRecentTerminatedSessions("agent-a", 10);

      expect(terminated).toHaveLength(2);
      expect(terminated.map((s) => s.id)).not.toContain(s3.id);
      expect(terminated.map((s) => s.id)).toContain(s1.id);
      expect(terminated.map((s) => s.id)).toContain(s2.id);
    });

    it("listRecentTerminatedSessions includes summarized sessions", () => {
      setup();
      const memId = createMemoryEntry(memStore, "summarized-check");
      const session = convStore.startSession("agent-a");
      convStore.recordTurn({
        sessionId: session.id,
        role: "user",
        content: "x",
      });
      convStore.endSession(session.id);
      convStore.markSummarized(session.id, memId);

      const terminated = convStore.listRecentTerminatedSessions("agent-a", 10);

      expect(terminated).toHaveLength(1);
      expect(terminated[0].status).toBe("summarized");
    });

    it("listRecentTerminatedSessions orders by started_at DESC", () => {
      setup();
      const s1 = convStore.startSession("agent-a");
      convStore.recordTurn({ sessionId: s1.id, role: "user", content: "1" });
      convStore.endSession(s1.id);
      const s2 = convStore.startSession("agent-a");
      convStore.recordTurn({ sessionId: s2.id, role: "user", content: "2" });
      convStore.endSession(s2.id);
      const s3 = convStore.startSession("agent-a");
      convStore.recordTurn({ sessionId: s3.id, role: "user", content: "3" });
      convStore.endSession(s3.id);

      const terminated = convStore.listRecentTerminatedSessions("agent-a", 10);

      expect(terminated).toHaveLength(3);
      expect(terminated[0].id).toBe(s3.id);
      expect(terminated[2].id).toBe(s1.id);
    });

    it("listRecentTerminatedSessions respects limit and agent filter", () => {
      setup();
      const s1 = convStore.startSession("agent-a");
      convStore.recordTurn({ sessionId: s1.id, role: "user", content: "1" });
      convStore.endSession(s1.id);
      const s2 = convStore.startSession("agent-a");
      convStore.recordTurn({ sessionId: s2.id, role: "user", content: "2" });
      convStore.endSession(s2.id);
      const s3 = convStore.startSession("agent-b");
      convStore.recordTurn({ sessionId: s3.id, role: "user", content: "3" });
      convStore.endSession(s3.id);

      const aLimited = convStore.listRecentTerminatedSessions("agent-a", 1);
      expect(aLimited).toHaveLength(1);
      expect(aLimited[0].agentName).toBe("agent-a");

      const bAll = convStore.listRecentTerminatedSessions("agent-b", 10);
      expect(bAll).toHaveLength(1);
      expect(bAll[0].id).toBe(s3.id);
    });

    // ── Phase 99-C: pending-summary backlog query ───────────────────────────
    it("listPendingSummarySessions returns ended/crashed sessions with no summary", () => {
      setup();
      // s1: ended, no summary, has turn → should appear
      const s1 = convStore.startSession("agent-a");
      convStore.recordTurn({
        sessionId: s1.id,
        role: "user",
        content: "hi",
      });
      convStore.endSession(s1.id);

      // s2: crashed, no summary, has turn → should appear
      const s2 = convStore.startSession("agent-a");
      convStore.recordTurn({
        sessionId: s2.id,
        role: "user",
        content: "yo",
      });
      convStore.crashSession(s2.id);

      // s3: ended WITH summary → should be excluded
      const s3 = convStore.startSession("agent-a");
      convStore.recordTurn({
        sessionId: s3.id,
        role: "user",
        content: "ok",
      });
      convStore.endSession(s3.id);
      const memId = createMemoryEntry(memStore, "s3-summary");
      convStore.markSummarized(s3.id, memId);

      // s4: zero-turn ended, no summary → excluded by EXISTS filter
      const s4 = convStore.startSession("agent-a");
      convStore.endSession(s4.id);
      void s4;

      // s5: still active → excluded by status filter
      convStore.startSession("agent-a");

      const pending = convStore.listPendingSummarySessions("agent-a", 10);
      expect(pending).toHaveLength(2);
      const ids = pending.map((s) => s.id);
      expect(ids).toContain(s1.id);
      expect(ids).toContain(s2.id);
    });

    it("listPendingSummarySessions orders by started_at ASC (oldest first)", () => {
      setup();
      const s1 = convStore.startSession("agent-a");
      convStore.recordTurn({ sessionId: s1.id, role: "user", content: "1" });
      convStore.endSession(s1.id);
      // Tiny gap so started_at differs deterministically — better-sqlite3 ISO
      // timestamps have ms resolution, so rowid tie-break catches the rest.
      const s2 = convStore.startSession("agent-a");
      convStore.recordTurn({ sessionId: s2.id, role: "user", content: "2" });
      convStore.endSession(s2.id);
      const s3 = convStore.startSession("agent-a");
      convStore.recordTurn({ sessionId: s3.id, role: "user", content: "3" });
      convStore.endSession(s3.id);

      const pending = convStore.listPendingSummarySessions("agent-a", 10);
      expect(pending).toHaveLength(3);
      expect(pending[0].id).toBe(s1.id);
      expect(pending[2].id).toBe(s3.id);
    });

    it("listPendingSummarySessions respects limit and agent filter", () => {
      setup();
      const s1 = convStore.startSession("agent-a");
      convStore.recordTurn({ sessionId: s1.id, role: "user", content: "1" });
      convStore.endSession(s1.id);
      const s2 = convStore.startSession("agent-a");
      convStore.recordTurn({ sessionId: s2.id, role: "user", content: "2" });
      convStore.endSession(s2.id);
      const s3 = convStore.startSession("agent-b");
      convStore.recordTurn({ sessionId: s3.id, role: "user", content: "3" });
      convStore.endSession(s3.id);

      const aOne = convStore.listPendingSummarySessions("agent-a", 1);
      expect(aOne).toHaveLength(1);
      expect(aOne[0].agentName).toBe("agent-a");

      const bAll = convStore.listPendingSummarySessions("agent-b", 10);
      expect(bAll).toHaveLength(1);
      expect(bAll[0].id).toBe(s3.id);
    });
  });

  describe("state machine transitions", () => {
    it("endSession throws on non-active session", () => {
      setup();
      const session = convStore.startSession("agent-a");
      convStore.endSession(session.id);

      expect(() => convStore.endSession(session.id)).toThrow();
    });

    it("crashSession throws on non-active session", () => {
      setup();
      const session = convStore.startSession("agent-a");
      convStore.endSession(session.id);

      expect(() => convStore.crashSession(session.id)).toThrow();
    });

    it("markSummarized throws on active session", () => {
      setup();
      const memId = createMemoryEntry(memStore, "active-test");
      const session = convStore.startSession("agent-a");

      expect(() => convStore.markSummarized(session.id, memId)).toThrow();
    });

    it("endSession throws on nonexistent session", () => {
      setup();
      expect(() => convStore.endSession("does-not-exist")).toThrow();
    });

    it("crashSession throws on nonexistent session", () => {
      setup();
      expect(() => convStore.crashSession("does-not-exist")).toThrow();
    });

    it("markSummarized throws on nonexistent session", () => {
      setup();
      const memId = createMemoryEntry(memStore, "nonexistent-test");
      expect(() => convStore.markSummarized("does-not-exist", memId)).toThrow();
    });

    // ── agents-forget-across-sessions debug (2026-04-19) ─────────────────
    // Race-condition idempotency: crash-path fire-and-forget and stop-path
    // awaited summarize can both reach markSummarized. The loser USED to
    // throw "not found or not in 'ended'/'crashed' status" which emitted a
    // misleading warn log. Now the loser returns the current (already-
    // summarized) row without error.
    it("markSummarized is idempotent when called twice on the same session", () => {
      setup();
      const memId1 = createMemoryEntry(memStore, "race-winner");
      const memId2 = createMemoryEntry(memStore, "race-loser");
      const session = convStore.startSession("agent-a");
      convStore.endSession(session.id);

      const first = convStore.markSummarized(session.id, memId1);
      expect(first.status).toBe("summarized");
      expect(first.summaryMemoryId).toBe(memId1);

      // Second call — session is already summarized. Should NOT throw, and
      // should return the existing row (the second memId does NOT overwrite
      // the first).
      const second = convStore.markSummarized(session.id, memId2);
      expect(second.status).toBe("summarized");
      expect(second.summaryMemoryId).toBe(memId1);
    });
  });

  describe("recordTurn", () => {
    it("records a turn with auto-incremented turnIndex (0-based)", () => {
      setup();
      const session = convStore.startSession("agent-a");

      const turn1 = convStore.recordTurn({
        sessionId: session.id,
        role: "user",
        content: "Hello",
        tokenCount: 10,
      });
      const turn2 = convStore.recordTurn({
        sessionId: session.id,
        role: "assistant",
        content: "Hi there",
        tokenCount: 20,
      });

      expect(turn1.turnIndex).toBe(0);
      expect(turn2.turnIndex).toBe(1);
      expect(turn1.id).toBeTruthy();
      expect(turn2.id).toBeTruthy();
    });

    it("increments session turn_count and total_tokens", () => {
      setup();
      const session = convStore.startSession("agent-a");

      convStore.recordTurn({
        sessionId: session.id,
        role: "user",
        content: "Hello",
        tokenCount: 10,
      });
      convStore.recordTurn({
        sessionId: session.id,
        role: "assistant",
        content: "Hi",
        tokenCount: 20,
      });

      const updated = convStore.getSession(session.id);
      expect(updated!.turnCount).toBe(2);
      expect(updated!.totalTokens).toBe(30);
    });

    it("records turn with all fields including optional ones", () => {
      setup();
      const session = convStore.startSession("agent-a");

      const turn = convStore.recordTurn({
        sessionId: session.id,
        role: "user",
        content: "Hello from Discord",
        tokenCount: 15,
        channelId: "ch-123",
        discordUserId: "user-456",
        discordMessageId: "msg-789",
        isTrustedChannel: true,
        origin: "discord:ch-123",
      });

      expect(turn.content).toBe("Hello from Discord");
      expect(turn.tokenCount).toBe(15);
      expect(turn.channelId).toBe("ch-123");
      expect(turn.discordUserId).toBe("user-456");
      expect(turn.discordMessageId).toBe("msg-789");
      expect(turn.isTrustedChannel).toBe(true);
      expect(turn.origin).toBe("discord:ch-123");
      expect(turn.createdAt).toBeTruthy();
    });

    it("defaults optional fields to null/false when omitted", () => {
      setup();
      const session = convStore.startSession("agent-a");

      const turn = convStore.recordTurn({
        sessionId: session.id,
        role: "user",
        content: "Simple message",
      });

      expect(turn.tokenCount).toBeNull();
      expect(turn.channelId).toBeNull();
      expect(turn.discordUserId).toBeNull();
      expect(turn.discordMessageId).toBeNull();
      expect(turn.isTrustedChannel).toBe(false);
      expect(turn.origin).toBeNull();
    });

    it("getTurnsForSession returns turns ordered by turn_index ASC", () => {
      setup();
      const session = convStore.startSession("agent-a");

      convStore.recordTurn({
        sessionId: session.id,
        role: "user",
        content: "First",
      });
      convStore.recordTurn({
        sessionId: session.id,
        role: "assistant",
        content: "Second",
      });
      convStore.recordTurn({
        sessionId: session.id,
        role: "user",
        content: "Third",
      });

      const turns = convStore.getTurnsForSession(session.id);
      expect(turns).toHaveLength(3);
      expect(turns[0].turnIndex).toBe(0);
      expect(turns[1].turnIndex).toBe(1);
      expect(turns[2].turnIndex).toBe(2);
      expect(turns[0].content).toBe("First");
      expect(turns[1].content).toBe("Second");
      expect(turns[2].content).toBe("Third");
    });

    it("getTurnsForSession with limit returns at most N turns", () => {
      setup();
      const session = convStore.startSession("agent-a");

      convStore.recordTurn({
        sessionId: session.id,
        role: "user",
        content: "First",
      });
      convStore.recordTurn({
        sessionId: session.id,
        role: "assistant",
        content: "Second",
      });
      convStore.recordTurn({
        sessionId: session.id,
        role: "user",
        content: "Third",
      });

      const turns = convStore.getTurnsForSession(session.id, 2);
      expect(turns).toHaveLength(2);
      expect(turns[0].turnIndex).toBe(0);
      expect(turns[1].turnIndex).toBe(1);
    });

    it("recording duplicate (session_id, turn_index, role) throws UNIQUE constraint error", () => {
      setup();
      const session = convStore.startSession("agent-a");

      convStore.recordTurn({
        sessionId: session.id,
        role: "user",
        content: "Hello",
      });

      // Manually try to insert duplicate via a second session with same session_id
      // Since recordTurn auto-increments, we need to reach the UNIQUE constraint
      // by using the underlying DB directly
      const db = memStore.getDatabase();
      expect(() => {
        db.prepare(
          `INSERT INTO conversation_turns (id, session_id, turn_index, role, content, is_trusted_channel, created_at)
           VALUES ('dup-id', ?, 0, 'user', 'duplicate', 0, datetime('now'))`,
        ).run(session.id);
      }).toThrow(/UNIQUE/);
    });
  });

  describe("provenance fields (SEC-01)", () => {
    it("stores isTrustedChannel=true as 1 and returns boolean true", () => {
      setup();
      const session = convStore.startSession("agent-a");

      const turn = convStore.recordTurn({
        sessionId: session.id,
        role: "user",
        content: "Trusted message",
        isTrustedChannel: true,
      });

      expect(turn.isTrustedChannel).toBe(true);
      expect(typeof turn.isTrustedChannel).toBe("boolean");

      // Verify via raw DB that it's stored as 1
      const db = memStore.getDatabase();
      const row = db
        .prepare(
          "SELECT is_trusted_channel FROM conversation_turns WHERE id = ?",
        )
        .get(turn.id) as { is_trusted_channel: number };
      expect(row.is_trusted_channel).toBe(1);
    });

    it("stores isTrustedChannel=false (default) as 0 and returns boolean false", () => {
      setup();
      const session = convStore.startSession("agent-a");

      const turn = convStore.recordTurn({
        sessionId: session.id,
        role: "user",
        content: "Untrusted message",
      });

      expect(turn.isTrustedChannel).toBe(false);
      expect(typeof turn.isTrustedChannel).toBe("boolean");

      // Verify raw DB
      const db = memStore.getDatabase();
      const row = db
        .prepare(
          "SELECT is_trusted_channel FROM conversation_turns WHERE id = ?",
        )
        .get(turn.id) as { is_trusted_channel: number };
      expect(row.is_trusted_channel).toBe(0);
    });

    it("stores channelId and discordUserId correctly", () => {
      setup();
      const session = convStore.startSession("agent-a");

      const turn = convStore.recordTurn({
        sessionId: session.id,
        role: "user",
        content: "From Discord",
        channelId: "channel-abc",
        discordUserId: "user-def",
      });

      expect(turn.channelId).toBe("channel-abc");
      expect(turn.discordUserId).toBe("user-def");

      // Verify persisted via getTurnsForSession
      const turns = convStore.getTurnsForSession(session.id);
      expect(turns[0].channelId).toBe("channel-abc");
      expect(turns[0].discordUserId).toBe("user-def");
    });
  });

  describe("immutability", () => {
    it("returned ConversationSession objects are frozen", () => {
      setup();
      const session = convStore.startSession("agent-a");
      expect(Object.isFrozen(session)).toBe(true);
    });

    it("returned ConversationTurn objects are frozen", () => {
      setup();
      const session = convStore.startSession("agent-a");
      const turn = convStore.recordTurn({
        sessionId: session.id,
        role: "user",
        content: "Test",
      });
      expect(Object.isFrozen(turn)).toBe(true);
    });

    it("returned arrays from listRecentSessions are frozen", () => {
      setup();
      convStore.startSession("agent-a");
      const sessions = convStore.listRecentSessions("agent-a", 10);
      expect(Object.isFrozen(sessions)).toBe(true);
    });

    it("returned arrays from getTurnsForSession are frozen", () => {
      setup();
      const session = convStore.startSession("agent-a");
      convStore.recordTurn({
        sessionId: session.id,
        role: "user",
        content: "Test",
      });
      const turns = convStore.getTurnsForSession(session.id);
      expect(Object.isFrozen(turns)).toBe(true);
    });

    it("getSession returns frozen session", () => {
      setup();
      const session = convStore.startSession("agent-a");
      const retrieved = convStore.getSession(session.id);
      expect(Object.isFrozen(retrieved)).toBe(true);
    });

    it("endSession returns frozen session", () => {
      setup();
      const session = convStore.startSession("agent-a");
      const ended = convStore.endSession(session.id);
      expect(Object.isFrozen(ended)).toBe(true);
    });

    it("crashSession returns frozen session", () => {
      setup();
      const session = convStore.startSession("agent-a");
      const crashed = convStore.crashSession(session.id);
      expect(Object.isFrozen(crashed)).toBe(true);
    });

    it("markSummarized returns frozen session", () => {
      setup();
      const memId = createMemoryEntry(memStore, "frozen-test");
      const session = convStore.startSession("agent-a");
      convStore.endSession(session.id);
      const summarized = convStore.markSummarized(session.id, memId);
      expect(Object.isFrozen(summarized)).toBe(true);
    });
  });

  describe("instructionFlags", () => {
    it("recordTurn persists instructionFlags when provided", () => {
      setup();
      const session = convStore.startSession("agent-a");
      const flags = '{"detected":true,"patterns":["<\\\\s*system\\\\s*>"],"riskLevel":"high"}';

      const turn = convStore.recordTurn({
        sessionId: session.id,
        role: "user",
        content: "<system>evil</system>",
        instructionFlags: flags,
      });

      expect(turn.instructionFlags).toBe(flags);

      // Verify via raw DB
      const db = memStore.getDatabase();
      const row = db
        .prepare(
          "SELECT instruction_flags FROM conversation_turns WHERE id = ?",
        )
        .get(turn.id) as { instruction_flags: string | null };
      expect(row.instruction_flags).toBe(flags);
    });

    it("recordTurn stores null instructionFlags when omitted", () => {
      setup();
      const session = convStore.startSession("agent-a");

      const turn = convStore.recordTurn({
        sessionId: session.id,
        role: "user",
        content: "Hello, normal message",
      });

      expect(turn.instructionFlags).toBeNull();
    });

    it("getTurnsForSession returns instructionFlags field", () => {
      setup();
      const session = convStore.startSession("agent-a");
      const flags = '{"detected":true,"patterns":[],"riskLevel":"medium"}';

      convStore.recordTurn({
        sessionId: session.id,
        role: "user",
        content: "Flagged message",
        instructionFlags: flags,
      });
      convStore.recordTurn({
        sessionId: session.id,
        role: "assistant",
        content: "Response",
      });

      const turns = convStore.getTurnsForSession(session.id);
      expect(turns).toHaveLength(2);
      expect(turns[0].instructionFlags).toBe(flags);
      expect(turns[1].instructionFlags).toBeNull();
    });
  });

  describe("lineage support", () => {
    it("source_turn_ids column exists on memories table", () => {
      setup();
      const db = memStore.getDatabase();
      const columns = db
        .prepare("PRAGMA table_info(memories)")
        .all() as ReadonlyArray<{ name: string }>;
      const hasColumn = columns.some((c) => c.name === "source_turn_ids");
      expect(hasColumn).toBe(true);
    });

    it("conversation_sessions table exists with expected columns", () => {
      setup();
      const db = memStore.getDatabase();
      const columns = db
        .prepare("PRAGMA table_info(conversation_sessions)")
        .all() as ReadonlyArray<{ name: string }>;
      const colNames = columns.map((c) => c.name);
      expect(colNames).toContain("id");
      expect(colNames).toContain("agent_name");
      expect(colNames).toContain("started_at");
      expect(colNames).toContain("ended_at");
      expect(colNames).toContain("turn_count");
      expect(colNames).toContain("total_tokens");
      expect(colNames).toContain("summary_memory_id");
      expect(colNames).toContain("status");
    });

    it("conversation_turns table exists with provenance columns", () => {
      setup();
      const db = memStore.getDatabase();
      const columns = db
        .prepare("PRAGMA table_info(conversation_turns)")
        .all() as ReadonlyArray<{ name: string }>;
      const colNames = columns.map((c) => c.name);
      expect(colNames).toContain("id");
      expect(colNames).toContain("session_id");
      expect(colNames).toContain("turn_index");
      expect(colNames).toContain("role");
      expect(colNames).toContain("content");
      expect(colNames).toContain("token_count");
      expect(colNames).toContain("channel_id");
      expect(colNames).toContain("discord_user_id");
      expect(colNames).toContain("discord_message_id");
      expect(colNames).toContain("is_trusted_channel");
      expect(colNames).toContain("origin");
      expect(colNames).toContain("created_at");
    });
  });

  // ---------------------------------------------------------------------
  // Phase 68 Plan 01 — RETR-02: FTS5 migration + sync triggers + backfill
  // ---------------------------------------------------------------------

  describe("FTS5 migration", () => {
    it("creates conversation_turns_fts virtual table idempotently", () => {
      setup();
      const db = memStore.getDatabase();

      const first = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='conversation_turns_fts'",
        )
        .all();
      expect(first.length).toBe(1);

      // Idempotency is provided by `CREATE VIRTUAL TABLE IF NOT EXISTS` +
      // the sqlite_master-gated backfill. Re-invoking the same migration on
      // the same connection must be a no-op. We use the existing
      // :memory: DB and issue the migration SQL again manually — simulates
      // what happens on daemon restart against a shared connection.
      const migrationSql = `
        CREATE VIRTUAL TABLE IF NOT EXISTS conversation_turns_fts USING fts5(
          content,
          content='conversation_turns',
          content_rowid='rowid',
          tokenize='unicode61 remove_diacritics 2'
        );
        CREATE TRIGGER IF NOT EXISTS conversation_turns_ai
        AFTER INSERT ON conversation_turns BEGIN
          INSERT INTO conversation_turns_fts(rowid, content)
            VALUES (new.rowid, new.content);
        END;
      `;
      expect(() => db.exec(migrationSql)).not.toThrow();

      const second = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='conversation_turns_fts'",
        )
        .all();
      expect(second.length).toBe(1);
    });

    it("creates all three triggers (AI/AD/AU) in sqlite_master", () => {
      setup();
      const db = memStore.getDatabase();
      const rows = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'conversation_turns_a%' ORDER BY name",
        )
        .all() as ReadonlyArray<{ name: string }>;
      const names = rows.map((r) => r.name).sort();
      expect(names).toEqual([
        "conversation_turns_ad",
        "conversation_turns_ai",
        "conversation_turns_au",
      ]);
    });
  });

  describe("backfill", () => {
    it("indexes turns recorded before the migration ran", () => {
      // Exercise the backfill path in-process on an in-memory DB:
      //   1. Construct MemoryStore (creates FTS5 table + triggers)
      //   2. Drop FTS5 + triggers, then INSERT a raw turn bypassing triggers
      //      — simulates a pre-Phase-68 row on a schema that didn't have FTS5
      //   3. Manually invoke the same CREATE/BACKFILL SQL the migration runs,
      //      gated on sqlite_master absence (which is now true after drop)
      //   4. Assert the pre-existing row is now in FTS5 and searchable
      setup();
      const db = memStore.getDatabase();
      const session = convStore.startSession("agent-a");

      // Drop FTS5 infra to simulate pre-migration state
      db.exec(`
        DROP TRIGGER IF EXISTS conversation_turns_ai;
        DROP TRIGGER IF EXISTS conversation_turns_ad;
        DROP TRIGGER IF EXISTS conversation_turns_au;
        DROP TABLE IF EXISTS conversation_turns_fts;
      `);

      // Insert with triggers absent — row lands in conversation_turns only
      db.prepare(
        `INSERT INTO conversation_turns
           (id, session_id, turn_index, role, content, token_count,
            channel_id, discord_user_id, discord_message_id,
            is_trusted_channel, origin, instruction_flags, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        "pre-phase-68-turn",
        session.id,
        0,
        "user",
        "pre-migration content about deployment",
        null,
        null,
        null,
        null,
        0,
        null,
        null,
        new Date().toISOString(),
      );

      // Confirm FTS5 absent before re-running the migration
      const before = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='conversation_turns_fts'",
        )
        .all();
      expect(before.length).toBe(0);

      // Re-run the migration body (mirrors migrateConversationTurnsFts)
      const existing = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='conversation_turns_fts'",
        )
        .get();
      const needsBackfill = !existing;
      db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS conversation_turns_fts USING fts5(
          content,
          content='conversation_turns',
          content_rowid='rowid',
          tokenize='unicode61 remove_diacritics 2'
        );
        CREATE TRIGGER IF NOT EXISTS conversation_turns_ai
        AFTER INSERT ON conversation_turns BEGIN
          INSERT INTO conversation_turns_fts(rowid, content)
            VALUES (new.rowid, new.content);
        END;
      `);
      if (needsBackfill) {
        db.exec(`
          INSERT INTO conversation_turns_fts(rowid, content)
            SELECT rowid, content FROM conversation_turns;
        `);
      }

      const ftsCount = db
        .prepare("SELECT COUNT(*) AS c FROM conversation_turns_fts")
        .get() as { c: number };
      const rawCount = db
        .prepare("SELECT COUNT(*) AS c FROM conversation_turns")
        .get() as { c: number };
      expect(ftsCount.c).toBe(rawCount.c);
      expect(rawCount.c).toBe(1);

      const hit = db
        .prepare(
          "SELECT content FROM conversation_turns_fts WHERE conversation_turns_fts MATCH ?",
        )
        .get("deployment") as { content: string } | undefined;
      expect(hit?.content).toContain("deployment");
    });

    it(
      "does not re-run backfill on subsequent MemoryStore constructions",
      { timeout: 30000 },
      () => {
        // Uses an on-disk tmp DB (required because :memory: DBs do not share
        // state across connections). mkdtempSync+rmSync pattern lifted from
        // graph-search.test.ts. Timeout raised to 30s because the parallel
        // vitest pool can contend with other suites opening sqlite-vec on
        // disk; open/close/reopen on a physical file path is slower than the
        // :memory: path used by other tests in this suite.
        const tempDir = mkdtempSync(join(tmpdir(), "fts5-noredup-"));
        const dbPath = join(tempDir, "test.db");
        try {
          const s1 = new MemoryStore(dbPath, {
            enabled: false,
            similarityThreshold: 0.85,
          });
          const c1 = new ConversationStore(s1.getDatabase());
          const session = c1.startSession("agent-a");
          c1.recordTurn({
            sessionId: session.id,
            role: "user",
            content: "hello world idempotency test",
          });
          const countAfterFirst = s1
            .getDatabase()
            .prepare("SELECT COUNT(*) AS c FROM conversation_turns_fts")
            .get() as { c: number };
          expect(countAfterFirst.c).toBe(1);
          s1.close();

          // Second construction — if backfill re-ran unconditionally, count
          // would be 2 (duplicate row). sqlite_master gate prevents that.
          const s2 = new MemoryStore(dbPath, {
            enabled: false,
            similarityThreshold: 0.85,
          });
          const countAfterReopen = s2
            .getDatabase()
            .prepare("SELECT COUNT(*) AS c FROM conversation_turns_fts")
            .get() as { c: number };
          expect(countAfterReopen.c).toBe(1);
          s2.close();
        } finally {
          rmSync(tempDir, { recursive: true, force: true });
        }
      },
    );
  });

  describe("trigger", () => {
    it("keeps FTS5 in sync on INSERT via recordTurn", () => {
      setup();
      const session = convStore.startSession("agent-a");
      convStore.recordTurn({
        sessionId: session.id,
        role: "user",
        content: "hello world",
      });

      const db = memStore.getDatabase();
      const rows = db
        .prepare(
          "SELECT rowid, content FROM conversation_turns_fts WHERE conversation_turns_fts MATCH ?",
        )
        .all("hello") as ReadonlyArray<{ rowid: number; content: string }>;
      expect(rows.length).toBe(1);
      expect(rows[0]!.content).toBe("hello world");
    });

    it("removes from FTS5 on DELETE", () => {
      setup();
      const session = convStore.startSession("agent-a");
      const turn = convStore.recordTurn({
        sessionId: session.id,
        role: "user",
        content: "delete me deployment",
      });

      const db = memStore.getDatabase();
      // Confirm present
      const before = db
        .prepare(
          "SELECT COUNT(*) AS c FROM conversation_turns_fts WHERE conversation_turns_fts MATCH 'deployment'",
        )
        .get() as { c: number };
      expect(before.c).toBe(1);

      db.prepare("DELETE FROM conversation_turns WHERE id = ?").run(turn.id);

      const after = db
        .prepare(
          "SELECT COUNT(*) AS c FROM conversation_turns_fts WHERE conversation_turns_fts MATCH 'deployment'",
        )
        .get() as { c: number };
      expect(after.c).toBe(0);
    });

    it("replaces FTS5 entry on UPDATE", () => {
      setup();
      const session = convStore.startSession("agent-a");
      const turn = convStore.recordTurn({
        sessionId: session.id,
        role: "user",
        content: "hello team",
      });

      const db = memStore.getDatabase();
      db.prepare("UPDATE conversation_turns SET content = ? WHERE id = ?").run(
        "goodbye team",
        turn.id,
      );

      const helloHits = db
        .prepare(
          "SELECT COUNT(*) AS c FROM conversation_turns_fts WHERE conversation_turns_fts MATCH 'hello'",
        )
        .get() as { c: number };
      const goodbyeHits = db
        .prepare(
          "SELECT COUNT(*) AS c FROM conversation_turns_fts WHERE conversation_turns_fts MATCH 'goodbye'",
        )
        .get() as { c: number };
      expect(helloHits.c).toBe(0);
      expect(goodbyeHits.c).toBe(1);
    });
  });

  // ---------------------------------------------------------------------
  // Phase 68 Plan 01 — RETR-02: searchTurns + escapeFtsQuery
  // ---------------------------------------------------------------------

  describe("searchTurns", () => {
    it("returns BM25-ranked matches ordered best-first", () => {
      setup();
      const session = convStore.startSession("agent-a");
      convStore.recordTurn({
        sessionId: session.id,
        role: "user",
        content: "deployment strategy discussion about CI",
        isTrustedChannel: true,
      });
      convStore.recordTurn({
        sessionId: session.id,
        role: "assistant",
        content: "deployment deployment deployment — high density",
        isTrustedChannel: true,
      });
      convStore.recordTurn({
        sessionId: session.id,
        role: "user",
        content: "lunch order today at noon",
        isTrustedChannel: true,
      });

      const out = convStore.searchTurns("deployment", {
        limit: 10,
        offset: 0,
      });
      expect(out.results.length).toBe(2);
      expect(out.totalMatches).toBe(2);
      // Both results contain "deployment"
      for (const r of out.results) {
        expect(r.content.toLowerCase()).toContain("deployment");
      }
      // BM25 ascending — results[0] has the lower (more negative) bm25Score
      expect(out.results[0]!.bm25Score).toBeLessThanOrEqual(
        out.results[1]!.bm25Score,
      );
    });

    it("projects sessionId, role, isTrustedChannel on each result", () => {
      setup();
      const session = convStore.startSession("agent-a");
      convStore.recordTurn({
        sessionId: session.id,
        role: "user",
        content: "project specific keyword",
        isTrustedChannel: true,
      });

      const out = convStore.searchTurns("keyword", { limit: 10, offset: 0 });
      expect(out.results.length).toBe(1);
      const r = out.results[0]!;
      expect(r.sessionId).toBe(session.id);
      expect(r.role).toBe("user");
      expect(r.isTrustedChannel).toBe(true);
      // Typecheck: boolean (not number 0/1)
      expect(typeof r.isTrustedChannel).toBe("boolean");
    });

    it("honors limit and offset pagination parameters", () => {
      setup();
      const session = convStore.startSession("agent-a");
      for (let i = 0; i < 15; i++) {
        convStore.recordTurn({
          sessionId: session.id,
          role: "user",
          content: `foo instance ${i}`,
          isTrustedChannel: true,
        });
      }

      const page1 = convStore.searchTurns("foo", { limit: 5, offset: 0 });
      const page2 = convStore.searchTurns("foo", { limit: 5, offset: 5 });
      const page3 = convStore.searchTurns("foo", { limit: 5, offset: 14 });

      expect(page1.results.length).toBe(5);
      expect(page2.results.length).toBe(5);
      expect(page3.results.length).toBe(1);
      expect(page1.totalMatches).toBe(15);
      expect(page2.totalMatches).toBe(15);
      expect(page3.totalMatches).toBe(15);

      // Distinct pages — no turnId overlap between page1 and page2
      const ids1 = new Set(page1.results.map((r) => r.turnId));
      const ids2 = new Set(page2.results.map((r) => r.turnId));
      for (const id of ids2) {
        expect(ids1.has(id)).toBe(false);
      }
    });

    it("excludes untrusted-channel turns by default (SEC-01 hygiene)", () => {
      setup();
      const session = convStore.startSession("agent-a");
      convStore.recordTurn({
        sessionId: session.id,
        role: "user",
        content: "secret plan trusted",
        isTrustedChannel: true,
      });
      convStore.recordTurn({
        sessionId: session.id,
        role: "user",
        content: "secret plan untrusted",
        isTrustedChannel: false,
      });

      const out = convStore.searchTurns("secret", { limit: 10, offset: 0 });
      expect(out.results.length).toBe(1);
      expect(out.totalMatches).toBe(1);
      expect(out.results[0]!.isTrustedChannel).toBe(true);
      expect(out.results[0]!.content).toContain("trusted");
    });

    it("includes untrusted-channel turns when includeUntrustedChannels: true", () => {
      setup();
      const session = convStore.startSession("agent-a");
      convStore.recordTurn({
        sessionId: session.id,
        role: "user",
        content: "secret plan trusted",
        isTrustedChannel: true,
      });
      convStore.recordTurn({
        sessionId: session.id,
        role: "user",
        content: "secret plan untrusted",
        isTrustedChannel: false,
      });

      const out = convStore.searchTurns("secret", {
        limit: 10,
        offset: 0,
        includeUntrustedChannels: true,
      });
      expect(out.results.length).toBe(2);
      expect(out.totalMatches).toBe(2);
    });

    it("returns frozen results array and frozen result objects", () => {
      setup();
      const session = convStore.startSession("agent-a");
      convStore.recordTurn({
        sessionId: session.id,
        role: "user",
        content: "immutability check",
        isTrustedChannel: true,
      });

      const out = convStore.searchTurns("immutability", {
        limit: 10,
        offset: 0,
      });
      expect(Object.isFrozen(out)).toBe(true);
      expect(Object.isFrozen(out.results)).toBe(true);
      expect(Object.isFrozen(out.results[0])).toBe(true);
    });
  });

  describe("escape", () => {
    it("escapes special characters in queries without crashing FTS5 parser", () => {
      setup();
      const session = convStore.startSession("agent-a");
      // Stored content includes a colon — our query below also contains a colon.
      // Without escapeFtsQuery, FTS5 would interpret `endpoint:` as a column
      // filter and throw `fts5: no such column 'endpoint'`.
      convStore.recordTurn({
        sessionId: session.id,
        role: "user",
        content: "the endpoint timeout: /v1/deploy fails after 30s",
        isTrustedChannel: true,
      });

      // Colon is FTS5-reserved (column filter syntax) — must not throw
      expect(() =>
        convStore.searchTurns("endpoint timeout", { limit: 10, offset: 0 }),
      ).not.toThrow();
      expect(() =>
        convStore.searchTurns("endpoint: fails", { limit: 10, offset: 0 }),
      ).not.toThrow();
      expect(() =>
        convStore.searchTurns("(boolean) groups", { limit: 10, offset: 0 }),
      ).not.toThrow();

      // Phrase "endpoint timeout" is adjacent in the content so the match lands
      const out = convStore.searchTurns("endpoint timeout", {
        limit: 10,
        offset: 0,
      });
      expect(out.results.length).toBeGreaterThanOrEqual(1);
      expect(out.results[0]!.content).toContain("endpoint");
    });

    it("handles empty and whitespace-only queries safely", () => {
      setup();
      const session = convStore.startSession("agent-a");
      convStore.recordTurn({
        sessionId: session.id,
        role: "user",
        content: "some body text",
        isTrustedChannel: true,
      });

      const empty = convStore.searchTurns("", { limit: 10, offset: 0 });
      expect(empty.results.length).toBe(0);
      expect(empty.totalMatches).toBe(0);

      const whitespace = convStore.searchTurns("   ", {
        limit: 10,
        offset: 0,
      });
      expect(whitespace.results.length).toBe(0);
      expect(whitespace.totalMatches).toBe(0);
    });

    it("escapes embedded double-quotes", () => {
      setup();
      const session = convStore.startSession("agent-a");
      convStore.recordTurn({
        sessionId: session.id,
        role: "user",
        content: 'She said "hello" and waved',
        isTrustedChannel: true,
      });

      // Trailing quote — classic FTS5 parse hazard
      expect(() =>
        convStore.searchTurns('hello"', { limit: 10, offset: 0 }),
      ).not.toThrow();

      // Embedded quote must not crash either
      expect(() =>
        convStore.searchTurns('hello "world', { limit: 10, offset: 0 }),
      ).not.toThrow();
    });

    it("escapeFtsQuery() helper returns a phrase-quoted, empty-safe string", () => {
      // Directly exercise the exported helper — guarantees no regression in
      // the escape strategy even if ConversationStore grows alternate paths.
      // Note: import is at top of file (module-level).
      expect(escapeFtsQueryUnderTest("")).toBe('""');
      expect(escapeFtsQueryUnderTest("   ")).toBe('""');
      expect(escapeFtsQueryUnderTest("hello")).toBe('"hello"');
      expect(escapeFtsQueryUnderTest('say "hi"')).toBe('"say ""hi"""');
      expect(escapeFtsQueryUnderTest("a:b(c)")).toBe('"a:b(c)"');
    });
  });

  // -------------------------------------------------------------------------
  // Gap 2 (memory-persistence-gaps) — deleteTurnsForSession
  // -------------------------------------------------------------------------
  describe("deleteTurnsForSession", () => {
    it("removes all turns for the given session and returns the count", () => {
      setup();
      const session = convStore.startSession("agent-a");
      for (let i = 0; i < 5; i++) {
        convStore.recordTurn({
          sessionId: session.id,
          role: i % 2 === 0 ? "user" : "assistant",
          content: `turn ${i}`,
        });
      }
      expect(convStore.getTurnsForSession(session.id)).toHaveLength(5);

      const deleted = convStore.deleteTurnsForSession(session.id);
      expect(deleted).toBe(5);
      expect(convStore.getTurnsForSession(session.id)).toHaveLength(0);
    });

    it("returns 0 and is a no-op when the session has no turns", () => {
      setup();
      const session = convStore.startSession("agent-a");
      expect(convStore.deleteTurnsForSession(session.id)).toBe(0);
    });

    it("only deletes turns for the target session (isolation)", () => {
      setup();
      const s1 = convStore.startSession("agent-a");
      const s2 = convStore.startSession("agent-a");
      convStore.recordTurn({ sessionId: s1.id, role: "user", content: "a1" });
      convStore.recordTurn({ sessionId: s1.id, role: "assistant", content: "a2" });
      convStore.recordTurn({ sessionId: s2.id, role: "user", content: "b1" });

      expect(convStore.deleteTurnsForSession(s1.id)).toBe(2);
      expect(convStore.getTurnsForSession(s1.id)).toHaveLength(0);
      expect(convStore.getTurnsForSession(s2.id)).toHaveLength(1);
    });

    it("leaves the session row intact after deleting its turns", () => {
      setup();
      const session = convStore.startSession("agent-a");
      convStore.recordTurn({ sessionId: session.id, role: "user", content: "x" });
      convStore.deleteTurnsForSession(session.id);

      const stillThere = convStore.getSession(session.id);
      expect(stillThere).not.toBeNull();
      expect(stillThere!.id).toBe(session.id);
    });
  });
});
