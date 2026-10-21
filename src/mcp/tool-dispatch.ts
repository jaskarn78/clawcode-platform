/**
 * Phase 55 Plan 02 — concurrency-capped parallel dispatch.
 *
 * Phase 115 Plan 07 ADDS: `dispatchTool` — daemon-side tool-response cache
 * dispatch boundary. See bottom of this file for the new export. The Phase
 * 55 `runWithConcurrencyLimit` + `ConcurrencyGate` exports stay unchanged
 * (still consumed by `invokeWithCache` in src/mcp/server.ts).
 *
 * Purpose
 *   When the Claude Agent SDK dispatches multiple tool_use blocks in the
 *   SAME assistant message batch, our MCP handlers (registered in
 *   src/mcp/server.ts) can execute them in parallel. This utility caps the
 *   in-flight count at `perf.tools.maxConcurrent` (default 10) using a
 *   simple worker-pool pattern, and returns per-handler outcomes via
 *   Promise.allSettled semantics so one failure does not block siblings.
 *
 * Implementation
 *   Lock-free worker pool: a shared `nextIndex` counter is advanced by each
 *   worker. `workerCount = min(maxConcurrent, handlers.length)` workers
 *   loop until the shared counter is exhausted. No polling, no setInterval;
 *   only native promise scheduling.
 *
 * Error Isolation
 *   Each handler's outcome is captured as `{status: "fulfilled", value}` or
 *   `{status: "rejected", reason}`. Unhandled rejections cannot escape
 *   because we catch inside the worker. Behaviour matches Promise.allSettled
 *   but with a concurrency cap.
 *
 * Result Ordering
 *   Results are placed into the output array at their input index, so the
 *   returned array is ALWAYS in input order regardless of completion
 *   order.
 */

export async function runWithConcurrencyLimit<T>(
  handlers: ReadonlyArray<() => Promise<T>>,
  maxConcurrent: number,
): Promise<ReadonlyArray<PromiseSettledResult<T>>> {
  if (handlers.length === 0) return [];
  if (maxConcurrent <= 0) {
    throw new Error(
      `runWithConcurrencyLimit: maxConcurrent must be >= 1 (got ${maxConcurrent})`,
    );
  }

  const results: PromiseSettledResult<T>[] = new Array(handlers.length);
  let nextIndex = 0;

  const worker = async (): Promise<void> => {
    while (true) {
      const i = nextIndex++;
      if (i >= handlers.length) return;
      try {
        const value = await handlers[i]!();
        results[i] = { status: "fulfilled", value };
      } catch (reason) {
        results[i] = { status: "rejected", reason };
      }
    }
  };

  const workerCount = Math.min(maxConcurrent, handlers.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

/**
 * ConcurrencyGate — per-agent semaphore for gating individual tool invocations.
 *
 * Motivation
 *   The Claude Agent SDK dispatches multiple `tool_use` blocks in parallel — our
 *   MCP handler is invoked concurrently for each. `runWithConcurrencyLimit`
 *   above gates a known array of handlers (call-site batch), but at the MCP
 *   transport boundary handler invocations arrive as independent async calls.
 *   A semaphore is the natural fit: each call `await`s acquire(), runs, then
 *   calls release() in a `finally`.
 *
 * Semantics
 *   - `acquire()` resolves when in-flight count < limit; increments count.
 *   - Returned release function decrements count and wakes the next waiter.
 *   - FIFO fairness — waiters resolve in enqueue order.
 *   - Reentrant-safe: each acquire returns its own release fn; double-release
 *     on the SAME call is a no-op (idempotent).
 *
 * Usage
 *   ```ts
 *   const gate = new ConcurrencyGate(10);
 *   const release = await gate.acquire();
 *   try { return await rawCall(); } finally { release(); }
 *   ```
 */
export class ConcurrencyGate {
  readonly #limit: number;
  #inFlight = 0;
  readonly #waiters: Array<() => void> = [];

  constructor(limit: number) {
    if (limit <= 0 || !Number.isFinite(limit)) {
      throw new Error(
        `ConcurrencyGate: limit must be a positive finite integer (got ${limit})`,
      );
    }
    this.#limit = limit;
  }

  /** Current number of in-flight acquirers. Test-only accessor. */
  get inFlight(): number {
    return this.#inFlight;
  }

  /** Configured concurrency limit. Test-only accessor. */
  get limit(): number {
    return this.#limit;
  }

  /**
   * Acquire a slot. Returns a one-shot release function.
   *
   * When in-flight count < limit, resolves immediately.
   * Otherwise queues until a slot frees up.
   */
  async acquire(): Promise<() => void> {
    if (this.#inFlight < this.#limit) {
      this.#inFlight += 1;
      return this.#makeReleaseFn();
    }

    await new Promise<void>((resolve) => {
      this.#waiters.push(resolve);
    });
    this.#inFlight += 1;
    return this.#makeReleaseFn();
  }

  #makeReleaseFn(): () => void {
    let released = false;
    return () => {
      if (released) return; // idempotent
      released = true;
      this.#inFlight -= 1;
      const nextWaiter = this.#waiters.shift();
      if (nextWaiter) nextWaiter();
    };
  }
}

/* ────────────────────────────────────────────────────────────────────── *
 *  Phase 115 Plan 07 sub-scope 15 — daemon-side tool-response cache       *
 *  dispatch (folds Phase 999.40)                                          *
 * ────────────────────────────────────────────────────────────────────── */

import type { Logger } from "pino";
import type { ToolCacheStore, PutRow } from "./tool-cache-store.js";
import {
  buildCacheKey,
  resolveToolCachePolicy,
  stampCachedResponse,
  type CacheKeyStrategy,
  type CacheStamped,
  type ToolCachePolicy,
} from "./tool-cache-policy.js";

/**
 * Trace recording surface for tool-cache hits / misses. Mirrors the
 * `recordLazyRecallCall` pattern in trace-collector.ts (Plan 115-05 T04).
 *
 * Both methods are best-effort — failures NEVER block the dispatch path.
 */
export interface ToolCacheTraceRecorder {
  recordToolCacheHit(agent: string, tool: string): void;
  recordToolCacheMiss(agent: string, tool: string): void;
}

/**
 * Dispatch options for the daemon-side tool-cache wrapper.
 *
 * `upstream` is the underlying tool invocation — runs ONLY on cache miss.
 * The result is JSON-stringified for storage; ensure the upstream returns
 * a JSON-serializable value (or a frozen plain object).
 */
export interface DispatchToolOptions<T> {
  readonly tool: string;
  readonly args: Record<string, unknown>;
  readonly agentName: string;
  readonly cacheStore: ToolCacheStore;
  readonly maxSizeMb: number;
  readonly userPolicy?: Readonly<
    Record<
      string,
      Partial<{ ttlSeconds: number; keyStrategy: CacheKeyStrategy }>
    >
  >;
  readonly upstream: () => Promise<T>;
  readonly log?: Logger;
  readonly traceCollector?: ToolCacheTraceRecorder;
}

/**
 * dispatchTool — daemon-side cache-aware tool invocation.
 *
 * Flow (per Phase 115 sub-scope 15 spec):
 *   1. If `args.bypass_cache === true` → upstream call, no cache touch.
 *   2. Resolve effective policy (defaults + operator overrides).
 *   3. If `keyStrategy === "no-cache"` OR `ttlSeconds <= 0` → upstream, no cache.
 *   4. If policy.cacheable(args) returns false → upstream, no cache (e.g.
 *      mysql_query write-shaped query).
 *   5. Build cache key via the policy's keyStrategy:
 *        per-agent  → key includes agentName (Phase 90 lock)
 *        cross-agent → key OMITS agentName (public data shared)
 *   6. Cache GET. On hit:
 *        - record trace hit
 *        - return stamped response: { cached: { age_ms, source }, data }
 *   7. Cache MISS: run upstream, store result with TTL, record trace miss,
 *      return RAW upstream result (unwrapped — agents tell hits from misses
 *      by the presence of the `cached` envelope).
 *
 * Per-agent vs cross-agent isolation is grep-verifiable:
 *   - agent_or_null: agentName  (per-agent put — Phase 90 isolation)
 *   - agent_or_null: null       (cross-agent put — shared public data)
 *
 * Failure isolation: cache GET / PUT errors NEVER fail the upstream call.
 * The cache is a perf optimization, not a correctness boundary.
 *
 * M5 WIRING NOTE — `dispatchTool` is invoked from the daemon IPC boundary
 * (`daemon.ts`: search-tool-call / image-tool-call / search-documents). The
 * `mysql_query` (60s, read-only-gated) and `google_workspace_*` policies in
 * `tool-cache-policy.ts` are LIVE + fully unit-tested HERE (see
 * tool-cache-isolation.test.ts: read-only gate + per-agent isolation) but are
 * NOT YET REACHED in production: those tools are EXTERNAL stdio MCP servers
 * (`mcp__acme-db__mysql_query`, injected via `transformMcpServersForSdk`)
 * that the agent calls directly — their tool calls never cross the daemon IPC
 * boundary where `dispatchTool` lives. Realizing the "eliminate 120s
 * mysql_query p50" win requires a daemon-owned caching MCP proxy in FRONT of
 * acme-db that forwards each call through `dispatchTool` (option A in
 * `.planning/audit-fixes/medium/PLAN.md` + `RUNBOOK.md`). This function is the
 * ready, tested seam that proxy will call — adding a `dispatchTool` call site
 * in `daemon.ts` for mysql today would be DEAD CODE (no IPC method routes it).
 */
export async function dispatchTool<T>(
  opts: DispatchToolOptions<T>,
): Promise<T | CacheStamped<T>> {
  const {
    tool,
    args,
    agentName,
    cacheStore,
    maxSizeMb,
    userPolicy,
    upstream,
    log,
    traceCollector,
  } = opts;

  // 1. Explicit bypass — agent forces a fresh call.
  if (args.bypass_cache === true) {
    log?.debug(
      { tool, agent: agentName, action: "tool-cache-bypass" },
      "[diag] tool-cache-bypass",
    );
    return upstream();
  }

  // 2. Resolve effective policy (defaults + operator overrides).
  const effectivePolicy: ToolCachePolicy = resolveToolCachePolicy(
    tool,
    userPolicy,
  );

  // 3. No-cache strategy or zero TTL — bypass entirely.
  if (
    effectivePolicy.keyStrategy === "no-cache" ||
    effectivePolicy.ttlSeconds <= 0
  ) {
    return upstream();
  }

  // 4. Content-validation gate (e.g., mysql_query writes).
  if (effectivePolicy.cacheable && !effectivePolicy.cacheable(args)) {
    log?.debug(
      { tool, agent: agentName, action: "tool-cache-skip-not-cacheable" },
      "[diag] tool-cache-skip",
    );
    return upstream();
  }

  // 5. Build cache key. Strip bypass_cache from key components — it's a
  // dispatch flag, not a content discriminator.
  const argsForKey: Record<string, unknown> = { ...args };
  delete argsForKey.bypass_cache;
  const key = buildCacheKey(
    tool,
    argsForKey,
    agentName,
    effectivePolicy.keyStrategy,
  );

  // 6. Cache GET. Failure-isolated.
  let hit: ReturnType<ToolCacheStore["get"]> = null;
  try {
    hit = cacheStore.get(key);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown";
    log?.warn(
      { tool, agent: agentName, err: msg, action: "tool-cache-get-failed" },
      "[diag] tool-cache get failed (non-fatal); falling through to upstream",
    );
  }

  if (hit) {
    try {
      traceCollector?.recordToolCacheHit(agentName, tool);
    } catch {
      // Trace recording failures must never affect dispatch.
    }
    let cachedData: T;
    try {
      cachedData = JSON.parse(hit.response_json) as T;
    } catch (err) {
      // Corrupt row — drop and fall through to upstream. Defence-in-depth.
      const msg = err instanceof Error ? err.message : "unknown";
      log?.warn(
        { tool, agent: agentName, err: msg, action: "tool-cache-corrupt-row" },
        "[diag] tool-cache row failed to parse (non-fatal); falling through",
      );
      try {
        cacheStore.clear(); // cheap fallback for the rare corruption case
      } catch {
        /* ignore */
      }
      return upstreamWithStore({
        tool,
        args,
        agentName,
        cacheStore,
        maxSizeMb,
        upstream,
        effectivePolicy,
        key,
        traceCollector,
        log,
      });
    }
    return stampCachedResponse(cachedData, hit.created_at);
  }

  // 7. Cache MISS — run upstream and write the result.
  try {
    traceCollector?.recordToolCacheMiss(agentName, tool);
  } catch {
    /* trace recording is best-effort */
  }
  return upstreamWithStore({
    tool,
    args,
    agentName,
    cacheStore,
    maxSizeMb,
    upstream,
    effectivePolicy,
    key,
    traceCollector,
    log,
  });
}

/**
 * Internal helper — runs the upstream call and writes the result into the
 * cache. Extracted so the corrupt-row fallback path in `dispatchTool` can
 * reuse the same write logic without duplicating the put-row construction.
 *
 * The two `agent_or_null` literal patterns in this function are
 * grep-verifiable per the Plan 115-07 acceptance criteria:
 *   - Per-agent path: `agent_or_null: agentName`
 *   - Cross-agent path: `agent_or_null: null`
 */
async function upstreamWithStore<T>(opts: {
  tool: string;
  args: Record<string, unknown>;
  agentName: string;
  cacheStore: ToolCacheStore;
  maxSizeMb: number;
  upstream: () => Promise<T>;
  effectivePolicy: ToolCachePolicy;
  key: string;
  traceCollector?: ToolCacheTraceRecorder;
  log?: Logger;
}): Promise<T> {
  const {
    tool,
    agentName,
    cacheStore,
    maxSizeMb,
    upstream,
    effectivePolicy,
    key,
    log,
  } = opts;
  const result = await upstream();
  const now = Date.now();
  const expiresAt = now + effectivePolicy.ttlSeconds * 1000;

  let putRow: PutRow;
  if (effectivePolicy.keyStrategy === "per-agent") {
    // Per-agent isolation (Phase 90 lock) — store the agent name with the row
    // so inspect/clear can filter by agent. The cache KEY already includes
    // the agent (built by buildCacheKey), so the agent_or_null column is
    // primarily for operator introspection + cross-agent leak detection.
    putRow = {
      key,
      tool,
      agent_or_null: agentName,
      response_json: safeStringify(result),
      created_at: now,
      expires_at: expiresAt,
    };
  } else {
    // Cross-agent shared (public data) — store NULL so two agents calling
    // the same tool with the same args produce ONE row. The cache KEY also
    // omits the agent (built by buildCacheKey), so two agents converge on
    // the same key + same row.
    putRow = {
      key,
      tool,
      agent_or_null: null,
      response_json: safeStringify(result),
      created_at: now,
      expires_at: expiresAt,
    };
  }

  try {
    cacheStore.put(putRow, maxSizeMb);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown";
    log?.warn(
      { tool, agent: agentName, err: msg, action: "tool-cache-put-failed" },
      "[diag] tool-cache put failed (non-fatal); response returned uncached",
    );
  }
  return result;
}

/**
 * Defensive JSON.stringify — converts undefined / functions / symbols to
 * stable null. Errors return an empty object so a single broken response
 * shape can't poison the rest of the pipeline.
 */
function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(
      value,
      (_key, v) => (typeof v === "bigint" ? v.toString() : v),
      0,
    );
  } catch {
    return "{}";
  }
}
