/**
 * Phase 62 Plan 01 — PolicyDiffer tests.
 *
 * Validates rule-ID-based diffing: added, removed, modified detection.
 */

import { describe, it, expect } from "vitest";
import Handlebars from "handlebars";

import { diffPolicies, type PolicyDiff } from "../policy-differ.js";
import type { CompiledRule } from "../policy-loader.js";

/** Helper to create a CompiledRule for testing. */
function makeRule(overrides: Partial<Omit<CompiledRule, "template">> & { id: string }): CompiledRule {
  return Object.freeze({
    id: overrides.id,
    description: overrides.description,
    enabled: overrides.enabled ?? true,
    priority: overrides.priority ?? 0,
    source: overrides.source ?? {},
    target: overrides.target ?? "test-agent",
    template: Handlebars.compile("test", { noEscape: true }),
    throttle: overrides.throttle,
  });
}

describe("diffPolicies", () => {
  it("detects added rules (new ID in new set)", () => {
    const oldRules = [makeRule({ id: "a" })];
    const newRules = [makeRule({ id: "a" }), makeRule({ id: "b" })];

    const diff = diffPolicies(oldRules, newRules);
    expect(diff.added).toContain("b");
    expect(diff.removed).toHaveLength(0);
    expect(diff.modified).toHaveLength(0);
  });

  it("detects removed rules (old ID not in new set)", () => {
    const oldRules = [makeRule({ id: "a" }), makeRule({ id: "b" })];
    const newRules = [makeRule({ id: "a" })];

    const diff = diffPolicies(oldRules, newRules);
    expect(diff.removed).toContain("b");
    expect(diff.added).toHaveLength(0);
    expect(diff.modified).toHaveLength(0);
  });

  it("detects modified rules (same ID, different content)", () => {
    const oldRules = [makeRule({ id: "a", priority: 10, target: "alpha" })];
    const newRules = [makeRule({ id: "a", priority: 20, target: "alpha" })];

    const diff = diffPolicies(oldRules, newRules);
    expect(diff.modified).toContain("a");
    expect(diff.added).toHaveLength(0);
    expect(diff.removed).toHaveLength(0);
  });

  it("reports no changes when sets are identical", () => {
    const rules = [
      makeRule({ id: "a", priority: 10, target: "alpha" }),
      makeRule({ id: "b", priority: 5, target: "beta" }),
    ];

    const diff = diffPolicies(rules, rules);
    expect(diff.added).toHaveLength(0);
    expect(diff.removed).toHaveLength(0);
    expect(diff.modified).toHaveLength(0);
  });

  it("uses deep equality for modification detection", () => {
    const oldRules = [
      makeRule({ id: "a", source: { kind: "mysql", id: "pipeline_*" } }),
    ];
    const newRules = [
      makeRule({ id: "a", source: { kind: "mysql", id: "pipeline_*" } }),
    ];

    const diff = diffPolicies(oldRules, newRules);
    expect(diff.modified).toHaveLength(0); // same content
  });

  it("detects modification when source filter changes", () => {
    const oldRules = [
      makeRule({ id: "a", source: { kind: "mysql" } }),
    ];
    const newRules = [
      makeRule({ id: "a", source: { kind: "webhook" } }),
    ];

    const diff = diffPolicies(oldRules, newRules);
    expect(diff.modified).toContain("a");
  });

  it("detects modification when enabled flag changes", () => {
    const oldRules = [makeRule({ id: "a", enabled: true })];
    const newRules = [makeRule({ id: "a", enabled: false })];

    const diff = diffPolicies(oldRules, newRules);
    expect(diff.modified).toContain("a");
  });

  it("detects modification when throttle changes", () => {
    const oldRules = [makeRule({ id: "a", throttle: { maxPerMinute: 10 } })];
    const newRules = [makeRule({ id: "a", throttle: { maxPerMinute: 20 } })];

    const diff = diffPolicies(oldRules, newRules);
    expect(diff.modified).toContain("a");
  });

  it("handles empty old and new arrays", () => {
    const diff = diffPolicies([], []);
    expect(diff.added).toHaveLength(0);
    expect(diff.removed).toHaveLength(0);
    expect(diff.modified).toHaveLength(0);
  });

  it("handles combined adds, removes, and modifications", () => {
    const oldRules = [
      makeRule({ id: "keep", priority: 10 }),
      makeRule({ id: "remove-me" }),
      makeRule({ id: "change-me", priority: 1 }),
    ];
    const newRules = [
      makeRule({ id: "keep", priority: 10 }),
      makeRule({ id: "add-me" }),
      makeRule({ id: "change-me", priority: 99 }),
    ];

    const diff = diffPolicies(oldRules, newRules);
    expect(diff.added).toContain("add-me");
    expect(diff.removed).toContain("remove-me");
    expect(diff.modified).toContain("change-me");
    expect(diff.added).not.toContain("keep");
    expect(diff.modified).not.toContain("keep");
  });
});
