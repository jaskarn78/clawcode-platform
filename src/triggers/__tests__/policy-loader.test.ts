/**
 * Phase 62 Plan 01 — PolicyLoader tests.
 *
 * Validates the YAML parse -> Zod validate -> Handlebars compile pipeline.
 */

import { describe, it, expect } from "vitest";

import {
  loadPolicies,
  compileRule,
  PolicyValidationError,
  type CompiledRule,
} from "../policy-loader.js";
import type { PolicyRule } from "../policy-schema.js";

const validYaml = `
version: 1
rules:
  - id: new-client-research
    description: "Route new pipeline clients to research agent"
    enabled: true
    priority: 100
    source:
      kind: mysql
      id: "pipeline_*"
    target: research
    payload: |
      New client detected: {{event.payload.clientName}}
      Source: {{event.sourceId}}
    throttle:
      maxPerMinute: 10
  - id: daily-briefing
    enabled: true
    priority: 50
    source:
      kind: scheduler
    target: studio
    payload: "Run the daily briefing."
`;

describe("loadPolicies", () => {
  it("parses valid YAML and returns CompiledRule[]", () => {
    const rules = loadPolicies(validYaml);
    expect(rules).toHaveLength(2);
    expect(rules[0]!.id).toBeDefined();
    expect(rules[1]!.id).toBeDefined();
  });

  it("throws PolicyValidationError on invalid YAML", () => {
    const invalidYaml = `
version: 2
rules: []
`;
    expect(() => loadPolicies(invalidYaml)).toThrow(PolicyValidationError);
  });

  it("throws PolicyValidationError when rules have missing required fields", () => {
    const missingTarget = `
version: 1
rules:
  - id: broken
    payload: "test"
`;
    expect(() => loadPolicies(missingTarget)).toThrow(PolicyValidationError);
  });

  it("sorts rules by priority descending", () => {
    const rules = loadPolicies(validYaml);
    expect(rules[0]!.priority).toBeGreaterThanOrEqual(rules[1]!.priority);
    expect(rules[0]!.id).toBe("new-client-research");
    expect(rules[1]!.id).toBe("daily-briefing");
  });

  it("PolicyValidationError has issues array", () => {
    try {
      loadPolicies("version: 99\nrules: []");
      throw new Error("Expected PolicyValidationError");
    } catch (err) {
      expect(err).toBeInstanceOf(PolicyValidationError);
      expect((err as PolicyValidationError).issues).toBeDefined();
      expect(Array.isArray((err as PolicyValidationError).issues)).toBe(true);
    }
  });

  it("throws on completely invalid YAML syntax", () => {
    expect(() => loadPolicies(":::invalid:::yaml{{{")).toThrow();
  });
});

describe("compileRule", () => {
  const rawRule: PolicyRule = {
    id: "test-rule",
    enabled: true,
    priority: 10,
    target: "research",
    payload: "Hello {{event.sourceId}} from {{event.payload.clientName}}",
  };

  it("compiles a rule with a Handlebars template", () => {
    const compiled = compileRule(rawRule);
    expect(compiled.id).toBe("test-rule");
    expect(compiled.target).toBe("research");
    expect(typeof compiled.template).toBe("function");
  });

  it("compiled template renders event variables", () => {
    const compiled = compileRule(rawRule);
    const result = compiled.template({
      event: { sourceId: "src-1", payload: { clientName: "Acme" } },
    });
    expect(result).toContain("Hello src-1");
    expect(result).toContain("from Acme");
  });

  it("uses noEscape (does not HTML-encode)", () => {
    const rule: PolicyRule = {
      id: "escape-test",
      enabled: true,
      priority: 0,
      target: "test",
      payload: "{{event.payload.html}}",
    };
    const compiled = compileRule(rule);
    const result = compiled.template({
      event: { payload: { html: "<b>bold</b>" } },
    });
    expect(result).toBe("<b>bold</b>");
  });

  it("returns a frozen CompiledRule", () => {
    const compiled = compileRule(rawRule);
    expect(Object.isFrozen(compiled)).toBe(true);
  });

  it("defaults source to empty object when undefined", () => {
    const compiled = compileRule(rawRule);
    expect(compiled.source).toEqual({});
  });

  it("preserves source filter from raw rule", () => {
    const compiled = compileRule({
      ...rawRule,
      source: { kind: "mysql", id: "pipeline_*" },
    });
    expect(compiled.source.kind).toBe("mysql");
    expect(compiled.source.id).toBe("pipeline_*");
  });

  it("Handlebars renders missing variables as empty string (graceful)", () => {
    const rule: PolicyRule = {
      id: "missing-var",
      enabled: true,
      priority: 0,
      target: "test",
      payload: "Hello {{event.nonexistent}}!",
    };
    const compiled = compileRule(rule);
    const result = compiled.template({ event: { sourceId: "x" } });
    expect(result).toBe("Hello !");
  });
});
