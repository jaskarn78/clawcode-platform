/**
 * 999.116 hotfix — receive-path resilience + observability.
 *
 * Background (2026-09-04 live call): `/vc join` worked, Deepgram stayed
 * open, the operator spoke, and NOTHING was logged — every failure between
 * Discord and the decoder was debug-level, and @discordjs/voice destroys a
 * user's receive stream on the first packet it cannot parse/decrypt while
 * our singleton guard kept the dead stream forever. Pins:
 *
 *   - first packets per user → info line; a receiver stream error drops the
 *     subscription (warn) and the next speaking-start re-subscribes;
 *   - "voice connection ready" carries encryption mode + DAVE version, and
 *     DAVE/decrypt debug events are promoted to info + counted;
 *   - leave() unregisters BEFORE closing Deepgram → no reconnect leak, and
 *     "voice session closed" carries the receive stats;
 *   - the join greeting speaks through the wired speaker, "" disables it, a
 *     failure is a warning (never a join failure);
 *   - auto-join on a human joining the agent's channel (once, never for
 *     bots, honours autoJoinOnUser:false) and auto-leave when it empties;
 *   - schema accepts the two new knobs.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { PassThrough } from "node:stream";

const speakingHandlers: Array<(userId: string) => void> = [];
const subscribeCalls: Array<{ userId: string; stream: PassThrough }> = [];
const connectionEvents: Record<string, Array<(...a: unknown[]) => void>> = {};

const makeStubConnection = () => ({
  destroy: vi.fn(),
  subscribe: vi.fn(),
  receiver: {
    speaking: {
      on: vi.fn((ev: string, cb: (userId: string) => void) => {
        if (ev === "start") speakingHandlers.push(cb);
      }),
      off: vi.fn(),
    },
    subscribe: vi.fn((userId: string) => {
      const stream = new PassThrough();
      subscribeCalls.push({ userId, stream });
      return stream;
    }),
  },
  state: {
    status: "ready",
    networking: {
      state: {
        connectionData: { encryptionMode: "aead_aes256_gcm_rtpsize" },
        dave: { protocolVersion: 1 },
      },
    },
  },
  on: vi.fn((ev: string, cb: (...a: unknown[]) => void) => {
    (connectionEvents[ev] ??= []).push(cb);
  }),
  off: vi.fn(),
});
const mockJoinVoiceChannel = vi.fn();
const mockEntersState = vi.fn();

vi.mock("@discordjs/voice", () => ({
  joinVoiceChannel: (...args: unknown[]) => mockJoinVoiceChannel(...args),
  entersState: (...args: unknown[]) => mockEntersState(...args),
  createAudioPlayer: () => ({ stop: vi.fn(), on: vi.fn(), once: vi.fn(), state: { status: "idle" } }),
  VoiceConnectionStatus: { Ready: "ready" },
  EndBehaviorType: { Manual: 0 },
  StreamType: { Arbitrary: "arbitrary", Raw: "raw" },
}));

// The Opus decoder is not under test (and the native codec may be absent on
// a dev box): a pass-through stands in so the pipeline wiring is exercised.
vi.mock("../audio.js", () => ({
  decodeOpusToLinear16: (opus: PassThrough) => opus.pipe(new PassThrough()),
}));

// Deepgram: capture the callback set; close() fires onClose synchronously,
// which is what the real SDK does and what used to trigger the leak.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const dgOpens: Array<{ callbacks: any }> = [];
vi.mock("../stt.js", () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  openDeepgramConnection: vi.fn(async (_key: string, callbacks: any) => {
    dgOpens.push({ callbacks });
    return {
      close: vi.fn(() => callbacks.onClose?.()),
      sendMedia: vi.fn(),
      on: vi.fn(),
    };
  }),
}));

import { VoiceManager, DEFAULT_JOIN_GREETING } from "../manager.js";
import { voiceConfigSchema } from "../../../config/schema.js";
import type { AgentWithVoice } from "../config.js";

function makeFakeLog() {
  const log = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: () => log,
  };
  return log;
}

function makeFakeClient(guildId = "guild-1") {
  return {
    channels: {
      fetch: vi.fn(async (id: string) => ({
        id,
        type: 2,
        guild: { id: guildId, voiceAdapterCreator: () => ({}) },
        isVoiceBased: () => true,
      })),
    },
    users: { cache: new Map() },
    user: { id: "bot-user-id" },
  };
}

function makeAgents(voiceExtra: Record<string, unknown> = {}): readonly AgentWithVoice[] {
  return [
    {
      name: "test-agent",
      voice: {
        channelId: "voice-chan-1",
        deepgramKey: "dg-key",
        elevenLabsKey: "el-key",
        voiceId: "voice-id",
        ...voiceExtra,
      },
    } as unknown as AgentWithVoice,
  ];
}

function makeManager(voiceExtra: Record<string, unknown> = {}) {
  const conn = makeStubConnection();
  mockJoinVoiceChannel.mockReturnValue(conn);
  mockEntersState.mockResolvedValue(conn);
  const log = makeFakeLog();
  const client = makeFakeClient("guild-1");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const vm = new VoiceManager(client as any, log as any, makeAgents(voiceExtra));
  return { vm, log, conn };
}

const infoMessages = (log: ReturnType<typeof makeFakeLog>) =>
  log.info.mock.calls.map((c) => c[1] as string);
const warnMessages = (log: ReturnType<typeof makeFakeLog>) =>
  log.warn.mock.calls.map((c) => c[1] as string);

describe("999.116 hotfix — receive path", () => {
  beforeEach(() => {
    speakingHandlers.length = 0;
    subscribeCalls.length = 0;
    dgOpens.length = 0;
    for (const k of Object.keys(connectionEvents)) delete connectionEvents[k];
    mockJoinVoiceChannel.mockReset();
    mockEntersState.mockReset();
  });

  it("logs first packets per user at info; a receiver stream error drops the subscription and the next speech re-subscribes", async () => {
    const { vm, log } = makeManager();
    const session = await vm.join("test-agent", "voice-chan-1");
    expect(speakingHandlers).toHaveLength(1);
    const speakingStart = speakingHandlers[0]!;

    speakingStart("user-a");
    expect(subscribeCalls).toHaveLength(1);
    expect(session.activeReceivers.has("user-a")).toBe(true);
    expect(infoMessages(log)).toContain("voice hearing user — first packets received");

    // A second speaking-start with a healthy stream does NOT re-subscribe
    // (the decoder-stacking landmine), and does not re-log "first packets".
    speakingStart("user-a");
    expect(subscribeCalls).toHaveLength(1);
    expect(
      infoMessages(log).filter((m) => m === "voice hearing user — first packets received"),
    ).toHaveLength(1);

    // What @discordjs/voice does on a packet it cannot parse/decrypt.
    subscribeCalls[0]!.stream.emit("error", new Error("Failed to parse packet"));
    expect(session.activeReceivers.has("user-a")).toBe(false);
    expect(warnMessages(log)).toContain(
      "voice receiver stream error — subscription dropped; next speech re-subscribes",
    );

    // The user keeps talking → a fresh pipeline, not a permanent mute.
    speakingStart("user-a");
    expect(subscribeCalls).toHaveLength(2);
    expect(session.activeReceivers.get("user-a")).toBe(subscribeCalls[1]!.stream);
    expect(session.stats?.speakingStarts).toBe(3);
    expect(session.stats?.receiverErrors).toBe(1);
    expect(session.stats?.usersHeard.size).toBe(1);
  });

  it("logs the negotiated encryption mode + DAVE version at Ready, promotes DAVE debug events to info and counts decrypt failures", async () => {
    const { vm, log } = makeManager();
    const session = await vm.join("test-agent", "voice-chan-1");
    const ready = log.info.mock.calls.find((c) => c[1] === "voice connection ready");
    expect(ready?.[0]).toMatchObject({
      encryptionMode: "aead_aes256_gcm_rtpsize",
      daveProtocolVersion: 1,
    });

    const debug = connectionEvents["debug"]?.[0];
    expect(debug).toBeDefined();
    debug!("[NW] [DAVE] Failed to decrypt a packet (1 consecutive fails)");
    debug!("[WS] heartbeat acknowledged");
    const events = log.info.mock.calls.filter((c) => c[1] === "voice connection event");
    expect(events).toHaveLength(1);
    expect(events[0]?.[0]).toMatchObject({ message: expect.stringContaining("[DAVE]") });
    expect(session.stats?.daveFailures).toBe(1);

    const stateChange = connectionEvents["stateChange"]?.[0];
    stateChange!({ status: "ready" }, { status: "disconnected", reason: 1, closeCode: 4014 });
    const st = log.info.mock.calls.find((c) => c[1] === "voice connection state");
    expect(st?.[0]).toMatchObject({ from: "ready", to: "disconnected", closeCode: 4014 });
  });

  it("leave() unregisters before closing Deepgram (no reconnect leak) and logs the receive stats", async () => {
    const { vm, log } = makeManager();
    const session = await vm.join("test-agent", "voice-chan-1");
    speakingHandlers[0]!("user-a");
    // Deepgram delivered two interims + one final before the leave.
    dgOpens[0]!.callbacks.onInterimTranscript("hel");
    dgOpens[0]!.callbacks.onInterimTranscript("hello");
    expect(infoMessages(log)).toContain("voice stt hearing speech — first interim transcript");

    await vm.leave("guild-1");
    // One socket total — the synchronous onClose from close() must not reopen.
    expect(dgOpens).toHaveLength(1);
    expect(infoMessages(log)).not.toContain("attempting deepgram WS reconnect");
    const closed = log.info.mock.calls.find((c) => c[1] === "voice session closed");
    expect(closed?.[0]).toMatchObject({
      sessionId: session.id,
      speakingStarts: 1,
      usersHeard: 1,
      sttInterims: 2,
      receiverErrors: 0,
    });
    expect(typeof closed?.[0]?.durationMs).toBe("number");
    expect(vm.status()).toHaveLength(0);
  });

  it("speaks the join greeting through the wired speaker; '' disables it; a failure is a warning, not a join failure", async () => {
    const { vm, log } = makeManager();
    const speaker = vi.fn(async () => undefined);
    vm.setGreetingSpeaker(speaker);
    const session = await vm.join("test-agent", "voice-chan-1");
    expect(speaker).toHaveBeenCalledWith(session, DEFAULT_JOIN_GREETING);
    await Promise.resolve();
    await Promise.resolve();
    expect(infoMessages(log)).toContain("voice join greeting spoken");

    const off = makeManager({ joinGreeting: "" });
    const silent = vi.fn(async () => undefined);
    off.vm.setGreetingSpeaker(silent);
    await off.vm.join("test-agent", "voice-chan-1");
    expect(silent).not.toHaveBeenCalled();

    const broken = makeManager({ joinGreeting: "Hey." });
    broken.vm.setGreetingSpeaker(vi.fn(async () => { throw new Error("ElevenLabs 401"); }));
    const s2 = await broken.vm.join("test-agent", "voice-chan-1");
    expect(s2).toBeDefined(); // join still succeeds
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    const failed = broken.log.warn.mock.calls.find(
      (c) => c[1] === "voice join greeting FAILED — TTS or the send path is broken",
    );
    expect(failed?.[0]).toMatchObject({ error: "ElevenLabs 401" });
  });

  it("auto-joins once when a human enters the agent's channel, never for bots, honours autoJoinOnUser:false, and auto-leaves when the channel empties", async () => {
    const { vm, log } = makeManager();
    await vm.handleUserJoin("guild-1", "voice-chan-1", "user-a", false);
    expect(mockJoinVoiceChannel).toHaveBeenCalledTimes(1);
    expect(infoMessages(log)).toContain("voice auto-join — a user joined the agent's voice channel");
    expect(vm.status()).toHaveLength(1);
    // Already in → no second join; a different channel → ignored.
    await vm.handleUserJoin("guild-1", "voice-chan-1", "user-b", false);
    await vm.handleUserJoin("guild-1", "some-other-channel", "user-c", false);
    expect(mockJoinVoiceChannel).toHaveBeenCalledTimes(1);

    await vm.handleChannelEmpty("guild-1", "some-other-channel"); // not our channel
    expect(vm.status()).toHaveLength(1);
    await vm.handleChannelEmpty("guild-1", "voice-chan-1");
    expect(vm.status()).toHaveLength(0);
    expect(infoMessages(log)).toContain("voice auto-leave — no humans left in the channel");

    const bots = makeManager();
    await bots.vm.handleUserJoin("guild-1", "voice-chan-1", "music-bot", true);
    expect(mockJoinVoiceChannel).toHaveBeenCalledTimes(1); // unchanged

    const manual = makeManager({ autoJoinOnUser: false });
    await manual.vm.handleUserJoin("guild-1", "voice-chan-1", "user-a", false);
    expect(mockJoinVoiceChannel).toHaveBeenCalledTimes(1); // unchanged
  });

  it("schema accepts joinGreeting + autoJoinOnUser and bounds the greeting length", () => {
    const base = { deepgramKey: "dg", elevenLabsKey: "el", voiceId: "v" };
    expect(
      voiceConfigSchema.safeParse({ ...base, joinGreeting: "Hey Sam, I'm here.", autoJoinOnUser: false }).success,
    ).toBe(true);
    expect(voiceConfigSchema.safeParse({ ...base, joinGreeting: "" }).success).toBe(true);
    expect(voiceConfigSchema.safeParse({ ...base, joinGreeting: "x".repeat(201) }).success).toBe(false);
  });
});
