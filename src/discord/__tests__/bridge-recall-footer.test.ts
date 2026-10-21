/**
 * Phase 999.124 / 999.133 — recalled memory at the single mutation point.
 *
 * Default (`memoryRecallDisplay: button`): NO footer text; the recall is
 * recorded on the turn ledger so the 🧾 Sources button/card carries it.
 * `memoryRecallDisplay: footer`: the italic line (+ verbose block), as before.
 *
 * Harness mirrors bridge-steered-footer.test.ts — real DiscordBridge, real
 * private `streamAndPostResponse`, spied `sendResponse`, a stub turn
 * dispatcher whose `consumeRecallFooter` hands back the record.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import type { Message, Collection, Attachment } from "discord.js";
import type { RecallRecord } from "../../manager/recall-footer.js";

function makeMessage(overrides: { messageId?: string; channelId?: string } = {}): Message {
  const attMap = new Map<string, Attachment>();
  const collection = {
    size: 0,
    values: () => attMap.values(),
    [Symbol.iterator]: () => attMap.values(),
    map: <T>(_fn: (att: Attachment) => T): T[] => [],
  } as unknown as Collection<string, Attachment>;
  return {
    content: "hello",
    channelId: overrides.channelId ?? "chan-1",
    // A snowflake-shaped id: the dispatch path derives the turn id from it.
    id: overrides.messageId ?? "000000000000000034",
    author: { username: "user-a", bot: false, id: "user-1" },
    createdAt: new Date("2026-09-05T00:00:00Z"),
    attachments: collection,
    reference: null,
    webhookId: null,
    embeds: [],
    react: vi.fn().mockResolvedValue(undefined),
    reactions: { cache: new Map() },
    client: { user: { id: "bot-1" } },
    channel: {
      sendTyping: vi.fn(),
      send: vi.fn().mockImplementation(async (content: string) => ({
        id: "placeholder-msg",
        edit: vi.fn().mockResolvedValue(undefined),
        delete: vi.fn().mockResolvedValue(undefined),
        content,
      })),
      messages: { cache: new Map() },
    },
  } as unknown as Message;
}

const record: RecallRecord = {
  at: Date.now(),
  memories: [{ id: "m1", createdAt: "2026-06-12T17:00:00.000Z", snippet: "Zaid wants 40% SGOV" }],
  notes: [{ path: "MEMORY.md", heading: "Preferences" }],
  documents: [],
};

describe("recalled memory at the mutation point — Phase 999.124/133", () => {
  let bridge: any;
  let mockSendResponse: ReturnType<typeof vi.fn>;
  let consumed: string[];
  let agentConfig: Record<string, unknown>;

  function stubDispatcher(response: string, recall: RecallRecord | undefined) {
    return {
      dispatchStream: vi.fn().mockResolvedValue(response),
      consumeRecallFooter: vi.fn((session: string) => {
        consumed.push(session);
        return recall;
      }),
    };
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    consumed = [];
    agentConfig = { workspace: "/tmp/test-agent" };
    mockSendResponse = vi.fn().mockResolvedValue(undefined);
    const mod = await import("../bridge.js");
    bridge = new mod.DiscordBridge({
      routingTableRef: {
        current: {
          channelToAgent: new Map([["chan-1", "test-agent"]]),
          agentToChannels: new Map([["test-agent", ["chan-1"]]]),
        },
      },
      sessionManager: {
        forwardToAgent: vi.fn(),
        streamFromAgent: vi.fn(),
        getAgentConfig: vi.fn(() => agentConfig),
        getTraceCollector: vi.fn().mockReturnValue(undefined),
        advisorEvents: new EventEmitter(),
      } as unknown as import("../../manager/session-manager.js").SessionManager,
      botToken: "fake-token",
      log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } as unknown as import("pino").Logger,
    });
    bridge.sendResponse = mockSendResponse;
  });

  it("default (button): no footer text, the recall is recorded on the turn ledger for the 🧾 card", async () => {
    bridge.turnDispatcher = stubDispatcher("Answer body.", record);
    await bridge.streamAndPostResponse(makeMessage(), "test-agent", "hello");
    expect(consumed).toEqual(["test-agent"]);
    expect(mockSendResponse.mock.calls[0]![1]).toBe("Answer body.");
    const ledgers = bridge.ledgerStore.recent("test-agent", 5);
    expect(ledgers).toHaveLength(1);
    expect(ledgers[0].recall).toEqual(record);
    expect(ledgers[0].claims).toEqual([]);
    expect(ledgers[0].evidence).toEqual([]);
  });

  it("nothing recalled: reply byte-identical and no ledger record (still consumes)", async () => {
    bridge.turnDispatcher = stubDispatcher("Answer body.", undefined);
    await bridge.streamAndPostResponse(makeMessage(), "test-agent", "hello");
    expect(consumed).toEqual(["test-agent"]);
    expect(mockSendResponse.mock.calls[0]![1]).toBe("Answer body.");
    expect(bridge.ledgerStore.recent("test-agent", 5)).toHaveLength(0);
  });

  it("memoryRecallDisplay: footer keeps the italic line, and the block in a verbose channel", async () => {
    agentConfig = { workspace: "/tmp/test-agent", memoryRecallDisplay: "footer" };
    bridge.turnDispatcher = stubDispatcher("Answer body.", record);
    await bridge.streamAndPostResponse(makeMessage(), "test-agent", "hello");
    expect(mockSendResponse.mock.calls[0]![1]).toBe("Answer body.\n\n*— recalled 1 memory (Jun 12), 1 note*");
    expect(bridge.ledgerStore.recent("test-agent", 5)).toHaveLength(0);

    bridge.verboseState = { getLevel: () => "verbose" };
    bridge.turnDispatcher = stubDispatcher("Answer body.", record);
    await bridge.streamAndPostResponse(makeMessage(), "test-agent", "hello");
    expect(mockSendResponse.mock.calls[1]![1]).toContain(
      "*— recalled 1 memory (Jun 12), 1 note*\n```\n🧠 recalled\n• Jun 12: Zaid wants 40% SGOV\n• MEMORY.md › Preferences\n```",
    );
  });

  it("footer style composes AFTER the steered footer (advisor, steered, recalled)", async () => {
    agentConfig = { workspace: "/tmp/test-agent", memoryRecallDisplay: "footer" };
    bridge.turnDispatcher = stubDispatcher("Answer body.", record);
    bridge.noteSteeredIntoFlight("test-agent", "000000000000000026", "steer-1");
    await bridge.streamAndPostResponse(makeMessage({ messageId: "000000000000000026" }), "test-agent", "hello");
    expect(mockSendResponse.mock.calls[0]![1]).toBe(
      "Answer body.\n\n*— steered mid-turn: incorporated your follow-up*\n\n*— recalled 1 memory (Jun 12), 1 note*",
    );
  });

  it("tolerates a dispatcher without the method (older stubs / standalone runner)", async () => {
    bridge.turnDispatcher = { dispatchStream: vi.fn().mockResolvedValue("Answer body.") };
    await bridge.streamAndPostResponse(makeMessage(), "test-agent", "hello");
    expect(mockSendResponse.mock.calls[0]![1]).toBe("Answer body.");
  });
});
