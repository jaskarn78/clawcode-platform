/**
 * Phase 135 Plan 02 Task 3 — voice-mode prompt suffix.
 *
 * Returns the system-prompt augmentation that nudges the agent to
 * produce voice-friendly responses (short, no markdown, no emoji, no
 * code fences). Appended to the user-message wrapper on the voice path
 * ONLY — text-channel turns are unaffected.
 *
 * Per CONTEXT.md decision: "Default suffix appended to system prompt
 * when ingress fires from voice. Agent yaml `voice.promptSuffix`
 * overrides."
 *
 * Implementation note: Plan 02 originally specified injecting the
 * suffix into the agent's systemPrompt before TurnDispatcher.invoke.
 * The actual session-adapter binds systemPrompt at session START, not
 * per-turn (see src/manager/session-adapter.ts buildSystemPromptOption).
 * Plan 02 therefore wraps the user-message text instead — equivalent
 * effect (the agent sees the directive in-band on this turn) without
 * touching the session-scope prompt binding.
 */
import type { VoiceConfig } from "../../config/schema.js";

export const DEFAULT_VOICE_SUFFIX =
  "Reply in 2–3 sentences. No markdown, no code fences, no emoji — this is being read aloud.";

/**
 * Resolve the voice-mode prompt suffix for an agent. When the agent's
 * voice block sets `promptSuffix`, that override is returned verbatim;
 * otherwise the CONTEXT.md default. Empty-string `promptSuffix` is
 * rejected at zod boot time (`voiceConfigSchema` clamps `.min(1)`), so
 * the function never has to decide between empty-string and undefined.
 */
export function buildVoicePromptSuffix(
  voiceCfg: VoiceConfig | undefined,
): string {
  return voiceCfg?.promptSuffix ?? DEFAULT_VOICE_SUFFIX;
}
