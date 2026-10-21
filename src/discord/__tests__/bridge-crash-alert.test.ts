/**
 * Quick task 260521-5gh Gap 2 — DiscordBridge.sendCrashAlert tests.
 *
 * sendCrashAlert is the `onCrashAlert` DI hook's delivery target: it posts
 * an agent crash alert as a NEW standalone plain-text message. These tests
 * pin the fail-open contract (mirrors postFinancialCorrection):
 *   - a sendable channel receives the text exactly once via channel.send;
 *   - a null channelId is a safe no-op (no fetch, no send);
 *   - an unsendable channel is a safe no-op;
 *   - a send that throws is a safe no-op (never propagates);
 *   - a channels.fetch that throws is a safe no-op.
 *
 * A crash alert that throws must never propagate back into the
 * fire-and-forget recovery path.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";

vi.mock("../attachments.js", () => ({
  extractAttachments: vi.fn(),
  downloadAllAttachments: vi.fn(),
  formatAttachmentMetadata: vi.fn(),
  isImageAttachment: vi.fn(),
}));

describe("DiscordBridge.sendCrashAlert — Gap 2", () => {
  let DiscordBridge: typeof import("../bridge.js").DiscordBridge;

  const fakeAdvisorEvents = new EventEmitter();
  const fakeSessionManager = {
    forwardToAgent: vi.fn(),
    streamFromAgent: vi.fn(),
    getAgentConfig: vi.fn(),
    advisorEvents: fakeAdvisorEvents,
  };
  const fakeRoutingTable = {
    channelToAgent: new Map<string, string>([["chan-1", "fin-client"]]),
    agentToChannels: new Map<string, string[]>([
      ["fin-client", ["chan-1"]],
    ]),
  };
  const fakeLog = {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    const mod = await import("../bridge.js");
    DiscordBridge = mod.DiscordBridge;
  });

  function createBridge() {
    return new DiscordBridge({
      routingTableRef: { current: fakeRoutingTable },
      sessionManager: fakeSessionManager as never,
      botToken: "fake-token",
      log: fakeLog as never,
    });
  }

  it("posts the crash alert text to a sendable channel exactly once", async () => {
    const bridge = createBridge();
    const send = vi.fn().mockResolvedValue({ id: "sent-msg-1" });
    const fetch = vi.fn().mockResolvedValue({ send });
    (bridge as unknown as { client: unknown }).client = {
      channels: { fetch },
    };

    await bridge.sendCrashAlert({
      channelId: "chan-1",
      text: "fin-client crashed (attempt 2): warm-path: sqlite warm failed",
    });

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith("chan-1");
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(
      "fin-client crashed (attempt 2): warm-path: sqlite warm failed",
    );
  });

  it("is a safe no-op when channelId is null — no fetch, no send", async () => {
    const bridge = createBridge();
    const send = vi.fn();
    const fetch = vi.fn().mockResolvedValue({ send });
    (bridge as unknown as { client: unknown }).client = {
      channels: { fetch },
    };

    await expect(
      bridge.sendCrashAlert({ channelId: null, text: "crash" }),
    ).resolves.toBeUndefined();

    expect(fetch).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it("is a safe no-op when the channel is not sendable", async () => {
    const bridge = createBridge();
    // channel without a `send` function.
    const fetch = vi.fn().mockResolvedValue({});
    (bridge as unknown as { client: unknown }).client = {
      channels: { fetch },
    };

    await expect(
      bridge.sendCrashAlert({ channelId: "chan-1", text: "x" }),
    ).resolves.toBeUndefined();
  });

  it("never throws when channel.send rejects — failure is trapped + logged", async () => {
    const bridge = createBridge();
    const send = vi.fn().mockRejectedValue(new Error("discord 500"));
    const fetch = vi.fn().mockResolvedValue({ send });
    (bridge as unknown as { client: unknown }).client = {
      channels: { fetch },
    };

    await expect(
      bridge.sendCrashAlert({ channelId: "chan-1", text: "x" }),
    ).resolves.toBeUndefined();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("never throws when channels.fetch rejects", async () => {
    const bridge = createBridge();
    const fetch = vi.fn().mockRejectedValue(new Error("unknown channel"));
    (bridge as unknown as { client: unknown }).client = {
      channels: { fetch },
    };

    await expect(
      bridge.sendCrashAlert({ channelId: "bad-chan", text: "x" }),
    ).resolves.toBeUndefined();
  });
});
