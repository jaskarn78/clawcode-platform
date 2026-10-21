/**
 * Phase 71 — structured error factory + mapper for the web search MCP.
 *
 * Every error-path return in `providers/`, `fetcher.ts`, and `tools.ts`
 * flows through `makeError` (to freeze the payload) or `toSearchToolError`
 * (to convert an unexpected `unknown` into a typed `SearchError`).
 *
 * NEVER throw from search code — callers branch on `SearchToolOutcome.ok`.
 */

import type { SearchError, SearchErrorType } from "./types.js";

/**
 * Build a frozen `SearchError`. Use for any path that needs to return a
 * structured error (provider mapping, fetcher, handler guard clauses).
 *
 * Freezing the payload matches CLAUDE.md immutability rule and prevents
 * accidental mutation at the callsite (e.g. a caller wrapping and adding
 * a `retryAfter` that would alter the upstream object).
 */
export function makeError(
  type: SearchErrorType,
  message: string,
  extras: Partial<Omit<SearchError, "type" | "message">> = {},
): SearchError {
  const err: SearchError = { type, message, ...extras };
  return Object.freeze(err);
}

/**
 * Map an unexpected `unknown` thrown value into a `SearchError`. Used in
 * provider / fetcher catch blocks to normalize network-layer exceptions
 * (AbortError, TypeError from `fetch`) into the taxonomy.
 *
 * Mapping rules:
 *  - `AbortError` (name === "AbortError")     → `network` + "request aborted (timeout)"
 *  - `TypeError` with /fetch/i in message     → `network` (DNS failure, connection refused, etc.)
 *  - anything else                            → `fallbackType` (defaults to `internal`)
 *
 * Only the `name` + `message` fields of the caught value are inspected —
 * this is DOM-agnostic (works for both Node's undici and browser `fetch`).
 */
export function toSearchToolError(
  err: unknown,
  fallbackType: SearchErrorType = "internal",
): SearchError {
  if (err instanceof Error) {
    if (err.name === "AbortError") {
      return makeError("network", "request aborted (timeout)", {
        details: { cause: "abort" },
      });
    }
    if (err.name === "TypeError" && /fetch/i.test(err.message)) {
      return makeError("network", err.message, { details: { cause: "fetch-type-error" } });
    }
    return makeError(fallbackType, err.message);
  }
  return makeError(fallbackType, typeof err === "string" ? err : "unknown error");
}
