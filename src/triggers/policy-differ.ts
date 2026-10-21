/**
 * Phase 62 Plan 01 — rule-ID-based policy differ.
 *
 * Compares two CompiledRule arrays by ID to detect added, removed, and
 * modified rules. Used by the hot-reload watcher (Plan 62-02) to generate
 * audit trail entries and operator-visible diffs.
 *
 * Template functions are excluded from comparison — only serializable
 * fields are checked (id, enabled, priority, source, target, throttle,
 * description).
 */

import type { CompiledRule } from "./policy-loader.js";

// ---------------------------------------------------------------------------
// PolicyDiff — the output shape
// ---------------------------------------------------------------------------

export type PolicyDiff = Readonly<{
  added: readonly string[];
  removed: readonly string[];
  modified: readonly string[];
}>;

// ---------------------------------------------------------------------------
// Deep equality for JSON-compatible values (reused pattern from config/differ.ts)
// ---------------------------------------------------------------------------

function isDeepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (a === undefined || b === undefined) return false;
  if (typeof a !== typeof b) return false;

  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((val, i) => isDeepEqual(val, b[i]));
  }

  if (typeof a === "object" && typeof b === "object") {
    const aObj = a as Record<string, unknown>;
    const bObj = b as Record<string, unknown>;
    const aKeys = Object.keys(aObj);
    const bKeys = Object.keys(bObj);
    if (aKeys.length !== bKeys.length) return false;
    return aKeys.every((key) => isDeepEqual(aObj[key], bObj[key]));
  }

  return false;
}

// ---------------------------------------------------------------------------
// Serializable snapshot — strips template function for comparison
// ---------------------------------------------------------------------------

type SerializableFields = {
  id: string;
  description?: string;
  enabled: boolean;
  priority: number;
  source: Readonly<{ kind?: string; id?: string }>;
  target: string;
  throttle?: Readonly<{ maxPerMinute: number }>;
};

function toSerializable(rule: CompiledRule): SerializableFields {
  return {
    id: rule.id,
    description: rule.description,
    enabled: rule.enabled,
    priority: rule.priority,
    source: rule.source,
    target: rule.target,
    throttle: rule.throttle,
  };
}

// ---------------------------------------------------------------------------
// diffPolicies — the entry point
// ---------------------------------------------------------------------------

/**
 * Diff two CompiledRule arrays by rule ID.
 *
 * @param oldRules Previous rule set.
 * @param newRules Updated rule set.
 * @returns PolicyDiff with added, removed, and modified rule IDs.
 */
export function diffPolicies(
  oldRules: readonly CompiledRule[],
  newRules: readonly CompiledRule[],
): PolicyDiff {
  const oldMap = new Map<string, CompiledRule>();
  for (const rule of oldRules) {
    oldMap.set(rule.id, rule);
  }

  const newMap = new Map<string, CompiledRule>();
  for (const rule of newRules) {
    newMap.set(rule.id, rule);
  }

  const added: string[] = [];
  const removed: string[] = [];
  const modified: string[] = [];

  // Find added and modified
  for (const [id, newRule] of newMap) {
    const oldRule = oldMap.get(id);
    if (!oldRule) {
      added.push(id);
    } else {
      const oldSer = toSerializable(oldRule);
      const newSer = toSerializable(newRule);
      if (!isDeepEqual(oldSer, newSer)) {
        modified.push(id);
      }
    }
  }

  // Find removed
  for (const id of oldMap.keys()) {
    if (!newMap.has(id)) {
      removed.push(id);
    }
  }

  return Object.freeze({ added, removed, modified });
}
