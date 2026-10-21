/**
 * Phase 62 Plan 01 — DSL-aware PolicyEvaluator.
 *
 * Replaces the Phase 60 pure-function evaluatePolicy with a stateful class
 * that holds compiled rules, Handlebars templates, and throttle state.
 *
 * evaluate() matches rules in priority order (highest first), applies source
 * glob matching, checks throttle, validates target is configured, and renders
 * the Handlebars payload template with event context.
 *
 * The backward-compatible `evaluatePolicy` function wrapper is preserved so
 * TriggerEngine can continue calling it until Plan 62-02 wires the class.
 */

import type { TriggerEvent } from "./types.js";
import type { CompiledRule } from "./policy-loader.js";
import { TokenBucket } from "./policy-throttle.js";

// ---------------------------------------------------------------------------
// PolicyResult — discriminated union for policy evaluation outcomes
// ---------------------------------------------------------------------------

export type PolicyResult =
  | Readonly<{ allow: true; targetAgent: string; payload: string; ruleId: string }>
  | Readonly<{ allow: false; reason: string }>;

// ---------------------------------------------------------------------------
// Glob matching — hand-rolled, supports trailing `*` only
// ---------------------------------------------------------------------------

/**
 * Match a value against a glob pattern supporting only trailing `*`.
 * Examples: "pipeline_*" matches "pipeline_clients", "*" matches anything.
 */
function globMatch(pattern: string, value: string): boolean {
  if (pattern === "*") return true;
  if (pattern.endsWith("*")) {
    return value.startsWith(pattern.slice(0, -1));
  }
  return pattern === value;
}

/**
 * Check if an event matches a rule's source filter.
 * If the rule has no source filter (empty object), it matches all events.
 */
function matchesSource(
  ruleSource: Readonly<{ kind?: string; id?: string }>,
  event: TriggerEvent,
): boolean {
  // Check kind match: both must be present for the check to apply
  if (ruleSource.kind !== undefined && event.sourceKind !== undefined) {
    if (!globMatch(ruleSource.kind, event.sourceKind)) {
      return false;
    }
  }
  // If rule specifies kind but event has no sourceKind, skip kind check (match)
  // This is lenient — allows events without sourceKind to still match kind rules

  // Check id match
  if (ruleSource.id !== undefined) {
    if (!globMatch(ruleSource.id, event.sourceId)) {
      return false;
    }
  }

  return true;
}

// ---------------------------------------------------------------------------
// PolicyEvaluator — the stateful DSL-aware evaluator class
// ---------------------------------------------------------------------------

export class PolicyEvaluator {
  private readonly rules: readonly CompiledRule[];
  private readonly throttles: Map<string, TokenBucket>;
  private configuredAgents: ReadonlySet<string>;

  constructor(
    rules: readonly CompiledRule[],
    configuredAgents?: ReadonlySet<string>,
  ) {
    // Rules are already sorted by priority desc from the loader,
    // but re-sort to be safe
    this.rules = [...rules].sort((a, b) => b.priority - a.priority);
    this.configuredAgents = configuredAgents ?? new Set();

    // Initialize throttle buckets for rules with throttle config
    this.throttles = new Map();
    for (const rule of this.rules) {
      if (rule.throttle) {
        this.throttles.set(rule.id, new TokenBucket(rule.throttle.maxPerMinute));
      }
    }
  }

  /**
   * Evaluate a trigger event against the loaded rules.
   *
   * 1. Filter to enabled rules
   * 2. Iterate in priority order (highest first)
   * 3. Match source filter (glob on kind + id)
   * 4. Check throttle
   * 5. Check configuredAgents
   * 6. Render Handlebars template
   * 7. Return frozen PolicyResult
   */
  evaluate(event: TriggerEvent): PolicyResult {
    for (const rule of this.rules) {
      // Skip disabled rules
      if (!rule.enabled) continue;

      // Check source match
      if (!matchesSource(rule.source, event)) continue;

      // First matching rule found — check throttle
      if (rule.throttle) {
        const bucket = this.throttles.get(rule.id);
        if (bucket && !bucket.tryConsume()) {
          return Object.freeze({
            allow: false as const,
            reason: `rule '${rule.id}' throttled`,
          });
        }
      }

      // Check target agent is configured
      if (!this.configuredAgents.has(rule.target)) {
        return Object.freeze({
          allow: false as const,
          reason: `target agent '${rule.target}' not configured`,
        });
      }

      // Render Handlebars template with event context
      const renderedPayload = rule.template({ event });

      return Object.freeze({
        allow: true as const,
        targetAgent: rule.target,
        payload: renderedPayload,
        ruleId: rule.id,
      });
    }

    // No matching rule
    return Object.freeze({
      allow: false as const,
      reason: "no matching rule",
    });
  }

  /** Update the set of configured agents (for config hot-reload). */
  updateConfiguredAgents(agents: ReadonlySet<string>): void {
    this.configuredAgents = agents;
  }
}

// ---------------------------------------------------------------------------
// evaluatePolicy — backward-compatible wrapper (Plan 62-02 replaces usage)
// ---------------------------------------------------------------------------

/**
 * Backward-compatible wrapper. Pass-through policy: if event.targetAgent
 * is configured, allow with the event's own payload stringified.
 *
 * Plan 62-02 will replace TriggerEngine's usage with the class instance.
 */
export function evaluatePolicy(
  event: TriggerEvent,
  configuredAgents: ReadonlySet<string>,
): PolicyResult {
  if (!configuredAgents.has(event.targetAgent)) {
    return Object.freeze({
      allow: false as const,
      reason: `target agent '${event.targetAgent}' not configured`,
    });
  }
  return Object.freeze({
    allow: true as const,
    targetAgent: event.targetAgent,
    payload:
      typeof event.payload === "string"
        ? event.payload
        : JSON.stringify(event.payload),
    ruleId: "__default__",
  });
}
