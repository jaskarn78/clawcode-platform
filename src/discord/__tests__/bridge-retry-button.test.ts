/**
 * 999.178 R1 — Retry-button busy-guard + single-use dispatch at the bridge.
 *
 * `handleRetryButton` must never re-dispatch while the agent still has a turn
 * running (another message, or an auto-rerun of the same one): it replies
 * ephemerally and KEEPS the button. When the agent is idle it consumes the
 * entry (single-use), removes the button, and re-dispatches the original turn.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import type { Message } from "discord.js";
import { DiscordBridge } from "../bridge.js";
import { retryCustomId } from "../retry-actions.js";

vi.mock("../attachments.js", () => ({
  extractAttachments: vi.fn(),
  downloadAllAttachments: vi.fn(),
  formatAttachmentMetadata: vi.fn(),
  isImageAttachment: vi.fn(),
}));

const mockStreamFromAgent = vi.fn();
const mockHasActiveTurn = vi.fn();
const fakeAdvisorEvents = new EventEmitter();
const fakeLog = { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() };

function makeOriginal(): Message {
  return {
    content: "what's the CA rate?",
    channelId: "chan-1",
    id: "orig-1",
    type: 0,
    author: { username: "client-a", bot: false, id: "client-a" },
    createdAt: new Date("2026-09-26T00:00:00Z"),
    attachments: { size: 0, values: () => [][Symbol.iterator](), [Symbol.iterator]: () => [][Symbol.iterator](), map: () => [] },
    reference: null,
    webhookId: null,
    embeds: [],
    react: vi.fn().mockResolvedValue(undefined),
    channel: { sendTyping: vi.fn(), send: vi.fn().mockResolvedValue({ edit: vi.fn() }), isThread: vi.fn().mockReturnValue(false) },
  } as unknown as Message;
}

function makeInteraction(original: Message, userId = "client-a") {
  return {
    customId: retryCustomId("notice-1"),
    user: { id: userId },
    reply: vi.fn().mockResolvedValue(undefined),
    followUp: vi.fn().mockResolvedValue(undefined),
    deferUpdate: vi.fn().mockResolvedValue(undefined),
    message: { edit: vi.fn().mockResolvedValue(undefined) },
    channel: { messages: { fetch: vi.fn().mockResolvedValue(original) } },
  } as never;
}

function createBridge(): DiscordBridge {
  return new DiscordBridge({
    routingTableRef: {
      current: {
        channelToAgent: new Map([["chan-1", "agent-x"]]),
        agentToChannels: new Map([["agent-x", ["chan-1"]]]),
      },
    },
    sessionManager: {
      streamFromAgent: mockStreamFromAgent,
      hasActiveTurn: mockHasActiveTurn,
      getMcpToolAnnotationsForAgent: vi.fn().mockResolvedValue([]),
      getAgentConfig: vi.fn().mockReturnValue({ workspace: "/ws/agent-x" }),
      getTraceCollector: vi.fn().mockReturnValue(undefined),
      getConversationStore: vi.fn().mockReturnValue(undefined),
      getActiveConversationSessionId: vi.fn().mockReturnValue(undefined),
      advisorEvents: fakeAdvisorEvents,
    } as never,
    webhookManager: { hasWebhook: vi.fn().mockReturnValue(false), send: vi.fn() } as never,
    botToken: "fake-token",
    log: fakeLog as never,
  });
}

function registerEntry(bridge: DiscordBridge): void {
  (bridge as unknown as { retryActions: { register: (e: unknown) => void } }).retryActions.register({
    noticeMessageId: "notice-1",
    channelId: "chan-1",
    agentName: "agent-x",
    userId: "client-a",
    originalMessageId: "orig-1",
    replayMessage: "what's the CA rate?",
  });
}

const registrySize = (bridge: DiscordBridge): number =>
  (bridge as unknown as { retryActions: { size: () => number } }).retryActions.size();

describe("handleRetryButton — busy-guard + single-use", () => {
  beforeEach(() => vi.clearAllMocks());

  it("agent busy → ephemeral 'Still working on it', button + entry kept, no re-dispatch", async () => {
    mockHasActiveTurn.mockReturnValue(true);
    const bridge = createBridge();
    registerEntry(bridge);
    const interaction = makeInteraction(makeOriginal());

    await bridge.handleRetryButton(interaction, []);

    expect((interaction as unknown as { reply: ReturnType<typeof vi.fn> }).reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining("Still working on it") }),
    );
    expect((interaction as unknown as { message: { edit: ReturnType<typeof vi.fn> } }).message.edit).not.toHaveBeenCalled();
    expect(mockStreamFromAgent).not.toHaveBeenCalled();
    // Entry survives so the button can be tapped again once the turn settles.
    expect(registrySize(bridge)).toBe(1);
  });

  it("only the author or an admin may click", async () => {
    mockHasActiveTurn.mockReturnValue(false);
    const bridge = createBridge();
    registerEntry(bridge);
    const interaction = makeInteraction(makeOriginal(), "stranger");

    await bridge.handleRetryButton(interaction, []);

    expect((interaction as unknown as { reply: ReturnType<typeof vi.fn> }).reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining("Only the person who sent") }),
    );
    expect(mockStreamFromAgent).not.toHaveBeenCalled();
    expect(registrySize(bridge)).toBe(1);
  });

  it("agent idle → consumes the entry, removes the button, and re-dispatches", async () => {
    mockHasActiveTurn.mockReturnValue(false);
    mockStreamFromAgent.mockResolvedValue("recovered");
    const bridge = createBridge();
    registerEntry(bridge);
    const interaction = makeInteraction(makeOriginal());

    await bridge.handleRetryButton(interaction, []);

    // Single-use: the entry is consumed and the button row removed.
    expect(registrySize(bridge)).toBe(0);
    expect((interaction as unknown as { message: { edit: ReturnType<typeof vi.fn> } }).message.edit).toHaveBeenCalledWith(
      expect.objectContaining({ components: [] }),
    );
    // The failed turn was re-dispatched.
    expect(mockStreamFromAgent).toHaveBeenCalledTimes(1);
  });
});
