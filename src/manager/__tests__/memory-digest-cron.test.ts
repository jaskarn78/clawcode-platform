/**
 * Phase 999.127 — the weekly digest tick: posts per agent, seeds reactions,
 * skips derived sessions / disabled agents / empty weeks, isolates failures.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import pino from "pino";
import { MemoryStore } from "../../memory/store.js";
import { ConversationStore } from "../../memory/conversation-store.js";
import { runMemoryDigestTick, scheduleMemoryDigestCron } from "../memory-digest-cron.js";

const log = pino({ level: "silent" });
const NOW = Date.UTC(2026, 8, 7, 16, 0, 0); // Mon 2026-09-07 09:00 PT

function unit(i: number): Float32Array {
  const v = new Float32Array(384);
  v[i % 384] = 1;
  return v;
}

describe("memory digest cron", () => {
  const stores: MemoryStore[] = [];
  afterEach(() => {
    for (const s of stores.splice(0)) s.close();
  });

  function storeWith(memories: ReadonlyArray<{ content: string; ageDays: number }>): MemoryStore {
    const store = new MemoryStore(":memory:", { enabled: false, similarityThreshold: 0.85 });
    new ConversationStore(store.getDatabase());
    memories.forEach((m, i) => {
      const e = store.insert({ content: m.content, source: "manual", importance: 0.5, skipDedup: true }, unit(i));
      const at = new Date(NOW - m.ageDays * 86_400_000).toISOString();
      // insert() derives importance from the content; pin it so ordering is by recency.
      store
        .getDatabase()
        .prepare("UPDATE memories SET created_at = ?, updated_at = ?, accessed_at = ?, importance = 0.5 WHERE id = ?")
        .run(at, at, at, e.id);
    });
    stores.push(store);
    return store;
  }

  it("posts one digest per eligible agent and seeds the number reactions plus 👍", async () => {
    const alice = storeWith([{ content: "Alice likes tea", ageDays: 2 }, { content: "Alice runs on Sundays", ageDays: 5 }]);
    const bob = storeWith([{ content: "Old news", ageDays: 30 }]);
    const posts: Array<{ channelId: string; content: string }> = [];
    const reactions: Array<[string, string, string]> = [];
    const outcomes = await runMemoryDigestTick({
      manager: {
        getRunningAgents: () => ["alice", "alice-fork-abc123", "bob", "carol"],
        getMemoryStore: (a) => (a === "alice" ? alice : a === "bob" ? bob : undefined),
        getAgentConfig: (a) => (a === "carol" ? { memoryDigest: { enabled: false } } : {}),
      },
      channelFor: (a) => (a === "carol" ? undefined : `chan-${a}`),
      sender: () => ({
        sendText: vi.fn(async (channelId: string, content: string) => {
          posts.push({ channelId, content });
          return "msg-1";
        }),
      }),
      reactor: () => ({
        react: async (c, m, e) => {
          reactions.push([c, m, e]);
        },
      }),
      log,
      now: () => NOW,
    });
    expect(outcomes).toEqual([
      { agent: "alice", status: "posted", items: 2 },
      { agent: "bob", status: "empty", items: 0 },
      { agent: "carol", status: "skipped", reason: "disabled" },
    ]);
    expect(posts).toHaveLength(1);
    expect(posts[0]!.channelId).toBe("chan-alice");
    expect(posts[0]!.content).toContain("1. Alice likes tea");
    expect(posts[0]!.content).toContain("2. Alice runs on Sundays");
    expect(reactions.map((r) => r[2])).toEqual(["1️⃣", "2️⃣", "👍"]);
  });

  it("a failing post is isolated to its agent and a missing sender is a skip", async () => {
    const alice = storeWith([{ content: "Alice likes tea", ageDays: 2 }]);
    const bob = storeWith([{ content: "Bob likes coffee", ageDays: 1 }]);
    const outcomes = await runMemoryDigestTick({
      manager: {
        getRunningAgents: () => ["alice", "bob"],
        getMemoryStore: (a) => (a === "alice" ? alice : bob),
        getAgentConfig: () => ({}),
      },
      channelFor: (a) => `chan-${a}`,
      sender: () => ({
        sendText: vi.fn(async (channelId: string) => {
          if (channelId === "chan-alice") throw new Error("Missing Permissions");
          return "msg-2";
        }),
      }),
      log,
      now: () => NOW,
    });
    expect(outcomes).toEqual([
      { agent: "alice", status: "failed", reason: "Missing Permissions" },
      { agent: "bob", status: "posted", items: 1 },
    ]);
    const none = await runMemoryDigestTick({
      manager: { getRunningAgents: () => ["bob"], getMemoryStore: () => bob, getAgentConfig: () => ({}) },
      channelFor: () => "chan-bob",
      sender: () => undefined,
      log,
      now: () => NOW,
    });
    expect(none).toEqual([{ agent: "bob", status: "skipped", reason: "no sender" }]);
  });

  it("schedules with the Monday pattern and the Pacific timezone by default", () => {
    const factory = vi.fn((_p: string, _o: unknown, _cb: unknown) => ({ stop: vi.fn() }));
    scheduleMemoryDigestCron({
      manager: { getRunningAgents: () => [], getMemoryStore: () => undefined, getAgentConfig: () => undefined },
      channelFor: () => undefined,
      sender: () => undefined,
      log,
      cronFactory: factory,
    });
    expect(factory).toHaveBeenCalledWith("0 9 * * 1", { name: "memory-digest", timezone: "America/Los_Angeles" }, expect.any(Function));
  });
});
