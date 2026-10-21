/**
 * Capture helper -- ties instruction detection to conversation turn recording.
 *
 * Consumed by bridge.ts to capture each Discord exchange as a pair of turns
 * (user + assistant) in the conversation store. Runs instruction-pattern
 * detection on user content BEFORE storage, persisting the result as
 * instructionFlags on the user turn.
 *
 * This function is fire-and-forget: it NEVER throws. Any error from the
 * conversation store is caught and logged as a non-fatal warning.
 */

import type { ConversationStore } from "../memory/conversation-store.js";
import type { Logger } from "pino";
import { detectInstructionPatterns } from "../security/instruction-detector.js";

/** Input for capturing a single Discord message exchange (user + assistant). */
export type CaptureInput = {
  readonly convStore: ConversationStore;
  readonly sessionId: string;
  readonly userContent: string;
  readonly assistantContent: string;
  readonly channelId: string;
  readonly discordUserId: string;
  readonly discordMessageId: string;
  /**
   * Trust status of the originating Discord channel (SEC-01).
   *
   * Threaded through from `DiscordBridge` where the ACL gate at
   * `checkChannelAccess` has already decided whether the message may be
   * processed at all. When `true`, captured turns land with
   * `is_trusted_channel = 1` and are visible to the default (trust-filtered)
   * `ConversationStore.searchTurns` path. Omitted/false turns are still
   * recorded but excluded from that default search path (SEC-01 hygiene).
   */
  readonly isTrustedChannel?: boolean;
  readonly log: Logger;
  /**
   * Phase 116-03 F27 — optional callback fired after EACH successful
   * recordTurn (user then assistant). Receives metadata ONLY — agent name,
   * turn id, ISO timestamp, role. The dashboard SSE manager subscribes to
   * broadcast a `conversation-turn` event so the operator's live UI ticks
   * without polling. Callback is fire-and-forget; any throw is caught +
   * logged at warn (never disrupts capture). agentName is supplied by the
   * caller (bridge.ts has it; capture is agent-agnostic by default).
   */
  readonly onTurnRecorded?: (info: {
    readonly agent: string;
    readonly turnId: string;
    readonly role: "user" | "assistant";
    readonly ts: string;
  }) => void;
  readonly agentName?: string;
};

/**
 * Capture a Discord exchange as two conversation turns.
 *
 * 1. Runs instruction-pattern detection on user content
 * 2. If detected, logs a warning with risk level and channel
 * 3. Records user turn (with instructionFlags if detected)
 * 4. Records assistant turn (no instructionFlags -- only user content is scanned)
 *
 * Never throws -- any error is caught and logged as non-fatal.
 */
export function captureDiscordExchange(input: CaptureInput): void {
  try {
    // Run detection BEFORE any storage
    const detection = detectInstructionPatterns(input.userContent);

    if (detection.detected) {
      input.log.warn(
        {
          risk: detection.riskLevel,
          patterns: detection.patterns,
          channel: input.channelId,
        },
        "instruction pattern detected in user message",
      );
    }

    const instructionFlags = detection.detected
      ? JSON.stringify(detection)
      : undefined;

    // Record user turn
    const userTurn = input.convStore.recordTurn({
      sessionId: input.sessionId,
      role: "user",
      content: input.userContent,
      channelId: input.channelId,
      discordUserId: input.discordUserId,
      discordMessageId: input.discordMessageId,
      isTrustedChannel: input.isTrustedChannel,
      instructionFlags,
    });

    // Record assistant turn (no user-specific fields, no instructionFlags)
    const assistantTurn = input.convStore.recordTurn({
      sessionId: input.sessionId,
      role: "assistant",
      content: input.assistantContent,
      channelId: input.channelId,
      isTrustedChannel: input.isTrustedChannel,
    });

    // Phase 116-03 F27 — fire the SSE-broadcast hook for each turn after
    // both DB writes succeeded. Metadata only; no content. Hot-path safe —
    // ConversationTurn is the in-memory shape recordTurn just returned, no
    // re-read needed.
    if (input.onTurnRecorded && input.agentName) {
      const agent = input.agentName;
      try {
        input.onTurnRecorded({
          agent,
          turnId: userTurn.id,
          role: "user",
          ts: userTurn.createdAt,
        });
        input.onTurnRecorded({
          agent,
          turnId: assistantTurn.id,
          role: "assistant",
          ts: assistantTurn.createdAt,
        });
      } catch (hookErr) {
        input.log.warn(
          { error: (hookErr as Error).message },
          "[F27] onTurnRecorded hook threw (non-fatal)",
        );
      }
    }
  } catch (err) {
    input.log.warn(
      {
        agent: "capture",
        error: (err as Error).message,
      },
      "conversation capture failed (non-fatal)",
    );
  }
}
