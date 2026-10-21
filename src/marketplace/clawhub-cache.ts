/**
 * Phase 90 Plan 04 HUB-08 — in-memory TTL cache for ClawHub registry responses.
 *
 * Keyed by `{endpoint, query, cursor}` so the same search + page is served
 * from RAM within `ttlMs` (default 10 minutes per D-05; configurable via
 * `defaults.clawhubCacheTtlMs`).
 *
 * Two flavors of entries:
 *   - Positive: a successful response body. Expires after `ttlMs`.
 *   - Negative: a 429 rate-limit marker. `get()` returns kind:"rate-limited"
 *     until the `retryAfterMs` window closes. Lets subsequent picks fail fast
 *     without hitting the network (D-06).
 *
 * Daemon-scoped (no disk persistence) — boot resets. Acceptable since
 * browse responses are never hot-path.
 *
 * `now` is injectable for hermetic tests (HUB-CACHE-1, HUB-CACHE-2 rely on
 * it). Production callers omit it; defaults to Date.now.
 */

/**
 * Composite cache key. `query` and `cursor` are optional to let the catalog
 * loader issue the canonical "list first page, no query" request as
 * `{endpoint:"skills"}` with nothing else set.
 */
export type ClawhubCacheKey = Readonly<{
  endpoint: string;
  query?: string;
  cursor?: string;
}>;

/**
 * `get()` return type — callers branch on `.kind`:
 *   - "hit": fresh positive entry; `value` is the cached body.
 *   - "rate-limited": negative entry still inside the retry window.
 *     `retryAfterMs` is the REMAINING window (counts down as time advances).
 *   - "miss": no entry, or an expired one.
 */
export type ClawhubCacheHit<T> =
  | { readonly kind: "hit"; readonly value: T }
  | { readonly kind: "rate-limited"; readonly retryAfterMs: number }
  | { readonly kind: "miss" };

/**
 * Cache instance shape. Closed over its internal Map — never exposes the
 * raw Map to callers (prevents accidental key-shape divergence).
 */
export type ClawhubCache<T> = Readonly<{
  get(key: ClawhubCacheKey): ClawhubCacheHit<T>;
  set(key: ClawhubCacheKey, value: T): void;
  setNegative(key: ClawhubCacheKey, retryAfterMs: number): void;
}>;

// Internal entry: either a positive value (with `expiresAt`) or a negative
// sentinel (with `negativeUntil`). Exactly one of the two is non-null.
type Entry<T> = {
  expiresAt: number;
  value: T | null;
  negativeUntil: number | null;
};

/**
 * Build a cache keyed string from the composite key. Stable across
 * insertion/lookup (pipe-separated, undefined → empty segment).
 */
function keyOf(k: ClawhubCacheKey): string {
  return `${k.endpoint}|${k.query ?? ""}|${k.cursor ?? ""}`;
}

/**
 * Create a TTL-bounded ClawHub cache. Values live for `ttlMs` milliseconds;
 * negative entries live for their individual `retryAfterMs` window.
 *
 * `now` is injectable — production uses `Date.now`; tests pass a controlled
 * clock for deterministic expiry assertions.
 */
export function createClawhubCache<T>(
  ttlMs: number,
  now: () => number = () => Date.now(),
): ClawhubCache<T> {
  const map = new Map<string, Entry<T>>();

  return Object.freeze({
    get(k: ClawhubCacheKey): ClawhubCacheHit<T> {
      const key = keyOf(k);
      const entry = map.get(key);
      if (entry === undefined) return { kind: "miss" };
      const t = now();
      // Negative sentinel: still inside the rate-limit window?
      if (entry.negativeUntil !== null) {
        if (t < entry.negativeUntil) {
          return {
            kind: "rate-limited",
            retryAfterMs: entry.negativeUntil - t,
          };
        }
        // Negative window elapsed — evict and report miss.
        map.delete(key);
        return { kind: "miss" };
      }
      // Positive entry: within ttl?
      if (entry.value !== null && t < entry.expiresAt) {
        return { kind: "hit", value: entry.value };
      }
      // Expired — evict and report miss.
      map.delete(key);
      return { kind: "miss" };
    },
    set(k: ClawhubCacheKey, value: T): void {
      map.set(keyOf(k), {
        expiresAt: now() + ttlMs,
        value,
        negativeUntil: null,
      });
    },
    setNegative(k: ClawhubCacheKey, retryAfterMs: number): void {
      map.set(keyOf(k), {
        expiresAt: 0,
        value: null,
        negativeUntil: now() + retryAfterMs,
      });
    },
  });
}
