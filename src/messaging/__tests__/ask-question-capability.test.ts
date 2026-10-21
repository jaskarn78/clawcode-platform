/**
 * Phase 145 WS3 (Plan 04) Task 1 — capability-gated render-mode decision.
 *
 * `decideRenderMode` is the single branch point the daemon `ask-user-question`
 * handler uses to choose native rendering (Discord buttons / Slack Block Kit
 * once Plan 07 lands) vs the universal numbered text fallback — keyed purely
 * on `PlatformCapabilities.interactivePrompt`. No per-platform special-casing.
 */

import { describe, it, expect } from "vitest";
import { decideRenderMode } from "../pending-prompt-registry.js";
import type { PlatformCapabilities } from "../types.js";

const BASE: PlatformCapabilities = {
  editMessages: true,
  reactions: true,
  typingIndicator: true,
  threads: true,
  perMessageIdentity: true,
  fileDownload: true,
  interactivePrompt: false,
  maxMessageLength: 2000,
};

describe("decideRenderMode", () => {
  it("returns 'native' when interactivePrompt is true (Discord today)", () => {
    expect(decideRenderMode({ ...BASE, interactivePrompt: true })).toBe(
      "native",
    );
  });

  it("returns 'text' when interactivePrompt is false (Slack today → fallback)", () => {
    expect(decideRenderMode({ ...BASE, interactivePrompt: false })).toBe(
      "text",
    );
  });

  it("ignores other capability flags (only interactivePrompt drives the mode)", () => {
    const allElseOff: PlatformCapabilities = {
      editMessages: false,
      reactions: false,
      typingIndicator: false,
      threads: false,
      perMessageIdentity: false,
      fileDownload: false,
      interactivePrompt: true,
      maxMessageLength: 100,
    };
    expect(decideRenderMode(allElseOff)).toBe("native");
  });
});
