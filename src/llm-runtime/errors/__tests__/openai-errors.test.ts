/**
 * Phase 137 Plan 05 T-02 — OpenAI error mapping tests.
 *
 * Seven exhaustive cases per PLAN T-02 `<behavior>`:
 *  (1) 401 → AuthenticationError; status preserved.
 *  (2) 429 + `insufficient_quota` body → RateLimitError subtype 'billing'.
 *  (3) 429 + `rate_limit_exceeded` body → RateLimitError subtype 'rate_limit'.
 *  (4) 500 → ProviderServerError.
 *  (5) 503 → ProviderUnavailableError.
 *  (6) 418 (unmapped) → UnknownProviderError with status=418.
 *  (7) Malformed body still produces correct status-based error.
 *
 * Plus surface assertions:
 *  - All errors carry `provider: 'openai'`.
 *  - Body is preserved verbatim.
 *  - `codeFromBody` is null when not parseable.
 *  - 429 with NO body defaults to subtype 'rate_limit' (conservative —
 *    we don't assume billing without evidence).
 *  - Status preserved across all subclasses.
 *  - Error messages include the HTTP status (operator-greppable).
 */

import { describe, it, expect } from "vitest";

import {
  mapOpenAiHttpStatus,
  AuthenticationError,
  RateLimitError,
  ProviderServerError,
  ProviderUnavailableError,
  UnknownProviderError,
  ClawCodeInternalError,
} from "../openai-errors.js";

describe("mapOpenAiHttpStatus", () => {
  it("(1) 401 → AuthenticationError; status + provider preserved", () => {
    const err = mapOpenAiHttpStatus(401, {
      error: { type: "invalid_api_key", message: "no" },
    });
    expect(err).toBeInstanceOf(AuthenticationError);
    expect(err).toBeInstanceOf(ClawCodeInternalError);
    expect(err.status).toBe(401);
    expect(err.provider).toBe("openai");
    expect(err.codeFromBody).toBe("invalid_api_key");
    expect(err.message).toContain("401");
  });

  it("(2) 429 + insufficient_quota → RateLimitError subtype 'billing'", () => {
    const err = mapOpenAiHttpStatus(429, {
      error: { type: "insufficient_quota", message: "billing dry" },
    });
    expect(err).toBeInstanceOf(RateLimitError);
    expect((err as RateLimitError).subtype).toBe("billing");
    expect(err.codeFromBody).toBe("insufficient_quota");
    expect(err.message).toMatch(/billing/);
  });

  it("(3) 429 + rate_limit_exceeded → RateLimitError subtype 'rate_limit'", () => {
    const err = mapOpenAiHttpStatus(429, {
      error: { type: "rate_limit_exceeded", message: "slow down" },
    });
    expect(err).toBeInstanceOf(RateLimitError);
    expect((err as RateLimitError).subtype).toBe("rate_limit");
    expect(err.codeFromBody).toBe("rate_limit_exceeded");
  });

  it("(4) 500 → ProviderServerError", () => {
    const err = mapOpenAiHttpStatus(500, {
      error: { type: "server_error", message: "boom" },
    });
    expect(err).toBeInstanceOf(ProviderServerError);
    expect(err.status).toBe(500);
  });

  it("(5) 503 → ProviderUnavailableError", () => {
    const err = mapOpenAiHttpStatus(503, {
      error: { type: "overloaded", message: "too much" },
    });
    expect(err).toBeInstanceOf(ProviderUnavailableError);
    expect(err.status).toBe(503);
  });

  it("(6) 418 (unmapped) → UnknownProviderError, status preserved", () => {
    const err = mapOpenAiHttpStatus(418, {
      error: { type: "i_am_a_teapot" },
    });
    expect(err).toBeInstanceOf(UnknownProviderError);
    expect(err.status).toBe(418);
    expect(err.codeFromBody).toBe("i_am_a_teapot");
  });

  it("(7) malformed body still produces correct status-based error", () => {
    const err = mapOpenAiHttpStatus(401, "not json {");
    expect(err).toBeInstanceOf(AuthenticationError);
    expect(err.status).toBe(401);
    expect(err.codeFromBody).toBeNull();
    // Body is preserved verbatim (the raw string).
    expect(err.body).toBe("not json {");
  });

  it("body as JSON string is parsed", () => {
    const err = mapOpenAiHttpStatus(
      401,
      JSON.stringify({ error: { type: "invalid_api_key" } }),
    );
    expect(err.codeFromBody).toBe("invalid_api_key");
  });

  it("body absent → codeFromBody null, status-based mapping still works", () => {
    const err = mapOpenAiHttpStatus(429);
    expect(err).toBeInstanceOf(RateLimitError);
    // No body evidence of billing → conservative default 'rate_limit'.
    expect((err as RateLimitError).subtype).toBe("rate_limit");
    expect(err.codeFromBody).toBeNull();
  });

  it("all errors carry provider: 'openai'", () => {
    for (const status of [401, 429, 500, 503, 418]) {
      const err = mapOpenAiHttpStatus(status);
      expect(err.provider).toBe("openai");
    }
  });

  it("all error messages include the HTTP status string (operator-greppable)", () => {
    for (const status of [401, 429, 500, 503, 418]) {
      const err = mapOpenAiHttpStatus(status);
      expect(err.message).toContain(String(status));
    }
  });

  it("error.name reflects the subclass (operator log readability)", () => {
    expect(mapOpenAiHttpStatus(401).name).toBe("AuthenticationError");
    expect(mapOpenAiHttpStatus(429).name).toBe("RateLimitError");
    expect(mapOpenAiHttpStatus(500).name).toBe("ProviderServerError");
    expect(mapOpenAiHttpStatus(503).name).toBe("ProviderUnavailableError");
    expect(mapOpenAiHttpStatus(418).name).toBe("UnknownProviderError");
  });
});
