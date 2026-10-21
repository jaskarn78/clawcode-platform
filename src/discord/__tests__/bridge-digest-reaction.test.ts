/**
 * Phase 999.127 — reactions on a memory-digest message are applied
 * daemon-side (no model turn) and never forwarded; anything else on the
 * message, and number reactions on ordinary messages, fall through.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { MemoryStore } from "../../memory/store.js";
import { ConversationStore } from "../../memory/conversation-store.js";
import { NUMBER_EMOJI, parseDigestMessage, renderDigest, selectDigestMemories } from "../../manager/memory-digest.js";

function unit(i: number): Float32Array {
  const v = new Float32Array(384);
  v[i % 384] = 1;
  return v;
}

describe("memory-digest reactions — Phase 999.127", () => {
  let bridge: any;
  let store: MemoryStore;
  let forwardToAgent: ReturnType<typeof vi.fn>;
  let digestText: string;
  let ids: string[];

  beforeEach(async () => {
    store = new MemoryStore(":memory:", { enabled: false, similarityThreshold: 0.85 });
    new ConversationStore(store.getDatabase());
    ids = ["Sam likes tea", "Sam runs on Sundays"].map((c, i) =>
      store.insert({ content: c, source: "manual", importance: 0.5, skipDedup: true }, unit(i)).id,
    );
    const now = Date.now();
    const window = { since: new Date(now - 7 * 86_400_000).toISOString(), until: new Date(now).toISOString() };
    digestText = renderDigest(selectDigestMemories(store, window), window);
    forwardToAgent = vi.fn().mockResolvedValue(undefined);
    const mod = await import("../bridge.js");
    bridge = new mod.DiscordBridge({
      routingTableRef: {
        current: {
          channelToAgent: new Map([["chan-1", "test-agent"]]),
          agentToChannels: new Map([["test-agent", ["chan-1"]]]),
        },
      },
      sessionManager: {
        forwardToAgent,
        streamFromAgent: vi.fn(),
        getAgentConfig: vi.fn().mockReturnValue({ workspace: "/tmp/test-agent" }),
        getTraceCollector: vi.fn().mockReturnValue(undefined),
        getMemoryStore: vi.fn().mockReturnValue(store),
        advisorEvents: new EventEmitter(),
      } as unknown as import("../../manager/session-manager.js").SessionManager,
      botToken: "fake-token",
      log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } as unknown as import("pino").Logger,
    });
  });
  afterEach(() => store.close());

  function reaction(emoji: string, content: string) {
    const reply = vi.fn().mockResolvedValue(undefined);
    return {
      r: {
        partial: false,
        emoji: { name: emoji, id: null },
        message: { partial: false, channelId: "chan-1", id: "000000000000000035", content, reply },
        fetch: vi.fn(),
      },
      reply,
    };
  }
  const user = { bot: false, id: "u1", username: "sam" };

  it("a number reaction forgets that item and replies; nothing is forwarded", async () => {
    // Item order follows importance/recency; pick the number from the text.
    const target = parseDigestMessage(digestText)!.find((it) => it.line === "Sam runs on Sundays")!;
    const { r, reply } = reaction(NUMBER_EMOJI[target.index - 1]!, digestText);
    await bridge.handleReaction(r, user, "add");
    expect(store.getById(ids[1]!)).toBeNull();
    expect(store.getById(ids[0]!)).not.toBeNull();
    expect(reply).toHaveBeenCalledWith(`Noted. I've forgotten #${target.index}: "Sam runs on Sundays"`);
    expect(forwardToAgent).not.toHaveBeenCalled();
  });

  it("👍 confirms every item", async () => {
    const { r, reply } = reaction("👍", digestText);
    await bridge.handleReaction(r, user, "add");
    expect(store.getById(ids[0]!)!.tags).toContain("confirmed");
    expect(store.getById(ids[1]!)!.importance).toBe(0.9);
    expect(reply).toHaveBeenCalledWith("Thanks. I've marked all 2 as confirmed.");
    expect(forwardToAgent).not.toHaveBeenCalled();
  });

  it("an unrelated emoji on the digest, and a number on an ordinary message, fall through", async () => {
    const a = reaction("🎉", digestText);
    await bridge.handleReaction(a.r, user, "add");
    expect(a.reply).not.toHaveBeenCalled();
    expect(forwardToAgent).toHaveBeenCalledTimes(1);
    const b = reaction("1️⃣", "just a normal bot message");
    await bridge.handleReaction(b.r, user, "add");
    expect(store.getById(ids[0]!)).not.toBeNull();
    expect(forwardToAgent).toHaveBeenCalledTimes(2);
  });

  it("bot reactions (the seeded ones) are ignored", async () => {
    const { r, reply } = reaction("1️⃣", digestText);
    await bridge.handleReaction(r, { bot: true, id: "bot", username: "bot" }, "add");
    expect(reply).not.toHaveBeenCalled();
    expect(store.getById(ids[0]!)).not.toBeNull();
  });
});
