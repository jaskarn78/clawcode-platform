/**
 * Phase 999.82 Plan 02 — v3 chat block-level streaming with final-vs-progress
 * DEDUP (the highest-risk integration in the phase, SPEC §B6 / §Risks).
 *
 * The final agent text must be delivered by EXACTLY ONE of {v3Editor flush,
 * sendResponse} — never both (double-post), never neither (lost final). This
 * suite pins that single-branch delivery contract per
 * `feedback_silent_path_bifurcation`:
 *
 *   1. makeWebhookEditFn — post-once-then-edit over the masking webhook.
 *   2. decideV3Delivery — the pure dedup decision (the 5-case matrix).
 *   3. Integration smoke through handleMessage — progress-then-final (one
 *      edited message, sendResponse NOT called), final-only (sendResponse
 *      called once, no webhook post), and clearProgressCallback-in-finally.
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
import { makeWebhookEditFn } from "../webhook-manager.js";
import { decideV3Delivery } from "../bridge.js";

// ── 1. makeWebhookEditFn (post-once-then-edit) ─────────────────────────────

describe("makeWebhookEditFn (Phase 999.82 Plan 02)", () => {
  it("first call posts via sendReturningId, subsequent calls edit that id", async () => {
    const sendReturningId = vi.fn(async () => "msg-id-123");
    const editMessage = vi.fn(async () => {});
    const wm = { sendReturningId, editMessage } as any;

    const editFn = makeWebhookEditFn(wm, "agent-x");

    await editFn("first chunk");
    await editFn("first chunk plus more");
    await editFn("first chunk plus more and final");

    // Posted exactly ONCE.
    expect(sendReturningId).toHaveBeenCalledTimes(1);
    expect(sendReturningId).toHaveBeenCalledWith("agent-x", "first chunk");
    // Then edited the SAME message id on every subsequent call.
    expect(editMessage).toHaveBeenCalledTimes(2);
    expect(editMessage).toHaveBeenNthCalledWith(
      1,
      "agent-x",
      "msg-id-123",
      "first chunk plus more",
    );
    expect(editMessage).toHaveBeenNthCalledWith(
      2,
      "agent-x",
      "msg-id-123",
      "first chunk plus more and final",
    );
  });

  it("exposes whether a message was posted, and its id", async () => {
    const sendReturningId = vi.fn(async () => "mid-1");
    const editMessage = vi.fn(async () => {});
    const wm = { sendReturningId, editMessage } as any;

    const editFn = makeWebhookEditFn(wm, "agent-x");
    expect(editFn.posted()).toBe(false);
    expect(editFn.messageId()).toBeNull();

    await editFn("hi");
    expect(editFn.posted()).toBe(true);
    expect(editFn.messageId()).toBe("mid-1");
  });

  it("each factory call returns a fresh closure (no shared module state)", async () => {
    const sendReturningId = vi.fn(async () => "x");
    const editMessage = vi.fn(async () => {});
    const wm = { sendReturningId, editMessage } as any;

    const a = makeWebhookEditFn(wm, "agent-a");
    const b = makeWebhookEditFn(wm, "agent-b");
    await a("a-text");
    // b is independent — it has NOT posted just because a did.
    expect(b.posted()).toBe(false);
  });
});

// ── 2. decideV3Delivery (the pure dedup decision) ──────────────────────────

describe("decideV3Delivery (Phase 999.82 Plan 02 — single-branch dedup)", () => {
  it("editor posted + short final → flush-editor (NO sendResponse)", () => {
    const d = decideV3Delivery({
      editorPosted: true,
      response: "short final",
      maxLength: 2000,
    });
    expect(d.kind).toBe("flush-editor");
  });

  it("editor never posted (final-only) → send-only via sendResponse", () => {
    const d = decideV3Delivery({
      editorPosted: false,
      response: "the only message",
      maxLength: 2000,
    });
    expect(d).toEqual({ kind: "send-only", response: "the only message" });
  });

  it("editor posted + final EXCEEDS 2000 → flush-and-tail split (no loss)", () => {
    const head = "H".repeat(2000);
    const tail = "T".repeat(150);
    const response = head + tail;
    const d = decideV3Delivery({
      editorPosted: true,
      response,
      maxLength: 2000,
    });
    expect(d.kind).toBe("flush-and-tail");
    if (d.kind === "flush-and-tail") {
      // Editor message holds EXACTLY the first 2000 (no truncate ellipsis).
      expect(d.head).toBe(head);
      expect(d.head.length).toBe(2000);
      // Tail is the remainder.
      expect(d.tail).toBe(tail);
      // ONE logical delivery — reassembles to the full final, no loss.
      expect(d.head + d.tail).toBe(response);
    }
  });

  it("editor never posted + final exceeds 2000 → send-only (sendResponse chunks it)", () => {
    const response = "X".repeat(2500);
    const d = decideV3Delivery({
      editorPosted: false,
      response,
      maxLength: 2000,
    });
    // No streamed message exists to flush into → the whole thing goes through
    // the existing sendResponse chunking path. Still ONE logical delivery.
    expect(d).toEqual({ kind: "send-only", response });
  });

  it("editor posted but final is empty → still flush-editor (edits the streamed message, no second post)", () => {
    const d = decideV3Delivery({
      editorPosted: true,
      response: "",
      maxLength: 2000,
    });
    expect(d.kind).toBe("flush-editor");
  });
});

// ── 3. Integration smoke through handleMessage ─────────────────────────────

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
    content: overrides.content ?? "hello",
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

/** A minimal fake AgentChannelBridge with the streaming surface Plan 02 needs. */
function makeFakeV3Bridge(opts: {
  finalResult: string;
  pendingReplyCount?: number;
  /** progress frames the bridge will fan out before awaitReply resolves. */
  progressFrames?: readonly string[];
}) {
  let cb: ((text: string) => void) | null = null;
  return {
    push: vi.fn(),
    pendingReplyCount: vi.fn(() => opts.pendingReplyCount ?? 0),
    registerProgressCallback: vi.fn((fn: (text: string) => void) => {
      cb = fn;
    }),
    clearProgressCallback: vi.fn(() => {
      cb = null;
    }),
    awaitReply: vi.fn(async () => {
      // Fire the progress frames synchronously before resolving — simulates the
      // PostToolUse hook shipping accumulated text mid-turn.
      for (const frame of opts.progressFrames ?? []) {
        cb?.(frame);
      }
      return { result: opts.finalResult };
    }),
    _emitProgress: (text: string) => cb?.(text),
  };
}

function createV3Bridge(
  v3Bridge: ReturnType<typeof makeFakeV3Bridge>,
  webhookManager: unknown,
) {
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
    webhookManager: webhookManager as any,
    getBridge: (agent: string) => (agent === "agent-x" ? (v3Bridge as any) : undefined),
    botToken: "fake-token",
    log: fakeLog as any,
  });
  // Expose the log so tests can assert on info/warn (operator visibility).
  (bridge as any).__fakeLog = fakeLog;
  return bridge;
}

describe("v3 chat streaming dedup (integration smoke — Phase 999.82 Plan 02)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("PROGRESS-THEN-FINAL: one webhook message posted+edited, final flushes into it, sendResponse NOT called", async () => {
    const v3Bridge = makeFakeV3Bridge({
      finalResult: "final answer",
      pendingReplyCount: 0,
      progressFrames: ["working...", "working on it..."],
    });
    const sendReturningId = vi.fn(async (_agent: string, _content: string) => "wh-msg-1");
    const editMessage = vi.fn(async (_agent: string, _id: string, _content: string) => {});
    const send = vi.fn(async () => {});
    const webhookManager = {
      hasWebhook: vi.fn().mockReturnValue(true),
      sendReturningId,
      editMessage,
      send,
    };

    const bridge = createV3Bridge(v3Bridge, webhookManager);
    const sendResponseSpy = vi.spyOn(bridge as any, "sendResponse");
    const msg = makeMessage({ messageId: "msg-pf", channelId: "chan-1" });

    await (bridge as any).handleMessage(msg);

    // The editor registered a progress callback and posted ONCE.
    expect(v3Bridge.registerProgressCallback).toHaveBeenCalledTimes(1);
    expect(sendReturningId).toHaveBeenCalledTimes(1);
    // Final flushed into the SAME message (edit), not a second post.
    expect(editMessage).toHaveBeenCalled();
    // The final edit carries the final answer.
    const lastEdit = editMessage.mock.calls.at(-1);
    expect(lastEdit?.[2]).toBe("final answer");
    // CRITICAL DEDUP: sendResponse was NOT invoked for this response.
    expect(sendResponseSpy).not.toHaveBeenCalled();
    // Callback cleared in finally — no cross-turn leak.
    expect(v3Bridge.clearProgressCallback).toHaveBeenCalledTimes(1);
    // No spurious "agent returned empty response" warn on the streamed path
    // (messageRef.current is null on v3 — the shared cleanup must key off the
    // `delivered` flag, not messageRef).
    const log = (bridge as any).__fakeLog;
    expect(log.warn).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({ agent: "agent-x" }),
      "agent response sent to Discord",
    );
  });

  it("QUEUED v3 streamed turn: DELIVERED transition fires and queuedMessageIds is drained", async () => {
    const v3Bridge = makeFakeV3Bridge({
      finalResult: "queued final",
      pendingReplyCount: 0,
      progressFrames: ["working..."],
    });
    const webhookManager = {
      hasWebhook: vi.fn().mockReturnValue(true),
      sendReturningId: vi.fn(async (_a: string, _c: string) => "wh-msg-q"),
      editMessage: vi.fn(async (_a: string, _i: string, _c: string) => {}),
      send: vi.fn(async () => {}),
    };

    const bridge = createV3Bridge(v3Bridge, webhookManager);
    // transitionIcon is private + best-effort (void); spy so we can assert the
    // DELIVERED transition still fires for an editor-delivered v3 turn.
    const transitionSpy = vi
      .spyOn(bridge as any, "transitionIcon")
      .mockResolvedValue(undefined);
    const msg = makeMessage({ messageId: "msg-q", channelId: "chan-1" });
    // Mark the message as having ridden the queue path (QUEUED → IN_FLIGHT).
    (bridge as any).queuedMessageIds.add("msg-q");

    await (bridge as any).handleMessage(msg);

    // DELIVERED ✅ transition fired despite delivery via the editor (not sendResponse).
    expect(transitionSpy).toHaveBeenCalledWith(msg, "DELIVERED");
    // The set was drained (no unbounded growth on the queue path).
    expect((bridge as any).queuedMessageIds.has("msg-q")).toBe(false);
  });

  it("FINAL-ONLY (no progress frames): no webhook post, sendResponse called once", async () => {
    // Phase 141 — "agent is active" is the Discord typing indicator, NOT a
    // canned webhook placeholder (reverted: the fixed "on it…" read as robotic).
    // So with no progress frames the editor never posts and the final answer
    // flows through the unchanged sendResponse path — non-verbose default.
    const v3Bridge = makeFakeV3Bridge({
      finalResult: "just the final",
      pendingReplyCount: 0,
      progressFrames: [],
    });
    const sendReturningId = vi.fn(async () => "wh-msg-1");
    const editMessage = vi.fn(async () => {});
    const send = vi.fn(async () => {});
    const webhookManager = {
      hasWebhook: vi.fn().mockReturnValue(true),
      sendReturningId,
      editMessage,
      send,
    };

    const bridge = createV3Bridge(v3Bridge, webhookManager);
    const sendResponseSpy = vi.spyOn(bridge as any, "sendResponse");
    const msg = makeMessage({ messageId: "msg-fo", channelId: "chan-1" });

    await (bridge as any).handleMessage(msg);

    // No progress arrived → the editor never posted.
    expect(sendReturningId).not.toHaveBeenCalled();
    expect(editMessage).not.toHaveBeenCalled();
    // Final delivered through the EXISTING sendResponse path exactly once.
    expect(sendResponseSpy).toHaveBeenCalledTimes(1);
    expect(sendResponseSpy.mock.calls[0]?.[1]).toBe("just the final");
    // Callback always cleared.
    expect(v3Bridge.clearProgressCallback).toHaveBeenCalledTimes(1);
  });

  it("CONCURRENT-PENDING SKIP: >1 pending reply → no progress callback registered, final-only", async () => {
    const v3Bridge = makeFakeV3Bridge({
      finalResult: "final under contention",
      pendingReplyCount: 1, // another turn already awaiting
      progressFrames: ["should be ignored"],
    });
    const sendReturningId = vi.fn(async () => "wh-msg-1");
    const editMessage = vi.fn(async () => {});
    const send = vi.fn(async () => {});
    const webhookManager = {
      hasWebhook: vi.fn().mockReturnValue(true),
      sendReturningId,
      editMessage,
      send,
    };

    const bridge = createV3Bridge(v3Bridge, webhookManager);
    const sendResponseSpy = vi.spyOn(bridge as any, "sendResponse");
    const msg = makeMessage({ messageId: "msg-cc", channelId: "chan-1" });

    await (bridge as any).handleMessage(msg);

    // Streaming skipped — no callback registered, no webhook post.
    expect(v3Bridge.registerProgressCallback).not.toHaveBeenCalled();
    expect(sendReturningId).not.toHaveBeenCalled();
    // Final-only delivery.
    expect(sendResponseSpy).toHaveBeenCalledTimes(1);
  });

  it("CLEANUP: clearProgressCallback runs even when awaitReply throws", async () => {
    const v3Bridge = makeFakeV3Bridge({
      finalResult: "n/a",
      pendingReplyCount: 0,
    });
    v3Bridge.awaitReply = vi.fn(async () => {
      throw new Error("timeout");
    });
    const webhookManager = {
      hasWebhook: vi.fn().mockReturnValue(true),
      sendReturningId: vi.fn(async () => "wh-msg-1"),
      editMessage: vi.fn(async () => {}),
      send: vi.fn(async () => {}),
    };

    const bridge = createV3Bridge(v3Bridge, webhookManager);
    const msg = makeMessage({ messageId: "msg-cleanup", channelId: "chan-1" });

    // handleMessage swallows the routing error internally (error path).
    await (bridge as any).handleMessage(msg);

    expect(v3Bridge.clearProgressCallback).toHaveBeenCalledTimes(1);
  });
});
