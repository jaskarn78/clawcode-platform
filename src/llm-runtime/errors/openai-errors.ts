/**
 * Phase 137 Plan 05 T-02 — OpenAI HTTP error mapping +
 * ClawCode internal error class hierarchy.
 *
 * Symmetric with the (future) Anthropic mapping per SC7 — downstream
 * consumers (advisor, escalation, retry path) branch on the typed
 * internal class, not on the wire status. Phase 138 may unify the
 * Anthropic side onto this same hierarchy; for now the hierarchy
 * lives provider-neutral at `src/llm-runtime/errors/` so the surface
 * is shared.
 *
 * ── grep-finding (T-02 step 1) ──────────────────────────────────────
 *
 * Greps for `AuthenticationError` / `RateLimitError` in `src/bridge/`,
 * `src/manager/`, and `src/llm/` found NO clawcode-internal error
 * class hierarchy for provider HTTP errors. The only matches were
 * Discord-API rate-limit handling (`isDiscordRateLimitError` —
 * discord.js wire layer, orthogonal). → Plan 05 CREATES the
 * hierarchy from scratch under `src/llm-runtime/errors/`. The
 * Anthropic mapping today surfaces errors as raw `Error` from the
 * SDK; Phase 138 (credit telemetry) can refactor to consume this
 * hierarchy uniformly across providers.
 *
 * ── Mapping table ───────────────────────────────────────────────────
 *
 *   HTTP 401  → AuthenticationError       (`provider: 'openai'`)
 *   HTTP 429  → RateLimitError, subtype:
 *                   'billing'  when `body.error.type === 'insufficient_quota'`
 *                   'rate_limit' otherwise
 *   HTTP 500  → ProviderServerError
 *   HTTP 503  → ProviderUnavailableError
 *   any other → UnknownProviderError
 *
 * The body is passed-through verbatim onto the error instance so
 * operators can inspect the wire payload during incident response.
 * Telemetry consumers see only `httpStatus` + `internalType` +
 * `codeFromBody` (the OpenAI `error.type` string) — never the raw
 * body (T-137-05-02 Information Disclosure mitigation).
 *
 * See:
 *   - `./__tests__/openai-errors.test.ts` — exhaustive mapping tests.
 *   - `../backends/codex-query.ts` — production consumer; invokes
 *     `mapOpenAiHttpStatus` on stderr/exit error paths.
 */

/**
 * Base class for every typed error this module emits. Carries the
 * provider tag + wire status + raw body for incident triage. Subclasses
 * narrow the semantic meaning (auth / rate / server / unavailable /
 * unknown).
 */
export class ClawCodeInternalError extends Error {
  /** Wire-level HTTP status code (401, 429, 500, 503, …). */
  readonly status: number;
  /** Provider tag — currently always 'openai' for this module's mapping. */
  readonly provider: "openai";
  /** Raw response body for operator debugging. Never logged. */
  readonly body: unknown;
  /** OpenAI `error.type` string when parseable; null otherwise. */
  readonly codeFromBody: string | null;

  constructor(
    message: string,
    init: {
      readonly status: number;
      readonly provider: "openai";
      readonly body?: unknown;
      readonly codeFromBody?: string | null;
    },
  ) {
    super(message);
    this.name = new.target.name;
    this.status = init.status;
    this.provider = init.provider;
    this.body = init.body ?? null;
    this.codeFromBody = init.codeFromBody ?? null;
  }
}

/**
 * HTTP 401 — wire bearer was missing / invalid / expired. Operator
 * action: rotate `providers.openai.apiKeyPath` value.
 */
export class AuthenticationError extends ClawCodeInternalError {}

/**
 * HTTP 429 — either a transient rate limit (`subtype: 'rate_limit'`)
 * or a hard billing block (`subtype: 'billing'`, OpenAI
 * `insufficient_quota`).
 *
 *   - `'rate_limit'` — retryable with backoff; the existing turn-retry
 *     path (10s → 30s → 90s …) applies.
 *   - `'billing'`    — NOT retryable; operator must top up the OpenAI
 *     billing balance or flip the agent back to `anthropic-agent-sdk`
 *     until resolved. Phase 138 owns auto-failover.
 */
export class RateLimitError extends ClawCodeInternalError {
  readonly subtype: "rate_limit" | "billing";
  constructor(
    message: string,
    init: {
      readonly status: number;
      readonly provider: "openai";
      readonly body?: unknown;
      readonly codeFromBody?: string | null;
      readonly subtype: "rate_limit" | "billing";
    },
  ) {
    super(message, init);
    this.subtype = init.subtype;
  }
}

/** HTTP 500 — provider-side bug / outage. Retryable with caution. */
export class ProviderServerError extends ClawCodeInternalError {}

/** HTTP 503 — provider unavailable / overloaded. Retryable. */
export class ProviderUnavailableError extends ClawCodeInternalError {}

/** Anything else (405, 418, 502, 504, …) — operator-actionable. */
export class UnknownProviderError extends ClawCodeInternalError {}

/**
 * Best-effort body parser. The OpenAI error wire shape is:
 *
 *   { "error": { "message": string, "type": string, "code"?: string,
 *                "param"?: string|null } }
 *
 * but error responses sometimes arrive as plain text (gateway HTML
 * pages, non-JSON 503 stubs, …). We tolerate that — if parsing fails
 * the body is left as the raw input and `codeFromBody` is null.
 */
function parseBody(body: unknown): {
  readonly parsed: unknown;
  readonly codeFromBody: string | null;
} {
  let parsed: unknown = body;
  if (typeof body === "string") {
    try {
      parsed = JSON.parse(body);
    } catch {
      return { parsed: body, codeFromBody: null };
    }
  }
  if (
    parsed === null ||
    typeof parsed !== "object" ||
    Array.isArray(parsed)
  ) {
    return { parsed, codeFromBody: null };
  }
  const err = (parsed as { error?: unknown }).error;
  if (err === null || typeof err !== "object") {
    return { parsed, codeFromBody: null };
  }
  const type = (err as { type?: unknown }).type;
  const codeFromBody = typeof type === "string" ? type : null;
  return { parsed, codeFromBody };
}

/**
 * Map an OpenAI HTTP error status into the typed
 * `ClawCodeInternalError` subclass. Pure function — no I/O.
 *
 * @param status  Wire HTTP status code from the response.
 * @param body    Optional response body. May be the raw JSON object,
 *                a JSON string, plain text, or undefined. Body
 *                parsing is best-effort; malformed bodies still yield
 *                a status-based error.
 */
export function mapOpenAiHttpStatus(
  status: number,
  body?: unknown,
): ClawCodeInternalError {
  const { parsed, codeFromBody } = parseBody(body);

  switch (status) {
    case 401:
      return new AuthenticationError(
        `OpenAI authentication failed (HTTP 401${codeFromBody ? `, ${codeFromBody}` : ""})`,
        { status, provider: "openai", body: parsed, codeFromBody },
      );
    case 429: {
      const subtype: "rate_limit" | "billing" =
        codeFromBody === "insufficient_quota" ? "billing" : "rate_limit";
      const reasonHint = subtype === "billing" ? "billing cap" : "rate limit";
      return new RateLimitError(
        `OpenAI ${reasonHint} (HTTP 429${codeFromBody ? `, ${codeFromBody}` : ""})`,
        { status, provider: "openai", body: parsed, codeFromBody, subtype },
      );
    }
    case 500:
      return new ProviderServerError(
        `OpenAI server error (HTTP 500${codeFromBody ? `, ${codeFromBody}` : ""})`,
        { status, provider: "openai", body: parsed, codeFromBody },
      );
    case 503:
      return new ProviderUnavailableError(
        `OpenAI unavailable (HTTP 503${codeFromBody ? `, ${codeFromBody}` : ""})`,
        { status, provider: "openai", body: parsed, codeFromBody },
      );
    default:
      return new UnknownProviderError(
        `OpenAI unmapped error (HTTP ${status}${codeFromBody ? `, ${codeFromBody}` : ""})`,
        { status, provider: "openai", body: parsed, codeFromBody },
      );
  }
}
