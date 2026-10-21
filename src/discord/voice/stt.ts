/**
 * Phase 135 Plan 02 Task 2 — Deepgram streaming STT.
 *
 * Opens a single Deepgram WebSocket per VoiceSession (RESEARCH Pitfall 4:
 * the WS lives for the lifetime of the session, NOT per utterance).
 * Audio frames decoded from Discord's Opus receiver are sent via
 * `sendMedia`; transcripts arrive via the `message` event and are
 * dispatched through the caller-supplied callbacks.
 *
 * **Decision: streaming WebSocket, NOT REST batch.** BACKLOG.md said
 * "REST API" but per RESEARCH § Open Q3 and the 4-second end-to-end
 * latency budget, REST batching of 1-2s chunks would consume the entire
 * budget on STT alone. Streaming WS is the only viable surface for the
 * latency target.
 *
 * Config (RESEARCH § Code Examples > Deepgram Streaming):
 *   model: "nova-3"
 *   language: "en-US"
 *   smart_format: true
 *   encoding: "linear16"
 *   sample_rate: 48000
 *   channels: 2
 *   interim_results: true   — used only for VAD timing; not dispatched.
 *   utterance_end_ms: 1500  — Phase 135.4 raised from 1000; operator-tunable
 *   endpointing: 500        — Phase 135.4 added; voice-activity-aware silence
 *   vad_events: true
 *
 * Dedup semantics live in `manager.ts` `attachSpeakingListeners` — this
 * file is dumb pipework: forward audio in, forward transcripts out.
 */
import { DeepgramClient } from "@deepgram/sdk";
import type { DeepgramLiveConnection } from "./session.js";

/**
 * Phase 135.4 — VAD-tuning defaults applied at the stt.ts call site when
 * the operator hasn't set the corresponding voice.* field. Exposing them
 * as `export const` lets tests assert the defaults and lets the schema
 * commentary in schema.ts stay in sync.
 *
 * Plan 02 hardcoded utterance_end_ms=1000; operator UAT (2026-05-19)
 * reported the agent cutting off mid-sentence on natural pauses. Plan 04
 * raises the default to 1500 (operator-tunable up to 5000) and adds an
 * explicit endpointing signal — combined, premature finalisation
 * on breaths/pauses drops sharply.
 *
 * Phase 135 REBUILD (2026-06-02): endpointing default raised 500 → 1000.
 * `endpointing` is what makes Deepgram set `speech_final`; at 500ms it fired
 * on ordinary mid-sentence pauses, and (before the rebuild's turn-aggregation)
 * each `speech_final` dispatched a separate agent turn — the "one sentence,
 * multiple back-to-back replies" symptom. 1000ms means `speech_final` only
 * fires at genuine turn-ends; aggregation + UtteranceEnd handle the rest.
 *
 * minConfidence + minWordCount filter background noise + 1-word
 * backchannel ("yeah", "okay") that Deepgram still flags as `is_final`
 * but isn't a real agent turn.
 */
export const DEFAULT_UTTERANCE_END_MS = 1500;
export const DEFAULT_ENDPOINTING_MS = 1000;
export const DEFAULT_MIN_CONFIDENCE = 0.6;
export const DEFAULT_MIN_WORD_COUNT = 2;

/**
 * Phase 135.4 — narrow input slice for `openDeepgramConnection`. Carved
 * out of `VoiceConfig` so the connection function doesn't depend on the
 * wider schema (and tests can construct a literal without touching
 * deepgramKey / elevenLabsKey / voiceId).
 */
export type VadConfig = {
  readonly utteranceEndMs?: number;
  readonly endpointingMs?: number;
  readonly minConfidence?: number;
  readonly minWordCount?: number;
  /**
   * Phase 135 REBUILD — nova-3 keyterm prompting. Custom terms (proper nouns,
   * the agent's name) boosted for recognition — fixes "Clawdy" → "Claudia".
   * nova-3 uses `keyterm` (model-driven, contextual); the legacy `keywords`
   * param is NOT supported on nova-3. Empty/undefined = no keyterm param.
   */
  readonly keyterms?: readonly string[];
};

export type DeepgramTranscriptCallbacks = {
  /**
   * Phase 135 REBUILD: fired ONCE per COMPLETE user turn. The stt.ts
   * aggregator buffers `is_final` segments and invokes this on `speech_final`
   * OR `UtteranceEnd` (NOT per `is_final` — that fragmented one sentence into
   * multiple agent turns). `audioDurationSeconds` is the SUM across the
   * turn's segments. Plan 02 limitation:
   * Deepgram V1 streaming does NOT carry per-user attribution (the WS
   * is shared across all speakers in the channel). stt.ts therefore
   * emits ONLY the transcript text — the manager resolves the speaker
   * userId + generation from its own per-session "last-speaker" state
   * (single-speaker assumption per CONTEXT.md decision; multi-speaker
   * context tracking is deferred to v3.0.1).
   *
   * If a future plan switches to per-speaker WS connections (one
   * Deepgram WS per Discord user), this callback's contract becomes
   * "transcript for the WS this callback was registered against",
   * which is still just `transcript` — the wrapper at registration
   * time supplies the userId via closure.
   *
   * Phase 135 Plan 03 — `audioDurationSeconds` is the Deepgram-reported
   * `duration` field on the Results message (transcribed audio length
   * in seconds, ms-precision). Manager accumulates this against the
   * per-session MinutesTracker for the monthly cap.
   */
  readonly onFinalTranscript: (
    transcript: string,
    audioDurationSeconds: number,
  ) => void;
  /**
   * Called on `is_final === false` (interim) transcripts. Plan 02
   * does not dispatch these — provided as a hook so the manager can
   * surface them in future plans (e.g., live captions UI).
   */
  readonly onInterimTranscript: (transcript: string) => void;
  /** Network or protocol error on the WS. */
  readonly onError: (err: Error) => void;
  /** Optional close handler. */
  readonly onClose?: () => void;
  /**
   * Phase 135.4 — fired when a final transcript is dropped because its
   * Deepgram-reported confidence fell below `vad.minConfidence`
   * (default 0.6). Optional — the manager wires this to a debug log so
   * the reject is observable without polluting stt.ts with a logger
   * dependency (Plan 02 invariant: stt.ts stays logger-free).
   */
  readonly onLowConfidenceReject?: (transcript: string, confidence: number) => void;
  /**
   * Phase 135.4 — fired when a final transcript is dropped because its
   * word count fell below `vad.minWordCount` (default 2). Same wiring
   * pattern as onLowConfidenceReject. Single-word backchannels ("yeah",
   * "okay") trip this path and never reach the dispatcher.
   */
  readonly onShortUtteranceReject?: (transcript: string, wordCount: number) => void;
  /**
   * Phase 135 REBUILD — observability. Fired when a complete turn is
   * dispatched, with the trigger reason + how many `is_final` segments were
   * aggregated + total chars. Manager wires this to an info log so a single
   * live verify shows exactly one dispatch per spoken turn (and why).
   */
  readonly onTurnFlush?: (
    reason: "speech_final" | "utterance_end" | "finalize",
    segments: number,
    chars: number,
  ) => void;
  /**
   * Phase 135 REBUILD — observability. Fired when the dead-air rescue sends a
   * `Finalize` control message (an `UtteranceEnd` arrived with an empty buffer
   * but speech was heard). Manager logs it so dead-air recovery is visible.
   */
  readonly onDeadAirFinalize?: () => void;
};

/**
 * Open a Deepgram streaming WS connection.
 *
 * The returned `DeepgramLiveConnection` wraps the SDK's V1Socket with a
 * stable shape (`sendMedia`, `close`, `on`). The manager stores it in
 * `session.deepgramConnection` and forwards PCM via `sendMedia(pcm)`
 * from each per-user pcm stream's `data` event.
 *
 * NOTE — Plan 02 limitation: Deepgram's V1 streaming response carries the
 * transcript text but does NOT carry the originating Discord userId
 * (the WS is shared across all speakers in the channel). Per-user
 * routing is therefore approximated by the manager's per-user
 * pcm-stream pipeline + Deepgram's `channels: 2` mode — each speaker
 * is keyed by the userId on the receiving side (`attachSpeakingListeners`
 * routes the transcript callback per-user via the stored generation).
 * A future plan may switch to per-speaker WS connections if
 * cross-speaker mixing becomes a bottleneck.
 *
 * @param deepgramKey  Resolved API key (NOT an `op://` URI — the
 *                     SecretsResolver has already resolved it at boot).
 * @param callbacks    Transcript + error sinks.
 */
export async function openDeepgramConnection(
  deepgramKey: string,
  callbacks: DeepgramTranscriptCallbacks,
  vad?: VadConfig,
): Promise<DeepgramLiveConnection> {
  const client = new DeepgramClient({ apiKey: deepgramKey });

  // Phase 135.4 — operator-tunable VAD knobs. `undefined` falls through
  // to the in-code defaults so the existing fleet picks up the new
  // behavior (1500ms utterance window + explicit 500ms endpointing)
  // without any yaml edits. The schema clamp at config-load time guards
  // against extreme values.
  const utteranceEndMs = vad?.utteranceEndMs ?? DEFAULT_UTTERANCE_END_MS;
  const endpointingMs = vad?.endpointingMs ?? DEFAULT_ENDPOINTING_MS;
  // Phase 135 REBUILD — nova-3 keyterm prompting. The Deepgram SDK serialises
  // an array value as repeated `keyterm=` query params; only include the key
  // when at least one non-empty term is configured.
  const keyterms = vad?.keyterms?.filter((t) => t.trim().length > 0) ?? [];

  const socket = await client.listen.v1.connect({
    model: "nova-3",
    language: "en-US",
    smart_format: "true",
    encoding: "linear16",
    sample_rate: 48000,
    channels: 2,
    interim_results: "true",
    utterance_end_ms: utteranceEndMs,
    endpointing: endpointingMs,
    vad_events: "true",
    ...(keyterms.length > 0 ? { keyterm: keyterms } : {}),
    Authorization: `Token ${deepgramKey}`,
  });

  // Phase 135 REBUILD — resolve filter thresholds once at connect time.
  const minConfidence = vad?.minConfidence ?? DEFAULT_MIN_CONFIDENCE;
  const minWordCount = vad?.minWordCount ?? DEFAULT_MIN_WORD_COUNT;

  // ── Turn-aggregation seam (Phase 135 REBUILD Tier 1) ──────────────────────
  //
  // Deepgram streaming emits MANY `is_final` segments per spoken sentence; the
  // true end-of-turn is `speech_final` (endpointing-driven) OR the word-gap
  // `UtteranceEnd` event. The pre-rebuild code dispatched a turn on every
  // `is_final` → one sentence fragmented into multiple agent turns
  // ("back-to-back replies"). And relying on `speech_final` alone produced
  // DEAD AIR: Deepgram staff confirm it is silently suppressed whenever
  // background noise breaks the endpointing VAD, so on a noisy Discord channel
  // nothing finalised and no turn ever dispatched.
  //
  // Fix: buffer accepted `is_final` segments, never dispatch on them, and emit
  // exactly ONE complete turn via `onFinalTranscript` when EITHER `speech_final`
  // fires OR an `UtteranceEnd` arrives (word-gap based → noise-immune). If
  // `UtteranceEnd` arrives with an empty buffer but we DID hear speech
  // (interims), send a `Finalize` control message to force Deepgram to flush —
  // the rescue for the dead-air case where no final was ever produced; the
  // `from_finalize` reply is treated as a turn boundary.
  //
  // This function is the turn-detection SEAM: a future Deepgram Flux migration
  // (Tier 3) swaps the internals here to consume EndOfTurn events, keeping the
  // `onFinalTranscript(completeTurn, durationSeconds)` contract unchanged.
  let segments: string[] = [];
  let bufferedDurationSeconds = 0;
  let sawSpeechSinceFlush = false;
  let finalizeRequested = false;

  const resetTurn = (): void => {
    segments = [];
    bufferedDurationSeconds = 0;
    sawSpeechSinceFlush = false;
  };

  const flushTurn = (
    reason: "speech_final" | "utterance_end" | "finalize",
  ): void => {
    const joined = segments.join(" ").replace(/\s+/g, " ").trim();
    const durationSeconds = bufferedDurationSeconds;
    const segmentCount = segments.length;
    const hadSpeech = sawSpeechSinceFlush;
    resetTurn();

    if (joined.length === 0) {
      // Nothing buffered. If a word-gap boundary arrived after we heard speech
      // (interims) but Deepgram never produced a final, ask it to flush — the
      // dead-air rescue. Guard so we request at most once per gap.
      if (reason === "utterance_end" && hadSpeech && !finalizeRequested) {
        finalizeRequested = true;
        try {
          socket.sendFinalize({ type: "Finalize" });
          callbacks.onDeadAirFinalize?.();
        } catch {
          /* best-effort — UtteranceEnd already covers most dead-air cases */
        }
      }
      return;
    }

    finalizeRequested = false;

    // Word-count filter on the AGGREGATE turn (single-word backchannels like
    // "yeah"/"okay" never reach the dispatcher). Per-segment confidence is
    // filtered below, before a segment is buffered.
    const wordCount = joined.split(/\s+/).filter((s) => s.length > 0).length;
    if (wordCount < minWordCount) {
      callbacks.onShortUtteranceReject?.(joined, wordCount);
      return;
    }

    callbacks.onTurnFlush?.(reason, segmentCount, joined.length);
    callbacks.onFinalTranscript(joined, durationSeconds);
  };

  // Wire SDK event handlers. The `message` event carries Results (transcripts),
  // UtteranceEnd (word-gap boundary), and other event types (Metadata,
  // SpeechStarted) we ignore here.
  socket.on("message", (message: unknown) => {
    try {
      if (!message || typeof message !== "object") return;
      const m = message as {
        type?: string;
        is_final?: boolean;
        speech_final?: boolean;
        from_finalize?: boolean;
        duration?: number;
        channel?: {
          alternatives?: Array<{ transcript?: string; confidence?: number }>;
        };
      };

      // Word-gap boundary — noise-immune. Flush the buffered turn, or trigger
      // the dead-air Finalize rescue when the buffer is empty.
      if (m.type === "UtteranceEnd") {
        flushTurn("utterance_end");
        return;
      }

      if (m.type !== "Results") return;
      const alt = m.channel?.alternatives?.[0];
      const transcript = alt?.transcript ?? "";

      // Plan 02 limitation — Deepgram V1 streaming WS doesn't carry per-user
      // attribution; the manager resolves the speaker via its own per-session
      // "last-speaker" state (single-speaker assumption per CONTEXT.md).
      if (m.is_final === true) {
        if (transcript.length > 0) {
          // Per-segment confidence gate — drop noisy segments before they
          // pollute the buffered turn. Undefined confidence → 1.0 (fail-open).
          const confidence =
            typeof alt?.confidence === "number" &&
            Number.isFinite(alt.confidence)
              ? alt.confidence
              : 1;
          if (confidence < minConfidence) {
            callbacks.onLowConfidenceReject?.(transcript, confidence);
          } else {
            segments.push(transcript);
            if (typeof m.duration === "number" && Number.isFinite(m.duration)) {
              bufferedDurationSeconds += m.duration;
            }
            sawSpeechSinceFlush = true;
          }
        }
        // Turn boundary: endpointing-driven `speech_final`, or the forced
        // `from_finalize` reply to our dead-air Finalize request.
        if (m.speech_final === true || m.from_finalize === true) {
          flushTurn(m.from_finalize === true ? "finalize" : "speech_final");
        }
      } else if (transcript.length > 0) {
        // Interim — never dispatched, but proves the user is speaking (drives
        // the dead-air rescue) and is exposed for future live-caption use.
        sawSpeechSinceFlush = true;
        callbacks.onInterimTranscript(transcript);
      }
    } catch (err) {
      callbacks.onError(err instanceof Error ? err : new Error(String(err)));
    }
  });

  socket.on("error", (err: Error) => {
    callbacks.onError(err);
  });

  // 135.0.3 — Deepgram closes idle WS connections after ~10s of no audio.
  // When the user pauses between utterances, the Discord receiver stops
  // emitting PCM, Deepgram sees no audio, and tears down the WS. After
  // that the session is alive but STT is dead — every subsequent utterance
  // silently fails. Send a KeepAlive JSON every 8s (under their 10s
  // threshold) to keep the WS hot across silent gaps.
  let keepAliveCount = 0;
  let keepAliveErrors = 0;
  const keepAliveInterval = setInterval(() => {
    try {
      socket.sendKeepAlive({ type: "KeepAlive" });
      keepAliveCount++;
    } catch (err) {
      keepAliveErrors++;
      // eslint-disable-next-line no-console
      console.log(JSON.stringify({
        component: "voice-stt-keepalive",
        msg: "sendKeepAlive threw",
        error: err instanceof Error ? err.message : String(err),
        totalSent: keepAliveCount,
        totalErrors: keepAliveErrors,
      }));
    }
  }, 8000);

  socket.on("close", () => {
    clearInterval(keepAliveInterval);
    // eslint-disable-next-line no-console
    console.log(JSON.stringify({
      component: "voice-stt-keepalive",
      msg: "WS closed — keepalive stats",
      totalSent: keepAliveCount,
      totalErrors: keepAliveErrors,
    }));
    callbacks.onClose?.();
  });

  // Connect + wait for open. The SDK's `connect()` returns the socket
  // already attached; `waitForOpen` resolves when the WS handshake
  // completes.
  try {
    socket.connect();
    await socket.waitForOpen();
  } catch (err) {
    // If we couldn't open, surface the error rather than returning a
    // half-broken connection.
    throw err instanceof Error ? err : new Error(String(err));
  }

  // Return the stable DeepgramLiveConnection shape. The SDK's V1Socket
  // already exposes `sendMedia`, `close`, and `on` matching our
  // interface — but we wrap defensively so future SDK refactors don't
  // ripple into the manager.
  return {
    sendMedia: (data) => socket.sendMedia(data),
    close: () => socket.close(),
    on: (event, callback) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      socket.on(event as any, callback as any);
    },
    waitForOpen: () => socket.waitForOpen(),
  };
}
