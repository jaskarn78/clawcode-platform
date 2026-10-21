/**
 * Phase 72 — structured error factory + mapper for the image MCP.
 *
 * Every error-path return in `providers/`, `workspace.ts`, `costs.ts`,
 * and `tools.ts` flows through `makeImageError` (to freeze the payload)
 * or `toImageToolError` (to convert an unexpected `unknown` into a typed
 * `ImageError`).
 *
 * NEVER throw from image code — callers branch on `ImageToolOutcome.ok`.
 *
 * Mirrors src/search/errors.ts shape so the two MCP families share
 * mental model + test patterns.
 */

import type { ImageBackend, ImageError, ImageErrorType } from "./types.js";

/**
 * Build a frozen `ImageError`. Use for any path that needs to return a
 * structured error (provider mapping, workspace writer, handler guards).
 */
export function makeImageError(
  type: ImageErrorType,
  message: string,
  extras: Partial<Omit<ImageError, "type" | "message">> = {},
): ImageError {
  const err: ImageError = { type, message, ...extras };
  return Object.freeze(err);
}

/**
 * Map an unexpected `unknown` thrown value into an `ImageError`. Used in
 * provider / workspace catch blocks to normalize layer exceptions
 * (AbortError, TypeError from `fetch`, FS errors) into the taxonomy.
 *
 * Mapping rules:
 *  - `AbortError` (name === "AbortError")     → fallbackType (usually "network")
 *                                               with "request aborted (timeout)"
 *  - `TypeError` with /fetch/i in message     → `network` (DNS, conn refused)
 *  - anything else                            → `fallbackType` (defaults to `internal`)
 *
 * Only `name` + `message` are inspected — DOM-agnostic (works for both
 * Node's undici and browser `fetch`).
 */
export function toImageToolError(
  err: unknown,
  fallbackType: ImageErrorType = "internal",
  backend?: ImageBackend,
): ImageError {
  const backendExtra = backend ? { backend } : {};
  if (err instanceof Error) {
    if (err.name === "AbortError") {
      return makeImageError(fallbackType, "request aborted (timeout)", {
        ...backendExtra,
        details: { cause: "abort" },
      });
    }
    if (err.name === "TypeError" && /fetch/i.test(err.message)) {
      return makeImageError("network", err.message, {
        ...backendExtra,
        details: { cause: "fetch-type-error" },
      });
    }
    return makeImageError(fallbackType, err.message, backendExtra);
  }
  return makeImageError(
    fallbackType,
    typeof err === "string" ? err : "unknown error",
    backendExtra,
  );
}
