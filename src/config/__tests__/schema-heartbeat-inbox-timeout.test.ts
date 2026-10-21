/**
 * Phase 999.12 Plan 00 — Wave 0 RED test for the new
 * `defaults.heartbeatInboxTimeoutMs` zod field (HB-01b).
 *
 * Pure zod-parse tests against `defaultsSchema`. Pins:
 *   - Default-bearing: omission resolves to 60_000
 *   - Acceptance: explicit positive int overrides the default
 *   - Rejection: 0, negatives (positive constraint)
 *   - Backward-compat: existing v2.x configs parse unchanged
 *
 * Field shape (Wave 1):
 *   heartbeatInboxTimeoutMs: z.number().int().positive().default(60_000).optional()
 *
 * Same pattern as preDeploySnapshotMaxAgeHours (schema.ts:1338).
 */

import { describe, it, expect } from "vitest";
import { defaultsSchema } from "../schema.js";

describe("defaultsSchema.heartbeatInboxTimeoutMs (Phase 999.12 HB-01)", () => {
  it("heartbeatInboxTimeoutMs absent → resolves to 60000 (default-bearing)", () => {
    const result = defaultsSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.heartbeatInboxTimeoutMs).toBe(60_000);
    }
  });

  it("heartbeatInboxTimeoutMs=120000 → resolves to 120000 (operator override)", () => {
    const result = defaultsSchema.safeParse({ heartbeatInboxTimeoutMs: 120_000 });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.heartbeatInboxTimeoutMs).toBe(120_000);
    }
  });

  it("heartbeatInboxTimeoutMs=0 → parse fails (positive constraint)", () => {
    const result = defaultsSchema.safeParse({ heartbeatInboxTimeoutMs: 0 });
    expect(result.success).toBe(false);
  });

  it("heartbeatInboxTimeoutMs=-1 → parse fails (positive constraint)", () => {
    const result = defaultsSchema.safeParse({ heartbeatInboxTimeoutMs: -1 });
    expect(result.success).toBe(false);
  });

  it("BACKWARD COMPAT: empty defaults parses unchanged + default surfaces", () => {
    const result = defaultsSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      // Sibling fields still resolve.
      expect(result.data.model).toBeDefined();
      expect(result.data.autoStart).toBe(true);
      // New default fires on omission.
      expect(result.data.heartbeatInboxTimeoutMs).toBe(60_000);
    }
  });
});
