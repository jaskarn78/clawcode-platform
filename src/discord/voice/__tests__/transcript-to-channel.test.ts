/**
 * Phase 135 Plan 05 — voice.transcriptToChannel opt-in.
 *
 * Pins the paired-post behaviour in handleVoiceTranscript:
 *
 *   1. Disabled (default): voice.transcriptToChannel unset/false on
 *      voiceCfg → NEITHER user-half nor agent-half posts emit.
 *   2. Enabled, happy path: user-half (raw channel.send via
 *      postWithTimeout) AND agent-half (sendAgentMessageToChannel —
 *      webhook-preferring identity) both emit; user-half fires before
 *      streamAndPostResponse returns; agent-half fires after.
 *   3. Display-name resolution: members.cache hit takes precedence;
 *      members.fetch fallback covers cold cache; userId fallback covers
 *      complete miss.
 *   4. fallbackSpoken=true: user-half emits; agent-half SKIPPED (Haiku
 *      already spoke — posting agent text would mislead the reader).
 *   5. Empty response: agent-half SKIPPED.
 *   6. Empty channels array: BOTH halves skipped; log.info fires ONCE
 *      per agent per process (dedupe Set).
 *   7. User-half post FAILS: agent turn still dispatches.
 *   8. Agent-half post FAILS: voice flow does NOT throw; log.warn fires.
 *
 * Harness pattern mirrors silence-fallback.test.ts / ingress.test.ts.
 * The bridge's own helpers (postWithTimeout, sendAgentMessageToChannel,
 * resolveVoiceDisplayName) are stubbed post-construction via
 * `(bridge as any).<name> = vi.fn()` — same approach
 * bridge-advisor-footer.test.ts uses for verboseState. This avoids
 * mocking the discord.js Client surface (guilds.cache, channels.fetch)
 * which the existing test harness doesn't need.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";

const mockSpeakResponse = vi.fn(async (..._args: unknown[]) => undefined);
vi.mock("../tts.js", () => ({
  speakResponse: (...args: unknown[]) => mockSpeakResponse(...args),
}));

import { DiscordBridge } from "../../bridge.js";
import type { VoiceSession } from "../session.js";

type AgentCfgInput = {
  channels?: readonly string[];
  voice?: { transcriptToChannel?: boolean } & Record<string, unknown>;
};

function makeBridge(opts: {
  agentCfg: AgentCfgInput;
  dispatchReturn?: string | Error;
}) {
  const advisorEvents = new EventEmitter();
  const dispatcher = {
    dispatchStream: vi.fn(async (..._args: unknown[]) => {
      if (opts.dispatchReturn instanceof Error) throw opts.dispatchReturn;
      return opts.dispatchReturn ?? "I am the agent reply.";
    }),
  };
  const logCalls = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
  const bridge = new DiscordBridge({
    routingTableRef: {
      current: {
        channelToAgent: new Map([["chan-1", "test-agent"]]),
        agentToChannels: new Map([["test-agent", ["chan-1"]]]),
      },
    },
    sessionManager: {
      forwardToAgent: vi.fn(),
      streamFromAgent: vi.fn(),
      getAgentConfig: vi.fn().mockReturnValue(opts.agentCfg),
      getTraceCollector: vi.fn().mockReturnValue(undefined),
      advisorEvents,
      hasActiveTurn: vi.fn().mockReturnValue(false),
      getConversationStore: vi.fn().mockReturnValue(null),
      getActiveConversationSessionId: vi.fn().mockReturnValue(null),
    } as any,
    turnDispatcher: dispatcher as any,
    botToken: "fake-token",
    log: {
      ...logCalls,
      child: () => ({ ...logCalls } as any),
    } as any,
  });
  return { bridge, dispatcher, logCalls };
}

function makeFakeSession(): VoiceSession {
  return {
    id: "sess-1",
    agentName: "test-agent",
    channelId: "chan-1",
    guildId: "guild-1",
    createdAt: Date.now(),
    connection: null,
    player: { play: vi.fn(), stop: vi.fn() } as any,
    captureState: { generations: new Map() } as any,
    silenceTimer: null,
    fallbackSpoken: false,
    minutesUsedThisMonth: 0,
    deepgramConnection: null,
    activeReceivers: new Map(),
    lastSpeakerUserId: null,
    lastSpeakerGeneration: 0,
    minutesTracker: null,
    utteranceStartedAt: new Map(),
    turnLock: Promise.resolve(),
    phase: "idle",
    currentTurn: null,
    turnGeneration: 0,
    voiceCfg: {
      channelId: "chan-1",
      deepgramKey: "dg",
      elevenLabsKey: "el",
      voiceId: "voice-id-x",
    },
  };
}

/** Run any pending fire-and-forget detached promises. */
async function flushMicrotasks(): Promise<void> {
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
}

describe("DiscordBridge.handleVoiceTranscript — Phase 135.5 transcriptToChannel", () => {
  beforeEach(() => {
    mockSpeakResponse.mockClear();
  });

  it("[1] Disabled (default): no posts emit when transcriptToChannel is unset", async () => {
    const { bridge, dispatcher } = makeBridge({
      agentCfg: {
        channels: ["#text-1"],
        // voice block omitted entirely (or voice.transcriptToChannel unset)
      },
    });
    const postWithTimeout = vi.fn().mockResolvedValue(undefined);
    const sendAgentMessageToChannel = vi.fn().mockResolvedValue(undefined);
    (bridge as any).postWithTimeout = postWithTimeout;
    (bridge as any).sendAgentMessageToChannel = sendAgentMessageToChannel;

    await bridge.handleVoiceTranscript({
      agentName: "test-agent",
      channelId: "chan-1",
      transcript: "hello",
      voiceUserId: "user-a",
      guildId: "guild-1",
      voiceSession: makeFakeSession(),
    });
    await flushMicrotasks();

    expect(dispatcher.dispatchStream).toHaveBeenCalledTimes(1);
    expect(postWithTimeout).not.toHaveBeenCalled();
    expect(sendAgentMessageToChannel).not.toHaveBeenCalled();
  });

  it("[2] Enabled happy path: user-half + agent-half both emit to channels[0]", async () => {
    const { bridge, dispatcher } = makeBridge({
      agentCfg: {
        channels: ["#text-1", "#text-2"],
        voice: { transcriptToChannel: true },
      },
      dispatchReturn: "Sure, the answer is 42.",
    });
    const postWithTimeout = vi.fn().mockResolvedValue(undefined);
    const sendAgentMessageToChannel = vi.fn().mockResolvedValue(undefined);
    const resolveVoiceDisplayName = vi.fn().mockResolvedValue("Sam");
    (bridge as any).postWithTimeout = postWithTimeout;
    (bridge as any).sendAgentMessageToChannel = sendAgentMessageToChannel;
    (bridge as any).resolveVoiceDisplayName = resolveVoiceDisplayName;

    await bridge.handleVoiceTranscript({
      agentName: "test-agent",
      channelId: "chan-1",
      transcript: "what is 6 times 7",
      voiceUserId: "user-a",
      guildId: "guild-1",
      voiceSession: makeFakeSession(),
    });
    await flushMicrotasks();

    // User-half — postWithTimeout(channels[0], userLine, 5000)
    expect(postWithTimeout).toHaveBeenCalledTimes(1);
    const userCall = postWithTimeout.mock.calls[0]!;
    expect(userCall[0]).toBe("#text-1");
    expect(userCall[1]).toBe("🎙️ **Sam:** what is 6 times 7");
    expect(userCall[2]).toBe(5000);

    // Agent-half — sendAgentMessageToChannel("test-agent", channels[0], agentLine)
    expect(sendAgentMessageToChannel).toHaveBeenCalledTimes(1);
    const agentCall = sendAgentMessageToChannel.mock.calls[0]!;
    expect(agentCall[0]).toBe("test-agent");
    expect(agentCall[1]).toBe("#text-1");
    expect(agentCall[2]).toBe("💬 **test-agent:** Sure, the answer is 42.");

    expect(dispatcher.dispatchStream).toHaveBeenCalledTimes(1);
  });

  it("[3] Display-name resolution: real resolver returns userId when no guild/member", async () => {
    // Drive the real resolveVoiceDisplayName — client.guilds.cache.get
    // returns undefined for an unknown guildId, so fallback is userId.
    const { bridge } = makeBridge({
      agentCfg: {
        channels: ["#text-1"],
        voice: { transcriptToChannel: true },
      },
      dispatchReturn: "ok",
    });
    const postWithTimeout = vi.fn().mockResolvedValue(undefined);
    const sendAgentMessageToChannel = vi.fn().mockResolvedValue(undefined);
    (bridge as any).postWithTimeout = postWithTimeout;
    (bridge as any).sendAgentMessageToChannel = sendAgentMessageToChannel;

    await bridge.handleVoiceTranscript({
      agentName: "test-agent",
      channelId: "chan-1",
      transcript: "ping",
      voiceUserId: "user-xyz",
      guildId: "guild-never-cached",
      voiceSession: makeFakeSession(),
    });
    await flushMicrotasks();

    expect(postWithTimeout).toHaveBeenCalledTimes(1);
    expect(postWithTimeout.mock.calls[0]![1]).toBe("🎙️ **user-xyz:** ping");
  });

  it("[4] fallbackSpoken=true (silence-fallback fired mid-turn): user-half emits; agent-half SKIPPED", async () => {
    // Simulate the production race: handleVoiceTranscript resets
    // fallbackSpoken=false at the start of every turn (bridge.ts:1148);
    // then fireHaikuFallback flips it true right before its
    // speakResponse call. To exercise the agent-half-skip branch, we
    // drive the dispatcher to "win the race" by flipping
    // session.fallbackSpoken=true while it computes its response —
    // which mirrors what happens when Haiku already started speaking
    // by the time the agent's response arrives.
    const session = makeFakeSession();
    const { bridge, dispatcher } = makeBridge({
      agentCfg: {
        channels: ["#text-1"],
        voice: { transcriptToChannel: true },
      },
    });
    dispatcher.dispatchStream.mockImplementation(async () => {
      // Mid-turn: Haiku silence-fallback fires + flips the claim flag.
      session.fallbackSpoken = true;
      return "Agent's would-have-been response.";
    });
    const postWithTimeout = vi.fn().mockResolvedValue(undefined);
    const sendAgentMessageToChannel = vi.fn().mockResolvedValue(undefined);
    (bridge as any).postWithTimeout = postWithTimeout;
    (bridge as any).sendAgentMessageToChannel = sendAgentMessageToChannel;
    (bridge as any).resolveVoiceDisplayName = vi.fn().mockResolvedValue("Sam");

    await bridge.handleVoiceTranscript({
      agentName: "test-agent",
      channelId: "chan-1",
      transcript: "ping",
      voiceUserId: "user-a",
      guildId: "guild-1",
      voiceSession: session,
    });
    await flushMicrotasks();

    expect(dispatcher.dispatchStream).toHaveBeenCalledTimes(1);
    expect(postWithTimeout).toHaveBeenCalledTimes(1); // user-half DID emit
    expect(sendAgentMessageToChannel).not.toHaveBeenCalled(); // agent-half SKIPPED
  });

  it("[5] Empty response: agent-half SKIPPED; user-half still emits", async () => {
    const { bridge } = makeBridge({
      agentCfg: {
        channels: ["#text-1"],
        voice: { transcriptToChannel: true },
      },
      dispatchReturn: "",
    });
    const postWithTimeout = vi.fn().mockResolvedValue(undefined);
    const sendAgentMessageToChannel = vi.fn().mockResolvedValue(undefined);
    (bridge as any).postWithTimeout = postWithTimeout;
    (bridge as any).sendAgentMessageToChannel = sendAgentMessageToChannel;
    (bridge as any).resolveVoiceDisplayName = vi.fn().mockResolvedValue("Sam");

    await bridge.handleVoiceTranscript({
      agentName: "test-agent",
      channelId: "chan-1",
      transcript: "ping",
      voiceUserId: "user-a",
      guildId: "guild-1",
      voiceSession: makeFakeSession(),
    });
    await flushMicrotasks();

    expect(postWithTimeout).toHaveBeenCalledTimes(1);
    expect(sendAgentMessageToChannel).not.toHaveBeenCalled();
  });

  it("[6] Empty channels: both halves SKIPPED; log.info fires ONCE per agent", async () => {
    const { bridge, logCalls } = makeBridge({
      agentCfg: {
        channels: [], // empty
        voice: { transcriptToChannel: true },
      },
      dispatchReturn: "ok",
    });
    const postWithTimeout = vi.fn().mockResolvedValue(undefined);
    const sendAgentMessageToChannel = vi.fn().mockResolvedValue(undefined);
    (bridge as any).postWithTimeout = postWithTimeout;
    (bridge as any).sendAgentMessageToChannel = sendAgentMessageToChannel;

    // Two voice turns for the same agent — log.info should fire ONCE.
    for (let i = 0; i < 2; i += 1) {
      await bridge.handleVoiceTranscript({
        agentName: "test-agent",
        channelId: "chan-1",
        transcript: `ping-${i}`,
        voiceUserId: "user-a",
        guildId: "guild-1",
        voiceSession: makeFakeSession(),
      });
      await flushMicrotasks();
    }

    expect(postWithTimeout).not.toHaveBeenCalled();
    expect(sendAgentMessageToChannel).not.toHaveBeenCalled();

    const emptyChannelLogs = logCalls.info.mock.calls.filter((call) => {
      const msg = String(call[1] ?? "");
      return msg.includes("has no text channels");
    });
    expect(emptyChannelLogs.length).toBe(1);
  });

  it("[7] User-half post fails: agent turn STILL dispatches; log.warn fires", async () => {
    const { bridge, dispatcher, logCalls } = makeBridge({
      agentCfg: {
        channels: ["#text-1"],
        voice: { transcriptToChannel: true },
      },
      dispatchReturn: "Reply text.",
    });
    const postWithTimeout = vi
      .fn()
      .mockRejectedValue(new Error("discord 500"));
    const sendAgentMessageToChannel = vi.fn().mockResolvedValue(undefined);
    (bridge as any).postWithTimeout = postWithTimeout;
    (bridge as any).sendAgentMessageToChannel = sendAgentMessageToChannel;
    (bridge as any).resolveVoiceDisplayName = vi.fn().mockResolvedValue("Sam");

    await bridge.handleVoiceTranscript({
      agentName: "test-agent",
      channelId: "chan-1",
      transcript: "ping",
      voiceUserId: "user-a",
      guildId: "guild-1",
      voiceSession: makeFakeSession(),
    });
    await flushMicrotasks();

    // The agent dispatch happened DESPITE the user-half failure.
    expect(dispatcher.dispatchStream).toHaveBeenCalledTimes(1);
    // The agent-half STILL emits (failure of one half doesn't suppress the other).
    expect(sendAgentMessageToChannel).toHaveBeenCalledTimes(1);
    // log.warn fired for the user-half failure.
    const warnLogs = logCalls.warn.mock.calls.filter((call) => {
      const msg = String(call[1] ?? "");
      return msg.includes("voice user-half post failed");
    });
    expect(warnLogs.length).toBe(1);
  });

  it("[8] Agent-half post fails: voice flow does NOT throw; log.warn fires", async () => {
    const { bridge, logCalls } = makeBridge({
      agentCfg: {
        channels: ["#text-1"],
        voice: { transcriptToChannel: true },
      },
      dispatchReturn: "Reply.",
    });
    const postWithTimeout = vi.fn().mockResolvedValue(undefined);
    const sendAgentMessageToChannel = vi
      .fn()
      .mockRejectedValue(new Error("webhook 500"));
    (bridge as any).postWithTimeout = postWithTimeout;
    (bridge as any).sendAgentMessageToChannel = sendAgentMessageToChannel;
    (bridge as any).resolveVoiceDisplayName = vi.fn().mockResolvedValue("Sam");

    // handleVoiceTranscript MUST NOT throw — it caught the error and
    // logged. If this await rejects, the test fails.
    await bridge.handleVoiceTranscript({
      agentName: "test-agent",
      channelId: "chan-1",
      transcript: "ping",
      voiceUserId: "user-a",
      guildId: "guild-1",
      voiceSession: makeFakeSession(),
    });
    await flushMicrotasks();

    expect(sendAgentMessageToChannel).toHaveBeenCalledTimes(1);
    const warnLogs = logCalls.warn.mock.calls.filter((call) => {
      const msg = String(call[1] ?? "");
      return msg.includes("voice agent-half post failed");
    });
    expect(warnLogs.length).toBe(1);
  });
});
