/**
 * Phase 999.154 WS-2 — resolved per-agent turn-vision config.
 */

import type { ResolvedAgentConfig } from "../shared/types.js";

export type TurnVisionMode = "inline" | "prepass" | "off";

export type ResolvedTurnVisionConfig = {
  readonly enabled: boolean;
  readonly mode: TurnVisionMode;
  readonly inline: {
    readonly fullResImages: number;
    readonly maxImageTokens: number;
    readonly maxImages: number;
    readonly screenshotSidePx: number;
    readonly photoSidePx: number;
    readonly contactSheet: { readonly grid: number; readonly tilePx: number };
  };
  readonly burst: { readonly quietMs: number; readonly maxWaitMs: number };
};

export const TURN_VISION_DEFAULTS: ResolvedTurnVisionConfig = Object.freeze({
  enabled: false,
  mode: "inline" as const,
  inline: Object.freeze({
    fullResImages: 4,
    maxImageTokens: 24_000,
    maxImages: 60,
    screenshotSidePx: 1568,
    photoSidePx: 1024,
    contactSheet: Object.freeze({ grid: 3, tilePx: 512 }),
  }),
  burst: Object.freeze({ quietMs: 1500, maxWaitMs: 5000 }),
});

export function resolveTurnVisionConfig(
  vision: ResolvedAgentConfig["vision"] | undefined,
): ResolvedTurnVisionConfig {
  const d = TURN_VISION_DEFAULTS;
  const i = vision?.inline;
  return {
    enabled: vision?.enabled === true,
    mode: vision?.mode ?? d.mode,
    inline: {
      fullResImages: i?.fullResImages ?? d.inline.fullResImages,
      maxImageTokens: i?.maxImageTokens ?? d.inline.maxImageTokens,
      maxImages: i?.maxImages ?? d.inline.maxImages,
      screenshotSidePx: i?.screenshotSidePx ?? d.inline.screenshotSidePx,
      photoSidePx: i?.photoSidePx ?? d.inline.photoSidePx,
      contactSheet: {
        grid: i?.contactSheet?.grid ?? d.inline.contactSheet.grid,
        tilePx: i?.contactSheet?.tilePx ?? d.inline.contactSheet.tilePx,
      },
    },
    burst: {
      quietMs: vision?.burst?.quietMs ?? d.burst.quietMs,
      maxWaitMs: vision?.burst?.maxWaitMs ?? d.burst.maxWaitMs,
    },
  };
}
