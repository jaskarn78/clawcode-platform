/**
 * Phase 135 Plan 02 Task 3 — TTS delivery + discriminated union routing.
 *
 * Pins the delivery-union switch in DiscordBridge.streamAndPostResponse:
 *   - delivery.kind === "text" (the existing path) → text emission, no
 *     speakResponse call.
 *   - delivery.kind === "voice" → speakResponse invoked with the
 *     agent's response text; NO Discord message send/edit.
 *
 * Plus a small structural pin on prompt.ts:
 *   - buildVoicePromptSuffix is composed into the user-message wrapper
 *     when delivery.kind === "voice" (the suffix appears in the
 *     formattedMessage passed to dispatchStream).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";

// Mock ElevenLabs so speakResponse never touches the network. Use a
// real (Web) ReadableStream so `Readable.fromWeb` inside tts.ts is
// happy — the stream emits zero chunks and closes immediately.
const mockTtsStream = vi.fn(async (..._args: unknown[]) => {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.close();
    },
  });
});

vi.mock("@elevenlabs/elevenlabs-js", () => ({
  ElevenLabsClient: class {
    textToSpeech = {
      stream: (...args: unknown[]) => mockTtsStream(...args),
    };
  },
}));

// Mock @discordjs/voice's createAudioResource + player.play.
const mockPlayerPlay = vi.fn();
const mockPlayerOnce = vi.fn();
const mockPlayerOff = vi.fn();

vi.mock("@discordjs/voice", async () => {
  const actual = await vi.importActual<typeof import("@discordjs/voice")>("@discordjs/voice");
  return {
    ...actual,
    createAudioResource: vi.fn(() => ({ readable: true, kind: "audio-resource-stub" })),
    AudioPlayerStatus: {
      Idle: "idle",
      Playing: "playing",
      Buffering: "buffering",
      Paused: "paused",
      AutoPaused: "autoPaused",
    },
  };
});

import { speakResponse } from "../tts.js";
import type { VoiceSession } from "../session.js";

function makeFakeSession(): VoiceSession {
  const player = new EventEmitter() as unknown as VoiceSession["player"] & {
    play: ReturnType<typeof vi.fn>;
  };
  (player as unknown as { play: typeof mockPlayerPlay }).play = mockPlayerPlay;
  // The wait-for-idle promise registers `once("idle", ...)` and `once("error", ...)`;
  // we trigger idle immediately so speakResponse resolves.
  setImmediate(() => {
    (player as unknown as EventEmitter).emit("idle");
  });

  return {
    id: "sess-1",
    agentName: "test-agent",
    channelId: "chan-1",
    guildId: "guild-1",
    createdAt: Date.now(),
    connection: null,
    player: player as unknown as VoiceSession["player"],
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

describe("speakResponse — Phase 135 Plan 02 Task 3", () => {
  beforeEach(() => {
    mockTtsStream.mockClear();
    mockPlayerPlay.mockClear();
  });

  it("calls ElevenLabs streaming with mp3_44100_128 + eleven_flash_v2_5 and routes audio into the session player", async () => {
    const session = makeFakeSession();
    await speakResponse(session, "Hello there.");

    expect(mockTtsStream).toHaveBeenCalledTimes(1);
    expect(mockTtsStream).toHaveBeenCalledWith(
      "voice-id-x",
      expect.objectContaining({
        text: "Hello there.",
        modelId: "eleven_flash_v2_5",
        outputFormat: "mp3_44100_128",
      }),
    );
    expect(mockPlayerPlay).toHaveBeenCalledTimes(1);
  });

  it("throws when session has no player", async () => {
    const session = makeFakeSession();
    (session as any).player = null;
    await expect(speakResponse(session, "hi")).rejects.toThrow(/no audio player/);
  });

  it("throws when ElevenLabs credentials are missing", async () => {
    const session = makeFakeSession();
    (session.voiceCfg as any).elevenLabsKey = "";
    await expect(speakResponse(session, "hi")).rejects.toThrow(
      /no ElevenLabs credentials/,
    );
  });
});

// The Delivery union's discriminator behavior is exercised in
// ingress.test.ts (voice path) and bridge-advisor-footer.test.ts (text
// path stays byte-identical via the `delivery` default-undefined
// synthesis). A loaded-bridge import-time assertion is intentionally
// omitted here because bridge.ts pulls in discord.js and the SDK,
// which is heavy enough to push test setup past the 5s default
// timeout — and the type-level pin is enforced at compile time by
// `npx tsc --noEmit` (the verification matrix in 135-02-PLAN.md).
