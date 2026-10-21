/**
 * Phase 999.6 Plan 00 — Wave 0 RED test for the new
 * `defaults.preDeploySnapshotMaxAgeHours` zod field (SNAP-04).
 *
 * Pure zod-parse tests against `defaultsSchema`. Pins:
 *   - Default-bearing: omission resolves to 24
 *   - Acceptance: explicit positive int overrides the default
 *   - Rejection: 0, negatives, floats, strings (no coercion)
 *   - Backward-compat: existing v2.5/v2.6 configs parse unchanged
 *
 * The field shape (to be added in Wave 1) follows the established blueprint
 * from greetCoolDownMs (line 1316) / memoryFlushIntervalMs (line 1334):
 *
 *   preDeploySnapshotMaxAgeHours: z.number().int().positive().default(24).optional()
 *
 * Note: when both `.default(24)` and `.optional()` are present, zod treats
 * the field as default-bearing — `safeParse({}).data.preDeploySnapshotMaxAgeHours
 * === 24` (the default fires; .optional() makes the input slot omittable but
 * does not strip the default from the output). This is the exact semantic the
 * daemon reader relies on at boot.
 *
 * Wave 0 RED: assertions that read `parsed.data.preDeploySnapshotMaxAgeHours`
 * fail because the field is `undefined` on the existing schema. Wave 1 GREEN:
 * adding the field to defaultsSchema makes them pass.
 */

import { describe, it, expect } from "vitest";
import { defaultsSchema } from "../schema.js";

describe("defaultsSchema.preDeploySnapshotMaxAgeHours (Phase 999.6 SNAP-04)", () => {
  it("preDeploySnapshotMaxAgeHours absent → resolves to 24 (default-bearing)", () => {
    const result = defaultsSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.preDeploySnapshotMaxAgeHours).toBe(24);
    }
  });

  it("preDeploySnapshotMaxAgeHours=12 → resolves to 12 (operator override)", () => {
    const result = defaultsSchema.safeParse({ preDeploySnapshotMaxAgeHours: 12 });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.preDeploySnapshotMaxAgeHours).toBe(12);
    }
  });

  it("preDeploySnapshotMaxAgeHours=0 → parse fails (positive constraint)", () => {
    const result = defaultsSchema.safeParse({ preDeploySnapshotMaxAgeHours: 0 });
    expect(result.success).toBe(false);
  });

  it("preDeploySnapshotMaxAgeHours=-1 → parse fails (positive constraint)", () => {
    const result = defaultsSchema.safeParse({ preDeploySnapshotMaxAgeHours: -1 });
    expect(result.success).toBe(false);
  });

  it("preDeploySnapshotMaxAgeHours=1.5 → parse fails (int constraint)", () => {
    const result = defaultsSchema.safeParse({ preDeploySnapshotMaxAgeHours: 1.5 });
    expect(result.success).toBe(false);
  });

  it("preDeploySnapshotMaxAgeHours='24' → parse fails (number constraint, no string coercion)", () => {
    const result = defaultsSchema.safeParse({ preDeploySnapshotMaxAgeHours: "24" });
    expect(result.success).toBe(false);
  });

  it("BACKWARD COMPAT: a defaults object with no preDeploySnapshotMaxAgeHours field parses unchanged + populates default", () => {
    // Pre-Phase-999.6 minimal defaults (every field is default-bearing in
    // defaultsSchema, so {} is the canonical "v2.6 migrated config" shape).
    // The new additive-optional field MUST NOT break this — and it must
    // surface its zod default (24) on the parsed output so the daemon
    // reader sees a concrete number, not undefined.
    const result = defaultsSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      // Sanity: existing fields still resolve (regression guard if a future
      // refactor accidentally drops a default while adding our field)
      expect(result.data.model).toBeDefined();
      expect(result.data.autoStart).toBe(true);
      // The new field's zod default applies on the omission path
      expect(result.data.preDeploySnapshotMaxAgeHours).toBe(24);
    }
  });
});
