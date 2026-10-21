/**
 * Phase 62 Plan 01 — PolicySchema tests.
 *
 * Validates Zod schemas for the policy YAML shape: PolicyFileSchema,
 * PolicyRuleSchema, PolicySourceSchema, PolicyThrottleSchema.
 */

import { describe, it, expect } from "vitest";

import {
  PolicyFileSchema,
  PolicyRuleSchema,
  PolicySourceSchema,
  PolicyThrottleSchema,
} from "../policy-schema.js";

describe("PolicySourceSchema", () => {
  it("accepts empty object (no filter)", () => {
    expect(() => PolicySourceSchema.parse({})).not.toThrow();
  });

  it("accepts kind-only", () => {
    const result = PolicySourceSchema.parse({ kind: "mysql" });
    expect(result.kind).toBe("mysql");
    expect(result.id).toBeUndefined();
  });

  it("accepts id-only", () => {
    const result = PolicySourceSchema.parse({ id: "pipeline_*" });
    expect(result.id).toBe("pipeline_*");
    expect(result.kind).toBeUndefined();
  });

  it("accepts both kind and id", () => {
    const result = PolicySourceSchema.parse({ kind: "mysql", id: "pipeline_*" });
    expect(result.kind).toBe("mysql");
    expect(result.id).toBe("pipeline_*");
  });
});

describe("PolicyThrottleSchema", () => {
  it("accepts positive integer maxPerMinute", () => {
    const result = PolicyThrottleSchema.parse({ maxPerMinute: 10 });
    expect(result.maxPerMinute).toBe(10);
  });

  it("rejects zero maxPerMinute", () => {
    expect(() => PolicyThrottleSchema.parse({ maxPerMinute: 0 })).toThrow();
  });

  it("rejects negative maxPerMinute", () => {
    expect(() => PolicyThrottleSchema.parse({ maxPerMinute: -1 })).toThrow();
  });

  it("rejects non-integer maxPerMinute", () => {
    expect(() => PolicyThrottleSchema.parse({ maxPerMinute: 1.5 })).toThrow();
  });
});

describe("PolicyRuleSchema", () => {
  const validRule = {
    id: "test-rule",
    target: "research",
    payload: "Hello {{event.sourceId}}",
  };

  it("accepts a valid rule with all required fields", () => {
    const result = PolicyRuleSchema.parse(validRule);
    expect(result.id).toBe("test-rule");
    expect(result.target).toBe("research");
    expect(result.payload).toBe("Hello {{event.sourceId}}");
  });

  it("defaults enabled to true when omitted", () => {
    const result = PolicyRuleSchema.parse(validRule);
    expect(result.enabled).toBe(true);
  });

  it("defaults priority to 0 when omitted", () => {
    const result = PolicyRuleSchema.parse(validRule);
    expect(result.priority).toBe(0);
  });

  it("rejects missing id field", () => {
    const { id: _, ...noId } = validRule;
    expect(() => PolicyRuleSchema.parse(noId)).toThrow();
  });

  it("rejects missing target field", () => {
    const { target: _, ...noTarget } = validRule;
    expect(() => PolicyRuleSchema.parse(noTarget)).toThrow();
  });

  it("rejects missing payload field", () => {
    const { payload: _, ...noPayload } = validRule;
    expect(() => PolicyRuleSchema.parse(noPayload)).toThrow();
  });

  it("rejects empty id string", () => {
    expect(() => PolicyRuleSchema.parse({ ...validRule, id: "" })).toThrow();
  });

  it("rejects empty target string", () => {
    expect(() => PolicyRuleSchema.parse({ ...validRule, target: "" })).toThrow();
  });

  it("rejects empty payload string", () => {
    expect(() => PolicyRuleSchema.parse({ ...validRule, payload: "" })).toThrow();
  });

  it("accepts optional source filter", () => {
    const result = PolicyRuleSchema.parse({
      ...validRule,
      source: { kind: "mysql", id: "pipeline_*" },
    });
    expect(result.source?.kind).toBe("mysql");
  });

  it("accepts optional throttle", () => {
    const result = PolicyRuleSchema.parse({
      ...validRule,
      throttle: { maxPerMinute: 5 },
    });
    expect(result.throttle?.maxPerMinute).toBe(5);
  });

  it("accepts optional description", () => {
    const result = PolicyRuleSchema.parse({
      ...validRule,
      description: "A test rule",
    });
    expect(result.description).toBe("A test rule");
  });
});

describe("PolicyFileSchema", () => {
  it("accepts a valid policy file with rules", () => {
    const result = PolicyFileSchema.parse({
      version: 1,
      rules: [
        { id: "r1", target: "research", payload: "test" },
        { id: "r2", target: "writer", payload: "test2" },
      ],
    });
    expect(result.version).toBe(1);
    expect(result.rules).toHaveLength(2);
  });

  it("requires version: 1 literal", () => {
    expect(() =>
      PolicyFileSchema.parse({ version: 2, rules: [] }),
    ).toThrow();
  });

  it("rejects missing version", () => {
    expect(() => PolicyFileSchema.parse({ rules: [] })).toThrow();
  });

  it("accepts empty rules array", () => {
    const result = PolicyFileSchema.parse({ version: 1, rules: [] });
    expect(result.rules).toHaveLength(0);
  });

  it("validates nested rule schemas", () => {
    expect(() =>
      PolicyFileSchema.parse({
        version: 1,
        rules: [{ id: "", target: "x", payload: "y" }],
      }),
    ).toThrow(); // id cannot be empty
  });
});
