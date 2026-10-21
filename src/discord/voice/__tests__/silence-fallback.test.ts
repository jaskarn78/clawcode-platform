/**
 * Phase 135 Plan 03 Task 2 (+ 999.116 progress-cue conversion) —
 * silence-fallback timer + progress-cue tests.
 *
 * Pins:
 *   - DEFAULT_SILENCE_FALLBACK_MS = 30_000.
 *   - armSilenceTimer schedules a setTimeout at the configured ms; the
 *     default window fires the cue after 30s when no agent response arrives.
 *   - cancelSilenceTimer (called when the agent starts responding) prevents
 *     the cue.
 *   - Per-agent voice.silenceFallbackMs overrides the default.
 *   - fireProgressCue speaks a short filler via speakResponse and — the
 *     999.116 race fix — NEVER sets session.fallbackSpoken, so the agent's
 *     real answer is not suppressed.
 *   - fireProgressCue skips entirely if the agent is already speaking.
 *
 * Uses vi.useFakeTimers() so the 30s window doesn't actually delay the suite.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mockSpeakResponse = vi.fn(async (..._args: unknown[]) => ({
  interrupted: false,
  playedMs: 0,
}));
vi.mock("../tts.js", () => ({
  speakResponse: (...args: unknown[]) => mockSpeakResponse(...args),
}));

import {
  armSilenceTimer,
  cancelSilenceTimer,
  fireProgressCue,
  DEFAULT_SILENCE_FALLBACK_MS,
  PROGRESS_CUES,
} from "../silence-fallback.js";
import type { VoiceSession } from "../session.js";
import { createVoiceTurnTrace } from "../turn-trace.js";

function makeFakeSession(
  overrides?: Partial<VoiceSession["voiceCfg"]>,
  sessionOverrides?: Partial<VoiceSession>,
): VoiceSession {
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
      ...overrides,
    },
    ...sessionOverrides,
  } as VoiceSession;
}

const makeLog = () => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
});

describe("silence-fallback timer — Phase 135 Plan 03 Task 2", () => {
  beforeEach(() => {
    mockSpeakResponse.mockClear();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("DEFAULT_SILENCE_FALLBACK_MS is exactly 30_000", () => {
    expect(DEFAULT_SILENCE_FALLBACK_MS).toBe(30_000);
  });

  it("armSilenceTimer schedules at the default 30s when voiceCfg.silenceFallbackMs is unset", () => {
    const session = makeFakeSession();
    const callback = vi.fn();
    armSilenceTimer(session, callback);
    expect(session.silenceTimer).not.toBeNull();
    vi.advanceTimersByTime(29_999);
    expect(callback).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it("armSilenceTimer honors voiceCfg.silenceFallbackMs override (10s)", () => {
    const session = makeFakeSession({ silenceFallbackMs: 10_000 });
    const callback = vi.fn();
    armSilenceTimer(session, callback);
    vi.advanceTimersByTime(9_999);
    expect(callback).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it("cancelSilenceTimer prevents the callback from firing", () => {
    const session = makeFakeSession();
    const callback = vi.fn();
    armSilenceTimer(session, callback);
    expect(session.silenceTimer).not.toBeNull();
    cancelSilenceTimer(session);
    expect(session.silenceTimer).toBeNull();
    vi.advanceTimersByTime(60_000);
    expect(callback).not.toHaveBeenCalled();
  });

  it("armSilenceTimer replaces any existing timer (no stacking)", () => {
    const session = makeFakeSession();
    const first = vi.fn();
    const second = vi.fn();
    armSilenceTimer(session, first);
    armSilenceTimer(session, second);
    vi.advanceTimersByTime(30_000);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });
});

describe("fireProgressCue — 999.116 progress-cue conversion", () => {
  beforeEach(() => {
    mockSpeakResponse.mockClear();
  });

  it("speaks a non-empty cue from PROGRESS_CUES via speakResponse", async () => {
    const session = makeFakeSession();
    await fireProgressCue(session, makeLog() as any);

    expect(mockSpeakResponse).toHaveBeenCalledTimes(1);
    const [passedSession, spokenText] = mockSpeakResponse.mock.calls[0] ?? [];
    expect(passedSession).toBe(session);
    expect(typeof spokenText).toBe("string");
    expect((spokenText as string).length).toBeGreaterThan(0);
    expect(PROGRESS_CUES).toContain(spokenText);
  });

  it("NEVER sets session.fallbackSpoken (the race fix — agent reply not suppressed)", async () => {
    const session = makeFakeSession();
    expect(session.fallbackSpoken).toBe(false);
    await fireProgressCue(session, makeLog() as any);
    // The whole point of the conversion: the cue must not claim the speaker,
    // so the bridge's fallbackSpoken suppression branches stay inert and the
    // agent's real answer plays when it lands.
    expect(session.fallbackSpoken).toBe(false);
  });

  it("rotates through the cue set on successive fires", async () => {
    const first = makeFakeSession();
    const second = makeFakeSession();
    await fireProgressCue(first, makeLog() as any);
    await fireProgressCue(second, makeLog() as any);
    const a = mockSpeakResponse.mock.calls[0]?.[1];
    const b = mockSpeakResponse.mock.calls[1]?.[1];
    // Consecutive cues differ (rotation), assuming >1 phrase in the set.
    if (PROGRESS_CUES.length > 1) expect(a).not.toBe(b);
  });

  it("skips the cue when the agent is already speaking (no overlap)", async () => {
    const session = makeFakeSession(undefined, { phase: "speaking" });
    await fireProgressCue(session, makeLog() as any);
    expect(mockSpeakResponse).not.toHaveBeenCalled();
  });

  it("skips the cue during a pending barge-in", async () => {
    const session = makeFakeSession(undefined, { phase: "interrupt_pending" });
    await fireProgressCue(session, makeLog() as any);
    expect(mockSpeakResponse).not.toHaveBeenCalled();
  });

  it("swallows a speakResponse failure (logs, does not throw)", async () => {
    mockSpeakResponse.mockRejectedValueOnce(new Error("tts boom"));
    const session = makeFakeSession();
    const log = makeLog();
    await expect(
      fireProgressCue(session, log as any),
    ).resolves.toBeUndefined();
    expect(log.error).toHaveBeenCalled();
    expect(session.fallbackSpoken).toBe(false);
  });

  it("999.116 A3 (G7): marks the live turn's trace when it speaks, but never traces its own audio as the answer", async () => {
    const trace = createVoiceTurnTrace();
    const session = makeFakeSession(undefined, {
      currentTurn: {
        id: "turn-1",
        generation: 1,
        abort: new AbortController(),
        ttsStream: null,
        startedAt: Date.now(),
        trace,
      },
    });
    await fireProgressCue(session, makeLog() as any);
    expect(trace.cueFired).toBe(true);
    expect(trace.stamps.has("cue")).toBe(true);
    // speakResponse(session, cue) — no signal, no trace: the cue's first
    // frame must not be mistaken for the answer's.
    expect(mockSpeakResponse).toHaveBeenCalledTimes(1);
    expect(mockSpeakResponse.mock.calls[0]?.[3]).toBeUndefined();
  });

  it("999.116 A3 (G7): leaves the trace untouched when the cue is skipped", async () => {
    const trace = createVoiceTurnTrace();
    const session = makeFakeSession(undefined, {
      phase: "speaking",
      currentTurn: {
        id: "turn-1",
        generation: 1,
        abort: new AbortController(),
        ttsStream: null,
        startedAt: Date.now(),
        trace,
      },
    });
    await fireProgressCue(session, makeLog() as any);
    expect(trace.cueFired).toBe(false);
    expect(trace.stamps.has("cue")).toBe(false);
  });
});
