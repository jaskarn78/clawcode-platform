/**
 * Phase 117 Plan 06 — schema validation for the `advisor` block.
 *
 * Pins three contract invariants for the Phase 117 feature-flag rollout:
 *
 *   1. The backend enum admits exactly `"native"` and `"fork"`. The
 *      `"portable-fork"` value carried by `BackendId`
 *      (`src/advisor/types.ts:30`) is REJECTED at schema parse — Plan
 *      117-05 ships the scaffold but Phase 118 owns the rollout. Schema
 *      rejection is the operator-visible signal that the value is not
 *      selectable yet (regression assertion C below).
 *   2. `maxUsesPerRequest` is bounded 1–10 — sub-1 is meaningless, super-
 *      10 burns budget on a misconfigured agent (CONTEXT.md
 *      Anthropic-example default 3).
 *   3. Both `defaultsSchema.advisor` and `agentSchema.advisor` accept
 *      partial blocks (empty `{}` parses) so operators can override one
 *      knob at a time without re-specifying the rest. defaults populates
 *      inner field defaults; agent override leaves omitted fields
 *      undefined for the loader resolver to fall through.
 *
 * Pattern reference: `tools-schema.test.ts:100` style (multiple ZodError
 * forbidden-value assertions, single `describe` block).
 */
import { describe, it, expect } from "vitest";
import { z } from "zod/v4";
import {
  defaultsSchema,
  agentSchema,
  advisorBackendSchema,
  advisorConfigSchema,
  agentAdvisorOverrideSchema,
} from "../schema.js";

describe("defaults.advisor — Phase 117 Plan 06 schema validation", () => {
  it("A: accepts `backend: \"native\"` (the default)", () => {
    const parsed = defaultsSchema.parse({ advisor: { backend: "native" } });
    expect(parsed.advisor?.backend).toBe("native");
  });

  it("B: accepts `backend: \"fork\"` (the rollback gate)", () => {
    const parsed = defaultsSchema.parse({ advisor: { backend: "fork" } });
    expect(parsed.advisor?.backend).toBe("fork");
  });

  it("C: REJECTS `backend: \"portable-fork\"` with a clear ZodError", () => {
    const result = defaultsSchema.safeParse({
      advisor: { backend: "portable-fork" },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      // Zod 4 surfaces the allowed values and the rejected path
      // ("advisor","backend") in the issue. The plan's must-have line
      // calls for a "clear message" — verify both the message phrase
      // AND the allowed-value list so operators get a useful signal.
      // Zod 4 omits the rejected value from the message text (unlike Zod 3),
      // but the path + allowed-options together are enough to diagnose.
      const flat = JSON.stringify(result.error.issues);
      expect(flat).toContain("Invalid option");
      expect(flat).toContain("native");
      expect(flat).toContain("fork");
      expect(flat).toContain('"path":["advisor","backend"]');
    }
  });

  it("D: REJECTS `maxUsesPerRequest: 0` (below min 1)", () => {
    const result = defaultsSchema.safeParse({
      advisor: { maxUsesPerRequest: 0 },
    });
    expect(result.success).toBe(false);
  });

  it("E: REJECTS `maxUsesPerRequest: 99` (above max 10)", () => {
    const result = defaultsSchema.safeParse({
      advisor: { maxUsesPerRequest: 99 },
    });
    expect(result.success).toBe(false);
  });

  it("populates inner defaults when block is empty `advisor: {}`", () => {
    const parsed = defaultsSchema.parse({ advisor: {} });
    expect(parsed.advisor).toEqual({
      backend: "native",
      model: "opus",
      maxUsesPerRequest: 3,
      // caching is .optional() — undefined when omitted by operator;
      // resolveAdvisorCaching fills the {true,"5m"} baseline at call time.
      caching: undefined,
    });
  });

  it("leaves the whole block undefined when advisor is omitted entirely", () => {
    // Phase 117 spec — backward-compat with pre-117 yaml. Parse must not
    // synthesise a defaulted advisor block when operator says nothing;
    // loader resolvers handle the baseline. Mirrors shimRuntime's parent-
    // level `.optional()` semantic in shim-runtime-enum.test.ts.
    const parsed = defaultsSchema.parse({});
    expect(parsed.advisor).toBeUndefined();
  });

  it("accepts a fully-populated advisor block with caching", () => {
    const parsed = defaultsSchema.parse({
      advisor: {
        backend: "fork",
        model: "sonnet",
        maxUsesPerRequest: 5,
        caching: { enabled: false, ttl: "1h" },
      },
    });
    expect(parsed.advisor).toEqual({
      backend: "fork",
      model: "sonnet",
      maxUsesPerRequest: 5,
      caching: { enabled: false, ttl: "1h" },
    });
  });

  it("rejects an unknown caching ttl value", () => {
    const result = defaultsSchema.safeParse({
      advisor: { caching: { ttl: "10m" } },
    });
    expect(result.success).toBe(false);
  });
});

describe("agents[].advisor — per-agent override schema", () => {
  it("F: accepts `{backend: \"fork\"}` (partial override)", () => {
    const parsed = agentSchema.parse({
      name: "test-agent",
      advisor: { backend: "fork" },
    });
    expect(parsed.advisor?.backend).toBe("fork");
    // Other fields stay undefined — loader resolver falls through to
    // defaults.advisor / hardcoded baseline.
    expect(parsed.advisor?.model).toBeUndefined();
    expect(parsed.advisor?.maxUsesPerRequest).toBeUndefined();
  });

  it("F: REJECTS `{backend: \"portable-fork\"}` per-agent (same enum as defaults)", () => {
    const result = agentSchema.safeParse({
      name: "test-agent",
      advisor: { backend: "portable-fork" },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      // Same Zod 4 issue shape as the defaults-side assertion C.
      const flat = JSON.stringify(result.error.issues);
      expect(flat).toContain("Invalid option");
      expect(flat).toContain("native");
      expect(flat).toContain("fork");
      expect(flat).toContain('"path":["advisor","backend"]');
    }
  });

  it("G: accepts an empty advisor block `{}` (every sub-field optional)", () => {
    const parsed = agentSchema.parse({
      name: "test-agent",
      advisor: {},
    });
    // Per-agent schema is .partial() — empty object parses to all-undefined.
    expect(parsed.advisor).toEqual({});
  });

  it("accepts a single `model` override without backend", () => {
    const parsed = agentSchema.parse({
      name: "test-agent",
      advisor: { model: "opus" },
    });
    expect(parsed.advisor?.model).toBe("opus");
    expect(parsed.advisor?.backend).toBeUndefined();
  });

  it("accepts a partial caching override (`enabled` only)", () => {
    // Operator wants caching disabled but accepts the default 5m ttl.
    const parsed = agentSchema.parse({
      name: "test-agent",
      advisor: { caching: { enabled: false } },
    });
    expect(parsed.advisor?.caching?.enabled).toBe(false);
    expect(parsed.advisor?.caching?.ttl).toBeUndefined();
  });

  it("REJECTS per-agent `maxUsesPerRequest: 11` (same range as defaults)", () => {
    const result = agentSchema.safeParse({
      name: "test-agent",
      advisor: { maxUsesPerRequest: 11 },
    });
    expect(result.success).toBe(false);
  });

  it("leaves advisor undefined when omitted entirely (back-compat)", () => {
    // Pre-117 yaml — every existing agent config parses unchanged.
    const parsed = agentSchema.parse({ name: "test-agent" });
    expect(parsed.advisor).toBeUndefined();
  });
});

describe("advisor helper schemas — direct shape pinning", () => {
  it("advisorBackendSchema is exactly `[\"native\", \"fork\"]` (regression pin)", () => {
    // If a future contributor adds "portable-fork" here without flipping
    // the Phase 117 → 118 gate, this assertion fires in CI.
    expect(() => advisorBackendSchema.parse("native")).not.toThrow();
    expect(() => advisorBackendSchema.parse("fork")).not.toThrow();
    expect(() => advisorBackendSchema.parse("portable-fork")).toThrow(z.ZodError);
    expect(() => advisorBackendSchema.parse("anthropic-sdk")).toThrow(z.ZodError);
  });

  it("advisorConfigSchema populates ALL inner defaults from `{}`", () => {
    const parsed = advisorConfigSchema.parse({});
    expect(parsed).toEqual({
      backend: "native",
      model: "opus",
      maxUsesPerRequest: 3,
      caching: undefined,
    });
  });

  it("agentAdvisorOverrideSchema admits `{}` but rejects extra fields' bad values", () => {
    // Partial-shape sanity — empty object yields all-undefined.
    expect(agentAdvisorOverrideSchema.parse({})).toEqual({});
    // Bad backend value still rejected even though every field is optional.
    expect(() =>
      agentAdvisorOverrideSchema.parse({ backend: "portable-fork" }),
    ).toThrow(z.ZodError);
  });
});
