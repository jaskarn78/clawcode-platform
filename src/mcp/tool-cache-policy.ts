/**
 * Phase 115 Plan 07 sub-scope 15 — tool-response cache policy table.
 *
 * Per-tool TTL + key-strategy table. Defines:
 *   - which tools cache and which don't (TTL = 0 → never cache),
 *   - which tools are per-agent vs cross-agent (the BLOCKING-CRITICAL
 *     isolation invariant — see PLAN.md acceptance criteria),
 *   - mysql_query write-pattern detector (caches ONLY read-shaped queries),
 *   - cache-stamping helper for cached responses (`cached: { age_ms, source }`).
 *
 * # Per-agent vs cross-agent (BLOCKING-CRITICAL)
 *
 * Per Phase 90 lock + roadmap line 857 — `search_documents` is per-agent
 * (cache key includes `agent_name`); `web_search` / `brave_search` /
 * `exa_search` are cross-agent OK (cache key OMITS `agent_name`, public
 * data shared across agents). Both keying strategies must be
 * grep-verifiable in this file (and in tool-dispatch.ts at the put-call
 * sites).
 *
 * # Per-tool defaults (per roadmap line 857)
 *
 *   web_search                  → 300s,  cross-agent
 *   brave_search                → 300s,  cross-agent
 *   exa_search                  → 300s,  cross-agent
 *   search_documents            → 1800s, per-agent      (Phase 90 isolation)
 *   mysql_query                 → 60s,   per-agent      (read-only via isReadOnlySql)
 *   google_workspace_*_get      → 300s,  per-agent
 *   image_generate              → 0      (never cache — unique work each call)
 *   spawn_subagent_thread       → 0      (never cache — unique work each call)
 *
 * Operators can override per-tool via `clawcode.yaml`:
 *   defaults.toolCache.policy.<tool_name>: { ttlSeconds, keyStrategy }
 */

import { createHash } from "crypto";

/**
 * Cache key strategy.
 *
 * - `per-agent` — cache key INCLUDES the agent name. Two agents calling the
 *   same tool with the same args produce DIFFERENT keys, so they never see
 *   each other's results. Required for `search_documents` and any tool whose
 *   results depend on per-agent state (per-agent corpora, per-agent
 *   credentials).
 *
 * - `cross-agent` — cache key OMITS the agent name. Two agents calling the
 *   same tool with the same args produce the SAME key, so the second caller
 *   gets the first caller's cached result. Safe ONLY for tools that return
 *   public data (web search results) where cross-agent sharing is not an
 *   isolation breach.
 *
 * - `no-cache` — never cache, regardless of TTL. Equivalent to `ttlSeconds:
 *   0` but signals intent more loudly in policy tables.
 */
export type CacheKeyStrategy = "per-agent" | "cross-agent" | "no-cache";

/**
 * Per-tool cache policy.
 *
 * `cacheable` is an OPTIONAL gate evaluated AFTER the strategy check. When
 * present and returning false, the call bypasses the cache regardless of
 * TTL — used by `mysql_query` to refuse caching write-shaped queries.
 */
export interface ToolCachePolicy {
  readonly ttlSeconds: number;
  readonly keyStrategy: CacheKeyStrategy;
  readonly cacheable?: (args: Record<string, unknown>) => boolean;
}

/**
 * DEFAULT_TOOL_CACHE_POLICY — per roadmap line 857.
 *
 * Locked invariants (verified by tests):
 *   - web_search / brave_search / exa_search: cross-agent (public data)
 *   - search_documents: per-agent (Phase 90 isolation)
 *   - mysql_query: per-agent + isReadOnlySql gate
 *   - google_workspace_*_get: per-agent (per-account credentials)
 *   - image_generate / spawn_subagent_thread: no-cache
 */
export const DEFAULT_TOOL_CACHE_POLICY: Readonly<
  Record<string, ToolCachePolicy>
> = Object.freeze({
  // Public web data — cross-agent shared, 5min.
  web_search:                    { ttlSeconds: 300,  keyStrategy: "cross-agent" },
  brave_search:                  { ttlSeconds: 300,  keyStrategy: "cross-agent" },
  exa_search:                    { ttlSeconds: 300,  keyStrategy: "cross-agent" },
  // Phase 71 IPC name parity — search_results is the alias the IPC layer uses
  // for the unified search flow. Same TTL/strategy as web_search.
  web_fetch_url:                 { ttlSeconds: 300,  keyStrategy: "cross-agent" },

  // Per-agent document corpus — 30min, agent-scoped (Phase 90 lock).
  search_documents:              { ttlSeconds: 1800, keyStrategy: "per-agent" },

  // mysql_query — 60s read-only patterns; never cache writes.
  mysql_query:                   {
    ttlSeconds: 60,
    keyStrategy: "per-agent",
    cacheable: (args) =>
      isReadOnlySql(typeof args.query === "string" ? args.query : ""),
  },

  // Google workspace — get-shaped only, 5min, per-account isolation.
  google_workspace_drive_get:    { ttlSeconds: 300,  keyStrategy: "per-agent" },
  google_workspace_calendar_get: { ttlSeconds: 300,  keyStrategy: "per-agent" },
  google_workspace_gmail_get:    { ttlSeconds: 300,  keyStrategy: "per-agent" },

  // Image generation + subagent threads — NEVER cache (each call unique work).
  image_generate:                { ttlSeconds: 0,    keyStrategy: "no-cache" },
  image_edit:                    { ttlSeconds: 0,    keyStrategy: "no-cache" },
  image_variations:              { ttlSeconds: 0,    keyStrategy: "no-cache" },
  spawn_subagent_thread:         { ttlSeconds: 0,    keyStrategy: "no-cache" },
});

/**
 * mysql_query write-pattern detector.
 *
 * Caches ONLY when the query is a clear READ pattern (starts with SELECT /
 * WITH / SHOW / DESCRIBE / EXPLAIN at trim-and-lower).
 *
 * Refuses caching when ANY write keyword appears anywhere in the query —
 * this is intentionally STRICT to defend against CTE-then-write patterns
 * like `WITH foo AS (SELECT 1) UPDATE bar ...` where the leading token
 * passes the read check but the actual statement mutates state.
 *
 * False positives (read queries with `update` / `insert` etc. in literal
 * data values) are acceptable — they cause a cache miss, not a stale-data
 * read. False negatives (write queries cached as reads) are NOT acceptable
 * because they would serve stale state after writes.
 */
export function isReadOnlySql(query: string): boolean {
  const trimmed = query.trim().toLowerCase();
  if (!trimmed) return false;

  // Hard reject: any leading verb that is not a read.
  if (
    /^(insert|update|delete|drop|alter|truncate|replace|create|grant|revoke|merge|call|exec|execute|do|load|set)\b/.test(
      trimmed,
    )
  ) {
    return false;
  }

  // Defence-in-depth: refuse anything that contains a write keyword anywhere.
  // This catches CTE-then-write patterns like `WITH x AS (SELECT 1) UPDATE bar ...`.
  // Word-boundary anchors keep us from rejecting `select * from updated_at_log`.
  if (
    /\b(update|insert|delete|drop|alter|truncate|replace into|grant|revoke|merge into)\b/.test(
      trimmed,
    )
  ) {
    return false;
  }

  // Accept only known read shapes.
  return /^(select|with|show|describe|desc|explain|values|table)\b/.test(
    trimmed,
  );
}

/**
 * Build cache key from tool name + args + agent context + strategy.
 *
 * Two strategies, each grep-verifiable in this file:
 *   - per-agent: components include `agentName` → distinct keys per agent.
 *   - cross-agent: components OMIT `agentName` → identical keys across agents.
 *
 * Hash: sha256 of stable-stringified components, hex-truncated to 32 chars.
 * Prefixed with the tool name so eyeballing keys in the DB shows which tool
 * a row belongs to without a JOIN.
 */
export function buildCacheKey(
  tool: string,
  args: Record<string, unknown>,
  agentName: string,
  strategy: CacheKeyStrategy,
): string {
  if (strategy === "no-cache") {
    // Defensive — callers should not invoke buildCacheKey for no-cache
    // tools, but if they do, return a key that will never match a stored
    // row (no row gets written for no-cache strategy).
    return `${tool}:no-cache:${stableStringify(args).slice(0, 16)}`;
  }

  const argsJson = stableStringify(args);
  // per-agent: key components INCLUDE agent name.
  // cross-agent: key components OMIT agent name (public data shared).
  const components =
    strategy === "per-agent"
      ? [tool, agentName, argsJson]
      : [tool, argsJson];

  const hash = createHash("sha256")
    .update(components.join("\x1f")) // ASCII unit separator — never appears in tool/agent names
    .digest("hex");

  const prefix =
    strategy === "per-agent" ? `${tool}:${agentName.slice(0, 12)}:` : `${tool}:`;
  return `${prefix}${hash.slice(0, 32)}`;
}

/**
 * Stable JSON stringify with sorted object keys.
 *
 * Required so `{ a: 1, b: 2 }` and `{ b: 2, a: 1 }` produce the same cache
 * key — otherwise call-site argument order (which the SDK does not
 * guarantee) would cause spurious misses.
 *
 * Handles primitives, arrays, plain objects. Functions / symbols / BigInt
 * fall through JSON.stringify's default behavior (function returns
 * undefined, BigInt throws — neither expected in tool args).
 */
function stableStringify(obj: unknown): string {
  if (obj === null || typeof obj !== "object") return JSON.stringify(obj);
  if (Array.isArray(obj)) {
    return `[${obj.map(stableStringify).join(",")}]`;
  }
  const keys = Object.keys(obj as Record<string, unknown>).sort();
  return `{${keys
    .map(
      (k) =>
        JSON.stringify(k) +
        ":" +
        stableStringify((obj as Record<string, unknown>)[k]),
    )
    .join(",")}}`;
}

/**
 * Cache-stamped response shape.
 *
 * When a cache HIT serves a response, the response is wrapped in this
 * envelope so the calling agent can detect / handle staleness:
 *
 *   { cached: { age_ms: 4712, source: "tool-cache" }, data: <original> }
 *
 * Cache MISS responses are NOT wrapped — they pass through unchanged. This
 * matches Anthropic's prompt-cache hit detection pattern: agents see the
 * `cached` envelope as the indicator and can decide whether to trust or
 * re-call with `bypass_cache: true`.
 */
export interface CacheStamped<T> {
  readonly cached: { readonly age_ms: number; readonly source: "tool-cache" };
  readonly data: T;
}

/**
 * Wrap a cached response with the staleness stamp.
 *
 * `createdAtMs` is the row's `created_at` timestamp; the age is computed
 * relative to `Date.now()` at stamping time.
 */
export function stampCachedResponse<T>(
  data: T,
  createdAtMs: number,
): CacheStamped<T> {
  return Object.freeze({
    cached: Object.freeze({
      age_ms: Math.max(0, Date.now() - createdAtMs),
      source: "tool-cache" as const,
    }),
    data,
  });
}

/**
 * Resolve the effective policy for a tool, applying operator overrides on
 * top of DEFAULT_TOOL_CACHE_POLICY. Tools without a default policy AND
 * without an override fall through to a no-cache stub — the dispatch layer
 * will see `keyStrategy === "no-cache"` and bypass.
 *
 * `userPolicy` shape mirrors the zod schema in src/config/schema.ts:
 *   defaults.toolCache.policy: Record<string, Partial<ToolCachePolicy>>
 */
export function resolveToolCachePolicy(
  tool: string,
  userPolicy?: Readonly<
    Record<
      string,
      Partial<{ ttlSeconds: number; keyStrategy: CacheKeyStrategy }>
    >
  >,
): ToolCachePolicy {
  const baseDefault: ToolCachePolicy =
    DEFAULT_TOOL_CACHE_POLICY[tool] ??
    Object.freeze({ ttlSeconds: 0, keyStrategy: "no-cache" as const });
  const override = userPolicy?.[tool];
  if (!override) return baseDefault;

  return Object.freeze({
    ttlSeconds: override.ttlSeconds ?? baseDefault.ttlSeconds,
    keyStrategy: override.keyStrategy ?? baseDefault.keyStrategy,
    cacheable: baseDefault.cacheable, // Operator overrides cannot patch the predicate
  });
}
