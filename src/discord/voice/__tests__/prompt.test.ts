/**
 * Phase 135 Plan 02 Task 3 — voice-mode prompt suffix.
 *
 * Pins:
 *   - The CONTEXT.md default suffix string exactly (used as agent
 *     guidance when the agent has no voice.promptSuffix override).
 *   - Per-agent override beats the default.
 *   - Undefined voiceCfg returns the default (defense-in-depth: caller
 *     shouldn't pass undefined for the voice path, but if it does we
 *     prefer a sane fallback over a TypeError).
 */
import { describe, it, expect } from "vitest";
import { buildVoicePromptSuffix, DEFAULT_VOICE_SUFFIX } from "../prompt.js";

describe("buildVoicePromptSuffix — Phase 135 Plan 02 Task 3", () => {
  it("returns the CONTEXT.md default suffix when voiceCfg is undefined", () => {
    expect(buildVoicePromptSuffix(undefined)).toBe(DEFAULT_VOICE_SUFFIX);
  });

  it("returns the default when voiceCfg has no promptSuffix field", () => {
    expect(
      buildVoicePromptSuffix({
        deepgramKey: "x",
        elevenLabsKey: "y",
        voiceId: "z",
      } as any),
    ).toBe(DEFAULT_VOICE_SUFFIX);
  });

  it("returns the per-agent override when voiceCfg.promptSuffix is set", () => {
    const custom = "Speak like a pirate.";
    expect(
      buildVoicePromptSuffix({
        deepgramKey: "x",
        elevenLabsKey: "y",
        voiceId: "z",
        promptSuffix: custom,
      } as any),
    ).toBe(custom);
  });

  it("DEFAULT_VOICE_SUFFIX matches the CONTEXT.md decision exactly", () => {
    // Pinned: this is the wording from 135-CONTEXT.md decisions block.
    expect(DEFAULT_VOICE_SUFFIX).toBe(
      "Reply in 2–3 sentences. No markdown, no code fences, no emoji — this is being read aloud.",
    );
  });
});
