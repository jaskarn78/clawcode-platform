/**
 * Phase 135 Plan 02 Task 3 — handleVoiceTranscript end-to-end mock.
 * Phase 135 Plan 03 Task 1 — env-gate fixture replaced with real ACL.
 *
 * Pins the bridge-side ingress shape:
 *
 *   1. ACL deny: voice transcript from a user NOT in the channel ACL is
 *      silently dropped — no dispatch, no speak (mirrors text-path
 *      bridge.ts:944 silent-ignore on `checkChannelAccess` false).
 *   2. ACL allow (default-open, no policy registered): handleVoiceTranscript
 *      opens a turn, calls TurnDispatcher.dispatchStream with the wrapped
 *      user message (voice prompt suffix prepended), and routes the
 *      response through speakResponse instead of webhookManager/edit.
 *   3. Custom per-agent voice.promptSuffix appears in the formattedMessage
 *      instead of the default suffix.
 *
 * The TurnDispatcher and speakResponse module are mocked.
 *
 * Plan 03 deviation: the Plan 02 fixture used a `VOICE_DEV_BYPASS_ACL`
 * env-gate. That env var no longer exists in production code (Plan 03
 * Task 1 removed it alongside the Plan-03 deferral marker — see grep
 * contract in 135-03-PLAN.md). The fixture now registers a
 * default-allow security policy for the allowed case and a deny-case
 * channel ACL for the silent-drop case.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import type { SecurityPolicy } from "../../../security/types.js";

// Phase 135.1 — speakResponse now returns {interrupted, playedMs} and takes
// an optional AbortSignal (the in-flight turn's cancellation signal).
const mockSpeakResponse = vi.fn(async (..._args: unknown[]) => ({
  interrupted: false,
  playedMs: 0,
}));
vi.mock("../tts.js", () => ({
  speakResponse: (...args: unknown[]) => mockSpeakResponse(...args),
}));

import { DiscordBridge } from "../../bridge.js";
import type { VoiceSession } from "../session.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeBridge(turnDispatcher: { dispatchStream: any }, opts?: {
  securityPolicies?: ReadonlyMap<string, SecurityPolicy>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  log?: any;
}) {
  const advisorEvents = new EventEmitter();
  return new DiscordBridge({
    routingTableRef: {
      current: {
        channelToAgent: new Map([["chan-1", "test-agent"]]),
        agentToChannels: new Map([["test-agent", ["chan-1"]]]),
      },
    },
    sessionManager: {
      forwardToAgent: vi.fn(),
      streamFromAgent: vi.fn(),
      getAgentConfig: vi.fn().mockReturnValue({ workspace: "/tmp/x" }),
      getTraceCollector: vi.fn().mockReturnValue(undefined),
      advisorEvents,
      hasActiveTurn: vi.fn().mockReturnValue(false),
      getConversationStore: vi.fn().mockReturnValue(null),
      getActiveConversationSessionId: vi.fn().mockReturnValue(null),
    } as any,
    turnDispatcher: turnDispatcher as any,
    botToken: "fake-token",
    securityPolicies: opts?.securityPolicies,
    log: opts?.log ?? ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as any),
    } as any),
  });
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

describe("DiscordBridge.handleVoiceTranscript — Phase 135 Plan 02 Task 3 / Plan 03 Task 1 ACL", () => {
  beforeEach(() => {
    mockSpeakResponse.mockClear();
  });

  it("ACL deny: drops the transcript when voiceUserId is NOT in the channel ACL", async () => {
    const dispatcher = { dispatchStream: vi.fn(async () => "should not be called") };
    const policies = new Map<string, SecurityPolicy>([
      [
        "test-agent",
        {
          allowlist: [],
          channelAcls: [
            { channelId: "chan-1", allowedUserIds: ["alice"], allowedRoles: [] },
          ],
        },
      ],
    ]);
    const bridge = makeBridge(dispatcher, { securityPolicies: policies });

    await bridge.handleVoiceTranscript({
      agentName: "test-agent",
      channelId: "chan-1",
      transcript: "hello",
      voiceUserId: "eve", // not in allowedUserIds
      guildId: "guild-1",
      voiceSession: makeFakeSession(),
    });

    expect(dispatcher.dispatchStream).not.toHaveBeenCalled();
    expect(mockSpeakResponse).not.toHaveBeenCalled();
  });

  it("ACL allow (no policy registered = open): dispatches through TurnDispatcher and routes the response through speakResponse", async () => {
    const dispatcher = {
      dispatchStream: vi.fn(async (..._args: unknown[]) => "I am the agent reply."),
    };
    // No securityPolicies map → open by default (matches text-path
    // behaviour at bridge.ts:941 where the if-guard short-circuits).
    const bridge = makeBridge(dispatcher);
    const session = makeFakeSession();

    await bridge.handleVoiceTranscript({
      agentName: "test-agent",
      channelId: "chan-1",
      transcript: "what time is it",
      voiceUserId: "user-a",
      guildId: "guild-1",
      voiceSession: session,
    });

    expect(dispatcher.dispatchStream).toHaveBeenCalledTimes(1);
    const callArgs = (dispatcher.dispatchStream.mock.calls[0] ?? []) as unknown[];
    const formattedMessage = String(callArgs[2] ?? "");
    expect(formattedMessage).toContain("what time is it");
    expect(formattedMessage).toContain("read aloud");

    expect(mockSpeakResponse).toHaveBeenCalledTimes(1);
    // Phase 135.1 — third arg is the in-flight turn's AbortController signal
    // (beginVoiceTurn runs before dispatch, so currentTurn is populated).
    // 999.116 — fourth arg is the turn's latency trace (the ANSWER is traced;
    // the progress cue calls speakResponse without one).
    expect(mockSpeakResponse).toHaveBeenCalledWith(
      session,
      "I am the agent reply.",
      expect.any(AbortSignal),
      expect.objectContaining({ stamps: expect.any(Map) }),
    );
  });

  it("999.116 A3 (G7): logs ONE tagged turn-trace record when the turn settles (lengths only)", async () => {
    const dispatcher = {
      dispatchStream: vi.fn(async (..._args: unknown[]) => "Spoken reply."),
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const log: any = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    log.child = () => log;
    const bridge = makeBridge(dispatcher, { log });
    const session = makeFakeSession();

    await bridge.handleVoiceTranscript({
      agentName: "test-agent",
      channelId: "chan-1",
      transcript: "what time is it",
      voiceUserId: "user-a",
      guildId: "guild-1",
      voiceSession: session,
      sttTiming: { speechEndAt: 1_000, decisionAt: 1_900, reason: "speech_final" },
    });

    const traceCalls = log.info.mock.calls.filter(
      (c: unknown[]) => c[1] === "voice turn trace",
    );
    expect(traceCalls).toHaveLength(1);
    const record = traceCalls[0][0];
    expect(record).toMatchObject({
      tag: "phase999.116-voice-turn",
      agent: "test-agent",
      sessionId: "sess-1",
      generation: 1,
      engine: "nova3",
      streamingTts: false,
      bargeInEnabled: false,
      ttsMode: "http",
      outcome: "spoken",
      sttReason: "speech_final",
      sttLagMs: 900, // speechEnd 1000 → decision 1900
      transcriptChars: "what time is it".length,
      responseChars: "Spoken reply.".length,
      cueFired: false,
    });
    expect(record.totalMs).toEqual(expect.any(Number));
    expect(record.queueMs).toEqual(expect.any(Number));
    // WR-01: never the spoken text, in either direction.
    const flat = JSON.stringify(record);
    expect(flat).not.toContain("what time is it");
    expect(flat).not.toContain("Spoken reply");
    // The turn is cleared afterwards (endVoiceTurn) — no trace leaks into the next turn.
    expect(session.currentTurn).toBeNull();
  });

  it("ACL allow (user in allowedUserIds): dispatches and speaks", async () => {
    const dispatcher = {
      dispatchStream: vi.fn(async () => "ok"),
    };
    const policies = new Map<string, SecurityPolicy>([
      [
        "test-agent",
        {
          allowlist: [],
          channelAcls: [
            { channelId: "chan-1", allowedUserIds: ["user-a"], allowedRoles: [] },
          ],
        },
      ],
    ]);
    const bridge = makeBridge(dispatcher, { securityPolicies: policies });

    await bridge.handleVoiceTranscript({
      agentName: "test-agent",
      channelId: "chan-1",
      transcript: "hello",
      voiceUserId: "user-a",
      guildId: "guild-1",
      voiceSession: makeFakeSession(),
    });

    expect(dispatcher.dispatchStream).toHaveBeenCalledTimes(1);
    expect(mockSpeakResponse).toHaveBeenCalledTimes(1);
  });

  it("respects per-agent voice.promptSuffix override (custom suffix appears in formattedMessage instead of default)", async () => {
    const dispatcher = {
      dispatchStream: vi.fn(async () => "ok"),
    };
    const bridge = makeBridge(dispatcher);
    const session = makeFakeSession();
    (session.voiceCfg as any).promptSuffix = "Speak with the wisdom of a sphinx.";

    await bridge.handleVoiceTranscript({
      agentName: "test-agent",
      channelId: "chan-1",
      transcript: "riddle me this",
      voiceUserId: "user-a",
      guildId: "guild-1",
      voiceSession: session,
    });

    const callArgs = (dispatcher.dispatchStream.mock.calls[0] ?? []) as unknown[];
    const formattedMessage = String(callArgs[2] ?? "");
    expect(formattedMessage).toContain("riddle me this");
    expect(formattedMessage).toContain("wisdom of a sphinx");
    expect(formattedMessage).not.toContain("read aloud");
  });
});
