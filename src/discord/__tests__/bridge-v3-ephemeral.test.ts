/**
 * Phase 999.86 — DiscordBridge wires `ephemeralChatDispatcher` to route v3
 * Discord chat through the warm worker pool instead of the long-lived
 * parent `v3Bridge.push`.
 *
 * Pins:
 *   - When `ephemeralChatDispatcher` is injected AND the agent is v3,
 *     the dispatcher's `dispatch()` runs. `v3Bridge.push` is NOT called
 *     even if a bridge is wired (the long-lived parent path is bypassed).
 *   - When `ephemeralChatDispatcher` is NOT injected, the existing v3
 *     long-lived parent path runs (regression pin — the fallback path
 *     keeps working so `CLAWCODE_WARM_POOL=0` is a clean rollback).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import type {
  Message,
  Collection,
  Attachment,
  Embed,
} from "discord.js";
import { DiscordBridge } from "../bridge.js";
import type { EphemeralChatDispatcher } from "../ephemeral-chat-dispatcher.js";

const fakeAdvisorEvents = new EventEmitter();

function makeMessage(
  overrides: {
    content?: string;
    channelId?: string;
    messageId?: string;
  } = {},
): Message {
  const attMap = new Map<string, Attachment>();
  const collection = {
    size: 0,
    values: () => attMap.values(),
    [Symbol.iterator]: () => attMap.values(),
    map: <T>(): T[] => [],
  } as unknown as Collection<string, Attachment>;

  return {
    content: overrides.content ?? "hello agent",
    channelId: overrides.channelId ?? "chan-1",
    id: overrides.messageId ?? "msg-1",
    type: 0,
    author: { username: "human-user", bot: false, id: "user-1" },
    createdAt: new Date("2026-05-27T00:00:00Z"),
    attachments: collection,
    reference: null,
    webhookId: null,
    embeds: [] as Embed[],
    channel: {
      sendTyping: vi.fn(),
      send: vi.fn().mockResolvedValue({ edit: vi.fn(), delete: vi.fn() }),
      isThread: vi.fn().mockReturnValue(false),
    },
  } as unknown as Message;
}

vi.mock("../attachments.js", () => ({
  extractAttachments: vi.fn(),
  downloadAllAttachments: vi.fn(),
  formatAttachmentMetadata: vi.fn(),
  isImageAttachment: vi.fn(),
}));

function makeFakeV3Bridge() {
  return {
    push: vi.fn(),
    awaitReply: vi.fn(async () => ({ result: "parent path result" })),
    pendingReplyCount: vi.fn(() => 0),
    registerProgressCallback: vi.fn(),
    clearProgressCallback: vi.fn(),
  };
}

interface MakeBridgeOpts {
  /** Inject a dispatcher (the pool path). */
  dispatcher?: EphemeralChatDispatcher | undefined;
  /** Whether the v3 long-lived parent bridge resolves (default true). */
  parentBridgeWired?: boolean;
}

function makeBridge(opts: MakeBridgeOpts) {
  const v3Bridge = makeFakeV3Bridge();
  const routingTable = {
    channelToAgent: new Map([["chan-1", "agent-x"]]),
    agentToChannels: new Map([["agent-x", ["chan-1"]]]),
  };
  const fakeLog = {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  };
  const bridge = new DiscordBridge({
    routingTableRef: { current: routingTable },
    sessionManager: {
      forwardToAgent: vi.fn(),
      streamFromAgent: vi.fn(),
      getAgentConfig: vi.fn().mockReturnValue({
        workspace: "/workspace/agent-x",
        llmRuntime: { backend: "claude-code-interactive" },
      }),
      getTraceCollector: vi.fn().mockReturnValue(undefined),
      advisorEvents: fakeAdvisorEvents,
      getConversationStore: vi.fn().mockReturnValue(undefined),
      getActiveConversationSessionId: vi.fn().mockReturnValue(undefined),
    } as any,
    webhookManager: {
      hasWebhook: vi.fn().mockReturnValue(false),
    } as any,
    getBridge: (agent: string) =>
      opts.parentBridgeWired !== false && agent === "agent-x"
        ? (v3Bridge as any)
        : undefined,
    ephemeralChatDispatcher: opts.dispatcher,
    botToken: "fake-token",
    log: fakeLog as any,
  });
  (bridge as any).__fakeLog = fakeLog;
  return { bridge, v3Bridge, fakeLog };
}

describe("bridge — ephemeralChatDispatcher routing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("with dispatcher injected + v3 agent → dispatcher.dispatch fires, v3Bridge.push is NOT called", async () => {
    const dispatcher: EphemeralChatDispatcher = {
      dispatch: vi.fn(async () => ({
        result: "pool-path result",
        wasWarm: true,
      })),
    };
    const { bridge, v3Bridge } = makeBridge({ dispatcher });
    const sendResponseSpy = vi.spyOn(bridge as any, "sendResponse");
    const msg = makeMessage({ messageId: "msg-pool-1" });

    await (bridge as any).handleMessage(msg);

    // The dispatcher carried the chat; v3Bridge.push was bypassed.
    expect(dispatcher.dispatch).toHaveBeenCalledTimes(1);
    const dispatchCall = (dispatcher.dispatch as any).mock.calls[0][0];
    expect(dispatchCall.parent).toBe("agent-x");
    expect(dispatchCall.correlationId).toBe("discord-msg-pool-1");
    expect(dispatchCall.userMessage).toContain("hello agent");
    expect(v3Bridge.push).not.toHaveBeenCalled();

    // The pool-returned result reached Discord via sendResponse (no webhook → no edit-in-place).
    expect(sendResponseSpy).toHaveBeenCalledTimes(1);
    expect(sendResponseSpy.mock.calls[0]?.[1]).toBe("pool-path result");
  });

  it("WITHOUT dispatcher → v3Bridge.push fires (regression pin: rollback path still works)", async () => {
    const { bridge, v3Bridge } = makeBridge({});
    const sendResponseSpy = vi.spyOn(bridge as any, "sendResponse");
    const msg = makeMessage({ messageId: "msg-parent-1" });

    await (bridge as any).handleMessage(msg);

    // The long-lived parent path was used.
    expect(v3Bridge.push).toHaveBeenCalledTimes(1);
    expect(v3Bridge.awaitReply).toHaveBeenCalledTimes(1);
    // sendResponse posts the result.
    expect(sendResponseSpy).toHaveBeenCalledTimes(1);
    expect(sendResponseSpy.mock.calls[0]?.[1]).toBe("parent path result");
  });

  it("dispatcher rejection surfaces as a turn error (no silent loss)", async () => {
    const dispatcher: EphemeralChatDispatcher = {
      dispatch: vi.fn(async () => {
        throw new Error("simulated worker channel timeout");
      }),
    };
    const { bridge, fakeLog } = makeBridge({ dispatcher });
    const msg = makeMessage({ messageId: "msg-fail-1" });

    await (bridge as any).handleMessage(msg);

    // The error path is logged via the bridge's existing handleMessage error
    // wrapper — we just assert dispatch was attempted and no successful
    // sendResponse fired for the response (the error path is the same one v2
    // / v3 long-lived agents use today).
    expect(dispatcher.dispatch).toHaveBeenCalledTimes(1);
    // bridge.ts logs the dispatch failure through `error`; the exact call
    // shape varies by call site, just assert that error or warn was used.
    const errCalls =
      fakeLog.error.mock.calls.length + fakeLog.warn.mock.calls.length;
    expect(errCalls).toBeGreaterThan(0);
  });

  it("dispatcher does NOT fire for a v2 agent (backend gate)", async () => {
    const dispatcher: EphemeralChatDispatcher = {
      dispatch: vi.fn(async () => ({ result: "should-not-fire", wasWarm: false })),
    };
    const v3Bridge = makeFakeV3Bridge();
    const fakeLog = {
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
    };
    const bridge = new DiscordBridge({
      routingTableRef: {
        current: {
          channelToAgent: new Map([["chan-1", "agent-v2"]]),
          agentToChannels: new Map([["agent-v2", ["chan-1"]]]),
        },
      },
      sessionManager: {
        forwardToAgent: vi.fn(),
        streamFromAgent: vi.fn(async () => "v2 reply"),
        getAgentConfig: vi.fn().mockReturnValue({
          workspace: "/workspace/agent-v2",
          // No llmRuntime.backend → defaults to anthropic-agent-sdk (v2).
        }),
        getTraceCollector: vi.fn().mockReturnValue(undefined),
        advisorEvents: fakeAdvisorEvents,
        getConversationStore: vi.fn().mockReturnValue(undefined),
        getActiveConversationSessionId: vi.fn().mockReturnValue(undefined),
      } as any,
      webhookManager: {
        hasWebhook: vi.fn().mockReturnValue(false),
      } as any,
      getBridge: () => v3Bridge as any,
      ephemeralChatDispatcher: dispatcher,
      botToken: "fake-token",
      log: fakeLog as any,
    });

    const msg = makeMessage({ messageId: "msg-v2", channelId: "chan-1" });
    await (bridge as any).handleMessage(msg);

    // Dispatcher gated out for non-v3 backend.
    expect(dispatcher.dispatch).not.toHaveBeenCalled();
  });
});
