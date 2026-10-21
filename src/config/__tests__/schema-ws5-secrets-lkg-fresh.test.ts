/**
 * WS-5 (2026-08-28) — `defaults.secrets.lkgFreshMs` schema contract.
 *
 * The knob lets a daemon restart serve last-known-good secrets younger than
 * the window WITHOUT live `op read`s (32 refs on prod ≈ 30 reads of the
 * shared 1,000/24h 1Password cap per restart). These pin:
 *   - default 0 = pre-WS-5 behaviour (every boot reads live),
 *   - the prod value (12h = 43_200_000) parses,
 *   - the sibling `lkgMaxAgeMs` default is untouched,
 *   - negatives / non-integers are rejected (a fractional or negative window
 *     would silently disable or invert the age comparison).
 */

import { describe, it, expect } from "vitest";
import { configSchema, defaultsSchema } from "../schema.js";

describe("WS-5 — defaults.secrets.lkgFreshMs", () => {
  it("defaults to 0 (fresh-serve OFF) when the secrets block is present but the key is omitted", () => {
    const result = defaultsSchema.safeParse({ secrets: {} });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.secrets?.lkgFreshMs).toBe(0);
      // Sibling default unchanged (30d).
      expect(result.data.secrets?.lkgMaxAgeMs).toBe(2_592_000_000);
    }
  });

  it("accepts the prod value 43_200_000 (12h) at the root config level", () => {
    const result = configSchema.safeParse({
      version: 1,
      agents: [{ name: "test-agent" }],
      defaults: { secrets: { lkgFreshMs: 43_200_000 } },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.defaults.secrets?.lkgFreshMs).toBe(43_200_000);
      expect(result.data.defaults.secrets?.lkgMaxAgeMs).toBe(2_592_000_000);
    }
  });

  it("leaves defaults.secrets undefined when the block is omitted entirely (daemon applies `?? 0`)", () => {
    const result = configSchema.safeParse({ version: 1, agents: [{ name: "test-agent" }] });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.defaults.secrets).toBeUndefined();
    }
  });

  it("rejects a negative or non-integer window", () => {
    expect(defaultsSchema.safeParse({ secrets: { lkgFreshMs: -1 } }).success).toBe(false);
    expect(defaultsSchema.safeParse({ secrets: { lkgFreshMs: 1.5 } }).success).toBe(false);
    expect(defaultsSchema.safeParse({ secrets: { lkgFreshMs: "12h" } }).success).toBe(false);
  });
});
