/**
 * Phase 135 Plan 02 Task 2 — voice transcript → bridge ingress.
 *
 * Connects the Deepgram callback path (via VoiceManager's
 * `setTranscriptDispatcher`) to the DiscordBridge's
 * `handleVoiceTranscript()` method. Kept in a small dedicated module
 * so the manager itself stays free of `bridge.ts` imports (avoids a
 * circular dependency: bridge → manager → bridge).
 *
 * Per RESEARCH § Architecture Pattern 3 — `handleVoiceTranscript`
 * dispatches the transcript through the SAME turn machinery as text
 * (the existing TurnDispatcher / streamAndPostResponse path). The
 * agent's tools/MCPs/skills work transparently because there is no
 * parallel "voice-only" runtime — voice and text both flow into the
 * same dispatcher, distinguished only by the discriminated `delivery`
 * union (Task 3 wires the union).
 *
 * Wrapped in try/catch per Pitfall 8: voice subsystem errors must NOT
 * leak into the shared discord.js Client.
 */
import type { Logger } from "pino";
import type { VoiceSession } from "./session.js";
import type { VoiceSttTiming } from "./turn-trace.js";

/**
 * Minimum shape this module needs from DiscordBridge. We typedef it
 * structurally (rather than importing `DiscordBridge` directly) so
 * unit tests can substitute a mock without dragging the full bridge
 * type machinery into every fixture, AND to avoid the circular
 * dependency (bridge.ts imports VoiceManager → manager.ts imports
 * stt.ts → eventually back into the bridge).
 */
export type VoiceBridgeIngress = {
  handleVoiceTranscript: (args: {
    readonly agentName: string;
    readonly channelId: string;
    readonly transcript: string;
    readonly voiceUserId: string;
    readonly guildId: string;
    readonly voiceSession: VoiceSession;
    /** 999.116 A3 (G7) — STT decision timing for the turn trace. */
    readonly sttTiming?: VoiceSttTiming;
  }) => Promise<void>;
};

/**
 * Dispatch a final transcript from VoiceManager to DiscordBridge.
 *
 * The bridge's `handleVoiceTranscript` opens a turn and calls through
 * to the existing dispatcher; this helper exists only so the
 * VoiceManager can route through a single typed seam (and to keep the
 * try/catch boundary in one place).
 *
 * @param bridge        DiscordBridge (or a structural mock in tests).
 * @param session       The VoiceSession the transcript came from.
 * @param transcript    The final Deepgram transcript text.
 * @param voiceUserId   The Discord userId who spoke. Plan 02's
 *                       single-speaker assumption means this may be an
 *                       empty string when Deepgram can't attribute
 *                       (Plan 04+ adds multi-speaker tracking).
 * @param log           Pino logger for the catch-at-boundary log line.
 * @param timing        999.116 A3 (G7) — when STT decided the turn was
 *                       complete (and when the user stopped talking), so
 *                       the bridge's turn trace can measure dead air.
 */
export async function dispatchTranscriptToAgent(
  bridge: VoiceBridgeIngress,
  session: VoiceSession,
  transcript: string,
  voiceUserId: string,
  log: Logger,
  timing?: VoiceSttTiming,
): Promise<void> {
  try {
    await bridge.handleVoiceTranscript({
      agentName: session.agentName,
      channelId: session.channelId,
      transcript,
      voiceUserId,
      guildId: session.guildId,
      voiceSession: session,
      sttTiming: timing,
    });
  } catch (err) {
    log.error(
      {
        sessionId: session.id,
        agent: session.agentName,
        guildId: session.guildId,
        voiceUserId,
        error: err instanceof Error ? err.message : String(err),
      },
      "voice transcript dispatch failed (caught at ingress boundary)",
    );
  }
}
