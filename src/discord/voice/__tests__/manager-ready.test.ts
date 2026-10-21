/**
 * Phase 135 Plan 02 Task 1 — VoiceManager lifecycle + auto-join unit tests.
 *
 * Coverage:
 *   - `autoJoin()` walks `resolvedAgents`, calls `join()` for each agent with a
 *     `voice.channelId` set, and records fatal failures so retries do not
 *     storm. (RESEARCH § Pattern 1)
 *   - `join()` opens a real `joinVoiceChannel(...)`, awaits Ready, subscribes
 *     an AudioPlayer, and stores the resulting `VoiceSession` in the per-guild
 *     map.
 *   - `leave()` destroys the connection and removes the session.
 *   - `status()` returns one entry per live session with the agent name,
 *     ids, and a derived `durationMs`.
 *   - Fatal-failure dedup: `autoJoin()` invoked twice with the same
 *     permission-denied error → only ONE join attempt fires.
 *
 * The Discord client and `@discordjs/voice` join primitive are mocked so the
 * test does not touch the network.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mock @discordjs/voice ──────────────────────────────────────────────────

const mockConnectionDestroy = vi.fn();
const mockPlayerStop = vi.fn();
const mockConnectionSubscribe = vi.fn();

// `joinVoiceChannel` returns a connection that transitions to Ready
// synchronously (entersState resolves immediately).
const makeStubConnection = () => ({
  destroy: mockConnectionDestroy,
  subscribe: mockConnectionSubscribe,
  receiver: {
    speaking: {
      on: vi.fn(),
      off: vi.fn(),
    },
    subscribe: vi.fn(),
  },
  state: { status: "ready" },
  on: vi.fn(),
  off: vi.fn(),
});

const mockJoinVoiceChannel = vi.fn();
const mockEntersState = vi.fn();
const mockCreateAudioPlayer = vi.fn(() => ({
  stop: mockPlayerStop,
  on: vi.fn(),
  once: vi.fn(),
  state: { status: "idle" },
}));

vi.mock("@discordjs/voice", () => ({
  joinVoiceChannel: (...args: unknown[]) => mockJoinVoiceChannel(...args),
  entersState: (...args: unknown[]) => mockEntersState(...args),
  createAudioPlayer: () => mockCreateAudioPlayer(),
  VoiceConnectionStatus: {
    Ready: "ready",
    Destroyed: "destroyed",
    Disconnected: "disconnected",
  },
  EndBehaviorType: { Manual: 0 },
  StreamType: { Arbitrary: "arbitrary", Raw: "raw" },
}));

// Mock the Deepgram STT module so manager.join() doesn't try to connect.
vi.mock("../stt.js", () => ({
  openDeepgramConnection: vi.fn(async () => ({
    close: vi.fn(),
    sendMedia: vi.fn(),
    on: vi.fn(),
  })),
}));

import { VoiceManager } from "../manager.js";
import type { AgentWithVoice } from "../config.js";

function makeFakeLog() {
  const log = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    // recurse on .child so the manager's `log.child(...)` returns the same
    // fake (good enough for assertion on call counts).
    child: () => log,
  };
  return log;
}

function makeFakeClient(guildId = "guild-1") {
  return {
    channels: {
      fetch: vi.fn(async (id: string) => {
        // Return a stub voice channel.
        return {
          id,
          type: 2, // GuildVoice
          guild: { id: guildId, voiceAdapterCreator: () => ({}) },
          guildId,
          isVoiceBased: () => true,
        };
      }),
    },
    user: { id: "bot-user-id" },
  };
}

describe("VoiceManager.join — Phase 135 Plan 02 Task 1", () => {
  beforeEach(() => {
    mockJoinVoiceChannel.mockReset();
    mockEntersState.mockReset();
    mockConnectionDestroy.mockReset();
    mockConnectionSubscribe.mockReset();
    mockPlayerStop.mockReset();
    mockCreateAudioPlayer.mockClear();
  });

  it("opens a voice connection, waits for Ready, subscribes a player, and stores the session", async () => {
    const conn = makeStubConnection();
    mockJoinVoiceChannel.mockReturnValue(conn);
    mockEntersState.mockResolvedValue(conn);

    const log = makeFakeLog();
    const client = makeFakeClient("guild-1");
    const agents: readonly AgentWithVoice[] = [
      {
        name: "test-agent",
        voice: {
          channelId: "voice-chan-1",
          deepgramKey: "dg-key",
          elevenLabsKey: "el-key",
          voiceId: "voice-id",
        },
      },
    ];
    const vm = new VoiceManager(client as any, log as any, agents);

    const session = await vm.join("test-agent", "voice-chan-1");

    expect(mockJoinVoiceChannel).toHaveBeenCalledTimes(1);
    expect(mockEntersState).toHaveBeenCalled();
    expect(mockConnectionSubscribe).toHaveBeenCalledTimes(1);
    expect(session.agentName).toBe("test-agent");
    expect(session.channelId).toBe("voice-chan-1");
    expect(session.connection).toBe(conn);
    expect(session.player).not.toBeNull();
    // session stored in the per-guild map
    expect(vm.status().length).toBe(1);
    expect(vm.status()[0].agent).toBe("test-agent");
    expect(vm.status()[0].guildId).toBe("guild-1");
  });
});

describe("VoiceManager.leave — Phase 135 Plan 02 Task 1", () => {
  beforeEach(() => {
    mockJoinVoiceChannel.mockReset();
    mockEntersState.mockReset();
    mockConnectionDestroy.mockReset();
    mockConnectionSubscribe.mockReset();
  });

  it("destroys the connection and removes the session", async () => {
    const conn = makeStubConnection();
    mockJoinVoiceChannel.mockReturnValue(conn);
    mockEntersState.mockResolvedValue(conn);

    const log = makeFakeLog();
    const client = makeFakeClient("guild-1");
    const agents: readonly AgentWithVoice[] = [
      {
        name: "test-agent",
        voice: {
          channelId: "voice-chan-1",
          deepgramKey: "dg",
          elevenLabsKey: "el",
          voiceId: "v",
        },
      },
    ];
    const vm = new VoiceManager(client as any, log as any, agents);
    await vm.join("test-agent", "voice-chan-1");
    expect(vm.status().length).toBe(1);

    await vm.leave("guild-1");
    expect(mockConnectionDestroy).toHaveBeenCalledTimes(1);
    expect(vm.status().length).toBe(0);
  });

  it("does nothing for a guildId with no active session (no throw)", async () => {
    const log = makeFakeLog();
    const client = makeFakeClient("guild-unknown");
    const vm = new VoiceManager(client as any, log as any, []);
    await expect(vm.leave("guild-unknown")).resolves.toBeUndefined();
    expect(mockConnectionDestroy).not.toHaveBeenCalled();
  });
});

describe("VoiceManager.autoJoin — Phase 135 Plan 02 Task 1", () => {
  beforeEach(() => {
    mockJoinVoiceChannel.mockReset();
    mockEntersState.mockReset();
    mockConnectionDestroy.mockReset();
    mockConnectionSubscribe.mockReset();
  });

  it("iterates resolvedAgents and joins every agent with voice.channelId set", async () => {
    const conn = makeStubConnection();
    mockJoinVoiceChannel.mockReturnValue(conn);
    mockEntersState.mockResolvedValue(conn);

    const log = makeFakeLog();
    const client = makeFakeClient("guild-1");
    const agents: readonly AgentWithVoice[] = [
      { name: "agent-a", voice: { channelId: "chan-a", deepgramKey: "x", elevenLabsKey: "y", voiceId: "z", autoJoin: true } },
      { name: "agent-b" }, // no voice → skipped
      { name: "agent-c", voice: { channelId: "chan-c", deepgramKey: "x", elevenLabsKey: "y", voiceId: "z", autoJoin: true } },
    ];
    const vm = new VoiceManager(client as any, log as any, agents);

    await vm.autoJoin();
    expect(mockJoinVoiceChannel).toHaveBeenCalledTimes(2);
  });

  it("skips agents with voice.autoJoin !== true (135.0.1 opt-in gate)", async () => {
    const conn = makeStubConnection();
    mockJoinVoiceChannel.mockReturnValue(conn);
    mockEntersState.mockResolvedValue(conn);

    const log = makeFakeLog();
    const client = makeFakeClient("guild-1");
    const agents: readonly AgentWithVoice[] = [
      { name: "no-autojoin", voice: { channelId: "chan-x", deepgramKey: "x", elevenLabsKey: "y", voiceId: "z" } },
      { name: "explicit-false", voice: { channelId: "chan-x", deepgramKey: "x", elevenLabsKey: "y", voiceId: "z", autoJoin: false } },
      { name: "explicit-true", voice: { channelId: "chan-x", deepgramKey: "x", elevenLabsKey: "y", voiceId: "z", autoJoin: true } },
    ];
    const vm = new VoiceManager(client as any, log as any, agents);

    await vm.autoJoin();
    expect(mockJoinVoiceChannel).toHaveBeenCalledTimes(1);
  });

  it("records fatal-failure agents in fatalAutoJoinFailures and does NOT retry on second autoJoin()", async () => {
    // First attempt: throw a fatal error (missing-permission shape).
    const err = Object.assign(new Error("Missing Permissions"), { code: 50013 });
    mockJoinVoiceChannel.mockImplementation(() => {
      throw err;
    });

    const log = makeFakeLog();
    const client = makeFakeClient("guild-1");
    const agents: readonly AgentWithVoice[] = [
      { name: "agent-a", voice: { channelId: "chan-a", deepgramKey: "x", elevenLabsKey: "y", voiceId: "z", autoJoin: true } },
    ];
    const vm = new VoiceManager(client as any, log as any, agents);

    await vm.autoJoin();
    expect(mockJoinVoiceChannel).toHaveBeenCalledTimes(1);

    // Second autoJoin: must not retry the same fatal failure.
    await vm.autoJoin();
    expect(mockJoinVoiceChannel).toHaveBeenCalledTimes(1);
  });

  it("does not throw if join() rejects with a transient error (logs and moves on)", async () => {
    mockJoinVoiceChannel.mockImplementation(() => {
      throw new Error("transient network blip");
    });

    const log = makeFakeLog();
    const client = makeFakeClient("guild-1");
    const agents: readonly AgentWithVoice[] = [
      { name: "agent-a", voice: { channelId: "chan-a", deepgramKey: "x", elevenLabsKey: "y", voiceId: "z", autoJoin: true } },
    ];
    const vm = new VoiceManager(client as any, log as any, agents);

    await expect(vm.autoJoin()).resolves.toBeUndefined();
  });
});

describe("VoiceManager.status — Phase 135 Plan 02 Task 1", () => {
  beforeEach(() => {
    mockJoinVoiceChannel.mockReset();
    mockEntersState.mockReset();
  });

  it("returns one entry per live session with a derived durationMs", async () => {
    const conn = makeStubConnection();
    mockJoinVoiceChannel.mockReturnValue(conn);
    mockEntersState.mockResolvedValue(conn);

    const log = makeFakeLog();
    const client = makeFakeClient("guild-99");
    const agents: readonly AgentWithVoice[] = [
      { name: "agent-a", voice: { channelId: "chan-a", deepgramKey: "x", elevenLabsKey: "y", voiceId: "z", autoJoin: true } },
    ];
    const vm = new VoiceManager(client as any, log as any, agents);

    await vm.join("agent-a", "chan-a");
    const status = vm.status();
    expect(status.length).toBe(1);
    expect(status[0].agent).toBe("agent-a");
    expect(status[0].channelId).toBe("chan-a");
    expect(status[0].guildId).toBe("guild-99");
    expect(status[0].durationMs).toBeGreaterThanOrEqual(0);
  });

  it("empty when no sessions are active", () => {
    const log = makeFakeLog();
    const client = makeFakeClient("guild-1");
    const vm = new VoiceManager(client as any, log as any, []);
    expect(vm.status()).toEqual([]);
  });
});
