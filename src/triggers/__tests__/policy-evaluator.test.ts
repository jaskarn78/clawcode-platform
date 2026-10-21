/**
 * Phase 62 Plan 01 — PolicyEvaluator class tests.
 *
 * Replaces the Phase 60 evaluatePolicy pure function tests with full
 * DSL-aware evaluator tests: rule matching, source glob, throttle,
 * priority ordering, enable/disable, Handlebars rendering.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import {
  PolicyEvaluator,
  evaluatePolicy,
  type PolicyResult,
} from "../policy-evaluator.js";
import { compileRule } from "../policy-loader.js";
import type { PolicyRule } from "../policy-schema.js";
import type { TriggerEvent } from "../types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRule(overrides: Partial<PolicyRule> & { id: string; target: string; payload: string }): PolicyRule {
  return {
    enabled: true,
    priority: 0,
    ...overrides,
  };
}

function makeEvent(overrides: Partial<TriggerEvent> = {}): TriggerEvent {
  return {
    sourceId: "src-1",
    idempotencyKey: "key-1",
    targetAgent: "research",
    payload: null,
    timestamp: Date.now(),
    ...overrides,
  };
}

function buildEvaluator(
  rules: PolicyRule[],
  agents?: ReadonlySet<string>,
): PolicyEvaluator {
  const compiled = rules.map(compileRule);
  return new PolicyEvaluator(compiled, agents ?? new Set(["research", "studio", "writer"]));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("PolicyEvaluator", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("evaluate() returns allow: true with targetAgent, payload, ruleId when a rule matches", () => {
    const evaluator = buildEvaluator([
      makeRule({ id: "r1", target: "research", payload: "hello" }),
    ]);
    const result = evaluator.evaluate(makeEvent());
    expect(result.allow).toBe(true);
    if (result.allow) {
      expect(result.targetAgent).toBe("research");
      expect(result.payload).toBe("hello");
      expect(result.ruleId).toBe("r1");
    }
  });

  it("evaluate() returns allow: false when no rule matches", () => {
    const evaluator = buildEvaluator([
      makeRule({
        id: "r1",
        target: "research",
        payload: "hello",
        source: { kind: "webhook" },
      }),
    ]);
    // Event has sourceKind "mysql" which doesn't match the "webhook" rule
    const result = evaluator.evaluate(
      makeEvent({ sourceKind: "mysql" }),
    );
    expect(result.allow).toBe(false);
    if (!result.allow) {
      expect(result.reason).toContain("no matching rule");
    }
  });

  it("rules are evaluated in priority order (highest first)", () => {
    const evaluator = buildEvaluator([
      makeRule({ id: "low", target: "research", payload: "low-pri", priority: 1 }),
      makeRule({ id: "high", target: "research", payload: "high-pri", priority: 100 }),
    ]);
    const result = evaluator.evaluate(makeEvent());
    expect(result.allow).toBe(true);
    if (result.allow) {
      expect(result.ruleId).toBe("high");
      expect(result.payload).toBe("high-pri");
    }
  });

  it("disabled rules (enabled: false) are skipped", () => {
    const evaluator = buildEvaluator([
      makeRule({ id: "disabled", target: "research", payload: "nope", enabled: false, priority: 100 }),
      makeRule({ id: "enabled", target: "research", payload: "yes", priority: 1 }),
    ]);
    const result = evaluator.evaluate(makeEvent());
    expect(result.allow).toBe(true);
    if (result.allow) {
      expect(result.ruleId).toBe("enabled");
    }
  });

  it("source glob matching: kind 'mysql' matches kind 'mysql'", () => {
    const evaluator = buildEvaluator([
      makeRule({
        id: "mysql-rule",
        target: "research",
        payload: "matched",
        source: { kind: "mysql" },
      }),
    ]);
    const result = evaluator.evaluate(
      makeEvent({ sourceKind: "mysql" }),
    );
    expect(result.allow).toBe(true);
    if (result.allow) {
      expect(result.ruleId).toBe("mysql-rule");
    }
  });

  it("source glob matching: id 'pipeline_*' matches 'pipeline_clients'", () => {
    const evaluator = buildEvaluator([
      makeRule({
        id: "glob-rule",
        target: "research",
        payload: "matched",
        source: { id: "pipeline_*" },
      }),
    ]);
    const result = evaluator.evaluate(
      makeEvent({ sourceId: "pipeline_clients" }),
    );
    expect(result.allow).toBe(true);
    if (result.allow) {
      expect(result.ruleId).toBe("glob-rule");
    }
  });

  it("source glob matching: '*' matches any value", () => {
    const evaluator = buildEvaluator([
      makeRule({
        id: "star-rule",
        target: "research",
        payload: "matched",
        source: { id: "*" },
      }),
    ]);
    const result = evaluator.evaluate(
      makeEvent({ sourceId: "anything-at-all" }),
    );
    expect(result.allow).toBe(true);
    if (result.allow) {
      expect(result.ruleId).toBe("star-rule");
    }
  });

  it("source matching: rule with no source filter matches all events", () => {
    const evaluator = buildEvaluator([
      makeRule({ id: "catch-all", target: "research", payload: "caught" }),
    ]);
    const result = evaluator.evaluate(
      makeEvent({ sourceId: "anything", sourceKind: "webhook" }),
    );
    expect(result.allow).toBe(true);
    if (result.allow) {
      expect(result.ruleId).toBe("catch-all");
    }
  });

  it("source matching: kind-only rule matches any sourceId", () => {
    const evaluator = buildEvaluator([
      makeRule({
        id: "kind-only",
        target: "research",
        payload: "matched",
        source: { kind: "mysql" },
      }),
    ]);
    const result = evaluator.evaluate(
      makeEvent({ sourceId: "any-source", sourceKind: "mysql" }),
    );
    expect(result.allow).toBe(true);
    if (result.allow) {
      expect(result.ruleId).toBe("kind-only");
    }
  });

  it("throttled rule returns allow: false with 'throttled' reason", () => {
    const evaluator = buildEvaluator([
      makeRule({
        id: "limited",
        target: "research",
        payload: "hi",
        throttle: { maxPerMinute: 1 },
      }),
    ]);
    // First call succeeds
    expect(evaluator.evaluate(makeEvent()).allow).toBe(true);
    // Second call is throttled
    const result = evaluator.evaluate(makeEvent({ idempotencyKey: "key-2" }));
    expect(result.allow).toBe(false);
    if (!result.allow) {
      expect(result.reason).toContain("throttled");
    }
  });

  it("Handlebars template renders event.sourceId and event.payload fields", () => {
    const evaluator = buildEvaluator([
      makeRule({
        id: "template-rule",
        target: "research",
        payload: "Source: {{event.sourceId}}, Client: {{event.payload.clientName}}",
      }),
    ]);
    const result = evaluator.evaluate(
      makeEvent({ sourceId: "src-x", payload: { clientName: "Acme" } }),
    );
    expect(result.allow).toBe(true);
    if (result.allow) {
      expect(result.payload).toBe("Source: src-x, Client: Acme");
    }
  });

  it("return values are frozen (Object.isFrozen)", () => {
    const evaluator = buildEvaluator([
      makeRule({ id: "r1", target: "research", payload: "hi" }),
    ]);
    const allowResult = evaluator.evaluate(makeEvent());
    expect(Object.isFrozen(allowResult)).toBe(true);

    // Deny result
    const evaluator2 = buildEvaluator([]); // no rules
    const denyResult = evaluator2.evaluate(makeEvent());
    expect(Object.isFrozen(denyResult)).toBe(true);
  });

  it("empty rules array means all events denied", () => {
    const evaluator = buildEvaluator([]);
    const result = evaluator.evaluate(makeEvent());
    expect(result.allow).toBe(false);
  });

  it("first matching rule wins (no fallthrough)", () => {
    const evaluator = buildEvaluator([
      makeRule({ id: "first", target: "research", payload: "first-payload", priority: 10 }),
      makeRule({ id: "second", target: "research", payload: "second-payload", priority: 5 }),
    ]);
    const result = evaluator.evaluate(makeEvent());
    expect(result.allow).toBe(true);
    if (result.allow) {
      expect(result.ruleId).toBe("first");
      expect(result.payload).toBe("first-payload");
    }
  });

  it("configuredAgents check: target not in set returns deny", () => {
    const compiled = [
      compileRule(makeRule({ id: "r1", target: "unknown-agent", payload: "hi" })),
    ];
    const evaluator = new PolicyEvaluator(compiled, new Set(["research"]));
    const result = evaluator.evaluate(makeEvent());
    expect(result.allow).toBe(false);
    if (!result.allow) {
      expect(result.reason).toContain("not configured");
    }
  });

  it("updateConfiguredAgents changes the agent set", () => {
    const compiled = [
      compileRule(makeRule({ id: "r1", target: "new-agent", payload: "hi" })),
    ];
    const evaluator = new PolicyEvaluator(compiled, new Set(["research"]));

    // Initially denied
    expect(evaluator.evaluate(makeEvent()).allow).toBe(false);

    // Update configured agents
    evaluator.updateConfiguredAgents(new Set(["research", "new-agent"]));
    const result = evaluator.evaluate(makeEvent());
    expect(result.allow).toBe(true);
  });

  it("source kind mismatch prevents matching", () => {
    const evaluator = buildEvaluator([
      makeRule({
        id: "webhook-only",
        target: "research",
        payload: "hi",
        source: { kind: "webhook" },
      }),
    ]);
    const result = evaluator.evaluate(
      makeEvent({ sourceKind: "mysql" }),
    );
    expect(result.allow).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Backward-compatible evaluatePolicy wrapper
// ---------------------------------------------------------------------------

describe("evaluatePolicy (backward-compatible wrapper)", () => {
  it("returns allow: true when targetAgent is configured", () => {
    const result = evaluatePolicy(makeEvent(), new Set(["research"]));
    expect(result.allow).toBe(true);
    if (result.allow) {
      expect(result.targetAgent).toBe("research");
      expect(result.ruleId).toBe("__default__");
    }
  });

  it("returns allow: false when targetAgent is NOT configured", () => {
    const result = evaluatePolicy(makeEvent(), new Set(["writer"]));
    expect(result.allow).toBe(false);
    if (!result.allow) {
      expect(result.reason).toContain("not configured");
    }
  });

  it("returns frozen objects", () => {
    const allow = evaluatePolicy(makeEvent(), new Set(["research"]));
    expect(Object.isFrozen(allow)).toBe(true);
    const deny = evaluatePolicy(makeEvent(), new Set());
    expect(Object.isFrozen(deny)).toBe(true);
  });
});
