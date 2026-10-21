/**
 * Debug session `in-tool-wedge-recovery` work-stream (B) — bridge-level
 * smart-recovery regression suite.
 *
 * Exercises `DiscordBridge.streamAndPostResponse` against a mocked
 * `streamFromAgent` that rejects with an AbortError carrying a `wedgeInfo`
 * object, and asserts:
 *   - a READ-ONLY wedge (or pure-text hang) AUTO RE-RUNS the request;
 *   - a MUTATING wedge posts a NOTIFY notice and does NOT re-run;
 *   - the FORK 7 one-shot cap — the auto re-run happens exactly ONCE; if
 *     the re-run also wedges, it falls through to NOTIFY (no infinite loop);
 *   - a non-wedge error (no `wedgeInfo`) is untouched by this branch.
 *
 * The bridge is driven through its private `streamAndPostResponse`. The
 * SessionManager mock provides `streamFromAgent` +
 * `getMcpToolAnnotationsForAgent`.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import type { Message } from "discord.js";
import { DiscordBridge } from "../bridge.js";
import type { WedgeInfo } from "../../manager/tool-mutation-classifier.js";

vi.mock("../attachments.js", () => ({
  extractAttachments: vi.fn(),
  downloadAllAttachments: vi.fn(),
  formatAttachmentMetadata: vi.fn(),
  isImageAttachment: vi.fn(),
}));

/** Build an AbortError carrying a WedgeInfo, mirroring the SDK handle. */
function wedgeError(
  reason: WedgeInfo["reason"],
  inFlightToolNames: readonly string[],
): Error {
  const err = new Error("Aborted: interrupt deadline exceeded");
  err.name = "AbortError";
  (err as Error & { wedgeInfo?: WedgeInfo }).wedgeInfo = {
    reason,
    inFlightToolNames,
  };
  return err;
}

function makeMessage(): Message {
  const channelSend = vi.fn().mockResolvedValue({ edit: vi.fn() });
  return {
    content: "do the thing",
    channelId: "chan-1",
    id: "msg-wedge-1",
    type: 0,
    author: { username: "human-user", bot: false, id: "user-1" },
    createdAt: new Date("2026-05-21T00:00:00Z"),
    attachments: {
      size: 0,
      values: () => [][Symbol.iterator](),
      [Symbol.iterator]: () => [][Symbol.iterator](),
      map: () => [],
    },
    reference: null,
    webhookId: null,
    embeds: [],
    channel: {
      sendTyping: vi.fn(),
      send: channelSend,
      isThread: vi.fn().mockReturnValue(false),
    },
  } as unknown as Message;
}

describe("bridge — in-tool-wedge smart recovery", () => {
  const mockStreamFromAgent = vi.fn();
  const mockGetMcpAnnotations = vi.fn();
  const fakeAdvisorEvents = new EventEmitter();
  const fakeLog = {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  };

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
        getMcpToolAnnotationsForAgent: mockGetMcpAnnotations,
        getAgentConfig: vi.fn().mockReturnValue({ workspace: "/ws/agent-x" }),
        getTraceCollector: vi.fn().mockReturnValue(undefined),
        getConversationStore: vi.fn().mockReturnValue(undefined),
        getActiveConversationSessionId: vi.fn().mockReturnValue(undefined),
        advisorEvents: fakeAdvisorEvents,
      } as never,
      webhookManager: {
        hasWebhook: vi.fn().mockReturnValue(false),
        send: vi.fn(),
      } as never,
      botToken: "fake-token",
      log: fakeLog as never,
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetMcpAnnotations.mockResolvedValue([]);
  });

  it("auto re-runs a read-only wedge (Read in flight)", async () => {
    const bridge = createBridge();
    const msg = makeMessage();
    // First dispatch wedges on a read-only tool; the auto re-run succeeds.
    mockStreamFromAgent
      .mockRejectedValueOnce(wedgeError("max-pause-exceeded", ["Read"]))
      .mockResolvedValueOnce("recovered response");

    await (
      bridge as unknown as {
        streamAndPostResponse: (m: Message, a: string, f: string) => Promise<void>;
      }
    ).streamAndPostResponse(msg, "agent-x", "do the thing");

    // The re-run is scheduled synchronously (no setTimeout for wedges) —
    // wait a tick for the recursive call to settle.
    await new Promise((r) => setTimeout(r, 0));

    expect(mockStreamFromAgent).toHaveBeenCalledTimes(2);
  });

  it("auto re-runs a pure-text hang (no tool in flight)", async () => {
    const bridge = createBridge();
    const msg = makeMessage();
    mockStreamFromAgent
      .mockRejectedValueOnce(wedgeError("no-useful-tokens", []))
      .mockResolvedValueOnce("recovered response");

    await (
      bridge as unknown as {
        streamAndPostResponse: (m: Message, a: string, f: string) => Promise<void>;
      }
    ).streamAndPostResponse(msg, "agent-x", "do the thing");
    await new Promise((r) => setTimeout(r, 0));

    expect(mockStreamFromAgent).toHaveBeenCalledTimes(2);
  });

  it("does NOT auto re-run a mutating wedge — posts a notice instead", async () => {
    const bridge = createBridge();
    const msg = makeMessage();
    mockStreamFromAgent.mockRejectedValueOnce(
      wedgeError("max-pause-exceeded", ["Bash"]),
    );

    await (
      bridge as unknown as {
        streamAndPostResponse: (m: Message, a: string, f: string) => Promise<void>;
      }
    ).streamAndPostResponse(msg, "agent-x", "do the thing");
    await new Promise((r) => setTimeout(r, 0));

    // Mutating wedge → exactly one dispatch, no re-run.
    expect(mockStreamFromAgent).toHaveBeenCalledTimes(1);
    // A "please resend" notice was posted to the channel.
    const send = (msg.channel as unknown as { send: ReturnType<typeof vi.fn> })
      .send;
    const noticePosted = send.mock.calls.some((c) =>
      String(c[0]).includes("stalled"),
    );
    expect(noticePosted).toBe(true);
    // 999.178 R1 — the notice is then edited to attach a Retry button.
    const notice = (await send.mock.results.at(-1)!.value) as { edit: ReturnType<typeof vi.fn> };
    const editArg = notice.edit.mock.calls.at(-1)?.[0] as { components?: unknown } | undefined;
    expect(JSON.stringify(editArg?.components ?? [])).toContain("retry:");
  });

  it("FORK 7 — caps the auto re-run at ONE; a re-wedge falls through to notify", async () => {
    const bridge = createBridge();
    const msg = makeMessage();
    // Both the original AND the re-run wedge on a read-only tool.
    mockStreamFromAgent
      .mockRejectedValueOnce(wedgeError("max-pause-exceeded", ["Read"]))
      .mockRejectedValueOnce(wedgeError("max-pause-exceeded", ["Read"]));

    await (
      bridge as unknown as {
        streamAndPostResponse: (m: Message, a: string, f: string) => Promise<void>;
      }
    ).streamAndPostResponse(msg, "agent-x", "do the thing");
    // Allow the single recursive re-run to settle.
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    // Exactly TWO dispatches: original + one re-run. The second wedge does
    // NOT trigger a third dispatch — the one-shot cap holds.
    expect(mockStreamFromAgent).toHaveBeenCalledTimes(2);
    // The re-wedge falls through to NOTIFY.
    const send = (msg.channel as unknown as { send: ReturnType<typeof vi.fn> })
      .send;
    const noticePosted = send.mock.calls.some((c) =>
      String(c[0]).includes("stalled"),
    );
    expect(noticePosted).toBe(true);
  });

  it("classifies a wedge using the SDK MCP annotation snapshot", async () => {
    const bridge = createBridge();
    const msg = makeMessage();
    // An MCP tool with a readOnly:true annotation → auto re-run.
    mockGetMcpAnnotations.mockResolvedValue([
      {
        name: "weather",
        tools: [{ name: "get_forecast", annotations: { readOnly: true } }],
      },
    ]);
    mockStreamFromAgent
      .mockRejectedValueOnce(
        wedgeError("sweep-force-release", ["mcp__weather__get_forecast"]),
      )
      .mockResolvedValueOnce("recovered");

    await (
      bridge as unknown as {
        streamAndPostResponse: (m: Message, a: string, f: string) => Promise<void>;
      }
    ).streamAndPostResponse(msg, "agent-x", "do the thing");
    await new Promise((r) => setTimeout(r, 0));

    expect(mockGetMcpAnnotations).toHaveBeenCalledTimes(1);
    expect(mockStreamFromAgent).toHaveBeenCalledTimes(2);
  });

  it("recovers a wedge dispatched via TurnDispatcher (production primary path)", async () => {
    // Production dispatches through `turnDispatcher.dispatchStream`, NOT the
    // `streamFromAgent` fallback the other tests exercise. turn-dispatcher
    // rethrows the original error unchanged (turn-dispatcher.ts:918), so
    // the `wedgeInfo` attached to the same Error object must survive — this
    // test locks that in so a future refactor wrapping the error cannot
    // silently turn the wedge branch into dead code in production.
    const mockDispatchStream = vi.fn();
    const bridge = new DiscordBridge({
      routingTableRef: {
        current: {
          channelToAgent: new Map([["chan-1", "agent-x"]]),
          agentToChannels: new Map([["agent-x", ["chan-1"]]]),
        },
      },
      sessionManager: {
        streamFromAgent: mockStreamFromAgent,
        getMcpToolAnnotationsForAgent: mockGetMcpAnnotations,
        getAgentConfig: vi.fn().mockReturnValue({ workspace: "/ws/agent-x" }),
        getTraceCollector: vi.fn().mockReturnValue(undefined),
        getConversationStore: vi.fn().mockReturnValue(undefined),
        getActiveConversationSessionId: vi.fn().mockReturnValue(undefined),
        advisorEvents: fakeAdvisorEvents,
      } as never,
      turnDispatcher: {
        dispatchStream: mockDispatchStream,
      } as never,
      webhookManager: {
        hasWebhook: vi.fn().mockReturnValue(false),
        send: vi.fn(),
      } as never,
      botToken: "fake-token",
      log: fakeLog as never,
    });
    const msg = makeMessage();
    // First dispatch wedges on a read-only tool; the auto re-run succeeds.
    mockDispatchStream
      .mockRejectedValueOnce(wedgeError("max-pause-exceeded", ["Read"]))
      .mockResolvedValueOnce("recovered via dispatcher");

    await (
      bridge as unknown as {
        streamAndPostResponse: (m: Message, a: string, f: string) => Promise<void>;
      }
    ).streamAndPostResponse(msg, "agent-x", "do the thing");
    await new Promise((r) => setTimeout(r, 0));

    // The wedge branch fired on the TurnDispatcher path and re-ran once.
    expect(mockDispatchStream).toHaveBeenCalledTimes(2);
  });

  it("leaves a non-wedge error untouched by the wedge branch", async () => {
    const bridge = createBridge();
    const msg = makeMessage();
    // A plain error with no wedgeInfo — must not trigger the wedge path.
    mockStreamFromAgent.mockRejectedValueOnce(new Error("ordinary failure"));

    await (
      bridge as unknown as {
        streamAndPostResponse: (m: Message, a: string, f: string) => Promise<void>;
      }
    ).streamAndPostResponse(msg, "agent-x", "do the thing");
    await new Promise((r) => setTimeout(r, 0));

    // No re-run, and getMcpToolAnnotationsForAgent was never consulted.
    expect(mockStreamFromAgent).toHaveBeenCalledTimes(1);
    expect(mockGetMcpAnnotations).not.toHaveBeenCalled();
  });
});

/**
 * Follow-up to the wedge cascade (2026-06-03):
 *  - Fix A: the 8s typing heartbeat is hard-capped so a `generator-dead` wedge
 *    that parks `await dispatchStream` forever can no longer type indefinitely.
 *  - Fix B: the wedge "please resend" notice is posted at most ONCE per message
 *    (a re-wedge / double-dispatch previously posted duplicate notices).
 */
describe("bridge — wedge cascade follow-up (typing cap + duplicate-notice guard)", () => {
  const fakeLog = { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() };

  function createBridge(streamImpl: () => Promise<string>): DiscordBridge {
    return new DiscordBridge({
      routingTableRef: {
        current: {
          channelToAgent: new Map([["chan-1", "agent-x"]]),
          agentToChannels: new Map([["agent-x", ["chan-1"]]]),
        },
      },
      sessionManager: {
        streamFromAgent: vi.fn(streamImpl),
        getMcpToolAnnotationsForAgent: vi.fn().mockResolvedValue([]),
        getAgentConfig: vi.fn().mockReturnValue({ workspace: "/ws/agent-x" }),
        getTraceCollector: vi.fn().mockReturnValue(undefined),
        getConversationStore: vi.fn().mockReturnValue(undefined),
        getActiveConversationSessionId: vi.fn().mockReturnValue(undefined),
        advisorEvents: new EventEmitter(),
      } as never,
      webhookManager: {
        hasWebhook: vi.fn().mockReturnValue(false),
        send: vi.fn(),
      } as never,
      botToken: "fake-token",
      log: fakeLog as never,
    });
  }

  const run = (bridge: DiscordBridge, msg: Message): Promise<void> =>
    (
      bridge as unknown as {
        streamAndPostResponse: (m: Message, a: string, f: string) => Promise<void>;
      }
    ).streamAndPostResponse(msg, "agent-x", "do the thing");

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("Fix B unit — rememberNoticedOnce: first true, repeats false, FIFO-bounded", () => {
    const bridge = createBridge(async () => "ok");
    const remember = (id: string): boolean =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (bridge as any).rememberNoticedOnce(id);
    expect(remember("m1")).toBe(true);
    expect(remember("m1")).toBe(false);
    expect(remember("m2")).toBe(true);
    for (let i = 0; i < 1024; i++) remember(`bulk-${i}`);
    expect(remember("m2")).toBe(true); // evicted past the cap → treated as fresh
  });

  it("Fix B integration — a re-wedge on the SAME message posts the stall notice only ONCE", async () => {
    const bridge = createBridge(async () => {
      throw wedgeError("max-pause-exceeded", ["Bash"]); // mutating → notify path
    });
    const msg = makeMessage();
    const send = (msg.channel as unknown as { send: ReturnType<typeof vi.fn> })
      .send;
    await run(bridge, msg);
    await run(bridge, msg); // same message id wedges again
    await new Promise((r) => setTimeout(r, 0));
    const noticeCount = send.mock.calls.filter((c) =>
      String(c[0]).includes("stalled"),
    ).length;
    expect(noticeCount).toBe(1);
  });

  it("Fix A — the typing heartbeat is hard-capped so a wedged turn cannot type forever", async () => {
    vi.useFakeTimers();
    try {
      // streamFromAgent never settles → models a generator-dead wedge.
      const bridge = createBridge(() => new Promise<string>(() => {}));
      const msg = makeMessage();
      const sendTyping = (
        msg.channel as unknown as { sendTyping: ReturnType<typeof vi.fn> }
      ).sendTyping;

      void run(bridge, msg); // never settles — do not await
      await Promise.resolve(); // flush synchronous setup (arm the interval)

      // Advance past the 10-min cap (8s beats → ~75 calls, then self-clear).
      await vi.advanceTimersByTimeAsync(620_000);
      const capped = sendTyping.mock.calls.length;
      expect(capped).toBeGreaterThan(0); // it WAS typing while "working"

      // Past the cap: no further typing (interval cleared).
      await vi.advanceTimersByTimeAsync(200_000);
      expect(sendTyping.mock.calls.length).toBe(capped);
      expect(fakeLog.warn).toHaveBeenCalledWith(
        expect.objectContaining({ agent: "agent-x" }),
        expect.stringContaining("hard-capped"),
      );
    } finally {
      vi.useRealTimers();
    }
  });
});
