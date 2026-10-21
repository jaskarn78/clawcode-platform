/**
 * 999.155 — messages buffered with ⏳ behind a SELF-FIRED turn (transcription
 * summary, reaction, timed-out send) have no Discord turn left to drain them.
 * The sweep drains them once the agent is idle (state-contract 2026-09-22).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Message } from "discord.js";

vi.mock("../../ipc/client.js", () => ({ sendIpcRequest: vi.fn().mockResolvedValue({}) }));

function fakeMessage(id: string, content: string): Message {
  return {
    id,
    content,
    channelId: "chan-sc",
    author: { id: "u-client-a", username: "client-a-user", bot: false },
    createdAt: new Date("2026-09-22T16:57:10Z"),
    attachments: { size: 0, values: () => [][Symbol.iterator](), [Symbol.iterator]: () => [][Symbol.iterator]() },
    reference: null,
    react: vi.fn().mockResolvedValue(undefined),
    reactions: { cache: new Map() },
    channel: { sendTyping: vi.fn(), send: vi.fn().mockResolvedValue({ edit: vi.fn(), id: "reply" }), messages: { fetch: vi.fn() } },
  } as unknown as Message;
}

describe("stranded coalesced drain sweep", () => {
  const streamFromAgent = vi.fn();
  let active = true;
  let DiscordBridge: new (opts: Record<string, unknown>) => Record<string, unknown>;

  beforeEach(async () => {
    vi.clearAllMocks();
    active = true;
    streamFromAgent.mockResolvedValue("answered all three");
    DiscordBridge = (await import("../bridge.js")).DiscordBridge as never;
  });

  function makeBridge() {
    const bridge = new DiscordBridge({
      routingTableRef: {
        current: {
          channelToAgent: new Map([["chan-sc", "state-contract"]]),
          agentToChannels: new Map([["state-contract", ["chan-sc"]]]),
        },
      },
      sessionManager: {
        streamFromAgent,
        getAgentConfig: () => ({ memoryPath: "/mem" }),
        advisorEvents: { on: vi.fn(), off: vi.fn() },
        hasActiveTurn: () => active,
      },
      botToken: "t",
      log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
    });
    return bridge;
  }

  it("drains buffered messages once the self-fired turn releases the queue", async () => {
    const bridge = makeBridge();
    const last = fakeMessage("m3", "third");
    const coalescer = bridge.messageCoalescer as {
      addMessage(a: string, c: string, id: string): boolean;
      getPendingCount(a: string): number;
    };
    coalescer.addMessage("state-contract", "first", "m1");
    coalescer.addMessage("state-contract", "second", "m2");
    coalescer.addMessage("state-contract", "third", "m3");
    (bridge.coalescedChannelById as Map<string, string>).set("m3", "chan-sc");
    (bridge.client as { channels: unknown }).channels = {
      fetch: vi.fn().mockResolvedValue({ messages: { fetch: vi.fn().mockResolvedValue(last) } }),
    };

    // Still held by the self-fired turn → nothing happens.
    await (bridge.sweepStrandedCoalesced as () => Promise<void>).call(bridge);
    expect(streamFromAgent).not.toHaveBeenCalled();
    expect(coalescer.getPendingCount("state-contract")).toBe(3);

    // Queue released → one combined turn answering all three.
    active = false;
    await (bridge.sweepStrandedCoalesced as () => Promise<void>).call(bridge);
    expect(streamFromAgent).toHaveBeenCalledTimes(1);
    const text = streamFromAgent.mock.calls[0]![1] as string;
    expect(text).toContain("first");
    expect(text).toContain("second");
    expect(text).toContain("third");
    expect(coalescer.getPendingCount("state-contract")).toBe(0);
  });
});
