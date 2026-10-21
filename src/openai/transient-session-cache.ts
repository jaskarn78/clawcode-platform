/**
 * Phase 74 Plan 01 — Transient-session LRU + TTL cache.
 *
 * Holds per-caller persistent SessionHandles keyed on
 * `(bearer_key_hash, caller_slug, soul_fingerprint, tier)`. Evicted entries
 * ALWAYS call `handle.close()` before dropping — fire-and-forget with error
 * isolation so cache invariants hold even if a handle's close() rejects or
 * throws synchronously.
 *
 * Design notes:
 *   - LRU recency is tracked via the Map's insertion order: `get(k)` deletes
 *     then re-inserts to move `k` to the tail; `set(k, h)` appends.
 *   - TTL is checked at `get()` time (reap-on-read). A background timer
 *     would add complexity with no benefit here — idle entries stay in
 *     memory until the next access, at which point they're closed + dropped.
 *   - Eviction reasons tracked for logging: "lru", "ttl", "replace".
 *   - `closeAll()` is idempotent — second call is a no-op.
 *
 * Matches 74-CONTEXT D-03: key = (bearer, slug, sha256(SOUL).slice(0,16), tier),
 * 30-minute idle TTL (operator-tunable via env; wired in endpoint-bootstrap.ts).
 */

import type { SessionHandle } from "../manager/session-adapter.js";

/** Four-part cache key — hashed/composed via makeTransientCacheKey(). */
export interface TransientCacheKeyParts {
  readonly keyHash: string;
  readonly callerSlug: string;
  readonly soulFp: string;
  readonly tier: string;
}

/** Compose a stable cache key string. "::" separator is safe — none of the
 *  four components can contain "::" by construction (keyHash is hex,
 *  callerSlug is slug-regex-validated, soulFp is hex, tier is a literal). */
export function makeTransientCacheKey(parts: TransientCacheKeyParts): string {
  return `${parts.keyHash}::${parts.callerSlug}::${parts.soulFp}::${parts.tier}`;
}

export interface TransientCacheOptions {
  /** LRU cap (minimum 1). Default configured at construction site. */
  readonly maxSize: number;
  /** Idle TTL in ms. 0 disables TTL (LRU only). */
  readonly ttlMs: number;
  /** Dependency-injected clock for deterministic tests. Default: Date.now. */
  readonly now?: () => number;
  /** Optional structured logger for eviction diagnostics. */
  readonly log?: {
    warn: (obj: Record<string, unknown>, msg?: string) => void;
  };
}

interface CacheEntry {
  readonly handle: SessionHandle;
  lastAccessMs: number;
}

/**
 * LRU + TTL cache for per-caller persistent session handles.
 *
 * Contract:
 *   - `get(k)` returns the handle and refreshes its LRU position. If the
 *     entry is past TTL, it is evicted (close() fired) and `undefined`
 *     returned.
 *   - `set(k, h)` inserts. If `k` already exists, the previous handle is
 *     closed first. If size exceeds maxSize, the LRU entry is closed + dropped.
 *   - `closeAll()` closes every cached handle concurrently (Promise.allSettled)
 *     and leaves the cache in `closed` state (subsequent `set()` also closes
 *     the inbound handle defensively; `get()` returns undefined).
 *
 * Observational: handle.close() errors are logged + swallowed. Cache state
 * is NEVER corrupted by a handle.close() failure.
 */
export class TransientSessionCache {
  private readonly map = new Map<string, CacheEntry>(); // insertion-order = LRU order
  private readonly maxSize: number;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly log?: TransientCacheOptions["log"];
  private closed = false;

  constructor(opts: TransientCacheOptions) {
    this.maxSize = Math.max(1, opts.maxSize);
    this.ttlMs = Math.max(0, opts.ttlMs);
    this.now = opts.now ?? (() => Date.now());
    this.log = opts.log;
  }

  /** Current number of cached entries. */
  size(): number {
    return this.map.size;
  }

  /**
   * Look up a handle by key. Returns undefined on miss OR on TTL-expiry
   * (in which case the expired entry's handle is closed before the undefined
   * return). Hit refreshes LRU recency.
   */
  get(key: string): SessionHandle | undefined {
    if (this.closed) return undefined;
    const entry = this.map.get(key);
    if (!entry) return undefined;
    if (this.ttlMs > 0 && this.now() - entry.lastAccessMs > this.ttlMs) {
      this.evictEntry(key, entry, "ttl");
      return undefined;
    }
    // LRU touch: delete + re-insert to move to tail.
    this.map.delete(key);
    entry.lastAccessMs = this.now();
    this.map.set(key, entry);
    return entry.handle;
  }

  /**
   * Insert or replace the handle for `key`. If replacing, the old handle
   * is closed first. If the cache is at capacity, the LRU entry is evicted
   * (its handle closed) before the new entry is appended.
   */
  set(key: string, handle: SessionHandle): void {
    if (this.closed) {
      // Defensive: cache is closed — don't retain the handle.
      void handle.close().catch(() => {
        /* post-shutdown close failure is non-fatal */
      });
      return;
    }
    // If already present, close the old handle before replacing.
    const existing = this.map.get(key);
    if (existing) {
      this.evictEntry(key, existing, "replace");
    }
    this.map.set(key, { handle, lastAccessMs: this.now() });
    while (this.map.size > this.maxSize) {
      const oldestKey = this.map.keys().next().value;
      if (oldestKey === undefined) break;
      const oldest = this.map.get(oldestKey);
      if (!oldest) break;
      this.evictEntry(oldestKey, oldest, "lru");
    }
  }

  /**
   * Close + drop every cached handle. Safe to call twice; second invocation
   * is a no-op. Resolves after all handle.close() promises settle.
   */
  async closeAll(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const entries = Array.from(this.map.values());
    this.map.clear();
    await Promise.allSettled(
      entries.map((e) =>
        Promise.resolve()
          .then(() => e.handle.close())
          .catch((err) => {
            this.log?.warn(
              { err },
              "transient-session-cache: handle.close() rejected during closeAll",
            );
          }),
      ),
    );
  }

  /**
   * Remove `key` from the map and close its handle. Errors from close()
   * are caught + logged; cache-state invariants still hold.
   */
  private evictEntry(
    key: string,
    entry: CacheEntry,
    reason: "lru" | "ttl" | "replace",
  ): void {
    this.map.delete(key);
    try {
      void Promise.resolve()
        .then(() => entry.handle.close())
        .catch((err) => {
          this.log?.warn(
            { err, reason },
            "transient-session-cache: handle.close() rejected",
          );
        });
    } catch (err) {
      this.log?.warn(
        { err, reason },
        "transient-session-cache: handle.close() threw synchronously",
      );
    }
  }
}
