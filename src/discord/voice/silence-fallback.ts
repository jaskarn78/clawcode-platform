/**
 * Phase 135 Plan 03 Task 2 — voice silence-fallback timer + progress cue.
 *
 * Problem this solves: when a voice transcript fires and the agent doesn't
 * reply within ~30 seconds (tool-call cascade, MCP latency, heavy context
 * restore), the user sits in dead air with no indication the agent heard
 * them. The voice surface feels broken.
 *
 * Solution: on every final transcript, arm a timer (configurable via
 * `voice.silenceFallbackMs`, default 30s). If the agent's response starts
 * before the timer fires, the bridge calls `cancelSilenceTimer`. If the
 * timer fires first, `fireProgressCue` speaks a short generic filler
 * ("one sec") so the user knows the agent is still working.
 *
 * ── 999.116 (2026-09-02): PROGRESS CUE, NOT A REPLACEMENT ANSWER ──────────
 * The Phase-135 version (`fireHaikuFallback`) ran a one-shot Haiku call
 * against the transcript, spoke that as the answer, and set
 * `session.fallbackSpoken = true` so the bridge SUPPRESSED the real agent
 * reply when it finally landed. That replace-race is the single biggest
 * reason prior voice verifies were inconclusive (G5/G7): on a genuinely
 * slow opus/fable turn the user heard Haiku's guess and never the agent's
 * real, tool-grounded answer — "the wrong voice answered."
 *
 * The cue deliberately:
 *   - speaks generic filler (no LLM call, no transcript, no cost, no
 *     wrong-answer risk — it is a "still working" earcon, not a reply);
 *   - NEVER sets `session.fallbackSpoken`, so the agent's real answer
 *     always plays when it lands (this IS the race fix — the bridge's
 *     three `fallbackSpoken` suppression branches stay inert);
 *   - is skipped if the agent has already started speaking (phase check),
 *     so a cue can never talk over live agent audio.
 *
 * The 135.1 streaming-TTS path also `cancelSilenceTimer`s the moment the
 * first sentence commits (~1s), so with `streamingTts.enabled` the cue
 * effectively never fires; it is the safety net for the nova-3 HTTP-TTS
 * path and pathologically slow turns.
 */
import { speakResponse } from "./tts.js";
import type { VoiceSession } from "./session.js";
import { stampVoiceTurn } from "./turn-trace.js";

/**
 * The default silence window — 30 seconds. Operators can override via
 * `voice.silenceFallbackMs` on the agent stanza (clamped 5s..120s by
 * `voiceConfigSchema`). A cue is cheap, so this can be lowered for a more
 * responsive "still there?" without the cost/disruption the old Haiku
 * fallback carried.
 */
export const DEFAULT_SILENCE_FALLBACK_MS = 30_000;

/**
 * Short, self-contained filler phrases. Rotated so back-to-back slow turns
 * don't repeat the same word. Kept ≤4 words each — a cue, not a sentence.
 */
export const PROGRESS_CUES: readonly string[] = [
  "One sec.",
  "Still on it.",
  "Give me a moment.",
  "Working on that.",
];

let cueIndex = 0;

/** Minimal log surface used here — narrows pino's Logger. */
type SilenceLog = {
  info: (obj: Record<string, unknown>, msg?: string) => void;
  warn: (obj: Record<string, unknown>, msg?: string) => void;
  error: (obj: Record<string, unknown>, msg?: string) => void;
};

/**
 * Arm the per-session silence timer. Replaces any previously-armed timer
 * (no stacking — every new final transcript resets the window).
 *
 * The callback is invoked at `voice.silenceFallbackMs` (default 30_000 ms)
 * after this call returns. Typical caller wraps the callback in a
 * try/catch — if the cue playback throws, the voice session must continue.
 */
export function armSilenceTimer(
  session: VoiceSession,
  callback: () => void,
): void {
  if (session.silenceTimer !== null) {
    clearTimeout(session.silenceTimer);
    session.silenceTimer = null;
  }
  const ms = session.voiceCfg.silenceFallbackMs ?? DEFAULT_SILENCE_FALLBACK_MS;
  session.silenceTimer = setTimeout(() => {
    // Clear the field on fire so isPending() callers (and a redundant
    // cancelSilenceTimer call from the bridge) see the timer as gone.
    session.silenceTimer = null;
    callback();
  }, ms);
}

/**
 * Cancel the per-session silence timer. Idempotent — safe to call even if
 * no timer is armed (the bridge calls this unconditionally after
 * `streamAndPostResponse` resolves or rejects, and the streaming-TTS path
 * calls it the moment the first sentence commits).
 */
export function cancelSilenceTimer(session: VoiceSession): void {
  if (session.silenceTimer !== null) {
    clearTimeout(session.silenceTimer);
    session.silenceTimer = null;
  }
}

/**
 * Speak a short progress cue when the agent has gone silent past the
 * window. Fire-and-forget from the timer closure; returns a Promise so the
 * caller can `.catch()` playback failures without leaking them into the
 * discord.js Client event loop.
 *
 * Does NOT set `session.fallbackSpoken` — the agent's real answer still
 * plays when it lands. Skips entirely if the agent is already speaking, so
 * the cue can never overlap live agent audio.
 */
export async function fireProgressCue(
  session: VoiceSession,
  log: SilenceLog,
): Promise<void> {
  // The agent started speaking (streaming committed, or an HTTP reply is
  // mid-playback) between the timer arming and firing — no cue needed.
  if (session.phase === "speaking" || session.phase === "interrupt_pending") {
    return;
  }

  const cue = PROGRESS_CUES[cueIndex % PROGRESS_CUES.length] ?? "One sec.";
  cueIndex += 1;

  // 999.116 A3 (G7) — mark the live turn so the trace shows the cue fired
  // (and when). The cue's own playback is deliberately NOT traced as the
  // answer's first audio — speakResponse below gets no trace argument.
  const trace = session.currentTurn?.trace;
  if (trace) {
    trace.cueFired = true;
    stampVoiceTurn(trace, "cue");
  }

  log.info(
    { agent: session.agentName, sessionId: session.id, cue },
    "voice silence — speaking progress cue (agent still working)",
  );

  try {
    // No abort signal: the cue is independent filler, not part of the
    // cancellable assistant turn. It plays to completion (~1s); if the
    // real answer lands first, its player.play() simply replaces the cue.
    await speakResponse(session, cue);
  } catch (err) {
    log.error(
      {
        agent: session.agentName,
        sessionId: session.id,
        error: err instanceof Error ? err.message : String(err),
      },
      "voice progress-cue TTS playback failed",
    );
  }
}
