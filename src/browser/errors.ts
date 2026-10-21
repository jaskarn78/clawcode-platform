import type { BrowserToolError } from "./types.js";

/**
 * Phase 70 — canonical error type taxonomy. LOCKED by 70-CONTEXT.md
 * "Error shape" line. Plan 02 tool handlers map thrown Playwright
 * errors onto this taxonomy via `toBrowserToolError` below.
 *
 * Adding a new type requires a CONTEXT.md amendment — agents/tools
 * rely on this enum for branching retry behavior.
 */
export const BROWSER_ERROR_TYPES = [
  "timeout",
  "element_not_found",
  "navigation_failed",
  "launch_failed",
  "invalid_argument",
  "internal",
] as const;

export type BrowserErrorType = (typeof BROWSER_ERROR_TYPES)[number];

/**
 * Typed error thrown by the BrowserManager and browser tool handlers.
 *
 * Mirrors the `extends Error` shape from src/shared/errors.ts with
 * readonly `type`/`selector`/`timeoutMs` context fields that flow
 * directly into `BrowserToolError.error` via `toBrowserToolError`.
 *
 * `opts.cause` is threaded into the native `Error.cause` property
 * so stack traces from Playwright/jsdom preserve the full chain.
 */
export class BrowserError extends Error {
  readonly type: BrowserErrorType;
  readonly selector?: string;
  readonly timeoutMs?: number;

  constructor(
    type: BrowserErrorType,
    message: string,
    opts: { selector?: string; timeoutMs?: number; cause?: unknown } = {},
  ) {
    super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = "BrowserError";
    this.type = type;
    if (opts.selector !== undefined) this.selector = opts.selector;
    if (opts.timeoutMs !== undefined) this.timeoutMs = opts.timeoutMs;
  }
}

/**
 * Normalize any thrown value into a frozen `BrowserToolError` envelope.
 *
 * - `BrowserError` → structured shape preserved.
 * - Playwright's `TimeoutError` (checked via `err.name === "TimeoutError"`)
 *   → `type: "timeout"`.
 * - Anything else → `type: "internal"` with best-effort message extraction.
 *
 * Result object and `error` sub-object are both `Object.freeze`d to
 * satisfy CLAUDE.md immutability — tool handlers return these directly
 * to agents with no further mutation.
 */
export function toBrowserToolError(err: unknown): BrowserToolError {
  if (err instanceof BrowserError) {
    return Object.freeze({
      ok: false as const,
      error: Object.freeze({
        type: err.type,
        message: err.message,
        ...(err.selector !== undefined ? { selector: err.selector } : {}),
        ...(err.timeoutMs !== undefined ? { timeoutMs: err.timeoutMs } : {}),
      }),
    });
  }
  if (err instanceof Error && err.name === "TimeoutError") {
    return Object.freeze({
      ok: false as const,
      error: Object.freeze({
        type: "timeout" as const,
        message: err.message,
      }),
    });
  }
  const msg = err instanceof Error ? err.message : String(err);
  return Object.freeze({
    ok: false as const,
    error: Object.freeze({
      type: "internal" as const,
      message: msg,
    }),
  });
}
