/**
 * Phase 999.10 — daemon-side `op://` secret cache + retry/backoff.
 *
 * `SecretsResolver` is the single in-memory secret cache + p-retry shim that
 * replaces the three independent `op read` shell-out sites (Discord
 * botToken, shared `mcpServers[].env`, and per-agent `mcpEnvOverrides`).
 *
 * Wave 1 (this plan, 999.10-01) implements the class. Wave 2 swaps the three
 * resolution callsites to it; Wave 3 wires `ConfigWatcher` invalidation and
 * the `secrets-status` IPC surface.
 *
 * DI-pure by construction — production wires `defaultOpReadShellOut` (from
 * `op-env-resolver.ts`) as the underlying `opRead`; tests inject a `vi.fn()`.
 *
 * Security invariants (SEC-07):
 *   - Resolved secret values NEVER appear in any pino log call. Only the
 *     `op://` URI (operator-controlled config) and structured retry/cache
 *     metadata land in log fields.
 *   - Errors thrown by `resolve()` embed the URI and the underlying error
 *     message (operator-controlled CLI noise) but never the resolved value.
 *   - Empty-string resolution throws an `AbortError` (no zero-token cache
 *     write — defense in depth against silent fail-open auth).
 *
 * Reliability invariants (SEC-02 / SEC-03):
 *   - URI-keyed cache: repeated `resolve(uri)` calls for the same URI hit
 *     the in-memory `Map` after the first miss.
 *   - Inflight dedup: concurrent `resolve(uri)` calls for the same URI
 *     share one underlying `opRead` invocation via a `Promise` map.
 *   - Exponential backoff with jitter (3 retries, 1s/2s/4s base × random
 *     1-2x). Rate-limit errors bail early via `AbortError` after attempt 2
 *     to avoid compounding the throttle window.
 */

import pRetry, { AbortError } from "p-retry";
import type pino from "pino";

/** Async shell-out signature — one URI in, resolved value out. */
export type OpReadFn = (uri: string) => Promise<string>;

/**
 * Constructor dependency injection — `opRead` and `log` are mandatory;
 * `retryOptions` overrides the per-field defaults (retries:3, minTimeout:
 * 1000, maxTimeout:8000, factor:2, randomize:true).
 */
export interface SecretsResolverDeps {
  readonly opRead: OpReadFn;
  readonly log: pino.Logger;
  readonly retryOptions?: {
    readonly retries?: number;
    readonly minTimeout?: number;
    readonly maxTimeout?: number;
    readonly factor?: number;
    readonly randomize?: boolean;
  };
  /**
   * INC-2026-07-27 — LAST-KNOWN-GOOD store, survives daemon restarts.
   *
   * WHY: the in-memory cache above dies with the process. On 2026-07-27 the
   * clawdbot service account was rate-limited for hours; a daemon restart
   * during that window resolved 0/17 secrets and two agents
   * (fin-client, fin-research) could not start at all, because their
   * 1password MCP token is itself an `op://` ref. Nothing was wrong with the
   * secrets — we simply had no copy once memory was gone.
   *
   * Implementations persist `{uri -> {value, savedAt}}`. The daemon writes it
   * 0600 under the manager dir. Exposure note: resolved secrets are ALREADY
   * passed to MCP servers on argv, which is world-readable (0444
   * /proc/<pid>/cmdline) — a 0600 file readable only by the daemon uid is
   * strictly less exposed than the status quo, not more.
   */
  readonly persistentStore?: SecretsPersistentStore;
  /**
   * Operator-declared env fallback: given an `op://` URI, return a value
   * from the process environment (systemd `EnvironmentFile`) or undefined.
   * Consulted ONLY after a live read fails. Explicit and auditable — no
   * magic name derivation — so an operator can see exactly which secrets
   * have an outage path. This is what restores an agent whose MCP token is
   * itself an `op://` ref during a total 1Password outage.
   */
  readonly envFallback?: (uri: string) => string | undefined;
  /**
   * Circuit breaker: after this many CONSECUTIVE rate-limited failures, stop
   * shelling out to `op` entirely for `breakerCooldownMs` and serve from the
   * fallbacks. Prevents the 2026-07-27 self-feeding loop, where retrying a
   * throttled service account was itself what kept the throttle alive
   * (~4k calls/day). Default 3 / 5 min. Set threshold 0 to disable.
   */
  readonly breakerThreshold?: number;
  readonly breakerCooldownMs?: number;
  /**
   * Staleness ceiling for the last-known-good store. An entry older than this
   * is REFUSED rather than served, so `resolve()` fails exactly as if no
   * fallback existed. 0 disables the check (any age serves).
   *
   * `savedAt` only advances on a successful LIVE read and `resolve()` hits the
   * in-memory cache first, so an entry's age ≈ daemon uptime since that URI
   * was last read live — NOT the age of the credential. `DEFAULT_LKG_MAX_AGE_MS`
   * (30d) is therefore sized against restart cadence, not rotation policy.
   *
   * WHY enforce at all: a secret deleted or rotated in 1Password fails every
   * live read forever, and a frozen `savedAt` would let the daemon replay that
   * dead credential indefinitely.
   */
  readonly lkgMaxAgeMs?: number;
  /**
   * WS-5 (2026-08-28) — FRESH-SERVE window for the last-known-good store.
   *
   * An LKG entry whose `savedAt` is at most this old is served by `resolve()`
   * WITHOUT a live `op read`. 0 (default) = the pre-WS-5 behaviour: the store
   * is only ever consulted AFTER a live read fails.
   *
   * WHY: every daemon restart pre-resolved every `op://` ref live — 32 refs on
   * prod ≈ 30 reads per restart against a 1,000/24h cap that is SHARED across
   * every service account on the 1Password account (see
   * .planning/INCIDENT-1p-ratelimit-2026-08-08.md). A deploy day with a few
   * restarts was burning a meaningful slice of the budget re-reading values
   * that had not changed. Rotations go through `refresh()` (the
   * `secrets-refresh` IPC / `clawcode secrets refresh`), which drops the entry
   * so the next resolve is live.
   *
   * `savedAt` is NOT advanced by a fresh serve — it may only advance on a
   * successful LIVE read, otherwise an entry would renew itself forever and
   * the `lkgMaxAgeMs` dead-secret end state could never be reached. The
   * effective window is clamped to `lkgMaxAgeMs` for the same reason.
   */
  readonly lkgFreshMs?: number;
  /** Clock (Date.now in production; injected in tests). */
  readonly now?: () => number;
}

/** One persisted last-known-good entry. */
export interface PersistedSecret {
  readonly value: string;
  /** Epoch ms of the last SUCCESSFUL live resolution. */
  readonly savedAt: number;
}

/**
 * WS-5 (2026-08-28) — outcome of one forced refresh (`refresh()` /
 * `refreshAll()`). `reason` is present only when `ok` is false and carries the
 * underlying error message (operator-controlled CLI noise) — never a value.
 */
export interface SecretsRefreshOutcome {
  readonly uri: string;
  readonly ok: boolean;
  readonly reason?: string;
}

/**
 * Durable last-known-good store. Deliberately synchronous + tiny: it is read
 * once at construction and written after each successful resolve. Any
 * implementation MUST persist with owner-only permissions.
 */
export interface SecretsPersistentStore {
  /** Load all entries. Returns {} on missing/corrupt store — never throws. */
  load: () => Record<string, PersistedSecret>;
  /** Persist the full entry set. Best-effort — must never throw. */
  save: (entries: Record<string, PersistedSecret>) => void;
}

/**
 * Telemetry counters surfaced by `snapshot()` and (in Wave 3) the
 * `secrets-status` IPC method. Mutated in place by the resolver — the
 * snapshot helper returns a frozen copy with `cacheSize` appended.
 */
export interface SecretsCounters {
  hits: number;
  misses: number;
  retries: number;
  rateLimitHits: number;
  lastFailureAt: string | undefined;
  lastFailureReason: string | undefined;
  lastRefreshedAt: string | undefined;
  /** INC-2026-07-27 — times a live read failed and a fallback served instead. */
  envFallbackServed: number;
  staleServed: number;
  /**
   * Times an LKG entry existed but was REFUSED for exceeding `lkgMaxAgeMs`.
   * Deliberately NOT plumbed into the `secrets-status` IPC response yet —
   * `handleSecretsStatus` picks fields explicitly, so adding it here is purely
   * additive; surfacing it belongs to the monitoring workstream.
   */
  staleRefused: number;
  /**
   * WS-5 (2026-08-28) — resolutions served from a last-known-good entry that
   * was younger than `lkgFreshMs`, with NO `op` invocation. The "reads we did
   * not spend" counter.
   */
  lkgFreshServed: number;
  /**
   * WS-5 (2026-08-28) — `op read` CLI invocations since boot. Each one is a
   * 1Password read against the shared daily cap; retries are counted because
   * they cost a read too. The "reads we did spend" counter.
   */
  opReads: number;
  /** Whether the breaker is currently open (op calls suppressed). */
  breakerOpen: boolean;
}

/**
 * Default staleness ceiling for last-known-good entries (30 days).
 *
 * Sized against DAEMON RESTART CADENCE, not rotation policy — see
 * `SecretsResolverDeps.lkgMaxAgeMs`. Mirrored as a literal in
 * `defaults.secrets.lkgMaxAgeMs` (src/config/schema.ts); the schema layer is
 * upstream of the manager layer so it cannot import this const.
 */
export const DEFAULT_LKG_MAX_AGE_MS = 30 * 24 * 60 * 60_000;

/** Rate-limit-class error detection — operator-visible regex per RESEARCH.md Pitfall 5. */
const RATE_LIMIT_RE = /rate.?limit|too many requests/i;

/**
 * In-memory `op://` secret cache + retry shim.
 *
 * One instance per daemon process. Construct in `startDaemon`, pass by
 * reference to (a) the loader's sync resolver wrapper, (b) the per-agent
 * `opEnvResolver` closure, (c) the Discord botToken resolution block, and
 * (d) the recovery handler.
 */
export class SecretsResolver {
  private readonly cache = new Map<string, string>();
  private readonly inflight = new Map<string, Promise<string>>();
  private readonly counters: SecretsCounters = {
    hits: 0,
    misses: 0,
    retries: 0,
    rateLimitHits: 0,
    lastFailureAt: undefined,
    lastFailureReason: undefined,
    lastRefreshedAt: undefined,
    envFallbackServed: 0,
    staleServed: 0,
    staleRefused: 0,
    lkgFreshServed: 0,
    opReads: 0,
    breakerOpen: false,
  };
  /** INC-2026-07-27 — last-known-good entries loaded from disk at construction. */
  private persisted: Record<string, PersistedSecret>;
  private consecutiveRateLimits = 0;
  private breakerOpenUntil = 0;

  constructor(private readonly deps: SecretsResolverDeps) {
    let loaded: Record<string, PersistedSecret> = {};
    try {
      loaded = deps.persistentStore?.load() ?? {};
    } catch {
      // load() is contractually non-throwing; belt-and-suspenders so a
      // corrupt store can never prevent daemon boot.
      loaded = {};
    }
    this.persisted = loaded;
    if (Object.keys(loaded).length > 0) {
      deps.log.info(
        { entries: Object.keys(loaded).length },
        "secrets-resolver: last-known-good store loaded (outage fallback armed)",
      );
    }
  }

  private nowMs(): number {
    return this.deps.now?.() ?? Date.now();
  }

  /**
   * Serve a failed live read from the fallbacks, in order:
   *   1. operator-declared env fallback (explicit, current by construction)
   *   2. last-known-good persisted value (STALE — logged loudly with age)
   * Returns undefined when neither is available, so the caller throws as before.
   */
  private serveFallback(uri: string, reason: string): string | undefined {
    const fromEnv = this.deps.envFallback?.(uri);
    if (fromEnv !== undefined && fromEnv.length > 0) {
      this.counters.envFallbackServed++;
      // INC-2026-07-27 FIX — populate the in-memory cache. `getCached()` is a
      // SYNC accessor read by the mcp-broker's tokenHash->rawToken map builder
      // and the loader's sync resolver wrapper. A fallback value that skips
      // the cache is INVISIBLE to them: the broker collected no literal for
      // this token, so a shim handshake resolved rawToken="" and the daemon
      // threw a fatal (fleet down, 2026-07-27). Caching also guarantees ONE
      // value is used everywhere for this process lifetime — a mix of
      // fallback and live values across call sites would break auth anyway.
      this.cache.set(uri, fromEnv);
      this.deps.log.warn(
        { uri, reason },
        "secrets-resolver: live read FAILED — serving operator env fallback",
      );
      return fromEnv;
    }
    const lkg = this.persisted[uri];
    if (lkg !== undefined && lkg.value.length > 0) {
      const ageMs = this.nowMs() - lkg.savedAt;
      const maxAgeMs = this.deps.lkgMaxAgeMs ?? DEFAULT_LKG_MAX_AGE_MS;
      // Staleness ceiling. Without it an entry is served forever, so a secret
      // DELETED or rotated in 1Password (every live read fails, for good) keeps
      // flowing to MCP children with no end state. Past the ceiling we return
      // undefined and let the caller's existing "no fallback available" throw
      // fire — refusal produces ABSENCE in the cache, never a divergent
      // literal, so the broker's tokenHash → rawToken map (built from
      // getCached) simply has no entry instead of a WRONG one. 0 disables.
      // NOTE: age ≈ daemon uptime since this URI was last read LIVE, not the
      // credential's rotation age — savedAt advances only in recordSuccess.
      if (maxAgeMs > 0 && ageMs > maxAgeMs) {
        this.counters.staleRefused++;
        this.deps.log.error(
          {
            uri,
            reason,
            ageMs,
            ageHours: Math.round(ageMs / 3_600_000),
            savedAt: new Date(lkg.savedAt).toISOString(),
            maxAgeMs,
          },
          "secrets-resolver: last-known-good value REFUSED — older than lkgMaxAgeMs; " +
            "failing this resolve instead of replaying a credential that may have been " +
            "revoked (raise defaults.secrets.lkgMaxAgeMs — or set 0 to disable — if this " +
            "is a long-uptime daemon rather than a dead secret)",
        );
        return undefined;
      }
      this.counters.staleServed++;
      this.deps.log.warn(
        {
          uri,
          reason,
          ageMs,
          ageHours: Math.round(ageMs / 3_600_000),
          savedAt: new Date(lkg.savedAt).toISOString(),
        },
        "secrets-resolver: live read FAILED — serving STALE last-known-good value " +
          "(rotate-safety: if this secret was rotated during the outage, this value is wrong)",
      );
      // Same cache-population contract as the env branch above.
      this.cache.set(uri, lkg.value);
      return lkg.value;
    }
    return undefined;
  }

  /** Record a successful live value in both the memory and durable stores. */
  private recordSuccess(uri: string, value: string): void {
    this.cache.set(uri, value);
    this.consecutiveRateLimits = 0;
    this.breakerOpenUntil = 0;
    this.counters.breakerOpen = false;
    this.counters.lastRefreshedAt = new Date(this.nowMs()).toISOString();
    if (this.deps.persistentStore) {
      // Immutable update — never mutate the loaded object in place.
      this.persisted = {
        ...this.persisted,
        [uri]: { value, savedAt: this.nowMs() },
      };
      try {
        this.deps.persistentStore.save(this.persisted);
      } catch (err: unknown) {
        this.deps.log.warn(
          { uri, err: err instanceof Error ? err.message : String(err) },
          "secrets-resolver: last-known-good persist failed (in-memory cache unaffected)",
        );
      }
    }
  }

  /**
   * Resolve an `op://` URI, hitting the cache if warm or shelling out via
   * the injected `opRead` (with retry + dedup) on miss.
   */
  async resolve(uri: string): Promise<string> {
    if (!uri.startsWith("op://")) {
      // Match the existing `defaultOpRefResolver` contract (case-sensitive
      // prefix only) — broader validation lives at the loader/schema layer.
      throw new Error(`SecretsResolver.resolve called with non-op URI: ${uri}`);
    }

    const cached = this.cache.get(uri);
    if (cached !== undefined) {
      this.counters.hits++;
      return cached;
    }

    // WS-5 (2026-08-28) — fresh last-known-good serve, BEFORE any shell-out.
    // Sits between the in-memory cache and the live path on purpose: a warm
    // cache still wins (one value per process lifetime), and nothing below
    // this line runs — no `op` spawn, no retry, no breaker bookkeeping.
    const fresh = this.serveFreshLkg(uri);
    if (fresh !== undefined) return fresh;

    // De-dupe concurrent resolutions of the same URI (boot-storm fix).
    const inflight = this.inflight.get(uri);
    if (inflight) return inflight;

    const promise = this.resolveWithRetry(uri).finally(() => {
      this.inflight.delete(uri);
    });
    this.inflight.set(uri, promise);
    return promise;
  }

  /** Sync read of the internal cache — used by Wave 2's loader sync wrapper. */
  getCached(uri: string): string | undefined {
    return this.cache.get(uri);
  }

  private async resolveWithRetry(uri: string): Promise<string> {
    this.counters.misses++;

    // INC-2026-07-27 circuit breaker — while open, do not shell out to `op`
    // at all. Retrying a throttled service account is what SUSTAINED the
    // 2026-07-27 outage, so during the cooldown we serve fallbacks only. If
    // no fallback exists the caller still gets a clear failure.
    if (this.breakerOpenUntil > this.nowMs()) {
      const served = this.serveFallback(uri, "circuit-breaker-open");
      if (served !== undefined) return served;
      throw new Error(
        `Failed to resolve ${uri}: 1Password circuit breaker open ` +
          `(${this.consecutiveRateLimits} consecutive rate-limits) and no fallback available`,
      );
    }

    try {
      const result = await pRetry(
        async () => {
          // WS-5 (2026-08-28) — every invocation (retries included) is one
          // 1Password read against the shared daily cap.
          this.counters.opReads++;
          const value = await this.deps.opRead(uri);
          if (value === undefined || value === null || value.length === 0) {
            // Permanent error — empty resolution should not retry, and must
            // not land in the cache as a zero-length token (Pitfall 4).
            throw new AbortError(`op read returned empty string for ${uri}`);
          }
          return value;
        },
        {
          retries: this.deps.retryOptions?.retries ?? 3,
          minTimeout: this.deps.retryOptions?.minTimeout ?? 1000,
          maxTimeout: this.deps.retryOptions?.maxTimeout ?? 8000,
          factor: this.deps.retryOptions?.factor ?? 2,
          randomize: this.deps.retryOptions?.randomize ?? true,
          onFailedAttempt: (ctx) => {
            this.counters.retries++;
            const reason = ctx.error.message;
            const isRateLimit = RATE_LIMIT_RE.test(reason);
            if (isRateLimit) this.counters.rateLimitHits++;

            // Structured log — operator-correlatable. NEVER includes the
            // resolved value (we only have it on success; failures by
            // construction never carry one).
            this.deps.log.warn(
              {
                uri,
                attempt: ctx.attemptNumber,
                retriesLeft: ctx.retriesLeft,
                reason,
                isRateLimit,
              },
              "secrets-resolver: op read attempt failed",
            );

            // Pitfall 5 — rate-limit early bail. After attempt 2 (the first
            // retry), if the error is still a rate-limit, abort the retry
            // loop. Throwing AbortError from onFailedAttempt halts retries
            // and surfaces the error to the outer catch.
            if (isRateLimit && ctx.attemptNumber >= 2) {
              throw new AbortError(
                `rate-limited at attempt ${ctx.attemptNumber}: ${reason}`,
              );
            }
          },
        },
      );

      this.recordSuccess(uri, result);
      this.deps.log.info(
        { uri, cacheSize: this.cache.size },
        "secrets-resolver: resolved + cached",
      );
      return result;
    } catch (err: unknown) {
      const reason = err instanceof Error ? err.message : String(err);
      this.counters.lastFailureAt = new Date(this.nowMs()).toISOString();
      this.counters.lastFailureReason = reason;

      // INC-2026-07-27 — trip the breaker on sustained rate limiting so we
      // stop feeding the throttle that is causing the failure.
      if (RATE_LIMIT_RE.test(reason)) {
        this.consecutiveRateLimits++;
        const threshold = this.deps.breakerThreshold ?? 3;
        if (threshold > 0 && this.consecutiveRateLimits >= threshold) {
          const cooldown = this.deps.breakerCooldownMs ?? 5 * 60_000;
          this.breakerOpenUntil = this.nowMs() + cooldown;
          this.counters.breakerOpen = true;
          this.deps.log.warn(
            {
              consecutiveRateLimits: this.consecutiveRateLimits,
              cooldownMs: cooldown,
            },
            "secrets-resolver: 1Password circuit breaker OPEN — suppressing op reads " +
              "(serving fallbacks) so retries stop sustaining the throttle",
          );
        }
      }

      // Outage fallback: env override, then last-known-good.
      const served = this.serveFallback(uri, reason);
      if (served !== undefined) return served;

      throw new Error(`Failed to resolve ${uri} after retries: ${reason}`, {
        cause: err instanceof Error ? err : undefined,
      });
    }
  }

  /** Drop one URI from the cache (Wave 3 — ConfigWatcher diff hook). */
  invalidate(uri: string): void {
    if (this.cache.delete(uri)) {
      this.deps.log.info({ uri }, "secrets-resolver: cache invalidated");
    }
  }

  /** Drop the entire cache (Wave 3 — `secrets-invalidate` IPC). */
  invalidateAll(): void {
    const size = this.cache.size;
    this.cache.clear();
    this.deps.log.info({ size }, "secrets-resolver: full cache invalidated");
  }

  /**
   * WS-5 (2026-08-28) — FORCE a live read for one URI (the rotation path).
   *
   * Drops the URI from the in-memory cache AND the last-known-good store
   * (persisting the drop), then resolves it live. WHY both: with `lkgFreshMs`
   * enabled, `invalidate()` alone would be undone by the next resolve serving
   * the still-fresh LKG entry — the rotated value would never be read. The
   * drop is persisted BEFORE the read so a crash mid-refresh cannot leave the
   * pre-rotation value on disk to be fresh-served after the next boot.
   *
   * Never throws — the outcome carries the failure reason (URI + CLI noise,
   * never a value) so the IPC/CLI layer can render it without reshaping.
   */
  async refresh(uri: string): Promise<SecretsRefreshOutcome> {
    if (!uri.startsWith("op://")) {
      return { uri, ok: false, reason: `not an op:// URI: ${uri}` };
    }
    this.cache.delete(uri);
    this.dropPersisted(uri);
    this.deps.log.info(
      { uri },
      "secrets-resolver: refresh — dropped cache + last-known-good entry, reading live",
    );
    try {
      await this.resolve(uri);
      return { uri, ok: true };
    } catch (err: unknown) {
      const reason = err instanceof Error ? err.message : String(err);
      return { uri, ok: false, reason };
    }
  }

  /**
   * WS-5 (2026-08-28) — `refresh()` for every URI this process holds (the
   * persisted store ∪ the in-memory cache — the union so a URI whose persist
   * once failed is not skipped). Same bounded concurrency (4) as
   * `preResolveAll`, for the same boot-storm reason. Outcomes are returned in
   * URI order; nothing throws.
   */
  async refreshAll(): Promise<readonly SecretsRefreshOutcome[]> {
    const uris = Array.from(
      new Set([...Object.keys(this.persisted), ...this.cache.keys()]),
    );
    return this.runBounded(uris, (uri) => this.refresh(uri));
  }

  /** Remove one URI from the last-known-good store (immutable update + persist). */
  private dropPersisted(uri: string): void {
    if (!(uri in this.persisted)) return;
    const { [uri]: _dropped, ...rest } = this.persisted;
    this.persisted = rest;
    if (!this.deps.persistentStore) return;
    try {
      this.deps.persistentStore.save(this.persisted);
    } catch (err: unknown) {
      this.deps.log.warn(
        { uri, err: err instanceof Error ? err.message : String(err) },
        "secrets-resolver: last-known-good drop failed to persist (in-memory drop still applied)",
      );
    }
  }

  /**
   * WS-5 (2026-08-28) — serve a last-known-good entry younger than the fresh
   * window WITHOUT shelling out. Returns undefined when the window is disabled
   * (0), when there is no usable entry, or when the entry is too old — in
   * every one of those cases the caller proceeds to the pre-WS-5 live path
   * unchanged. Populates the in-memory cache (same contract as the fallback
   * branches: `getCached()` is read synchronously by the broker token map) and
   * deliberately does NOT touch `savedAt` — see `SecretsResolverDeps.lkgFreshMs`.
   */
  private serveFreshLkg(uri: string): string | undefined {
    const windowMs = this.freshWindowMs();
    if (windowMs <= 0) return undefined;
    const lkg = this.persisted[uri];
    if (lkg === undefined || lkg.value.length === 0) return undefined;
    const ageMs = this.nowMs() - lkg.savedAt;
    if (ageMs > windowMs) return undefined;
    this.cache.set(uri, lkg.value);
    this.counters.lkgFreshServed++;
    return lkg.value;
  }

  /**
   * Effective fresh window: `lkgFreshMs`, clamped to `lkgMaxAgeMs` when that
   * ceiling is enabled. An entry the outage path would REFUSE as too old must
   * never be served as "fresh" on the happy path (misconfiguration guard).
   */
  private freshWindowMs(): number {
    const fresh = this.deps.lkgFreshMs ?? 0;
    if (fresh <= 0) return 0;
    const maxAge = this.deps.lkgMaxAgeMs ?? DEFAULT_LKG_MAX_AGE_MS;
    return maxAge > 0 ? Math.min(fresh, maxAge) : fresh;
  }

  /**
   * Pre-resolve every URI in the list at boot to fill the cache once,
   * before any agent spawn. Failures DO NOT throw — they're returned as a
   * per-URI result so the caller can decide fail-closed vs fail-open per
   * zone (mirrors the existing graceful-degradation contract for op://
   * reference failures at boot).
   *
   * Phase 999.33 — bounded-concurrency wave processor. The original
   * implementation did `Promise.allSettled(uris.map(...))` which fanned
   * out ALL URIs simultaneously. With ~25 distinct op:// references in a
   * production config, that issued 25 concurrent `op` CLI subprocesses in
   * ~1 second, saturating 1Password's rate-limit window and causing
   * BOOT-STORM failures (observed 2026-04-30 + 2026-05-03). The retry
   * shim's exponential backoff didn't help — the retries also fired
   * within the same RL window.
   *
   * Fix: cap in-flight resolutions to `MAX_CONCURRENT` (default 4). With
   * 25 URIs, boot resolves in ~7 sequential waves of 4 (last wave 1) ≈
   * 1-2s wall-clock IF every resolution is a cache miss + cold op-CLI
   * spawn. Cache hits (post-restart with persistent cache, Phase 999.34
   * follow-up) bypass the wave entirely. Inflight dedup (existing) stays
   * orthogonal — duplicate URIs in the input share a single resolution
   * regardless of wave placement.
   */
  async preResolveAll(
    uris: readonly string[],
  ): Promise<readonly { uri: string; ok: boolean; reason?: string }[]> {
    type Outcome = { uri: string; ok: boolean; reason?: string };
    const before = {
      fresh: this.counters.lkgFreshServed,
      reads: this.counters.opReads,
    };
    const out = await this.runBounded(uris, async (uri): Promise<Outcome> => {
      try {
        await this.resolve(uri);
        return { uri, ok: true };
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        return { uri, ok: false, reason };
      }
    });
    this.logFreshServeSummary(uris.length, before);
    return out;
  }

  /**
   * Bounded-concurrency wave processor shared by `preResolveAll` and
   * `refreshAll` (WS-5). Cap 4 — see the boot-storm note on `preResolveAll`.
   * Results are written by input index so the output mirrors input order even
   * when workers finish out of order.
   */
  private async runBounded<T>(
    uris: readonly string[],
    fn: (uri: string) => Promise<T>,
  ): Promise<readonly T[]> {
    const MAX_CONCURRENT = 4;
    const out: T[] = new Array(uris.length);
    let cursor = 0;

    const worker = async (): Promise<void> => {
      while (true) {
        const idx = cursor++;
        if (idx >= uris.length) return;
        out[idx] = await fn(uris[idx]!);
      }
    };

    const workers = Array.from(
      { length: Math.min(MAX_CONCURRENT, uris.length) },
      () => worker(),
    );
    await Promise.all(workers);
    return out;
  }

  /**
   * WS-5 (2026-08-28) — ONE summary line per `preResolveAll` (i.e. per boot),
   * only when the fresh window is enabled. Deliberately not per-secret: 32
   * near-identical lines per boot is noise, and the per-URI facts are already
   * in the counters (`secrets-status` → lkgFreshServed / opReads).
   */
  private logFreshServeSummary(
    total: number,
    before: { readonly fresh: number; readonly reads: number },
  ): void {
    if (this.freshWindowMs() <= 0 || total === 0) return;
    const lkgFreshServed = this.counters.lkgFreshServed - before.fresh;
    const liveReads = this.counters.opReads - before.reads;
    this.deps.log.info(
      { lkgFreshServed, liveReads, total, lkgFreshMs: this.deps.lkgFreshMs },
      `secrets-resolver: served ${lkgFreshServed} of ${total} secrets from last-known-good ` +
        "(fresh within lkgFreshMs); no 1Password reads for those",
    );
  }

  /** Frozen telemetry snapshot — counters + current cache size. */
  snapshot(): Readonly<SecretsCounters & { cacheSize: number }> {
    return Object.freeze({ ...this.counters, cacheSize: this.cache.size });
  }
}
