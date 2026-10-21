/**
 * Phase 999.119 pass 2 — conversation-session hygiene: stale-active close
 * at agent start, orphaned-active close for non-running names, empty
 * terminated-row pruning, and the census the doctor prints.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { MemoryStore } from "../store.js";
import { ConversationStore } from "../conversation-store.js";

const OLD = "2026-01-01T00:00:00.000Z";
const RECENT = "2026-09-05T00:00:00.000Z";

let memStore: MemoryStore;
let conv: ConversationStore;

function insertSession(id: string, agentName: string, status: string, startedAt: string): void {
  memStore
    .getDatabase()
    .prepare(
      `INSERT INTO conversation_sessions (id, agent_name, started_at, status, ended_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(id, agentName, startedAt, status, status === "active" ? null : startedAt);
}

function insertTurn(sessionId: string): void {
  memStore
    .getDatabase()
    .prepare(
      `INSERT INTO conversation_turns (id, session_id, turn_index, role, content, created_at)
       VALUES (?, ?, 0, 'user', 'hi', ?)`,
    )
    .run(`turn-${sessionId}`, sessionId, RECENT);
}

function statusOf(id: string): string | undefined {
  const row = memStore
    .getDatabase()
    .prepare("SELECT status FROM conversation_sessions WHERE id = ?")
    .get(id) as { status: string } | undefined;
  return row?.status;
}

beforeEach(() => {
  memStore = new MemoryStore(":memory:", { enabled: false, similarityThreshold: 0.85 });
  conv = new ConversationStore(memStore.getDatabase());
});

afterEach(() => memStore.close());

describe("closeStaleActiveSessions", () => {
  it("closes every other active row for the agent as crashed and keeps the new one", () => {
    insertSession("old-1", "projects", "active", OLD);
    insertSession("old-2", "projects", "active", OLD);
    insertSession("other-agent", "personal", "active", OLD);
    const fresh = conv.startSession("projects");

    expect(conv.closeStaleActiveSessions("projects", fresh.id)).toBe(2);

    expect(statusOf("old-1")).toBe("crashed");
    expect(statusOf("old-2")).toBe("crashed");
    expect(statusOf(fresh.id)).toBe("active");
    expect(statusOf("other-agent")).toBe("active");
    const ended = memStore
      .getDatabase()
      .prepare("SELECT ended_at FROM conversation_sessions WHERE id = 'old-1'")
      .get() as { ended_at: string | null };
    expect(ended.ended_at).not.toBeNull();
  });

  it("is a no-op when the agent has no stale rows", () => {
    const fresh = conv.startSession("projects");
    expect(conv.closeStaleActiveSessions("projects", fresh.id)).toBe(0);
  });
});

describe("closeOrphanedActiveSessions", () => {
  it("closes old active rows whose name is not running, leaves running names and recent rows alone", () => {
    insertSession("fork-old", "projects-fork-abc123", "active", OLD);
    insertSession("fork-new", "projects-fork-def456", "active", RECENT);
    insertSession("running-old", "projects", "active", OLD);

    const closed = conv.closeOrphanedActiveSessions(["projects", "personal"], "2026-06-01T00:00:00.000Z");

    expect(closed).toBe(1);
    expect(statusOf("fork-old")).toBe("crashed");
    expect(statusOf("fork-new")).toBe("active");
    expect(statusOf("running-old")).toBe("active");
  });

  it("with no running names, every old active row is closed", () => {
    insertSession("a", "x", "active", OLD);
    insertSession("b", "y", "active", OLD);
    expect(conv.closeOrphanedActiveSessions([], "2026-06-01T00:00:00.000Z")).toBe(2);
  });
});

describe("pruneEmptyTerminatedSessions", () => {
  it("deletes only old, terminated, turn-less, unarchived rows", () => {
    insertSession("empty-old", "projects", "ended", OLD);
    insertSession("empty-crashed-old", "projects", "crashed", OLD);
    insertSession("empty-recent", "projects", "ended", RECENT);
    insertSession("with-turns-old", "projects", "ended", OLD);
    insertTurn("with-turns-old");
    insertSession("active-old", "projects", "active", OLD);
    insertSession("archived-old", "projects", "summarized", OLD);
    memStore
      .getDatabase()
      .prepare(
        `INSERT INTO session_archive (session_id, agent_name, archived_at, archived_from, full_text)
         VALUES ('archived-old', 'projects', ?, 'summary-only', 'text')`,
      )
      .run(RECENT);

    const pruned = conv.pruneEmptyTerminatedSessions("2026-06-01T00:00:00.000Z");

    expect(pruned).toBe(2);
    expect(statusOf("empty-old")).toBeUndefined();
    expect(statusOf("empty-crashed-old")).toBeUndefined();
    expect(statusOf("empty-recent")).toBe("ended");
    expect(statusOf("with-turns-old")).toBe("ended");
    expect(statusOf("active-old")).toBe("active");
    expect(statusOf("archived-old")).toBe("summarized");
  });
});

describe("getSessionHealth", () => {
  it("reports the counts the doctor prints", () => {
    insertSession("active-empty-old", "projects", "active", OLD);
    insertSession("active-turns-recent", "projects", "active", RECENT);
    insertTurn("active-turns-recent");
    insertSession("ended-empty-old", "projects", "ended", OLD);
    insertSession("ended-turns-old", "projects", "ended", OLD);
    insertTurn("ended-turns-old");

    const health = conv.getSessionHealth("2026-06-01T00:00:00.000Z", "2026-06-01T00:00:00.000Z");

    expect(health).toEqual({
      total: 4,
      active: 2,
      activeEmpty: 1,
      staleActive: 1,
      emptyTerminated: 1,
    });
  });
});
