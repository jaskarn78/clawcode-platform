/**
 * Phase 55 Plan 02 — per-Turn idempotent tool-result cache.
 *
 * LIFETIME
 *   One instance per Turn. The cache's internal Map is unreachable once the
 *   parent Turn goes out of scope (Turn.end() drops its reference — GC
 *   handles cleanup). By construction, there is NO cross-turn leak: a fresh
 *   Turn allocates a fresh Map.
 *
 * SCOPE
 *   Only whitelisted tool names (from `perf.tools.idempotent`, default
 *   IDEMPOTENT_TOOL_DEFAULTS in config/schema.ts — 4 entries, CONTEXT D-02
 *   locked) are CACHE-READ candidates. Non-whitelisted tools bypass the
 *   cache entirely in the MCP server wrapper (see `invokeWithCache` in
 *   src/mcp/server.ts). This class itself is indifferent to the whitelist —
 *   filtering is the caller's responsibility.
 *
 * MUTATION SAFETY
 *   `set` and `get` both return via a deep-frozen structured clone:
 *     - `set`  stores a frozen clone of the incoming value so callers cannot
 *       mutate the stored reference later.
 *     - `get`  always returns the stored (already frozen) reference — deep
 *       mutation attempts throw silently or no-op, never corrupting
 *       subsequent hits.
 *
 * CACHE KEY
 *   `${toolName}:${canonicalStringify(args)}` — deterministic, arg-order-
 *   insensitive via canonicalStringify's recursive key sort. See
 *   src/shared/canonical-stringify.ts for the key stability contract.
 *
 * TELEMETRY
 *   `hitCount()` reports the number of successful `get` calls (returning a
 *   defined value) on this Turn. Used by the session-adapter to infer which
 *   tool_call span ended in a cache hit (span closes AFTER the wrapper
 *   records the hit — delta detection pattern).
 */

import { canonicalStringify } from "../shared/canonical-stringify.js";

/**
 * Deep-freeze helper — returns a frozen clone at every level so mutations to
 * caller-visible references cannot poison subsequent cache hits.
 *
 * Primitives (string, number, boolean, null, undefined) pass through. Arrays
 * and plain objects are recursively cloned + frozen. Functions, BigInt, and
 * Symbols are returned as-is (not expected as tool results, but we stay
 * defensive rather than throwing).
 */
function deepFreezeClone<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    return Object.freeze(value.map((v) => deepFreezeClone(v))) as unknown as T;
  }
  // Plain object — recursively clone + freeze.
  const source = value as Record<string, unknown>;
  const clone: Record<string, unknown> = {};
  for (const key of Object.keys(source)) {
    clone[key] = deepFreezeClone(source[key]);
  }
  return Object.freeze(clone) as unknown as T;
}

/**
 * Per-Turn idempotent tool-result cache. One instance per Turn; lifetime
 * bound to the parent Turn's garbage-collection cycle.
 */
export class ToolCache {
  private readonly hits: Map<string, unknown> = new Map();
  private hits_count = 0;

  /**
   * Build the stable cache key for a tool call.
   *
   * Format: `${toolName}:${canonicalStringify(args)}`. canonicalStringify
   * sorts object keys recursively and coerces undefined/NaN to null, so
   * call-site argument-order does not affect the key.
   */
  static key(toolName: string, args: unknown): string {
    return `${toolName}:${canonicalStringify(args)}`;
  }

  /**
   * Store a cached value. The value is deep-frozen+cloned before storage so
   * the caller cannot later mutate the stored reference.
   *
   * Caller responsibility: only call `set` for whitelisted idempotent tools
   * and only on successful handler execution (failures must not poison the
   * cache).
   */
  set(toolName: string, args: unknown, value: unknown): void {
    this.hits.set(ToolCache.key(toolName, args), deepFreezeClone(value));
  }

  /**
   * Fetch a cached value for a tool call. Returns the deep-frozen clone
   * stored at `set` time, or `undefined` on miss.
   *
   * Successful (defined) gets increment the hit counter; misses do NOT.
   */
  get(toolName: string, args: unknown): unknown | undefined {
    const value = this.hits.get(ToolCache.key(toolName, args));
    if (value !== undefined) {
      this.hits_count++;
    }
    return value;
  }

  /** Total successful gets this Turn. Used for cache-hit span enrichment. */
  hitCount(): number {
    return this.hits_count;
  }
}
