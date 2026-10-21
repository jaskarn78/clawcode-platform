/**
 * UX-D (2026-08-26) — handleReaction partial-message fetch guard.
 *
 * A reaction on an older/uncached message arrives with a PARTIAL message:
 * without fetching it, the forwarded event carries an id and no text,
 * which defeats point-and-verify (the agent is asked to verify claims it
 * cannot see). Pins:
 *   - partial message → fetched, then forwarded WITH its content;
 *   - fetch throws (message deleted) → silent return, nothing forwarded;
 *   - non-partial message → no fetch call (legacy path byte-identical).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";

vi.mock("../attachments.js", () => ({
  extractAttachments: vi.fn(),
  downloadAllAttachments: vi.fn(),
  formatAttachmentMetadata: vi.fn(),
  isImageAttachment: vi.fn(),
}));

describe("DiscordBridge.handleReaction — partial-message fetch (UX-D)", () => {
  const advisorEvents = new EventEmitter();
  const sessionManager = {
    forwardToAgent: vi.fn().mockResolvedValue(undefined),
    streamFromAgent: vi.fn(),
    getAgentConfig: vi.fn().mockReturnValue(undefined),
    advisorEvents,
  };
  const routingTable = {
    channelToAgent: new Map<string, string>([["chan-1", "fin-client"]]),
    agentToChannels: new Map<string, string[]>([
      ["fin-client", ["chan-1"]],
    ]),
  };
  const log = { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() };

  let DiscordBridge: typeof import("../bridge.js").DiscordBridge;
  beforeEach(async () => {
    vi.clearAllMocks();
    const mod = await import("../bridge.js");
    DiscordBridge = mod.DiscordBridge;
  });

  function createBridge() {
    return new DiscordBridge({
      routingTableRef: { current: routingTable },
      sessionManager: sessionManager as never,
      botToken: "fake-token",
      log: log as never,
    });
  }

  const user = { bot: false, username: "client-a-user", id: "u-client-a" };

  function makeReaction(message: Record<string, unknown>) {
    return {
      partial: false,
      emoji: { name: "🔍", id: null },
      message,
    };
  }

  it("fetches a partial message and forwards its hydrated content", async () => {
    const bridge = createBridge();
    const message: Record<string, unknown> = {
      partial: true,
      id: "old-msg-1",
      channelId: "chan-1",
      content: "",
      fetch: vi.fn().mockImplementation(async () => {
        message.partial = false;
        message.content =
          "Once you separate from Acme Corp, we open a Acme Brokerage Rollover IRA.";
        return message;
      }),
    };

    await (
      bridge as unknown as {
        handleReaction: (r: unknown, u: unknown, t: string) => Promise<void>;
      }
    ).handleReaction(makeReaction(message), user, "add");

    expect(message.fetch).toHaveBeenCalledTimes(1);
    expect(sessionManager.forwardToAgent).toHaveBeenCalledTimes(1);
    const [agent, formatted] = sessionManager.forwardToAgent.mock.calls[0];
    expect(agent).toBe("fin-client");
    expect(formatted).toContain(
      "Once you separate from Acme Corp, we open a Acme Brokerage Rollover IRA.",
    );
    expect(formatted).toContain("🔍");
  });

  it("returns silently when the partial message was deleted (fetch throws)", async () => {
    const bridge = createBridge();
    const message = {
      partial: true,
      id: "gone-msg",
      channelId: "chan-1",
      content: "",
      fetch: vi.fn().mockRejectedValue(new Error("Unknown Message")),
    };

    await (
      bridge as unknown as {
        handleReaction: (r: unknown, u: unknown, t: string) => Promise<void>;
      }
    ).handleReaction(makeReaction(message), user, "add");

    expect(sessionManager.forwardToAgent).not.toHaveBeenCalled();
    expect(log.error).not.toHaveBeenCalled();
  });

  it("does not fetch a non-partial message (legacy path unchanged)", async () => {
    const bridge = createBridge();
    const fetch = vi.fn();
    const message = {
      partial: false,
      id: "cached-msg",
      channelId: "chan-1",
      content: "cached content",
      fetch,
    };

    await (
      bridge as unknown as {
        handleReaction: (r: unknown, u: unknown, t: string) => Promise<void>;
      }
    ).handleReaction(makeReaction(message), user, "add");

    expect(fetch).not.toHaveBeenCalled();
    expect(sessionManager.forwardToAgent).toHaveBeenCalledTimes(1);
  });
});
