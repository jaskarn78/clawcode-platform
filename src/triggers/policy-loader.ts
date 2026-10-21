/**
 * Phase 62 Plan 01 — YAML parse + Zod validate + Handlebars compile pipeline.
 *
 * loadPolicies(yamlContent) is the single entry point used at daemon boot
 * and on each hot-reload. Returns CompiledRule[] sorted by priority descending.
 *
 * Throws PolicyValidationError on Zod parse failure (with .issues for
 * operator-friendly error messages). Throws on Handlebars syntax errors
 * at compile time — never at evaluate time.
 */

import { parse as parseYaml } from "yaml";
import Handlebars from "handlebars";

import {
  PolicyFileSchema,
  type PolicyRule,
  type PolicySource,
  type PolicyThrottle,
} from "./policy-schema.js";

// ---------------------------------------------------------------------------
// CompiledRule — the internal shape after validation + template compilation
// ---------------------------------------------------------------------------

export type CompiledRule = Readonly<{
  id: string;
  description?: string;
  enabled: boolean;
  priority: number;
  source: Readonly<{ kind?: string; id?: string }>;
  target: string;
  template: Handlebars.TemplateDelegate;
  throttle?: Readonly<{ maxPerMinute: number }>;
}>;

// ---------------------------------------------------------------------------
// PolicyValidationError — typed error for Zod validation failures
// ---------------------------------------------------------------------------

export class PolicyValidationError extends Error {
  public readonly issues: readonly unknown[];

  constructor(message: string, issues: readonly unknown[]) {
    super(message);
    this.name = "PolicyValidationError";
    this.issues = issues;
  }
}

// ---------------------------------------------------------------------------
// compileRule — compile a single raw PolicyRule into a CompiledRule
// ---------------------------------------------------------------------------

export function compileRule(raw: PolicyRule): CompiledRule {
  const template = Handlebars.compile(raw.payload, { noEscape: true });

  return Object.freeze({
    id: raw.id,
    description: raw.description,
    enabled: raw.enabled,
    priority: raw.priority,
    source: Object.freeze(raw.source ? { kind: raw.source.kind, id: raw.source.id } : {}),
    target: raw.target,
    template,
    throttle: raw.throttle
      ? Object.freeze({ maxPerMinute: raw.throttle.maxPerMinute })
      : undefined,
  });
}

// ---------------------------------------------------------------------------
// loadPolicies — the full pipeline
// ---------------------------------------------------------------------------

/**
 * Parse YAML, Zod-validate, compile Handlebars templates, sort by priority
 * descending, and freeze each rule.
 *
 * @param yamlContent Raw YAML string content of policies.yaml.
 * @returns Compiled rules sorted by priority (highest first).
 * @throws PolicyValidationError on Zod parse failure.
 * @throws Error on Handlebars syntax errors.
 */
export function loadPolicies(yamlContent: string): readonly CompiledRule[] {
  const parsed = parseYaml(yamlContent);

  const result = PolicyFileSchema.safeParse(parsed);
  if (!result.success) {
    throw new PolicyValidationError(
      `Invalid policy file: ${result.error.message}`,
      result.error.issues,
    );
  }

  const compiled = result.data.rules.map(compileRule);

  // Sort by priority descending (highest priority first)
  const sorted = [...compiled].sort((a, b) => b.priority - a.priority);

  return sorted;
}
