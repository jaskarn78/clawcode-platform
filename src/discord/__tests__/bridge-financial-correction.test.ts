/**
 * Phase 999.63 Plan 03 T-03 — DiscordBridge.postFinancialCorrection tests.
 *
 * postFinancialCorrection is the `postCorrectiveMessage` DI hook target:
 * it posts a labelled financial-verification correction as a NEW
 * standalone message. These tests pin:
 *   - a sendable channel receives the text exactly once via channel.send;
 *   - a null channelId is a safe no-op (no fetch, no send);
 *   - a send that throws is a safe no-op (never propagates).
 *
 * The discord.js client is mocked — postFinancialCorrection reuses the
 * client.channels.fetch + channel.send chain (same as sendBudgetAlert).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import { icons } from "../icons.js";

vi.mock("../attachments.js", () => ({
  extractAttachments: vi.fn(),
  downloadAllAttachments: vi.fn(),
  formatAttachmentMetadata: vi.fn(),
  isImageAttachment: vi.fn(),
}));

describe("DiscordBridge.postFinancialCorrection — T-03", () => {
  let DiscordBridge: typeof import("../bridge.js").DiscordBridge;

  const fakeAdvisorEvents = new EventEmitter();
  const fakeSessionManager = {
    forwardToAgent: vi.fn(),
    streamFromAgent: vi.fn(),
    getAgentConfig: vi.fn(),
    advisorEvents: fakeAdvisorEvents,
  };
  const fakeRoutingTable = {
    channelToAgent: new Map<string, string>([["chan-1", "fin-research"]]),
    agentToChannels: new Map<string, string[]>([["fin-research", ["chan-1"]]]),
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

  it("posts the correction text to a sendable channel exactly once", async () => {
    const bridge = createBridge();
    const send = vi.fn().mockResolvedValue({ id: "sent-msg-1" });
    const fetch = vi.fn().mockResolvedValue({ send });
    // Override the internal discord.js client with a minimal mock.
    (bridge as unknown as { client: unknown }).client = {
      channels: { fetch },
    };

    await bridge.postFinancialCorrection({
      channelId: "chan-1",
      text: "🔎 Correction (verified figures):\nThe 10-year is 4.31%.",
    });

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith("chan-1");
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(
      "🔎 Correction (verified figures):\nThe 10-year is 4.31%.",
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
      bridge.postFinancialCorrection({ channelId: null, text: "correction" }),
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
      bridge.postFinancialCorrection({ channelId: "chan-1", text: "x" }),
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
      bridge.postFinancialCorrection({ channelId: "chan-1", text: "x" }),
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
      bridge.postFinancialCorrection({ channelId: "bad-chan", text: "x" }),
    ).resolves.toBeUndefined();
  });
});

// UX-B (2026-08-26) — 🔎 reaction on in-place-corrected messages, so a
// silent edit can't be missed (Discord's "(edited)" tag is tiny).
// Self-contained harness: the first describe's createBridge is block-scoped.
describe("DiscordBridge.applyFinancialCorrection — 🔎 reaction (UX-B)", () => {
  const DRAFT = "The 10-year is 4.10%.";
  const CORRECTED = "The 10-year is 4.31% (source: ustreasury).";
  const FOOTER = "*— correction applied (verified figures)*";

  const uxAdvisorEvents = new EventEmitter();
  const uxSessionManager = {
    forwardToAgent: vi.fn(),
    streamFromAgent: vi.fn(),
    getAgentConfig: vi.fn(),
    advisorEvents: uxAdvisorEvents,
  };
  const uxRoutingTable = {
    channelToAgent: new Map<string, string>([["chan-1", "fin-research"]]),
    agentToChannels: new Map<string, string[]>([["fin-research", ["chan-1"]]]),
  };
  const uxLog = { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() };

  let UxDiscordBridge: typeof import("../bridge.js").DiscordBridge;
  beforeEach(async () => {
    const mod = await import("../bridge.js");
    UxDiscordBridge = mod.DiscordBridge;
  });

  function createBridge() {
    return new UxDiscordBridge({
      routingTableRef: { current: uxRoutingTable },
      sessionManager: uxSessionManager as never,
      botToken: "fake-token",
      log: uxLog as never,
    });
  }

  function seedRef(bridge: unknown, turnId: string) {
    (
      bridge as {
        deliveredRefs: {
          record: (ref: {
            kind: "bot";
            messageId: string;
            channelId: string;
            agentName: string;
            turnId: string;
            deliveredText: string;
            at: number;
          }) => void;
        };
      }
    ).deliveredRefs.record({
      kind: "bot",
      messageId: "orig-msg-1",
      channelId: "chan-1",
      agentName: "fin-research",
      turnId,
      deliveredText: DRAFT,
      at: Date.now(),
    });
  }

  it("reacts with cc_search on the edited message after a successful in-place edit", async () => {
    // 999.178 R1 — the correction marker is the cc_search custom emoji,
    // resolved through the registry (nothing reacts when it is not loaded).
    icons.setAll([{ id: "55", name: "cc_search" }]);
    const bridge = createBridge();
    const edit = vi.fn().mockResolvedValue(undefined);
    const react = vi.fn().mockResolvedValue(undefined);
    const messagesFetch = vi.fn().mockResolvedValue({ edit, react });
    const fetch = vi.fn().mockResolvedValue({ messages: { fetch: messagesFetch } });
    (bridge as unknown as { client: unknown }).client = { channels: { fetch } };
    seedRef(bridge, "discord:t1");

    const path = await bridge.applyFinancialCorrection({
      agentName: "fin-research",
      channelId: "chan-1",
      turnId: "discord:t1",
      originalResponse: DRAFT,
      correctedText: CORRECTED,
      fallbackText: `Correction (verified figures):\n${CORRECTED}`,
      footer: FOOTER,
    });

    expect(path).toBe("edit");
    expect(edit).toHaveBeenCalledTimes(1);
    expect(react).toHaveBeenCalledTimes(1);
    expect(react).toHaveBeenCalledWith("cc_search:55");
    icons.clear();
  });

  it("a throwing react is non-fatal — the edit still counts", async () => {
    const bridge = createBridge();
    const edit = vi.fn().mockResolvedValue(undefined);
    const react = vi.fn().mockRejectedValue(new Error("Missing Permissions"));
    const messagesFetch = vi.fn().mockResolvedValue({ edit, react });
    const fetch = vi.fn().mockResolvedValue({ messages: { fetch: messagesFetch } });
    (bridge as unknown as { client: unknown }).client = { channels: { fetch } };
    seedRef(bridge, "discord:t2");

    const path = await bridge.applyFinancialCorrection({
      agentName: "fin-research",
      channelId: "chan-1",
      turnId: "discord:t2",
      originalResponse: DRAFT,
      correctedText: CORRECTED,
      fallbackText: "fallback",
      footer: FOOTER,
    });

    expect(path).toBe("edit");
    expect(edit).toHaveBeenCalledTimes(1);
  });

  it("no reaction on the fallback-post path (no ref recorded)", async () => {
    const bridge = createBridge();
    const send = vi.fn().mockResolvedValue({ id: "posted" });
    const react = vi.fn();
    const fetch = vi.fn().mockResolvedValue({ send });
    (bridge as unknown as { client: unknown }).client = { channels: { fetch } };

    const path = await bridge.applyFinancialCorrection({
      agentName: "fin-research",
      channelId: "chan-1",
      turnId: "discord:t3",
      originalResponse: DRAFT,
      correctedText: CORRECTED,
      fallbackText: "🔎 Correction (verified figures):\nfallback text",
      footer: FOOTER,
    });

    expect(path).toBe("post");
    expect(react).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalled();
  });
});
