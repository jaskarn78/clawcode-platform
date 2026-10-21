/**
 * Phase 137 Plan 04 T-02 — `OpenAiCredentialsResolver`.
 *
 * Thin wrapper around the Phase 999.10 `SecretsResolver` that:
 *   1. Accepts `apiKeyPath` shaped as either:
 *      - an `op://example-vault/item/field` URI → delegate to
 *        `SecretsResolver.resolve()`, OR
 *      - a plaintext `sk-...` value → return verbatim (operator escape
 *        hatch; the `op://` form is recommended for production).
 *   2. Caches the resolved value at instance level so two `CodexQuery`
 *      spawns within the same agent's session don't re-resolve.
 *   3. Throws `OpenAiCredentialsMissingError` with an operator-actionable
 *      message when `apiKeyPath` is absent OR resolves to empty.
 *
 * **SEC-07 invariant (mirrors SecretsResolver):**
 *   - The resolved value NEVER appears in any logger call. Log lines
 *     include the URI (operator-controlled config) + a structural
 *     `apiKeyPathPrefix: "op://" | "plaintext"` field, never the
 *     decoded secret. Tested explicitly (test #9).
 *
 * **Auth surface separation invariant (T4):**
 *   - This wrapper is the ONLY place an OpenAI key is resolved + held in
 *     memory inside ClawCode. Anthropic OAuth bearer tokens are
 *     resolved + held in the SDK's own path; the two never share a
 *     code path. The resolved value flows from `resolve()` into
 *     `CodexQuery`'s spawn env, not via any shared global.
 *
 * **Lazy resolution (T3):**
 *   - Resolution fires on first `resolve()` call, NOT at construction.
 *     Constructing the resolver with absent `apiKeyPath` is legal —
 *     the error surfaces ONLY when an agent actually attempts a Codex
 *     spawn. This lets daemon boot stay non-blocking for agents that
 *     never flip to codex-cli.
 *
 * **Hot-reload (T5):**
 *   - `invalidateCache()` clears the per-instance cache. ConfigWatcher
 *     calls this on `providers.openai.apiKeyPath` deltas; the next
 *     `resolve()` call re-fetches through SecretsResolver (which is
 *     itself invalidated by `applySecretsDiff`).
 *
 * See:
 *   - `src/manager/secrets-resolver.ts` — the delegated `op://` resolver.
 *   - `src/config/schema.ts` — `providersConfigSchema`.
 *   - `.planning/phases/137-.../137-04-PLAN.md` T-02 spec.
 */

import type pino from "pino";
import type { SecretsResolver } from "../../manager/secrets-resolver.js";

/**
 * Error thrown when `providers.openai.apiKeyPath` is absent OR
 * resolves to empty. Fixed `name` so callers can branch on `err.name`
 * (matches the Phase 999.10 `AbortError` pattern from p-retry).
 *
 * Operator-actionable message — the operator drops this string into
 * Discord, an alert, or a journalctl excerpt and immediately knows
 * the next step: edit `clawcode.yaml` under
 * `defaults.providers.openai.apiKeyPath` (or the per-agent override).
 */
export class OpenAiCredentialsMissingError extends Error {
  override readonly name = "OpenAiCredentialsMissingError";
  constructor(message: string) {
    super(message);
  }
}

/**
 * Minimal pino-shape — keeps the deps surface narrow + DI-friendly.
 * Production passes a real pino child logger; tests pass a vi.fn() spy.
 */
export type OpenAiCredentialsLogger = Pick<pino.Logger, "info" | "warn">;

/**
 * Constructor deps for `OpenAiCredentialsResolver`.
 *
 * `apiKeyPath` is the OPERATOR-EDITED clawcode.yaml field — either an
 * `op://` URI or a plaintext key. May be `undefined` when the operator
 * has not configured the field for this agent; the error surfaces at
 * `resolve()` time (lazy fail, T3).
 */
export interface OpenAiCredentialsResolverDeps {
  readonly secretsResolver: SecretsResolver;
  readonly apiKeyPath: string | undefined;
  readonly logger?: OpenAiCredentialsLogger;
  /**
   * Agent name — included in log fields for operator-side correlation
   * (`journalctl -u clawcode -g phase137-codex-credentials-resolved`
   * grep target). Free-form string; no validation here.
   */
  readonly agentName?: string;
}

/**
 * Strip a `{{ ... }}` wrapping if present and return the inner string
 * trimmed. Used to normalise the curly-brace 1Password reference form
 * (e.g., `{{ op://example-vault/item/field }}`) that the rest of clawcode uses
 * in mcpServers env values into the bare `op://` URI shape that
 * SecretsResolver accepts.
 *
 * NOT a full template engine — only the outermost matched pair is
 * stripped. Anything else (env-var interpolation, nested handlebars)
 * is out of scope per the Phase 137 Plan 04 `<researcher_todo>` #3
 * disposition.
 */
function stripCurlyBraceWrappers(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith("{{") && trimmed.endsWith("}}")) {
    return trimmed.slice(2, -2).trim();
  }
  return trimmed;
}

/**
 * `OpenAiCredentialsResolver` — per-agent OpenAI API key resolver.
 *
 * Construct ONE per agent at daemon boot (in `daemon.ts`'s per-agent
 * factory loop). Each `CodexQuery` spawn within that agent's session
 * shares the same instance via `LlmRuntimeDeps.openaiCredentials`.
 * The per-instance cache ensures repeated `resolve()` calls (multi-
 * turn conversations, advisor forks, etc.) issue a single underlying
 * `SecretsResolver.resolve()` call until the cache is invalidated.
 */
export class OpenAiCredentialsResolver {
  private readonly secretsResolver: SecretsResolver;
  private readonly apiKeyPath: string | undefined;
  private readonly logger?: OpenAiCredentialsLogger;
  private readonly agentName: string;

  /**
   * Cached resolved value. `undefined` = cache miss; non-undefined =
   * hit. Set after a successful `resolve()` call; cleared by
   * `invalidateCache()`.
   *
   * Stored as a plain string (NOT a Promise) so we can read it
   * synchronously via `getCached()` if needed. The double-resolution
   * guard (`pending` below) handles concurrent first-resolve callers.
   */
  private cachedValue: string | undefined;

  /**
   * Inflight resolution promise. When two `resolve()` callers race the
   * first miss, the second one awaits this promise instead of issuing
   * a parallel SecretsResolver call. Cleared once resolution settles.
   *
   * Mirrors `SecretsResolver.inflight` (Phase 999.10 SEC-02 invariant).
   */
  private pending: Promise<string> | undefined;

  constructor(deps: OpenAiCredentialsResolverDeps) {
    this.secretsResolver = deps.secretsResolver;
    this.apiKeyPath = deps.apiKeyPath;
    this.logger = deps.logger;
    this.agentName = deps.agentName ?? "unknown";
  }

  /**
   * Resolve the configured `apiKeyPath` into a plaintext OpenAI API
   * key suitable for injection into the Codex child's
   * `OPENAI_API_KEY` env var.
   *
   * Resolution path:
   *   1. Cache hit → return cached value.
   *   2. `apiKeyPath` undefined OR empty → throw
   *      `OpenAiCredentialsMissingError`.
   *   3. Strip `{{ ... }}` curly-brace wrappers.
   *   4. Empty after stripping → throw
   *      `OpenAiCredentialsMissingError`.
   *   5. Starts with `op://` → delegate to
   *      `SecretsResolver.resolve()`. Empty resolution →
   *      `OpenAiCredentialsMissingError`.
   *   6. Otherwise (plaintext) → return verbatim.
   *   7. Cache the result + return.
   *
   * SEC-07: the resolved value NEVER appears in logger call args. Log
   * fields are limited to `{ agent, apiKeyPathPrefix, cached }`. The
   * URI itself is operator-controlled config, so logging it is safe;
   * the decoded secret is not.
   */
  async resolve(): Promise<string> {
    // 1. Cache hit — fast path. The structural log fires so operator
    // can audit cache effectiveness via journalctl grep. The cached
    // value is NOT included (SEC-07).
    if (this.cachedValue !== undefined) {
      this.logCacheEvent({ cached: true });
      return this.cachedValue;
    }

    // 1a. Inflight dedup — second concurrent caller awaits the first.
    if (this.pending) {
      return this.pending;
    }

    // 2. Absent path — operator-actionable error.
    if (this.apiKeyPath === undefined || this.apiKeyPath.length === 0) {
      throw new OpenAiCredentialsMissingError(
        `providers.openai.apiKeyPath not configured for agent "${this.agentName}". ` +
          "Set the field under `defaults.providers.openai` (fleet-wide) or " +
          "`agents.<name>.providers.openai` (per-agent override) in clawcode.yaml " +
          "and run `clawcode reload`.",
      );
    }

    // Start the resolution; cache the inflight promise so concurrent
    // callers share it. Promise settlement clears `pending` AND (on
    // success) populates `cachedValue`.
    this.pending = (async () => {
      try {
        const value = await this.resolveInner();
        this.cachedValue = value;
        this.logCacheEvent({ cached: false });
        return value;
      } finally {
        this.pending = undefined;
      }
    })();
    return this.pending;
  }

  /**
   * Inner resolution path — assumes `apiKeyPath` is defined and
   * non-empty. Splits the `op://` vs. plaintext dispatch and surfaces
   * empty resolutions as `OpenAiCredentialsMissingError`.
   */
  private async resolveInner(): Promise<string> {
    const normalised = stripCurlyBraceWrappers(this.apiKeyPath!);

    if (normalised.length === 0) {
      throw new OpenAiCredentialsMissingError(
        `providers.openai.apiKeyPath for agent "${this.agentName}" resolved to ` +
          "empty after stripping curly-brace wrappers. Check clawcode.yaml for " +
          "an empty `{{ }}` value.",
      );
    }

    if (normalised.startsWith("op://")) {
      const resolved = await this.secretsResolver.resolve(normalised);
      if (resolved === undefined || resolved.trim().length === 0) {
        throw new OpenAiCredentialsMissingError(
          `providers.openai.apiKeyPath for agent "${this.agentName}" resolved ` +
            `to empty value from 1Password (URI: ${normalised}). Verify the ` +
            "1Password item exists and the field is populated.",
        );
      }
      return resolved;
    }

    // Plaintext fallthrough — operator-supplied raw key (e.g., for
    // local debugging without 1Password). The SUMMARY recommends
    // `op://` for production deployments.
    return normalised;
  }

  /**
   * Drop the cached value. ConfigWatcher calls this on
   * `providers.openai.apiKeyPath` deltas (T5 — hot-reload). The next
   * `resolve()` call will re-fetch.
   *
   * Note: this clears OUR per-instance cache only. The underlying
   * SecretsResolver's URI cache is invalidated separately by
   * `applySecretsDiff` in `src/manager/secrets-watcher-bridge.ts` when
   * the URI itself changes. Both must invalidate for a key rotation
   * to take effect: SecretsResolver re-resolves the URI from
   * 1Password; our wrapper re-fetches from SecretsResolver.
   */
  invalidateCache(): void {
    if (this.cachedValue !== undefined) {
      this.cachedValue = undefined;
      if (this.logger) {
        this.logger.info(
          { agent: this.agentName },
          "phase137-codex-credentials-invalidated",
        );
      }
    }
  }

  /**
   * Test-only — synchronous read of the per-instance cache. Returns
   * `undefined` on miss. Used by tests to assert the cache contract
   * without forcing an async resolution.
   */
  getCachedForTest(): string | undefined {
    return this.cachedValue;
  }

  /**
   * Emit the cache-event log line. Single chokepoint so the
   * `apiKeyPathPrefix` derivation lives in one place and the resolved
   * value can NEVER accidentally leak (the call site sees only the
   * structural fields). SEC-07 invariant.
   */
  private logCacheEvent(opts: { cached: boolean }): void {
    if (!this.logger) return;
    const prefix =
      this.apiKeyPath !== undefined &&
      stripCurlyBraceWrappers(this.apiKeyPath).startsWith("op://")
        ? "op://"
        : "plaintext";
    this.logger.info(
      {
        agent: this.agentName,
        apiKeyPathPrefix: prefix,
        cached: opts.cached,
      },
      "phase137-codex-credentials-resolved",
    );
  }
}

/**
 * Factory helper — used by the daemon's per-agent loop. Mirrors the
 * `createDefaultCodexQueryDeps` factory pattern in
 * `src/llm-runtime/backends/codex-query.ts`.
 *
 * Returns `undefined` when `apiKeyPath` is undefined so the caller can
 * avoid threading an inert resolver into `LlmRuntimeDeps` for agents
 * with no provider credentials configured. The CodexAgentCli's
 * lazy-fail path surfaces the missing-credentials error on first
 * spawn (T3).
 */
export function createOpenAiCredentialsResolver(
  deps: OpenAiCredentialsResolverDeps,
): OpenAiCredentialsResolver {
  return new OpenAiCredentialsResolver(deps);
}
