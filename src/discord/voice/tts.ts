/**
 * Phase 135 Plan 02 Task 3 — ElevenLabs streaming TTS.
 *
 * `speakResponse(session, text)` streams a text-to-speech audio
 * response into the session's `AudioPlayer` so the bot speaks the
 * agent's reply in the voice channel.
 *
 * Output format: `mp3_44100_128` (RESEARCH Pitfall 3 — free-tier
 * portable). PCM 24kHz requires a Creator-tier ElevenLabs
 * subscription; Plan 02 hard-codes mp3 to keep the MVP usable on any
 * tier. A future plan can expose `voice.outputFormat` as an override
 * once the tier-detection story is sorted.
 *
 * Model: `eleven_flash_v2_5` (Phase 135.1 — ~75ms model latency, roughly
 * half the per-character cost of the pinned `eleven_turbo_v2_5`; the
 * lowest-latency ElevenLabs model, chosen for the voice-chat latency
 * budget). Quality is marginally below turbo but well within voice-chat
 * tolerances; flip back via `ELEVENLABS_MODEL_ID` if quality regresses.
 *
 * Discord audio player input: `StreamType.Arbitrary` for mp3 (the
 * `Raw` StreamType is for already-Opus or already-PCM streams that
 * skip the FFmpeg demux step). Per @discordjs/voice docs.
 *
 * The function resolves AFTER playback completes (waits for the
 * AudioPlayer's `idle` event). This serialises the agent's reply with
 * any subsequent voice turn so we don't talk over ourselves on rapid
 * back-to-back transcripts.
 */
import { Readable } from "node:stream";
import { ElevenLabsClient } from "@elevenlabs/elevenlabs-js";
import {
  createAudioResource,
  StreamType,
  AudioPlayerStatus,
} from "@discordjs/voice";
import type { VoiceSession } from "./session.js";
import {
  attachPlayerTrace,
  stampVoiceTurn,
  type VoiceTurnTrace,
} from "./turn-trace.js";

export const ELEVENLABS_MODEL_ID = "eleven_flash_v2_5";
export const ELEVENLABS_OUTPUT_FORMAT = "mp3_44100_128" as const;

/**
 * Convert a Web ReadableStream<Uint8Array> into a Node `Readable`.
 *
 * ElevenLabs' streaming endpoint returns a Web stream; @discordjs/voice
 * expects a Node Readable. Node 18+ has `Readable.fromWeb` for exactly
 * this — but we wrap defensively so the code path stays clear of
 * Node-version pitfalls (we're on Node 22 LTS per CLAUDE.md tech
 * stack).
 */
function webStreamToNodeReadable(
  webStream: ReadableStream<Uint8Array>,
): Readable {
  // Node 18+ supports Readable.fromWeb. We use a type-cast because
  // @types/node's `fromWeb` overload doesn't always agree with the
  // global ReadableStream type across the build target.
  return Readable.fromWeb(webStream as unknown as Parameters<typeof Readable.fromWeb>[0]);
}

/**
 * Stream a TTS response into the session's audio player.
 *
 * @param session   The active VoiceSession (must have `connection` +
 *                   `player` populated by VoiceManager.join).
 * @param text      The agent's response text. Should be voice-friendly
 *                   (Plan 02's prompt suffix nudges the agent toward
 *                   this shape; we don't do any post-processing here).
 *
 * @param trace     999.116 A3 (G7) — the turn trace to stamp with
 *                   ttsRequest / ttsFirstByte / firstFrame / playbackEnd.
 *                   Passed only for the agent's ANSWER; the progress cue
 *                   speaks without one so its audio never counts as the
 *                   answer's first frame.
 *
 * Throws if the session has no player or the ElevenLabs request fails.
 * Callers (`streamAndPostResponse` on the voice path) wrap in try/catch.
 */
export async function speakResponse(
  session: VoiceSession,
  text: string,
  signal?: AbortSignal,
  trace?: VoiceTurnTrace,
): Promise<{ interrupted: boolean; playedMs: number }> {
  if (!session.player) {
    throw new Error(
      `voice session ${session.id} has no audio player — cannot speak response`,
    );
  }
  if (!session.voiceCfg.elevenLabsKey || !session.voiceCfg.voiceId) {
    throw new Error(
      `voice session ${session.id} has no ElevenLabs credentials configured`,
    );
  }

  const client = new ElevenLabsClient({
    apiKey: session.voiceCfg.elevenLabsKey,
  });

  // 135.0.4 diagnostic — surface ElevenLabs request + audio-player events
  // so silent TTS failures stop being invisible.
  const log = (msg: string, extra: Record<string, unknown> = {}) => {
    // eslint-disable-next-line no-console
    console.log(JSON.stringify({ component: "voice-tts", sessionId: session.id, msg, ...extra }));
  };

  log("ElevenLabs request: starting stream", {
    voiceId: session.voiceCfg.voiceId,
    textLength: text.length,
    model: ELEVENLABS_MODEL_ID,
    format: ELEVENLABS_OUTPUT_FORMAT,
  });

  // The SDK returns an HttpResponsePromise — awaiting it resolves to
  // the inner ReadableStream<Uint8Array>.
  if (trace) stampVoiceTurn(trace, "ttsRequest");
  let audioWebStream: ReadableStream<Uint8Array>;
  try {
    audioWebStream = await client.textToSpeech.stream(
      session.voiceCfg.voiceId,
      {
        text,
        modelId: ELEVENLABS_MODEL_ID,
        outputFormat: ELEVENLABS_OUTPUT_FORMAT,
      },
    );
  } catch (err) {
    log("ElevenLabs request FAILED", {
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
  log("ElevenLabs request: stream received");
  if (trace) stampVoiceTurn(trace, "ttsFirstByte");

  const nodeStream = webStreamToNodeReadable(audioWebStream);
  const resource = createAudioResource(nodeStream, {
    inputType: StreamType.Arbitrary, // mp3 — requires FFmpeg demux
  });
  // 999.116 A3 (G7) — observe THIS resource's Playing/Idle transitions.
  // Registered before play() so the first frame can't be missed.
  const detachTrace = trace
    ? attachPlayerTrace(session.player, resource, trace)
    : () => undefined;

  // Wire player state diagnostics for this play() call. Pino-redaction
  // doesn't cover audio events, so use console JSON for visibility.
  const player = session.player;
  const onStateChange = (oldState: { status: string }, newState: { status: string }) => {
    log("player state change", { from: oldState.status, to: newState.status });
  };
  const onPlayerError = (err: Error) => {
    log("player error", { error: err.message });
  };
  player.on("stateChange", onStateChange);
  player.on("error", onPlayerError);

  // Phase 135.1 — interruptible playback (barge-in / leave). When the turn's
  // AbortController fires, destroy the node stream (stops the ffmpeg demux and
  // frees the ElevenLabs HTTP body) and player.stop(true), which forces the
  // Idle transition that resolves waitForPlayerIdle below — so the awaiting
  // caller unblocks within one frame. Park the stream on the current turn so
  // abortVoiceTurn can reach it in the same tick.
  let interrupted = false;
  const onAbort = () => {
    interrupted = true;
    log("playback aborted (barge-in / leave)");
    try { nodeStream.destroy(); } catch { /* non-fatal */ }
    try { player.stop(true); } catch { /* non-fatal */ }
  };
  if (signal) {
    if (signal.aborted) {
      // Cancelled before we could play a frame — bail without audio.
      try { nodeStream.destroy(); } catch { /* non-fatal */ }
      try { player.off("stateChange", onStateChange); } catch { /* non-fatal */ }
      try { player.off("error", onPlayerError); } catch { /* non-fatal */ }
      return { interrupted: true, playedMs: 0 };
    }
    signal.addEventListener("abort", onAbort, { once: true });
    if (session.currentTurn) session.currentTurn.ttsStream = nodeStream;
  }

  // Hand off to the player; wait for playback to finish (or a barge-in stop)
  // before returning so the caller doesn't overlap the next turn's TTS.
  player.play(resource);
  // Defensive read — test fakes don't always populate `state`.
  const playerStatus = (player as { state?: { status?: string } }).state?.status;
  log("player.play() called", { playerStatus });
  try {
    await waitForPlayerIdle(session);
    log(interrupted ? "player Idle after barge-in stop" : "player went Idle (playback complete)");
  } finally {
    detachTrace();
    if (signal) {
      try { signal.removeEventListener("abort", onAbort); } catch { /* non-fatal */ }
    }
    if (session.currentTurn?.ttsStream === nodeStream) {
      session.currentTurn.ttsStream = null;
    }
    try { player.off("stateChange", onStateChange); } catch { /* non-fatal */ }
    try { player.off("error", onPlayerError); } catch { /* non-fatal */ }
  }

  // Phase 135 Plan 03 / 135.1 — accumulate synthesis seconds against the
  // monthly cap. A fully-played turn charges the text estimate (chars/15 ≈
  // English speaking pace — this is OUTPUT duration, which is what
  // monthlyMinutesCap is denominated in; ElevenLabs bills by characters, so
  // dense text may under-count ~20-30% — accepted soft-cap drift). An
  // INTERRUPTED turn charges only what actually played (resource.playbackDuration)
  // so barge-in never over-counts the unspoken remainder.
  const playedMs =
    (resource as { playbackDuration?: number }).playbackDuration ?? 0;
  if (session.minutesTracker) {
    const seconds = interrupted ? playedMs / 1000 : text.length / 15;
    if (seconds > 0) session.minutesTracker.addSynthesisSeconds(seconds);
  }
  return { interrupted, playedMs };
}

/**
 * Resolve when the session's AudioPlayer enters the `Idle` state
 * (playback finished). If the player throws an error or the session
 * is torn down mid-playback, the promise rejects.
 *
 * Implementation: register `idle` + `error` event listeners ONCE
 * (`once`) so they auto-clean up. A 60-second hard timeout prevents
 * the promise from hanging forever on a malformed stream.
 */
export function waitForPlayerIdle(session: VoiceSession): Promise<void> {
  const player = session.player;
  if (!player) return Promise.resolve();

  // Phase 135.1 Phase 4 — already-Idle fast path. On the streaming path the
  // player can already be Idle when this is called (the audio stream ended, or
  // maxMissedFrames underflow forced Idle) — without this check, `once(Idle)`
  // would never fire and the caller would stall on the 60s timeout, holding
  // turnLock and delaying the next (e.g. barge-in) turn.
  const status = (player as { state?: { status?: string } }).state?.status;
  if (status === AudioPlayerStatus.Idle) return Promise.resolve();

  return new Promise<void>((resolve, reject) => {
    const onIdle = () => {
      cleanup();
      resolve();
    };
    const onError = (err: Error) => {
      cleanup();
      reject(err);
    };
    const cleanup = () => {
      try {
        player.off(AudioPlayerStatus.Idle, onIdle);
      } catch {
        /* non-fatal */
      }
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (player as any).off?.("error", onError);
      } catch {
        /* non-fatal */
      }
      clearTimeout(timer);
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("TTS playback timeout (60s) — audio stream stalled"));
    }, 60_000);

    player.once(AudioPlayerStatus.Idle, onIdle);
    player.once("error", onError);
    // Close the flush→registration gap: if Idle fired between the fast-path
    // check and here, resolve now rather than waiting for the timeout.
    const now = (player as { state?: { status?: string } }).state?.status;
    if (now === AudioPlayerStatus.Idle) onIdle();
  });
}
