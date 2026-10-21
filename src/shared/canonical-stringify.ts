/**
 * Deterministic stable stringify for cache keys and prefix hashes.
 *
 * The Phase 55 intra-turn tool-result cache (Plan 55-02) keys entries by
 * `${tool_name}:${canonicalStringify(args)}`. The same logical argument set
 * MUST produce identical cache keys regardless of:
 *
 *   1. Object key-insertion order — `{b:1,a:2}` and `{a:2,b:1}` hash identically.
 *   2. Deeply-nested objects — key sorting is recursive.
 *   3. Primitive coercions — `undefined` → `null`, `NaN` → `null`.
 *
 * Array order IS preserved (arrays are order-significant).
 *
 * Rules (LOCKED — any change requires a CONTEXT amendment):
 *   - Object keys sorted recursively (alphabetical, case-sensitive, standard
 *     `String#localeCompare`-free `Array#sort` — matches JavaScript string
 *     comparison exactly).
 *   - `undefined` is normalized to `null` (null-safe hashing — important
 *     because JSON.stringify(undefined) returns the string "undefined" in
 *     object context and drops the key entirely in arrays, which is not
 *     hash-stable).
 *   - `NaN` is serialized as `"null"` (mirrors JSON.stringify's own NaN
 *     handling; prevents the invalid token `NaN` from leaking into a key).
 *   - Arrays preserve order; each element is recursively normalized.
 *   - Primitives (string / number / boolean) serialize via JSON.stringify
 *     directly.
 *
 * Used by: src/mcp/tool-cache.ts (Plan 55-02) for intra-turn cache keys.
 *
 * @param value - Any JSON-serializable value (objects, arrays, primitives,
 *                null, undefined). Functions, BigInt, and symbols are not
 *                supported (consistent with JSON.stringify).
 * @returns A deterministic JSON string safe to use as a cache key.
 */
export function canonicalStringify(value: unknown): string {
  return JSON.stringify(normalize(value));
}

/**
 * Recursively normalize a value for deterministic stringification.
 *
 * - `undefined`, `null`, `NaN` → `null` (all collapse to the same JSON null).
 * - Primitives → returned as-is.
 * - Arrays → elements normalized in place (order preserved).
 * - Objects → keys sorted alphabetically, values recursively normalized.
 */
function normalize(value: unknown): unknown {
  if (value === undefined) return null;
  if (value === null) return null;
  if (typeof value === "number" && Number.isNaN(value)) return null;
  if (typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => normalize(v));
  const obj = value as Record<string, unknown>;
  const sortedKeys = Object.keys(obj).sort();
  const result: Record<string, unknown> = {};
  for (const k of sortedKeys) {
    result[k] = normalize(obj[k]);
  }
  return result;
}
