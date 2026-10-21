/**
 * Phase 999.10 — IPC handler for `secrets-status` + `secrets-invalidate`.
 *
 * Factored out of daemon.ts so the case branches stay one-liners and the
 * handler logic is unit-testable without booting the full IPC server. The
 * pattern mirrors `daemon-rate-limit-ipc.ts` (Phase 103) — a small handler
 * module receives the singleton + zod-parsed params, returns a typed
 * response object.
 *
 * Wave 3 (this plan, 999.10-04) consumes this from daemon.ts's IPC
 * dispatch closure (intercept-before-routeMethod pattern).
 *
 * SEC-07 invariant preserved: the snapshot returned over IPC contains only
 * counters, ISO 8601 timestamps, and a failure-reason string (operator-
 * controlled CLI noise). NO resolved secret value appears in any return
 * shape — `cacheSize` is a count, never a list of values.
 */

import type { SecretsResolver, SecretsRefreshOutcome } from "./secrets-resolver.js";
import {
  SecretsInvalidateRequestSchema,
  SecretsRefreshRequestSchema,
  type SecretsRefreshAllResponse,
  type SecretsStatusResponse,
} from "../ipc/protocol.js";

/**
 * Build the `secrets-status` IPC response from the resolver's frozen
 * counter snapshot. Optional timestamp/reason fields are omitted when
 * undefined (zod schema has them `.optional()`).
 */
export function handleSecretsStatus(
  resolver: SecretsResolver,
): SecretsStatusResponse {
  const snap = resolver.snapshot();
  return {
    ok: true,
    cacheSize: snap.cacheSize,
    hits: snap.hits,
    misses: snap.misses,
    retries: snap.retries,
    rateLimitHits: snap.rateLimitHits,
    // INC-2026-08-08 — surface the outage/degradation counters the resolver
    // has always tracked but never exposed. envFallbackServed + staleServed
    // are the "we are serving a fallback, not a live read" signal;
    // breakerOpen is the live circuit-breaker state. Unconditional (not
    // spread-conditional) — snapshot() always populates all three and the
    // zod schema declares them required.
    envFallbackServed: snap.envFallbackServed,
    staleServed: snap.staleServed,
    breakerOpen: snap.breakerOpen,
    // WS-5 (2026-08-28) — 1Password read-budget pair: reads NOT spent
    // (fresh LKG serves) vs reads spent (`op read` invocations since boot).
    lkgFreshServed: snap.lkgFreshServed,
    opReads: snap.opReads,
    ...(snap.lastFailureAt ? { lastFailureAt: snap.lastFailureAt } : {}),
    ...(snap.lastFailureReason ? { lastFailureReason: snap.lastFailureReason } : {}),
    ...(snap.lastRefreshedAt ? { lastRefreshedAt: snap.lastRefreshedAt } : {}),
  };
}

/**
 * Discriminated outcome shape for the invalidate handler. The success
 * branch carries either the literal `"all"` (full cache flush) or the
 * specific URI that was removed; the failure branch carries a human-
 * readable error string sourced from the zod validation message.
 */
export type SecretsInvalidateOutcome =
  | { readonly ok: true; readonly invalidated: "all" | string }
  | { readonly ok: false; readonly error: string };

/**
 * Validate the `secrets-invalidate` request shape via zod, then either
 * flush a single URI (when `params.uri` is present and starts with
 * `op://`) or the entire cache (when omitted). Returns a typed outcome
 * so the daemon caller can pass through to the IPC response without
 * additional reshaping.
 *
 * Defensive: accepts `unknown` for params to honor the IPC boundary
 * contract — we never trust the shape until zod parses it.
 */
export function handleSecretsInvalidate(
  resolver: SecretsResolver,
  params: unknown,
): SecretsInvalidateOutcome {
  const parsed = SecretsInvalidateRequestSchema.safeParse(params ?? {});
  if (!parsed.success) {
    return {
      ok: false,
      error: `Invalid params for secrets-invalidate: ${parsed.error.message}`,
    };
  }
  if (parsed.data.uri) {
    resolver.invalidate(parsed.data.uri);
    return { ok: true, invalidated: parsed.data.uri };
  }
  resolver.invalidateAll();
  return { ok: true, invalidated: "all" };
}

/**
 * WS-5 (2026-08-28) — discriminated outcome shape for the refresh handler.
 * Zod-rejection branch mirrors `SecretsInvalidateOutcome`; the single-URI
 * branch is the resolver's own outcome; the all branch wraps the list.
 */
export type SecretsRefreshResult =
  | { readonly ok: false; readonly error: string }
  | SecretsRefreshOutcome
  | SecretsRefreshAllResponse;

/**
 * WS-5 (2026-08-28) — `secrets-refresh`: force a LIVE re-read.
 *
 * With `params.uri`: drop that URI from the in-memory cache AND the
 * last-known-good store, then resolve it live → `{ uri, ok, reason? }`.
 * Without: the same for every secret the daemon holds (bounded concurrency
 * 4, see `SecretsResolver.refreshAll`) → `{ ok, refreshed: "all", total,
 * failed, results }`.
 *
 * WHY a separate method from `secrets-invalidate`: with
 * `defaults.secrets.lkgFreshMs` > 0 an invalidate is undone by the very next
 * resolve serving the still-fresh LKG entry, so a rotated credential would
 * never be read. Same `unknown` params contract — zod parses before the
 * resolver is touched. Never throws.
 */
export async function handleSecretsRefresh(
  resolver: SecretsResolver,
  params: unknown,
): Promise<SecretsRefreshResult> {
  const parsed = SecretsRefreshRequestSchema.safeParse(params ?? {});
  if (!parsed.success) {
    return {
      ok: false,
      error: `Invalid params for secrets-refresh: ${parsed.error.message}`,
    };
  }
  if (parsed.data.uri) {
    return resolver.refresh(parsed.data.uri);
  }
  const results = await resolver.refreshAll();
  const failed = results.filter((r) => !r.ok).length;
  return {
    ok: failed === 0,
    refreshed: "all",
    total: results.length,
    failed,
    results: [...results],
  };
}
