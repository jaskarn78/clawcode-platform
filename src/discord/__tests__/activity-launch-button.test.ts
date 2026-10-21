/**
 * Backlog 999.95 — DiscordBridge.postActivityLaunchButton.
 *
 * Activity-launch invites are voice-channel-scoped, so the method is two-tier:
 * voice-invite (true one-tap) when a voice channel resolves, else a text
 * fallback the Activity self-resolves. We stub the discord.js client's REST +
 * caches and assert the wire body + the chosen tier.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { DiscordBridge } from "../bridge.js";

const ACTIVITY_ENV = [
  "DISCORD_ACTIVITY_APP_ID",
  "DISCORD_ACTIVITY_OPERATOR_ID",
  "DISCORD_ACTIVITY_VOICE_CHANNEL_ID",
] as const;

const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ACTIVITY_ENV) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of ACTIVITY_ENV) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

type RestPost = ReturnType<typeof vi.fn>;

function makeBridge(args: {
  readonly agentToChannels: Map<string, readonly string[]>;
  readonly guildId?: string | null;
  readonly operatorVoiceChannelId?: string | null;
  readonly restPost: RestPost;
}) {
  const bridge = new DiscordBridge({
    routingTableRef: {
      current: {
        channelToAgent: new Map(),
        agentToChannels: args.agentToChannels,
      },
    },
    sessionManager: {} as unknown as import("../../manager/session-manager.js").SessionManager,
    botToken: "fake-token",
    log: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    } as unknown as import("pino").Logger,
  });

  const guild = {
    voiceStates: {
      cache: {
        get: vi.fn().mockReturnValue(
          args.operatorVoiceChannelId
            ? { channelId: args.operatorVoiceChannelId }
            : undefined,
        ),
      },
    },
  };

  const clientStub = {
    channels: {
      fetch: vi
        .fn()
        .mockResolvedValue(
          args.guildId === null ? null : { guildId: args.guildId ?? "guild-1" },
        ),
    },
    guilds: { cache: { get: vi.fn().mockReturnValue(guild) } },
    rest: { post: args.restPost },
  };

  (bridge as unknown as { client: unknown }).client = clientStub;
  return bridge;
}

describe("postActivityLaunchButton", () => {
  it("returns no-binding when the agent has no channel", async () => {
    const bridge = makeBridge({
      agentToChannels: new Map(),
      restPost: vi.fn(),
    });
    const r = await bridge.postActivityLaunchButton({
      agent: "a",
      previewId: "p1",
      previewUrl: "https://activity.example/preview/p1",
    });
    expect(r).toEqual({ ok: false, reason: "no-binding" });
  });

  it("voice path: creates a target_type=2 invite and posts a link button", async () => {
    process.env.DISCORD_ACTIVITY_OPERATOR_ID = "op-1";
    const restPost: RestPost = vi.fn(async (route: string) => {
      if (route.includes("/invites")) return { code: "inv123" };
      if (route.includes("/messages")) return { id: "msg-1" };
      throw new Error(`unexpected route ${route}`);
    });
    const bridge = makeBridge({
      agentToChannels: new Map([["a", ["chan-1"]]]),
      guildId: "guild-1",
      operatorVoiceChannelId: "voice-9",
      restPost,
    });

    const r = await bridge.postActivityLaunchButton({
      agent: "a",
      previewId: "p1",
      previewUrl: "https://activity.example/preview/p1",
    });

    expect(r).toEqual({ ok: true, mode: "voice-invite", messageId: "msg-1" });

    const inviteCall = restPost.mock.calls.find((c) => String(c[0]).includes("/invites"));
    expect(inviteCall).toBeDefined();
    expect(String(inviteCall![0])).toContain("voice-9");
    expect((inviteCall![1] as { body: Record<string, unknown> }).body).toMatchObject({
      target_type: 2,
      target_application_id: "000000000000000000", // public default app id
      max_age: 0,
    });

    const msgCall = restPost.mock.calls.find((c) => String(c[0]).includes("/messages"));
    const body = (msgCall![1] as { body: { components: unknown[]; content: string } })
      .body;
    expect(JSON.stringify(body.components)).toContain("https://discord.gg/inv123");
  });

  it("text fallback: posts a plain message when no voice channel resolves", async () => {
    const restPost: RestPost = vi.fn(async (route: string) => {
      if (route.includes("/messages")) return { id: "msg-2" };
      throw new Error(`unexpected route ${route}`);
    });
    const bridge = makeBridge({
      agentToChannels: new Map([["a", ["chan-1"]]]),
      guildId: "guild-1",
      operatorVoiceChannelId: null, // operator not in voice
      restPost,
    });

    const r = await bridge.postActivityLaunchButton({
      agent: "a",
      previewId: "p1",
      previewUrl: "https://activity.example/preview/p1",
    });

    expect(r).toEqual({ ok: true, mode: "fallback-message", messageId: "msg-2" });
    // No invite was attempted.
    expect(restPost.mock.calls.some((c) => String(c[0]).includes("/invites"))).toBe(false);
  });

  it("uses a configured voice channel id without needing the operator's voice state", async () => {
    process.env.DISCORD_ACTIVITY_VOICE_CHANNEL_ID = "voice-cfg";
    const restPost: RestPost = vi.fn(async (route: string) => {
      if (route.includes("/invites")) return { code: "invCFG" };
      if (route.includes("/messages")) return { id: "msg-3" };
      throw new Error(`unexpected route ${route}`);
    });
    const bridge = makeBridge({
      agentToChannels: new Map([["a", ["chan-1"]]]),
      guildId: "guild-1",
      operatorVoiceChannelId: null,
      restPost,
    });

    const r = await bridge.postActivityLaunchButton({
      agent: "a",
      previewId: "p1",
      previewUrl: "https://activity.example/preview/p1",
    });

    expect(r.ok).toBe(true);
    const inviteCall = restPost.mock.calls.find((c) => String(c[0]).includes("/invites"));
    expect(String(inviteCall![0])).toContain("voice-cfg");
  });
});
