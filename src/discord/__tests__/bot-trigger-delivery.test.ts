/**
 * 999.134 — bot-trigger replies must reach the channel.
 *
 * Regression: `maybeFireBotTrigger` dispatched a full agent turn for every
 * allowlisted bot message (Strava) and discarded the response — 20 fired
 * events in 30 days, zero replies posted. The dispatched text now goes
 * through `sendResponse` (delivery queue → webhook/bot), keyed on the
 * triggering message's channel.
 *
 * Harness mirrors bridge-recall-footer.test.ts — real DiscordBridge, the
 * private `maybeFireBotTrigger`, spied `sendResponse`, stub dispatcher.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import type { Message } from "discord.js";

function makeBotMessage(overrides: { username?: string; content?: string } = {}): Message {
  return {
    content: overrides.content ?? "🚴 Morning Ride · 50.17 mi · 1476 cal burned",
    channelId: "chan-1",
    id: "000000000000000034",
    author: { username: overrides.username ?? "Strava", bot: true, id: "hook-1" },
    embeds: [],
  } as unknown as Message;
}

async function flush(): Promise<void> {
  // Two macrotask hops: dispatch resolution + the delivery `then`.
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
}

describe("bot-trigger reply delivery — 999.134", () => {
  let bridge: any;
  let sendResponse: ReturnType<typeof vi.fn>;
  let log: { info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    vi.clearAllMocks();
    sendResponse = vi.fn().mockResolvedValue(undefined);
    log = { info: vi.fn(), warn: vi.fn() };
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
        getAgentConfig: vi.fn(() => ({
          workspace: "/tmp/test-agent",
          botTriggers: [{ author: "Strava", cooldownMinutes: 15, enabled: true }],
        })),
        getTraceCollector: vi.fn().mockReturnValue(undefined),
        advisorEvents: new EventEmitter(),
      } as unknown as import("../../manager/session-manager.js").SessionManager,
      botToken: "fake-token",
      log: { ...log, error: vi.fn(), debug: vi.fn() } as unknown as import("pino").Logger,
    });
    bridge.sendResponse = sendResponse;
  });

  it("delivers the dispatched reply into the triggering message's channel", async () => {
    const dispatch = vi.fn().mockResolvedValue("Logged: Morning Ride — 1,476 cal. 2,976 left today.");
    bridge.turnDispatcher = { dispatch };
    const message = makeBotMessage();
    bridge.maybeFireBotTrigger(message);
    await flush();

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch.mock.calls[0]![1]).toBe("test-agent");
    expect(dispatch.mock.calls[0]![2]).toContain("[AUTOMATED EVENT]");
    expect(sendResponse).toHaveBeenCalledWith(
      message,
      "Logged: Morning Ride — 1,476 cal. 2,976 left today.",
      "test-agent",
    );
    expect(log.info.mock.calls.some(([f]) => f?.action === "delivered" && f?.chars > 0)).toBe(true);
  });

  it.each(["   \n", "NO_REPORT", "**NO_REPORT** — already logged this ride.", "Nothing new to report."])(
    "drops a silent reply without posting: %j",
    async (reply) => {
      bridge.turnDispatcher = { dispatch: vi.fn().mockResolvedValue(reply) };
      bridge.maybeFireBotTrigger(makeBotMessage());
      await flush();

      expect(sendResponse).not.toHaveBeenCalled();
      expect(log.info.mock.calls.some(([f]) => f?.action === "silent")).toBe(true);
    },
  );

  it("a failed dispatch is warn-logged and nothing is posted", async () => {
    bridge.turnDispatcher = { dispatch: vi.fn().mockRejectedValue(new Error("agent not running")) };
    bridge.maybeFireBotTrigger(makeBotMessage());
    await flush();

    expect(sendResponse).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ tag: "bot-trigger", err: "agent not running" }),
      "bot-trigger dispatch failed",
    );
  });

  it("a non-allowlisted bot author never dispatches", async () => {
    const dispatch = vi.fn();
    bridge.turnDispatcher = { dispatch };
    bridge.maybeFireBotTrigger(makeBotMessage({ username: "SomeOtherBot" }));
    await flush();

    expect(dispatch).not.toHaveBeenCalled();
    expect(sendResponse).not.toHaveBeenCalled();
  });
});
