import { describe, expect, it } from "vitest";
import { verificationConfigSchema, verificationDefaultsSchema } from "../schema.js";

describe("verification.ux.narrationAsTrail (2026-08-27)", () => {
  it("per-agent: raw optional, accepted", () => {
    const r = verificationConfigSchema.safeParse({ ux: { narrationAsTrail: true } });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.ux?.narrationAsTrail).toBe(true);
    const o = verificationConfigSchema.safeParse({ ux: { streamStatus: true } });
    expect(o.success && o.data.ux?.narrationAsTrail).toBeUndefined();
  });
  it("defaults surface fills false (opt-in, like every ux toggle)", () => {
    const r = verificationDefaultsSchema.safeParse({ ux: {} });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.ux?.narrationAsTrail).toBe(false);
  });
});
