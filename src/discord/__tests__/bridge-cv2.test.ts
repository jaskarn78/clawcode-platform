/**
 * postCv2ToAgentChannel unit tests.
 *
 * Pins the REST-bypass send path: the bridge must call
 * `client.rest.post(Routes.channelMessages(channelId), { body: payload })`
 * with the EXACT payload produced by `buildCv2Payload(spec)` — no extra
 * fields injected. The bypass exists because discord.js v14.26.2's
 * `MessagePayload.resolveBody()` adds `content: ''` and `embeds: []` to
 * every message body, which Discord rejects with HTTP 400 when the
 * `IsComponentsV2` flag is set.
 *
 * Mocks the discord.js `Client.rest.post` directly. Does not require a
 * live Discord connection.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { Routes } from "discord-api-types/v10";
import { MessageFlags } from "discord.js";
import { DiscordBridge } from "../bridge.js";
import type { Cv2Spec } from "../cv2-renderer.js";

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

const fakeSessionManager = {
  forwardToAgent: vi.fn(),
  streamFromAgent: vi.fn(),
  getAgentConfig: vi.fn(),
  getTraceCollector: vi.fn().mockReturnValue(undefined),
  advisorEvents: { on: vi.fn(), off: vi.fn(), emit: vi.fn() },
};

function makeBridge(): DiscordBridge {
  return new DiscordBridge({
    routingTableRef: { current: fakeRoutingTable },
    sessionManager: fakeSessionManager as any,
    webhookManager: fakeWebhookManager as any,
    botToken: "fake-token",
    log: fakeLog as any,
  });
}

const SAMPLE_SPEC: Cv2Spec = {
  accentColor: 0x5865f2,
  blocks: [
    { type: "text", content: "# Board" },
    { type: "separator" },
    { type: "text", content: "Item 1" },
  ],
};

describe("postCv2ToAgentChannel", () => {
  let restPostSpy: ReturnType<typeof vi.fn>;
  let bridge: DiscordBridge;

  beforeEach(() => {
    vi.clearAllMocks();
    bridge = makeBridge();
    restPostSpy = vi.fn();
    // Replace the discord.js Client's rest.post with our spy.
    Object.defineProperty((bridge as any).client, "rest", {
      value: { post: restPostSpy },
      configurable: true,
    });
  });

  it("sends EXACTLY the buildCv2Payload output via REST — no extra fields", async () => {
    restPostSpy.mockResolvedValue({ id: "msg-001" });

    const result = await bridge.postCv2ToAgentChannel("agent-x", SAMPLE_SPEC);

    expect(result).toEqual({ ok: true, messageId: "msg-001" });
    expect(restPostSpy).toHaveBeenCalledTimes(1);

    const [route, options] = restPostSpy.mock.calls[0]!;
    expect(route).toBe(Routes.channelMessages("chan-1"));

    // Exact body shape — no content/embeds/tts defaults.
    expect(options.body).toEqual({
      flags: MessageFlags.IsComponentsV2,
      components: [
        {
          type: 17,
          accent_color: 0x5865f2,
          components: [
            { type: 10, content: "# Board" },
            { type: 14, divider: true, spacing: 1 },
            { type: 10, content: "Item 1" },
          ],
        },
      ],
    });
    // Belt-and-suspenders: ensure the CV2-forbidden fields are NOT in body.
    expect(options.body).not.toHaveProperty("content");
    expect(options.body).not.toHaveProperty("embeds");
    expect(options.body).not.toHaveProperty("stickers");
    expect(options.body).not.toHaveProperty("poll");
  });

  it("returns no-binding when the agent has no channel", async () => {
    const result = await bridge.postCv2ToAgentChannel("unknown-agent", SAMPLE_SPEC);

    expect(result).toEqual({
      ok: false,
      reason: "no-binding",
      detail: "no channel binding for agent unknown-agent",
    });
    expect(restPostSpy).not.toHaveBeenCalled();
  });

  it("returns invalid-spec when buildCv2Payload throws", async () => {
    const badSpec = { blocks: [] } as unknown as Cv2Spec;

    const result = await bridge.postCv2ToAgentChannel("agent-x", badSpec);

    expect(result.ok).toBe(false);
    if (result.ok === false) {
      expect(result.reason).toBe("invalid-spec");
      expect(result.detail).toMatch(/blocks must not be empty/);
    }
    expect(restPostSpy).not.toHaveBeenCalled();
  });

  it("returns send-failed when REST throws", async () => {
    restPostSpy.mockRejectedValue(new Error("DiscordAPIError[50035]: Invalid Form Body"));

    const result = await bridge.postCv2ToAgentChannel("agent-x", SAMPLE_SPEC);

    expect(result).toEqual({
      ok: false,
      reason: "send-failed",
      detail: "DiscordAPIError[50035]: Invalid Form Body",
    });
    expect(fakeLog.error).toHaveBeenCalled();
  });

  it("logs the success line with messageId + blockCount", async () => {
    restPostSpy.mockResolvedValue({ id: "msg-042" });

    await bridge.postCv2ToAgentChannel("agent-x", SAMPLE_SPEC);

    expect(fakeLog.info).toHaveBeenCalledWith(
      expect.objectContaining({
        agent: "agent-x",
        channelId: "chan-1",
        messageId: "msg-042",
        blockCount: 3,
      }),
      "CV2 embed posted",
    );
  });

  it("omits accent_color in body when spec has none", async () => {
    restPostSpy.mockResolvedValue({ id: "msg-noaccent" });
    const noAccentSpec: Cv2Spec = {
      blocks: [{ type: "text", content: "plain" }],
    };

    await bridge.postCv2ToAgentChannel("agent-x", noAccentSpec);

    const [, options] = restPostSpy.mock.calls[0]!;
    expect(options.body.components[0]).not.toHaveProperty("accent_color");
  });
});
