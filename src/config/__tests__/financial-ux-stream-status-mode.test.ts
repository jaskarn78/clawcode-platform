/**
 * 999.63d/5 — `verification.ux.streamStatusMode`.
 *
 * This codebase has a documented history of knobs that look wired but are
 * inert: `disallowedTools` was zod-inert per-agent, and the `plugins:`
 * knob was decorative on a 100%-v2 fleet. So this suite asserts the
 * SCHEMA actually accepts and carries the value on both surfaces, not
 * merely that the TypeScript compiles.
 */
import { describe, expect, it } from "vitest";

import {
  verificationConfigSchema,
  verificationDefaultsSchema,
} from "../schema.js";

describe("verification.ux.streamStatusMode", () => {
  it("accepts all three positions on the per-agent surface", () => {
    for (const mode of ["always", "topic", "auto"] as const) {
      const r = verificationConfigSchema.safeParse({
        ux: { streamStatus: true, streamStatusMode: mode },
      });
      expect(r.success).toBe(true);
      if (r.success) expect(r.data.ux?.streamStatusMode).toBe(mode);
    }
  });

  it("rejects an unknown position rather than silently ignoring it", () => {
    const r = verificationConfigSchema.safeParse({
      ux: { streamStatus: true, streamStatusMode: "sometimes" },
    });
    expect(r.success).toBe(false);
  });

  it("stays RAW-optional per-agent so operator-explicit is distinguishable", () => {
    // The loader's per-knob cascade (agent ?? defaults ?? built-in)
    // depends on omitted staying undefined here — an inner .default()
    // would make every agent look operator-explicit.
    const r = verificationConfigSchema.safeParse({
      ux: { streamStatus: true },
    });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.ux?.streamStatusMode).toBeUndefined();
  });

  it("defaults to 'auto' on the fleet-defaults surface", () => {
    // "auto" is what shipped 2026-08-26 — topic prompts paint from the
    // first event, other turns paint once they prove they are working.
    // Defaulting to "topic" would regress the 12-plan-audit blind spot;
    // "always" would regress the "not on every prompt" ask.
    const r = verificationDefaultsSchema.safeParse({
      ux: { streamStatus: true },
    });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.ux?.streamStatusMode).toBe("auto");
  });

  it("does not disturb the sibling ux knobs", () => {
    const r = verificationDefaultsSchema.safeParse({
      ux: { streamStatus: true },
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.ux?.streamStatus).toBe(true);
      expect(r.data.ux?.pendingMarker).toBe(false);
      expect(r.data.ux?.verifiedBadge).toBe(false);
    }
  });
});
