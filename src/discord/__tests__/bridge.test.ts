import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import type { Message, Collection, Attachment, Embed } from "discord.js";
import { DiscordBridge } from "../bridge.js";
import { _resetQueueStateMemory } from "../queue-state-icon.js";

// Plan 117-09 — `sessionManager.advisorEvents` (added in 117-04) is now
// consumed by the bridge. Stale test mocks predate that surface; supply
// a real EventEmitter so listener registration in streamAndPostResponse
// does not throw. Per-test stubs that need to emit events can replace
// this with their own emitter.
const fakeAdvisorEvents = new EventEmitter();

/**
 * Wave 0 RED tests for DiscordBridge tracing integration.
 *
 * Wave 2 will wire a `TraceCollector` through `SessionManager.getTraceCollector(name)`
 * and call `startTurn` / `startSpan("receive")` at the start of `handleMessage`.
 *
 * These tests fail today because the current bridge does not call any tracing
 * APIs. Wave 2 Task 1 will make them green.
 */

function makeMessage(overrides: {
  content?: string;
  channelId?: string;
  messageId?: string;
  username?: string;
  bot?: boolean;
  type?: number;
  sendTyping?: ReturnType<typeof vi.fn>;
  isThread?: boolean;
} = {}): Message {
  const attMap = new Map<string, Attachment>();
  const collection = {
    size: 0,
    values: () => attMap.values(),
    [Symbol.iterator]: () => attMap.values(),
    map: <T>(fn: (att: Attachment) => T): T[] => [],
  } as unknown as Collection<string, Attachment>;

  const isThreadFn = vi.fn().mockReturnValue(overrides.isThread ?? false);

  return {
    content: overrides.content ?? "hello",
    channelId: overrides.channelId ?? "chan-1",
    id: overrides.messageId ?? "msg-1",
    type: overrides.type ?? 0, // 0 = Default user message
    author: {
      username: overrides.username ?? "human-user",
      bot: overrides.bot ?? false,
      id: "user-1",
    },
    createdAt: new Date("2026-04-12T00:00:00Z"),
    attachments: collection,
    reference: null,
    webhookId: null,
    embeds: [] as Embed[],
    channel: {
      sendTyping: overrides.sendTyping ?? vi.fn(),
      send: vi.fn().mockResolvedValue({ edit: vi.fn() }),
      isThread: isThreadFn,
    },
  } as unknown as Message;
}

vi.mock("../attachments.js", () => ({
  extractAttachments: vi.fn(),
  downloadAllAttachments: vi.fn(),
  formatAttachmentMetadata: vi.fn(),
  isImageAttachment: vi.fn(),
}));

describe("DiscordBridge tracing", () => {
  let mockCollector: {
    startTurn: ReturnType<typeof vi.fn>;
  };
  let mockTurn: {
    startSpan: ReturnType<typeof vi.fn>;
    end: ReturnType<typeof vi.fn>;
  };
  let mockReceiveSpan: { end: ReturnType<typeof vi.fn> };

  const mockStreamFromAgent = vi.fn();
  const mockForwardToAgent = vi.fn();
  const mockGetAgentConfig = vi.fn();
  const mockGetTraceCollector = vi.fn();

  const fakeRoutingTable = {
    channelToAgent: new Map([["chan-1", "agent-x"]]),
    agentToChannels: new Map([["agent-x", ["chan-1"]]]),
  };

  const fakeWebhookManager = {
    hasWebhook: vi.fn().mockReturnValue(false),
    send: vi.fn(),
  };

  const fakeLog = {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  };

  function createBridgeWithCollector(hasCollector: boolean) {
    mockGetTraceCollector.mockReturnValue(hasCollector ? mockCollector : undefined);
    return new DiscordBridge({
      routingTableRef: { current: fakeRoutingTable },
      sessionManager: {
        forwardToAgent: mockForwardToAgent,
        streamFromAgent: mockStreamFromAgent,
        getAgentConfig: mockGetAgentConfig,
        getTraceCollector: mockGetTraceCollector,
        advisorEvents: fakeAdvisorEvents,
      } as any,
      webhookManager: fakeWebhookManager as any,
      botToken: "fake-token",
      log: fakeLog as any,
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockReceiveSpan = { end: vi.fn() };
    mockTurn = {
      startSpan: vi.fn().mockReturnValue(mockReceiveSpan),
      end: vi.fn(),
    };
    mockCollector = {
      startTurn: vi.fn().mockReturnValue(mockTurn),
    };
    mockStreamFromAgent.mockResolvedValue("response");
    mockGetAgentConfig.mockReturnValue({ workspace: "/workspace/agent-x" });
  });

  it("receive span: starts when handleMessage is entered and ends before session dispatch", async () => {
    const bridge = createBridgeWithCollector(true);
    const msg = makeMessage({ messageId: "msg-abc", channelId: "chan-1" });

    await (bridge as any).handleMessage(msg);

    // Phase 57 Plan 03: turnId format is `discord:<snowflake>` so Turn.id
    // matches TurnOrigin.rootTurnId. Pre-v1.8 tests asserted the raw
    // snowflake — updated per Plan 57-03 Step 9.
    expect(mockCollector.startTurn).toHaveBeenCalledWith("discord:msg-abc", "agent-x", "chan-1");
    const firstSpanCall = mockTurn.startSpan.mock.calls[0];
    expect(firstSpanCall).toBeDefined();
    expect(firstSpanCall![0]).toBe("receive");
    // Receive span must end before any downstream work (streamFromAgent is called later)
    expect(mockReceiveSpan.end).toHaveBeenCalled();
  });

  it("end_to_end: turn.end('success') fires when streamAndPostResponse resolves", async () => {
    const bridge = createBridgeWithCollector(true);
    mockStreamFromAgent.mockResolvedValueOnce("great response");

    const msg = makeMessage({ messageId: "msg-ok" });
    await (bridge as any).handleMessage(msg);

    expect(mockTurn.end).toHaveBeenCalledWith("success");
  });

  it("end_to_end: turn.end('error') fires when streamAndPostResponse throws", async () => {
    const bridge = createBridgeWithCollector(true);
    mockStreamFromAgent.mockRejectedValueOnce(new Error("boom"));

    const msg = makeMessage({ messageId: "msg-err" });
    await (bridge as any).handleMessage(msg);

    expect(mockTurn.end).toHaveBeenCalledWith("error");
  });

  it("skips tracing when no TraceCollector is available (non-running agent)", async () => {
    const bridge = createBridgeWithCollector(false);
    const msg = makeMessage({ messageId: "msg-no-trace" });

    await expect((bridge as any).handleMessage(msg)).resolves.not.toThrow();

    expect(mockCollector.startTurn).not.toHaveBeenCalled();
    expect(mockTurn.startSpan).not.toHaveBeenCalled();
    expect(mockTurn.end).not.toHaveBeenCalled();
  });
});

/**
 * Phase 54 Plan 02 — typing indicator relocation to handleMessage entry.
 *
 * The typing fire moves from the old post-session-dispatch location inside
 * streamAndPostResponse to the earliest point where the bridge knows the
 * message is ours to answer: right after channel routing confirms an agent,
 * ACL passes, the author is not a bot, and the message is a user message.
 *
 * These tests exercise the four guards, span emission, silent-swallow of
 * sendTyping failures, and parity between the channel and thread routes.
 */
describe("typing indicator (Phase 54)", () => {
  let mockCollector: { startTurn: ReturnType<typeof vi.fn> };
  let mockTurn: {
    startSpan: ReturnType<typeof vi.fn>;
    end: ReturnType<typeof vi.fn>;
  };
  let mockReceiveSpan: { end: ReturnType<typeof vi.fn> };
  let mockTypingSpan: { end: ReturnType<typeof vi.fn> };

  const mockStreamFromAgent = vi.fn();
  const mockForwardToAgent = vi.fn();
  const mockGetAgentConfig = vi.fn();
  const mockGetTraceCollector = vi.fn();

  const fakeRoutingTable = {
    channelToAgent: new Map([["chan-1", "agent-x"]]),
    agentToChannels: new Map([["agent-x", ["chan-1"]]]),
  };

  const fakeWebhookManager = {
    hasWebhook: vi.fn().mockReturnValue(false),
    send: vi.fn(),
  };

  const fakeLog = {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  };

  function createBridge(opts: {
    hasCollector?: boolean;
    routingTable?: typeof fakeRoutingTable;
    securityPolicies?: ReadonlyMap<string, unknown>;
    threadManager?: unknown;
  } = {}) {
    mockGetTraceCollector.mockReturnValue(
      (opts.hasCollector ?? true) ? mockCollector : undefined,
    );
    return new DiscordBridge({
      routingTableRef: { current: opts.routingTable ?? fakeRoutingTable },
      sessionManager: {
        forwardToAgent: mockForwardToAgent,
        streamFromAgent: mockStreamFromAgent,
        getAgentConfig: mockGetAgentConfig,
        getTraceCollector: mockGetTraceCollector,
        advisorEvents: fakeAdvisorEvents,
      } as any,
      webhookManager: fakeWebhookManager as any,
      securityPolicies: opts.securityPolicies as any,
      threadManager: opts.threadManager as any,
      botToken: "fake-token",
      log: fakeLog as any,
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockReceiveSpan = { end: vi.fn() };
    mockTypingSpan = { end: vi.fn() };
    mockTurn = {
      // startSpan returns a different span object per name — first call is
      // typing_indicator (handleMessage entry), second is receive.
      startSpan: vi.fn((name: string) => {
        if (name === "typing_indicator") return mockTypingSpan;
        return mockReceiveSpan;
      }),
      end: vi.fn(),
    };
    mockCollector = {
      startTurn: vi.fn().mockReturnValue(mockTurn),
    };
    mockStreamFromAgent.mockResolvedValue("response");
    mockGetAgentConfig.mockReturnValue({ workspace: "/workspace/agent-x" });
  });

  it("Test 1: a user message on a routed channel fires sendTyping() AND opens a typing_indicator span BEFORE session dispatch", async () => {
    const bridge = createBridge();
    const sendTyping = vi.fn().mockResolvedValue(undefined);
    const msg = makeMessage({ messageId: "msg-1", channelId: "chan-1", sendTyping });

    // Capture call ordering: span start must precede streamFromAgent
    const callOrder: string[] = [];
    mockTurn.startSpan.mockImplementation((name: string) => {
      callOrder.push(`startSpan:${name}`);
      return name === "typing_indicator" ? mockTypingSpan : mockReceiveSpan;
    });
    sendTyping.mockImplementation(() => {
      callOrder.push("sendTyping");
      return Promise.resolve();
    });
    mockStreamFromAgent.mockImplementation(() => {
      callOrder.push("streamFromAgent");
      return Promise.resolve("response");
    });

    await (bridge as any).handleMessage(msg);

    expect(sendTyping).toHaveBeenCalledTimes(1);
    // Assert typing_indicator span was opened exactly once on the Turn
    const typingSpanCalls = mockTurn.startSpan.mock.calls.filter(
      (c) => c[0] === "typing_indicator",
    );
    expect(typingSpanCalls.length).toBe(1);
    // Ordering: typing_indicator span + sendTyping fire happen before streamFromAgent
    expect(callOrder.indexOf("startSpan:typing_indicator")).toBeLessThan(
      callOrder.indexOf("streamFromAgent"),
    );
    expect(callOrder.indexOf("sendTyping")).toBeLessThan(
      callOrder.indexOf("streamFromAgent"),
    );
  });

  it("Test 2: a bot-authored non-webhook message does NOT fire sendTyping() and does NOT open a typing_indicator span", async () => {
    const bridge = createBridge();
    const sendTyping = vi.fn();
    const msg = makeMessage({ bot: true, sendTyping });

    await (bridge as any).handleMessage(msg);

    expect(sendTyping).not.toHaveBeenCalled();
    expect(mockTurn.startSpan).not.toHaveBeenCalledWith("typing_indicator", expect.anything());
  });

  it("Test 3: a message on an UNROUTED channel does NOT fire sendTyping()", async () => {
    // Empty routing table — channel not bound to any agent
    const bridge = createBridge({
      routingTable: {
        channelToAgent: new Map(),
        agentToChannels: new Map(),
      },
    });
    const sendTyping = vi.fn();
    const msg = makeMessage({ channelId: "chan-unrouted", sendTyping });

    await (bridge as any).handleMessage(msg);

    expect(sendTyping).not.toHaveBeenCalled();
    expect(mockCollector.startTurn).not.toHaveBeenCalled();
    expect(mockTurn.startSpan).not.toHaveBeenCalled();
  });

  it("Test 4: a message blocked by channel ACL does NOT fire sendTyping()", async () => {
    // Channel ACL that only allows "other-user" — our fake user "user-1" is denied
    const policy = {
      agent: "agent-x",
      channelAcls: [
        { channelId: "chan-1", allowedUserIds: ["other-user"], allowedRoles: [] },
      ],
    };
    const bridge = createBridge({
      securityPolicies: new Map([["agent-x", policy]]),
    });
    const sendTyping = vi.fn();
    const msg = makeMessage({ channelId: "chan-1", sendTyping });

    await (bridge as any).handleMessage(msg);

    expect(sendTyping).not.toHaveBeenCalled();
    // Turn creation must not precede the ACL block either
    expect(mockTurn.startSpan).not.toHaveBeenCalledWith("typing_indicator", expect.anything());
  });

  it("Test 5: a thread-routed message fires sendTyping() AND opens typing_indicator span (parity with channel route)", async () => {
    const threadManager = {
      routeMessage: vi.fn().mockResolvedValue("agent-thread"),
    };
    const bridge = createBridge({ threadManager });
    const sendTyping = vi.fn().mockResolvedValue(undefined);
    const msg = makeMessage({
      messageId: "msg-thread",
      channelId: "thread-1",
      sendTyping,
      isThread: true,
    });

    await (bridge as any).handleMessage(msg);

    expect(threadManager.routeMessage).toHaveBeenCalledWith("thread-1");
    expect(sendTyping).toHaveBeenCalledTimes(1);
    const typingSpanCalls = mockTurn.startSpan.mock.calls.filter(
      (c) => c[0] === "typing_indicator",
    );
    expect(typingSpanCalls.length).toBe(1);
  });

  it("Test 6: sendTyping() that rejects is silently swallowed — streamFromAgent still runs AND span is ended", async () => {
    const bridge = createBridge();
    const sendTyping = vi.fn().mockRejectedValue(new Error("discord 429"));
    const msg = makeMessage({ messageId: "msg-reject", sendTyping });

    await (bridge as any).handleMessage(msg);

    // Rejection did not propagate — streamFromAgent ran to completion
    expect(mockStreamFromAgent).toHaveBeenCalled();
    expect(mockTurn.end).toHaveBeenCalledWith("success");
    // Span was end()-ed regardless (we end in finally immediately after the fire)
    expect(mockTypingSpan.end).toHaveBeenCalled();
    // Debug log confirms silent swallow (the .catch handler fires asynchronously)
    // Yield the microtask queue so the rejection handler runs
    await Promise.resolve();
    await Promise.resolve();
    expect(fakeLog.debug).toHaveBeenCalled();
  });

  it("Test 7: typing_indicator span is end()-ed synchronously right after sendTyping() is called (not after streamFromAgent)", async () => {
    const bridge = createBridge();
    const sendTyping = vi.fn().mockResolvedValue(undefined);
    const msg = makeMessage({ sendTyping });

    // Track the order of events across startSpan / span.end / streamFromAgent
    const events: string[] = [];
    mockTypingSpan.end = vi.fn(() => {
      events.push("typing_span_end");
    });
    mockTurn.startSpan = vi.fn((name: string) => {
      if (name === "typing_indicator") {
        events.push("typing_span_start");
        return mockTypingSpan;
      }
      return mockReceiveSpan;
    });
    mockStreamFromAgent.mockImplementation(() => {
      events.push("streamFromAgent");
      return Promise.resolve("response");
    });

    await (bridge as any).handleMessage(msg);

    // Typing span closes BEFORE streamFromAgent starts (span duration = fire latency only)
    expect(events.indexOf("typing_span_end")).toBeGreaterThan(-1);
    expect(events.indexOf("typing_span_end")).toBeLessThan(
      events.indexOf("streamFromAgent"),
    );
  });

  it("Test 8: a non-user message type (e.g., type=6 PIN_ADD) does NOT fire sendTyping()", async () => {
    const bridge = createBridge();
    const sendTyping = vi.fn();
    const msg = makeMessage({ type: 6, sendTyping }); // 6 = ChannelPinnedMessage

    await (bridge as any).handleMessage(msg);

    expect(sendTyping).not.toHaveBeenCalled();
    expect(mockTurn.startSpan).not.toHaveBeenCalledWith("typing_indicator", expect.anything());
  });

  it("Test 9: the old eager sendTyping() in streamAndPostResponse is REMOVED — only one sendTyping fires per turn (not the setInterval)", async () => {
    const bridge = createBridge();
    const sendTyping = vi.fn().mockResolvedValue(undefined);
    const msg = makeMessage({ sendTyping });

    await (bridge as any).handleMessage(msg);

    // Exactly one fire — the handleMessage-entry fire. If the old eager fire
    // in streamAndPostResponse still existed we would see 2 calls here
    // (the setInterval only fires at 8s elapsed, not synchronously).
    expect(sendTyping).toHaveBeenCalledTimes(1);
  });

  it("Test 10: a Reply-type message (type=19) fires typing (Reply is a user message type)", async () => {
    const bridge = createBridge();
    const sendTyping = vi.fn().mockResolvedValue(undefined);
    const msg = makeMessage({ type: 19, sendTyping });

    await (bridge as any).handleMessage(msg);

    expect(sendTyping).toHaveBeenCalledTimes(1);
    const typingSpanCalls = mockTurn.startSpan.mock.calls.filter(
      (c) => c[0] === "typing_indicator",
    );
    expect(typingSpanCalls.length).toBe(1);
  });
});

/**
 * Phase 54 Plan 03 — streamAndPostResponse threads agentConfig.perf.streaming
 * into the ProgressiveMessageEditor constructor and passes the caller-owned
 * Turn so the editor can emit first_visible_token spans on the first editFn.
 */
describe("streamAndPostResponse streaming cadence wire (Phase 54)", () => {
  let mockCollector: { startTurn: ReturnType<typeof vi.fn> };
  let mockTurn: {
    startSpan: ReturnType<typeof vi.fn>;
    end: ReturnType<typeof vi.fn>;
  };
  let mockReceiveSpan: { end: ReturnType<typeof vi.fn> };
  let mockTypingSpan: { end: ReturnType<typeof vi.fn> };
  let mockFirstVisibleSpan: { end: ReturnType<typeof vi.fn> };

  const mockStreamFromAgent = vi.fn();
  const mockGetAgentConfig = vi.fn();
  const mockGetTraceCollector = vi.fn();

  const fakeRoutingTable = {
    channelToAgent: new Map([["chan-1", "agent-x"]]),
    agentToChannels: new Map([["agent-x", ["chan-1"]]]),
  };

  const fakeLog = {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  };

  function createBridge() {
    mockGetTraceCollector.mockReturnValue(mockCollector);
    return new DiscordBridge({
      routingTableRef: { current: fakeRoutingTable },
      sessionManager: {
        forwardToAgent: vi.fn(),
        streamFromAgent: mockStreamFromAgent,
        getAgentConfig: mockGetAgentConfig,
        getTraceCollector: mockGetTraceCollector,
        advisorEvents: fakeAdvisorEvents,
      } as any,
      botToken: "fake-token",
      log: fakeLog as any,
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockReceiveSpan = { end: vi.fn() };
    mockTypingSpan = { end: vi.fn() };
    mockFirstVisibleSpan = { end: vi.fn() };
    mockTurn = {
      startSpan: vi.fn((name: string) => {
        if (name === "typing_indicator") return mockTypingSpan;
        if (name === "first_visible_token") return mockFirstVisibleSpan;
        return mockReceiveSpan;
      }),
      end: vi.fn(),
    };
    mockCollector = {
      startTurn: vi.fn().mockReturnValue(mockTurn),
    };
  });

  it("Test A: editor uses agentConfig.perf.streaming.editIntervalMs when present", async () => {
    mockGetAgentConfig.mockReturnValue({
      workspace: "/workspace/agent-x",
      perf: { streaming: { editIntervalMs: 400 } },
    });
    // streamFromAgent is responsible for invoking the streamCallback, which
    // calls editor.update(). We can inspect the editor indirectly via the
    // send/edit calls on the channel.
    let capturedUpdate: ((s: string) => void) | undefined;
    mockStreamFromAgent.mockImplementation(async (_agent, _msg, onChunk) => {
      capturedUpdate = onChunk;
      // First chunk fires immediately via editFn (channel.send)
      onChunk("first");
      // Wait long enough for the override interval (400ms) to pass and verify
      // the 2nd edit fires inside that window — we rely on real timers here.
      await new Promise((r) => setTimeout(r, 450));
      onChunk("first + second");
      await new Promise((r) => setTimeout(r, 450));
      return "final response";
    });

    const bridge = createBridge();
    const sendMock = vi.fn().mockResolvedValue({ edit: vi.fn() });
    const msg = {
      content: "hi",
      channelId: "chan-1",
      id: "m1",
      type: 0,
      author: { bot: false, username: "u", id: "user-1" },
      createdAt: new Date(),
      attachments: {
        size: 0,
        values: () => [].values(),
        [Symbol.iterator]: () => [].values(),
        map: () => [],
      },
      reference: null,
      webhookId: null,
      embeds: [],
      channel: {
        sendTyping: vi.fn().mockResolvedValue(undefined),
        send: sendMock,
        isThread: () => false,
      },
    } as unknown as import("discord.js").Message;

    await (bridge as any).handleMessage(msg);

    // The editor took the override (400ms) so streamFromAgent's 450ms wait
    // is enough to elapse the throttled interval and fire a second edit.
    expect(mockStreamFromAgent).toHaveBeenCalled();
    expect(capturedUpdate).toBeDefined();
  }, 10000);

  it("Test B: first_visible_token span is emitted on the Turn after streamAndPostResponse runs", async () => {
    mockGetAgentConfig.mockReturnValue({ workspace: "/workspace/agent-x" });
    mockStreamFromAgent.mockImplementation(async (_agent, _msg, onChunk) => {
      // Simulate at least one streamed chunk so the editor's first editFn runs
      onChunk("hello");
      // Let microtasks flush so the span emission path runs
      await Promise.resolve();
      return "hello";
    });

    const bridge = createBridge();
    const sendMock = vi.fn().mockResolvedValue({ edit: vi.fn() });
    const msg = {
      content: "hi",
      channelId: "chan-1",
      id: "m1",
      type: 0,
      author: { bot: false, username: "u", id: "user-1" },
      createdAt: new Date(),
      attachments: {
        size: 0,
        values: () => [].values(),
        [Symbol.iterator]: () => [].values(),
        map: () => [],
      },
      reference: null,
      webhookId: null,
      embeds: [],
      channel: {
        sendTyping: vi.fn().mockResolvedValue(undefined),
        send: sendMock,
        isThread: () => false,
      },
    } as unknown as import("discord.js").Message;

    await (bridge as any).handleMessage(msg);

    const fvtCalls = mockTurn.startSpan.mock.calls.filter(
      (c) => c[0] === "first_visible_token",
    );
    expect(fvtCalls.length).toBe(1);
    expect(mockFirstVisibleSpan.end).toHaveBeenCalled();
  });
});

/**
 * Phase 100 follow-up — QUEUE_FULL coalescing (operator's resend friction fix).
 *
 * Operator-reported bug 2026-04-28: when the agent is busy and additional
 * messages arrive in rapid succession, the 3rd+ message hits
 * `SerialTurnQueue.QUEUE_FULL` (depth-1: one in-flight + one queued) and
 * the bridge reacts ❌, forcing the operator to track and resend it.
 *
 * Fix: per-agent MessageCoalescer at the bridge layer (upstream of
 * SerialTurnQueue). When QUEUE_FULL fires, append to the buffer and react
 * with ⏳ instead of ❌. After the in-flight turn completes, drain the
 * coalescer and dispatch a single combined turn with all pending content.
 *
 * CO-1: when QUEUE_FULL throws, coalescer.addMessage is called (not ❌ react)
 * CO-2: after in-flight turn completes, pending messages dispatch as ONE combined turn
 * CO-3: combined turn payload contains all pending message contents joined
 * CO-4: ⏳ reaction added (not ❌) on coalesced messages
 * CO-5: when perAgentCap is hit, falls back to ❌ react (still rejected, but only after cap of 50)
 * CO-6: non-QUEUE_FULL errors (e.g. auth fail, agent crash) STILL react ❌ (back-compat)
 */
describe("QUEUE_FULL coalescing (Phase 100-fu)", () => {
  const mockStreamFromAgent = vi.fn();
  const mockForwardToAgent = vi.fn();
  const mockGetAgentConfig = vi.fn();
  const mockGetTraceCollector = vi.fn();

  const fakeRoutingTable = {
    channelToAgent: new Map([["chan-1", "agent-x"]]),
    agentToChannels: new Map([["agent-x", ["chan-1"]]]),
  };

  const fakeWebhookManager = {
    hasWebhook: vi.fn().mockReturnValue(false),
    send: vi.fn(),
  };

  const fakeLog = {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  };

  function createBridge(opts: {
    coalescer?: unknown;
    hasActiveTurn?: ReturnType<typeof vi.fn>;
  } = {}) {
    mockGetTraceCollector.mockReturnValue(undefined); // tracing not relevant here
    // Phase 999.11 Plan 02 will gate the drain block on
    // `sessionManager.hasActiveTurn(agentName)`. Default the mock to
    // `() => false` so existing CO-1..CO-6 tests stay green; new CO-9
    // opts in `() => true` to exercise the gate.
    const hasActiveTurnMock = opts.hasActiveTurn ?? vi.fn().mockReturnValue(false);
    const bridge = new DiscordBridge({
      routingTableRef: { current: fakeRoutingTable },
      sessionManager: {
        forwardToAgent: mockForwardToAgent,
        streamFromAgent: mockStreamFromAgent,
        getAgentConfig: mockGetAgentConfig,
        getTraceCollector: mockGetTraceCollector,
        hasActiveTurn: hasActiveTurnMock,
        advisorEvents: fakeAdvisorEvents,
      } as any,
      webhookManager: fakeWebhookManager as any,
      botToken: "fake-token",
      log: fakeLog as any,
    });
    if (opts.coalescer) {
      // Inject custom coalescer for inspection
      (bridge as any).messageCoalescer = opts.coalescer;
    }
    return bridge;
  }

  function makeQueueFullMessage(opts: {
    content?: string;
    messageId?: string;
    react?: ReturnType<typeof vi.fn>;
  } = {}): import("discord.js").Message {
    // Phase 119 A2A-03 — queue-state icon state machine adapter requires
    // a `reactions.cache` Map and `client.user.id` to resolve the prior
    // emoji removal path. Empty cache + a stable bot user id is enough
    // for the CO-4/5/6 path (no prior emoji to remove on the QUEUE_FULL
    // entry — it's the first transition).
    return {
      content: opts.content ?? "third rapid msg",
      channelId: "chan-1",
      id: opts.messageId ?? "msg-3",
      type: 0,
      author: {
        username: "operator",
        bot: false,
        id: "user-1",
      },
      createdAt: new Date("2026-04-28T00:00:00Z"),
      attachments: {
        size: 0,
        values: () => [].values(),
        [Symbol.iterator]: () => [].values(),
        map: () => [],
      },
      reference: null,
      webhookId: null,
      embeds: [],
      react: opts.react ?? vi.fn().mockResolvedValue(undefined),
      reactions: { cache: new Map() },
      client: { user: { id: "bot-user-1" } },
      channel: {
        sendTyping: vi.fn().mockResolvedValue(undefined),
        send: vi.fn().mockResolvedValue({ edit: vi.fn() }),
        isThread: () => false,
        // Phase 119 A2A-03 hotfix 2026-05-14 #3 — pending-message lookup
        // for coalescer-drain icon transitions. Empty cache + a fetch mock
        // that rejects by default; individual tests inject pending
        // Messages directly into the cache.
        messages: {
          cache: new Map<string, import("discord.js").Message>(),
          fetch: vi
            .fn()
            .mockRejectedValue(new Error("not-found")) as unknown as (
            id: string,
          ) => Promise<import("discord.js").Message>,
        },
      },
    } as unknown as import("discord.js").Message;
  }

  /**
   * Phase 119 A2A-03 hotfix #3 — build a lightweight Message stand-in for
   * a pending (coalesced) message. The drain code looks these up by
   * messageId via channel.messages.cache.get(); each pending Message
   * needs a `react` mock + `reactions.cache` + `client.user.id` so the
   * state-machine module can add/remove reactions.
   */
  function makePendingMessage(opts: {
    messageId: string;
    channelId?: string;
    react?: ReturnType<typeof vi.fn>;
  }): import("discord.js").Message {
    return {
      content: "pending",
      channelId: opts.channelId ?? "chan-1",
      id: opts.messageId,
      type: 0,
      author: { username: "operator", bot: false, id: "user-1" },
      createdAt: new Date("2026-04-28T00:00:00Z"),
      attachments: { size: 0, values: () => [].values(), [Symbol.iterator]: () => [].values(), map: () => [] },
      reference: null,
      webhookId: null,
      embeds: [],
      react: opts.react ?? vi.fn().mockResolvedValue(undefined),
      reactions: { cache: new Map() },
      client: { user: { id: "bot-user-1" } },
      channel: {
        sendTyping: vi.fn().mockResolvedValue(undefined),
        send: vi.fn().mockResolvedValue({ edit: vi.fn() }),
        isThread: () => false,
      },
    } as unknown as import("discord.js").Message;
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    mockGetAgentConfig.mockReturnValue({ workspace: "/workspace/agent-x" });
    // Phase 119 A2A-03 — module-scoped state in queue-state-icon.ts
    // survives across vitest describe blocks. Two-step cleanup:
    //   1. Drain any pending setTimeout callbacks from the previous test
    //      (the state machine fires fire-and-forget transitions with
    //      200ms debounce + 200ms backoff; CO-1/2/3 don't await them).
    //   2. Reset the maps so the current test starts fresh.
    // Without the drain, a previous test's pending timer would fire mid-
    // current-test, write to the (just-reset) pendingTarget, and corrupt
    // state for the current test's first transition.
    await new Promise((r) => setTimeout(r, 600));
    _resetQueueStateMemory();
  });

  it("CO-1: when QUEUE_FULL throws, coalescer.addMessage is called (not ❌ react)", async () => {
    const fakeCoalescer = {
      addMessage: vi.fn().mockReturnValue(true),
      takePending: vi.fn().mockReturnValue([]),
      getPendingCount: vi.fn().mockReturnValue(0),
    };
    const bridge = createBridge({ coalescer: fakeCoalescer });
    mockStreamFromAgent.mockRejectedValueOnce(new Error("QUEUE_FULL"));

    const react = vi.fn().mockResolvedValue(undefined);
    const msg = makeQueueFullMessage({ content: "third msg", messageId: "msg-3", react });

    await (bridge as any).handleMessage(msg);

    expect(fakeCoalescer.addMessage).toHaveBeenCalledWith(
      "agent-x",
      expect.stringContaining("third msg"),
      "msg-3",
    );
    // Must NOT have reacted with ❌
    expect(react).not.toHaveBeenCalledWith("❌");
  });

  it("CO-2: after in-flight turn completes, pending messages dispatch as ONE combined turn", async () => {
    const fakeCoalescer = {
      addMessage: vi.fn().mockReturnValue(true),
      // First QUEUE_FULL fills the buffer (one msg). After turn drain, takePending returns it.
      takePending: vi
        .fn()
        .mockReturnValueOnce([
          { content: "(formatted) third msg", messageId: "msg-3", receivedAt: 1 },
        ])
        .mockReturnValue([]),
      getPendingCount: vi.fn().mockReturnValue(0),
    };
    const bridge = createBridge({ coalescer: fakeCoalescer });
    // First call rejects QUEUE_FULL (msg-3 hits the wall)
    // Second call (the drain dispatch) succeeds
    mockStreamFromAgent
      .mockRejectedValueOnce(new Error("QUEUE_FULL"))
      .mockResolvedValueOnce("combined response");

    const msg = makeQueueFullMessage({ messageId: "msg-3", content: "third msg" });
    await (bridge as any).handleMessage(msg);

    // streamFromAgent called TWICE: once for the QUEUE_FULL'd attempt, once for the drain
    expect(mockStreamFromAgent).toHaveBeenCalledTimes(2);
    // takePending was called to drain (after the failed turn)
    expect(fakeCoalescer.takePending).toHaveBeenCalledWith("agent-x");
  });

  it("CO-3: combined turn payload contains all pending message contents joined", async () => {
    const fakeCoalescer = {
      addMessage: vi.fn().mockReturnValue(true),
      takePending: vi
        .fn()
        .mockReturnValueOnce([
          { content: "msg A content", messageId: "id-A", receivedAt: 1 },
          { content: "msg B content", messageId: "id-B", receivedAt: 2 },
          { content: "msg C content", messageId: "id-C", receivedAt: 3 },
        ])
        .mockReturnValue([]),
      getPendingCount: vi.fn().mockReturnValue(0),
    };
    const bridge = createBridge({ coalescer: fakeCoalescer });
    mockStreamFromAgent
      .mockRejectedValueOnce(new Error("QUEUE_FULL"))
      .mockResolvedValueOnce("combined response");

    const msg = makeQueueFullMessage({ messageId: "msg-trigger", content: "trigger" });
    await (bridge as any).handleMessage(msg);

    // The drain dispatch (2nd call) must contain all 3 pending messages joined
    expect(mockStreamFromAgent).toHaveBeenCalledTimes(2);
    const drainCall = mockStreamFromAgent.mock.calls[1];
    const drainPayload = drainCall[1] as string;
    expect(drainPayload).toContain("msg A content");
    expect(drainPayload).toContain("msg B content");
    expect(drainPayload).toContain("msg C content");
  });

  it("CO-4: ⏳ reaction added (not ❌) on coalesced messages", async () => {
    const fakeCoalescer = {
      addMessage: vi.fn().mockReturnValue(true),
      takePending: vi.fn().mockReturnValue([]),
      getPendingCount: vi.fn().mockReturnValue(0),
    };
    const bridge = createBridge({ coalescer: fakeCoalescer });
    mockStreamFromAgent.mockRejectedValueOnce(new Error("QUEUE_FULL"));

    const react = vi.fn().mockResolvedValue(undefined);
    const msg = makeQueueFullMessage({ react });

    await (bridge as any).handleMessage(msg);
    // Phase 119 A2A-03 — queue-state state machine debounces 200ms. The
    // IN_FLIGHT transition fires first (start of streamAndPostResponse);
    // the error catch then fires QUEUED/FAILED which joins the mutex
    // chain (a second 200ms debounce window). Wait ~500ms so both slots
    // resolve and the final react() call lands.
    await new Promise((r) => setTimeout(r, 500));

    // ⏳ hourglass reaction (U+23F3) on coalesced messages
    expect(react).toHaveBeenCalledWith("⏳");
    expect(react).not.toHaveBeenCalledWith("❌");
  });

  it("CO-5: when perAgentCap is hit (addMessage returns false), falls back to ❌ react", async () => {
    const fakeCoalescer = {
      // Cap reached — addMessage returns false
      addMessage: vi.fn().mockReturnValue(false),
      takePending: vi.fn().mockReturnValue([]),
      getPendingCount: vi.fn().mockReturnValue(50),
    };
    const bridge = createBridge({ coalescer: fakeCoalescer });
    mockStreamFromAgent.mockRejectedValueOnce(new Error("QUEUE_FULL"));

    const react = vi.fn().mockResolvedValue(undefined);
    const msg = makeQueueFullMessage({ react });

    await (bridge as any).handleMessage(msg);
    // Phase 119 A2A-03 — IN_FLIGHT then catch-block transition;
    // ~500ms covers both 200ms debounce windows.
    await new Promise((r) => setTimeout(r, 500));

    // Cap hit — must fall back to ❌
    expect(fakeCoalescer.addMessage).toHaveBeenCalled();
    expect(react).toHaveBeenCalledWith("❌");
  });

  it("CO-6: non-QUEUE_FULL errors STILL react ❌ (back-compat for auth fail, agent crash, etc.)", async () => {
    const fakeCoalescer = {
      addMessage: vi.fn().mockReturnValue(true),
      takePending: vi.fn().mockReturnValue([]),
      getPendingCount: vi.fn().mockReturnValue(0),
    };
    const bridge = createBridge({ coalescer: fakeCoalescer });
    // Real disaster — not QUEUE_FULL
    mockStreamFromAgent.mockRejectedValueOnce(new Error("auth-failed: bad token"));

    const react = vi.fn().mockResolvedValue(undefined);
    const msg = makeQueueFullMessage({ react });

    await (bridge as any).handleMessage(msg);
    // Phase 119 A2A-03 — IN_FLIGHT then catch-block transition;
    // ~500ms covers both 200ms debounce windows.
    await new Promise((r) => setTimeout(r, 500));

    // Coalescer must NOT have been used
    expect(fakeCoalescer.addMessage).not.toHaveBeenCalled();
    // ❌ STILL fires for real errors
    expect(react).toHaveBeenCalledWith("❌");
  });

  // ---------------------------------------------------------------------
  // Phase 999.11 Plan 00 — CO-7..CO-11 RED tests for coalescer storm fix.
  //
  // Reproducer (clawdy 2026-04-30 09:47–09:58 PT): payload grew +54 chars
  // per ~150ms iteration as the drain re-queued a previously-coalesced
  // payload, formatCoalescedPayload re-wrapped it in another
  // [Combined: 1 message …] header, and the unbounded recursion hit
  // QUEUE_FULL again. Tests below pin the failure modes Plan 02 will fix.
  // ---------------------------------------------------------------------

  it("CO-7: idempotent coalesce — single pending entry already wrapped is NOT re-wrapped", () => {
    // RED — current main always wraps. Plan 02 adds the
    // `pending.length === 1 && content.startsWith("[Combined:")` guard
    // in formatCoalescedPayload.
    const bridge = createBridge();
    const wrapped =
      "[Combined: 1 message received during prior turn]\n\n(1) hello";
    const result = (bridge as any).formatCoalescedPayload([
      { content: wrapped, messageId: "msg-1" },
    ]);
    expect(result).toBe(wrapped);
    // No double-wrap: only ONE [Combined: header in the output.
    const matches = result.match(/\[Combined:/g) ?? [];
    expect(matches.length).toBe(1);
  });

  it("CO-8: multi-pending with one wrapped — ONE outer header, inner preserved as body", () => {
    // GREEN regression lock — current main already does this correctly,
    // but pin the contract so the Plan 02 idempotent guard doesn't widen
    // to multi-pending and accidentally strip wrappers.
    const bridge = createBridge();
    const result: string = (bridge as any).formatCoalescedPayload([
      {
        content: "[Combined: 1 message received during prior turn]\n\n(1) hello",
        messageId: "msg-1",
      },
      { content: "new message", messageId: "msg-2" },
    ]);
    // Outer header at offset 0.
    expect(result.indexOf("[Combined:")).toBe(0);
    expect(result.startsWith("[Combined: 2 messages received during prior turn]")).toBe(true);
    // Inner [Combined:] preserved in body — total occurrences === 2.
    const matches = result.match(/\[Combined:/g) ?? [];
    expect(matches.length).toBe(2);
    // New message also present.
    expect(result).toContain("new message");
  });

  it("CO-9: drain deferred when sessionManager.hasActiveTurn returns true", async () => {
    // RED — no hasActiveTurn gate exists on current main; drain runs
    // unconditionally and recurses into streamFromAgent.
    //
    // Plan 02 will add the gate: when an in-flight turn still occupies
    // the queue, the drain block must (a) NOT call streamFromAgent again
    // and (b) push pending messages back into the buffer via
    // MessageCoalescer.requeue() so the next message-arrival drains them.
    const bufferRef: { current: Array<{ content: string; messageId: string; receivedAt: number }> } = {
      current: [],
    };
    const fakeCoalescer = {
      addMessage: vi.fn((_a: string, content: string, messageId: string) => {
        bufferRef.current.push({ content, messageId, receivedAt: Date.now() });
        return true;
      }),
      // First take returns the 2 pre-buffered messages; subsequent takes
      // would return whatever requeue pushed back.
      takePending: vi.fn().mockImplementationOnce(() => {
        const out = bufferRef.current.slice();
        bufferRef.current = [];
        return out;
      }).mockImplementation(() => {
        const out = bufferRef.current.slice();
        bufferRef.current = [];
        return out;
      }),
      getPendingCount: vi.fn(() => bufferRef.current.length),
      // Plan 02 adds requeue — accept it on the mock so the test exercises
      // the desired semantic (push-back without cap).
      requeue: vi.fn((_a: string, msgs: Array<{ content: string; messageId: string; receivedAt: number }>) => {
        bufferRef.current.push(...msgs);
      }),
    };
    // Pre-populate 2 messages.
    bufferRef.current.push(
      { content: "buffered A", messageId: "id-A", receivedAt: 1 },
      { content: "buffered B", messageId: "id-B", receivedAt: 2 },
    );

    const hasActiveTurn = vi.fn().mockReturnValue(true);
    const bridge = createBridge({ coalescer: fakeCoalescer, hasActiveTurn });

    // First call rejects QUEUE_FULL; the drain that follows MUST defer
    // because hasActiveTurn=true.
    mockStreamFromAgent.mockRejectedValueOnce(new Error("QUEUE_FULL"));

    const msg = makeQueueFullMessage({ messageId: "msg-trigger", content: "trigger" });
    await (bridge as any).handleMessage(msg);

    // Exactly ONE streamFromAgent call (the failed initial). The drain
    // recursion must NOT have called it a second time.
    expect(mockStreamFromAgent).toHaveBeenCalledTimes(1);
    // Pending messages must remain buffered (via requeue or addMessage push-back).
    expect(bufferRef.current.length).toBeGreaterThanOrEqual(2);
    // hasActiveTurn was consulted by the drain block.
    expect(hasActiveTurn).toHaveBeenCalledWith("agent-x");
  });

  it("CO-10: drain depth cap — warn log + leave messages buffered after MAX_DRAIN_DEPTH", async () => {
    // RED — no depth cap exists. Plan 02 will cap recursion at
    // MAX_DRAIN_DEPTH=3 and emit a single warn log on cap-hit, leaving
    // pending messages in the coalescer for the next message-arrival.
    const bufferRef: { current: Array<{ content: string; messageId: string; receivedAt: number }> } = {
      current: [],
    };
    const fakeCoalescer = {
      addMessage: vi.fn((_a: string, content: string, messageId: string) => {
        bufferRef.current.push({ content, messageId, receivedAt: Date.now() });
        return true;
      }),
      // Every drain takes ALL pending; recursion will re-buffer them via
      // the QUEUE_FULL catch path on each iteration.
      takePending: vi.fn(() => {
        const out = bufferRef.current.slice();
        bufferRef.current = [];
        return out;
      }),
      getPendingCount: vi.fn(() => bufferRef.current.length),
      requeue: vi.fn((_a: string, msgs: Array<{ content: string; messageId: string; receivedAt: number }>) => {
        bufferRef.current.push(...msgs);
      }),
    };

    // hasActiveTurn=false so the gate doesn't fire — only the depth cap
    // can stop the recursion.
    const bridge = createBridge({
      coalescer: fakeCoalescer,
      hasActiveTurn: vi.fn().mockReturnValue(false),
    });

    // Every dispatch throws QUEUE_FULL — without a cap, this would spin
    // forever. With the cap, it must terminate. We harden the mock with
    // a hard call-count ceiling so the test fails cleanly (assertion)
    // instead of OOM-ing the worker on current main.
    let callCount = 0;
    const HARD_CEILING = 25;
    mockStreamFromAgent.mockImplementation(async () => {
      callCount++;
      if (callCount > HARD_CEILING) {
        // Switch to success to break the loop — the assertions below will
        // still fail because callCount > 5.
        return "force-stop";
      }
      throw new Error("QUEUE_FULL");
    });

    const msg = makeQueueFullMessage({ messageId: "msg-storm", content: "storm-trigger" });
    await (bridge as any).handleMessage(msg);

    // Cap = 3 means at most a few drain iterations before the warn log fires.
    // The exact bound depends on Plan 02's implementation but MUST be O(small).
    expect(mockStreamFromAgent.mock.calls.length).toBeLessThanOrEqual(5);
    // A warn log must have fired with "depth cap" or similar.
    const warnCalls = fakeLog.warn.mock.calls;
    const capWarn = warnCalls.find((c: unknown[]) => {
      const msg2 = c[1];
      const ctx = c[0] as Record<string, unknown> | undefined;
      const msgStr = typeof msg2 === "string" ? msg2 : "";
      const ctxStr = ctx ? JSON.stringify(ctx) : "";
      return msgStr.includes("depth cap") || ctxStr.includes("depth cap") || msgStr.includes("drain depth");
    });
    expect(capWarn).toBeDefined();
    // Pending messages remain buffered after cap-hit.
    expect(bufferRef.current.length).toBeGreaterThan(0);
  });

  it("CO-11: storm bounded log output — info logs ≤ MAX_DRAIN_DEPTH + 1 warn", async () => {
    // RED — current main spins ~10 iterations per repro trace, emitting
    // an info log per iteration. Plan 02 caps the loop, so info-log count
    // must be bounded by a small constant.
    const bufferRef: { current: Array<{ content: string; messageId: string; receivedAt: number }> } = {
      current: [],
    };
    const fakeCoalescer = {
      addMessage: vi.fn((_a: string, content: string, messageId: string) => {
        bufferRef.current.push({ content, messageId, receivedAt: Date.now() });
        return true;
      }),
      takePending: vi.fn(() => {
        const out = bufferRef.current.slice();
        bufferRef.current = [];
        return out;
      }),
      getPendingCount: vi.fn(() => bufferRef.current.length),
      requeue: vi.fn((_a: string, msgs: Array<{ content: string; messageId: string; receivedAt: number }>) => {
        bufferRef.current.push(...msgs);
      }),
    };

    const bridge = createBridge({
      coalescer: fakeCoalescer,
      hasActiveTurn: vi.fn().mockReturnValue(false),
    });

    // Storm: sustained QUEUE_FULL. Without bounding, the count is
    // unbounded; with cap=3, info logs are tightly bounded. Hard ceiling
    // prevents OOM on current main where the loop is unbounded.
    let callCount2 = 0;
    const HARD_CEILING_2 = 25;
    mockStreamFromAgent.mockImplementation(async () => {
      callCount2++;
      if (callCount2 > HARD_CEILING_2) return "force-stop";
      throw new Error("QUEUE_FULL");
    });

    const msg = makeQueueFullMessage({ messageId: "msg-storm-2", content: "storm" });
    await (bridge as any).handleMessage(msg);

    // Count "draining coalesced messages" info-log invocations.
    const drainInfoCalls = fakeLog.info.mock.calls.filter((c: unknown[]) => {
      const msg2 = c[1];
      return typeof msg2 === "string" && msg2.includes("draining coalesced messages");
    });
    // Plan 02 cap = 3 drains; pin to a small constant. Today this loops
    // until the queue actually frees, easily exceeding 5.
    expect(drainInfoCalls.length).toBeLessThanOrEqual(5);

    // Exactly one warn line for the cap-hit (storm scenario must emit it).
    const capWarnCount = fakeLog.warn.mock.calls.filter((c: unknown[]) => {
      const msg2 = c[1];
      const ctx = c[0] as Record<string, unknown> | undefined;
      const msgStr = typeof msg2 === "string" ? msg2 : "";
      const ctxStr = ctx ? JSON.stringify(ctx) : "";
      return msgStr.includes("depth cap") || ctxStr.includes("depth cap") || msgStr.includes("drain depth");
    }).length;
    expect(capWarnCount).toBe(1);
  });

  // Phase 119 A2A-03 hotfix 2026-05-14 #3 — fix for stuck-⏳ on coalesced
  // pending messages. Pre-hotfix-3, the drain dispatched a combined
  // payload via streamAndPostResponse(trigger, ...) — but the IN_FLIGHT/
  // DELIVERED checks inside streamAndPostResponse gate on
  // queuedMessageIds.has(message.id), where message.id is the trigger's,
  // not the pending messages'. So M2/M3 stayed stuck at ⏳ forever even
  // though their content delivered. Fix: drain code transitions each
  // pending messageId to IN_FLIGHT before the recursive dispatch and to
  // DELIVERED after success (FAILED on unhandled throw). Lookup via
  // channel.messages.cache.get(id), falling back to messages.fetch(id).

  it("CO-9: after QUEUE_FULL coalesce drain, pending messages transition through IN_FLIGHT (👍) and DELIVERED (✅), not stuck at ⏳", async () => {
    const pendingReact = vi.fn().mockResolvedValue(undefined);
    const pendingMsg = makePendingMessage({
      messageId: "pending-A",
      react: pendingReact,
    });

    const fakeCoalescer = {
      addMessage: vi.fn().mockReturnValue(true),
      takePending: vi
        .fn()
        .mockReturnValueOnce([
          { content: "pending-A content", messageId: "pending-A", receivedAt: 1 },
        ])
        .mockReturnValue([]),
      getPendingCount: vi.fn().mockReturnValue(0),
    };
    const bridge = createBridge({ coalescer: fakeCoalescer });
    // Pre-populate queuedMessageIds with the pending message's ID — in
    // production this happens when M2's own handleMessage→catch wrote
    // queuedMessageIds.add(M2.id) before coalescing. Skipping the natural
    // flow here lets the test focus on the drain-side transition logic.
    (bridge as any).queuedMessageIds.add("pending-A");

    // Trigger dispatch succeeds (no QUEUE_FULL); drain dispatch succeeds.
    // The drain dispatch has a 300ms delay so the state machine's 200ms
    // debounce window is exceeded between IN_FLIGHT (drain start) and
    // DELIVERED (drain success). Without the delay, both transitions fire
    // within the debounce window and IN_FLIGHT (👍) is collapsed into
    // DELIVERED (✅) — operator never sees 👍. Real-world LLM dispatches
    // always take >200ms so this matches production.
    mockStreamFromAgent
      .mockResolvedValueOnce("trigger response")
      .mockImplementationOnce(
        () =>
          new Promise<string>((resolve) =>
            setTimeout(() => resolve("combined drained response"), 300),
          ),
      );

    // Register the pending Message in the trigger's channel cache so the
    // drain code's transitionIconByMessageId lookup finds it.
    const triggerMsg = makeQueueFullMessage({ messageId: "trigger-1", content: "trigger" });
    const cache = (triggerMsg.channel as unknown as {
      messages: { cache: Map<string, import("discord.js").Message> };
    }).messages.cache;
    cache.set("pending-A", pendingMsg);

    await (bridge as any).handleMessage(triggerMsg);
    // Wait long enough for: drain dispatch (300ms) + 2 debounce windows
    // (200ms each) + slack. 1200ms covers both transitions cleanly.
    await new Promise((r) => setTimeout(r, 1200));

    // The pending message receives both IN_FLIGHT (👍) and DELIVERED (✅)
    // reactions from the drain block, even though message.id inside the
    // recursive streamAndPostResponse call is the TRIGGER's id, not
    // pending-A's. The pre-hotfix-3 behavior was: no transitions on
    // pending-A at all, so ⏳ stayed stuck.
    const reactCalls = pendingReact.mock.calls.map((c) => c[0]);
    expect(reactCalls).toContain("👍");
    expect(reactCalls).toContain("✅");
    // No ❌ — drain succeeded.
    expect(reactCalls).not.toContain("❌");
    // pending-A removed from queuedMessageIds after DELIVERED (memory bound).
    expect((bridge as any).queuedMessageIds.has("pending-A")).toBe(false);
  });

  it("CO-10: pending-message lookup falls back to channel.messages.fetch when not in cache", async () => {
    const pendingReact = vi.fn().mockResolvedValue(undefined);
    const pendingMsg = makePendingMessage({
      messageId: "pending-B",
      react: pendingReact,
    });

    const fakeCoalescer = {
      addMessage: vi.fn().mockReturnValue(true),
      takePending: vi
        .fn()
        .mockReturnValueOnce([
          { content: "pending-B content", messageId: "pending-B", receivedAt: 1 },
        ])
        .mockReturnValue([]),
      getPendingCount: vi.fn().mockReturnValue(0),
    };
    const bridge = createBridge({ coalescer: fakeCoalescer });
    (bridge as any).queuedMessageIds.add("pending-B");

    // Same delay shape as CO-9 — the recursive drain dispatch needs to
    // take longer than the 200ms debounce window so IN_FLIGHT (👍) and
    // DELIVERED (✅) don't collapse.
    mockStreamFromAgent
      .mockResolvedValueOnce("trigger response")
      .mockImplementationOnce(
        () =>
          new Promise<string>((resolve) =>
            setTimeout(() => resolve("drained ok"), 300),
          ),
      );

    const triggerMsg = makeQueueFullMessage({ messageId: "trigger-2", content: "trigger" });
    // Cache is empty (default from makeQueueFullMessage). Override fetch to
    // return our pending message stand-in.
    const channelMessages = (triggerMsg.channel as unknown as {
      messages: {
        cache: Map<string, import("discord.js").Message>;
        fetch: ReturnType<typeof vi.fn>;
      };
    }).messages;
    channelMessages.fetch = vi.fn().mockResolvedValue(pendingMsg);

    await (bridge as any).handleMessage(triggerMsg);
    // 1200ms — drain delay (300) + 2 debounce windows (200+200) + slack.
    await new Promise((r) => setTimeout(r, 1200));

    // fetch was called with the pending message's ID (cache-miss fallback).
    expect(channelMessages.fetch).toHaveBeenCalledWith("pending-B");
    // And the transitions landed on the fetched message.
    const reactCalls = pendingReact.mock.calls.map((c) => c[0]);
    expect(reactCalls).toContain("👍");
    expect(reactCalls).toContain("✅");
  });
});

// ---------------------------------------------------------------------------
// Phase 999.13 — TZ-04: formatDiscordMessage emits TZ-aware ts
//
// Wave 0 RED tests. These FAIL on current main because:
//   - formatDiscordMessage signature does not yet accept agentTz parameter
//     (Plan 02 adds it)
//   - on main, the ts attribute uses message.createdAt.toISOString() (UTC ISO)
//   - after Plan 02, ts should use renderAgentVisibleTimestamp(date, agentTz)
//     producing "YYYY-MM-DD HH:mm:ss ZZZ"
//
// We pass agentTz via `as any` so this file still compiles via tsc.
// ---------------------------------------------------------------------------
describe("Phase 999.13 — TZ-04: formatDiscordMessage TZ-aware ts", () => {
  function makeBridgeMessage(overrides: {
    content?: string;
    channelId?: string;
    messageId?: string;
    username?: string;
    createdAt?: Date;
    reference?: { messageId: string } | null;
  } = {}): Message {
    const attMap = new Map<string, Attachment>();
    const collection = {
      size: 0,
      values: () => attMap.values(),
      [Symbol.iterator]: () => attMap.values(),
      map: <T>(_fn: (att: Attachment) => T): T[] => [],
    } as unknown as Collection<string, Attachment>;
    return {
      content: overrides.content ?? "hello",
      channelId: overrides.channelId ?? "chan-1",
      id: overrides.messageId ?? "msg-1",
      author: { username: overrides.username ?? "human-user", bot: false, id: "user-1" },
      createdAt: overrides.createdAt ?? new Date("2026-04-30T18:32:51.000Z"),
      attachments: collection,
      reference: overrides.reference ?? null,
      webhookId: null,
      embeds: [] as Embed[],
    } as unknown as Message;
  }

  it("formatDiscordMessage-channel-ts-tz: <channel> tag carries TZ-aware ts when agentTz is America/Los_Angeles", async () => {
    const { formatDiscordMessage } = await import("../bridge.js");
    const message = makeBridgeMessage({
      createdAt: new Date("2026-04-30T18:32:51.000Z"),
    });
    // Plan 02 adds the 4th `agentTz` parameter. On main, the extra arg is
    // ignored and the ts emits ISO UTC — RED.
    const out = (formatDiscordMessage as unknown as (
      m: Message,
      d?: unknown,
      r?: Message,
      tz?: string,
    ) => string)(message, undefined, undefined, "America/Los_Angeles");
    expect(out).toContain('ts="2026-04-30 11:32:51 PDT"');
    // Negative assertion: must NOT carry the legacy ISO UTC format anymore.
    expect(out).not.toContain('ts="2026-04-30T18:32:51.000Z"');
  });

  it("formatDiscordMessage-replyingTo-ts-tz: <replying-to> tag also carries TZ-aware ts", async () => {
    const { formatDiscordMessage } = await import("../bridge.js");
    const referenced = makeBridgeMessage({
      messageId: "ref-msg-1",
      content: "earlier message",
      createdAt: new Date("2026-04-30T17:00:00.000Z"),
      username: "ref-user",
    });
    const message = makeBridgeMessage({
      createdAt: new Date("2026-04-30T18:32:51.000Z"),
      reference: { messageId: "ref-msg-1" },
    });
    const out = (formatDiscordMessage as unknown as (
      m: Message,
      d?: unknown,
      r?: Message,
      tz?: string,
    ) => string)(message, undefined, referenced, "America/Los_Angeles");
    // <replying-to> ts is the referenced message's createdAt, also TZ-aware.
    expect(out).toContain('<replying-to');
    expect(out).toContain('ts="2026-04-30 10:00:00 PDT"');
  });
});
