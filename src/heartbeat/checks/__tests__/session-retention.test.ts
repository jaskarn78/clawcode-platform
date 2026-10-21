/**
 * Phase 999.119 pass 2 — session-retention heartbeat check.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import sessionRetentionCheck, {
  EMPTY_SESSION_RETENTION_DAYS,
  ORPHAN_ACTIVE_MAX_AGE_MS,
} from "../session-retention.js";
import { MemoryStore } from "../../../memory/store.js";
import { ConversationStore } from "../../../memory/conversation-store.js";
import type { CheckContext } from "../../types.js";

let memStore: MemoryStore;
let conv: ConversationStore;

function makeContext(agentName: string, running: readonly string[], withStore = true): CheckContext {
  const sessionManager = {
    getRunningAgents: () => running,
    getConversationStore: (name: string) => (withStore && name === agentName ? conv : undefined),
  } as unknown as CheckContext["sessionManager"];
  return {
    agentName,
    sessionManager,
    registry: {} as CheckContext["registry"],
    config: {
      enabled: true,
      intervalSeconds: 60,
      checkTimeoutSeconds: 10,
      contextFill: { warningThreshold: 0.8, criticalThreshold: 0.95 },
    },
  };
}

function insertSession(id: string, agentName: string, status: string, startedAt: string): void {
  memStore
    .getDatabase()
    .prepare(
      "INSERT INTO conversation_sessions (id, agent_name, started_at, status) VALUES (?, ?, ?, ?)",
    )
    .run(id, agentName, startedAt, status);
}

beforeEach(() => {
  memStore = new MemoryStore(":memory:", { enabled: false, similarityThreshold: 0.85 });
  conv = new ConversationStore(memStore.getDatabase());
});

afterEach(() => memStore.close());

describe("session-retention heartbeat check", () => {
  it("registers daily with the fork guard", async () => {
    expect(sessionRetentionCheck.name).toBe("session-retention");
    expect(sessionRetentionCheck.interval).toBe(86400);
    const result = await sessionRetentionCheck.execute(makeContext("projects-fork-6NMty0", ["projects"]));
    expect(result.metadata).toEqual({ skipped: true, reason: "shared-parent-store" });
  });

  it("closes orphaned active rows and prunes empty terminated rows", async () => {
    const twoDaysAgo = new Date(Date.now() - 2 * ORPHAN_ACTIVE_MAX_AGE_MS).toISOString();
    const longAgo = new Date(
      Date.now() - (EMPTY_SESSION_RETENTION_DAYS + 5) * 24 * 60 * 60 * 1000,
    ).toISOString();
    insertSession("fork-orphan", "projects-fork-abc123", "active", twoDaysAgo);
    insertSession("live", "projects", "active", twoDaysAgo);
    insertSession("empty-old", "projects", "ended", longAgo);

    const result = await sessionRetentionCheck.execute(makeContext("projects", ["projects"]));

    expect(result.status).toBe("healthy");
    expect(result.message).toBe("Closed 1 orphaned active session(s), pruned 1 empty terminated session(s)");
    expect(result.metadata?.closed).toBe(1);
    expect(result.metadata?.pruned).toBe(1);
    const rows = memStore
      .getDatabase()
      .prepare("SELECT id, status FROM conversation_sessions ORDER BY id")
      .all() as Array<{ id: string; status: string }>;
    expect(rows).toEqual([
      { id: "fork-orphan", status: "crashed" },
      { id: "live", status: "active" },
    ]);
  });

  it("reports 'No stale sessions' on a clean table", async () => {
    const result = await sessionRetentionCheck.execute(makeContext("projects", ["projects"]));
    expect(result.status).toBe("healthy");
    expect(result.message).toBe("No stale sessions");
  });

  it("is healthy when the agent has no conversation store", async () => {
    const result = await sessionRetentionCheck.execute(makeContext("projects", ["projects"], false));
    expect(result.status).toBe("healthy");
    expect(result.message).toBe("No conversation store");
  });
});
