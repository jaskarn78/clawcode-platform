import type { BrowserContext } from "playwright-core";

/**
 * Phase 70 — frozen contracts consumed by Plan 02 (MCP tool handlers) and
 * Plan 03 (daemon + CLI). Types only — no runtime code here. Any future
 * runtime helpers that need to import these types go next to this file.
 */

/**
 * Success envelope returned by browser tool handlers.
 *
 * Agents/tools read `ok === true` to branch on success vs. structured error.
 * The type parameter `T` captures the tool-specific result shape (e.g.
 * `{ url, title, status }` for browser_navigate).
 */
export interface BrowserToolResult<T = unknown> {
  readonly ok: true;
  readonly data: T;
}

/**
 * Structured-error envelope. LOCKED by 70-CONTEXT.md "Error shape" line:
 *   { error: { type, message, selector?, timeout? } }.
 *
 * `type` is drawn from `BROWSER_ERROR_TYPES`. `selector` and `timeoutMs`
 * are optional context fields that surface to the agent so it can retry
 * with a different selector or a longer timeout.
 */
export interface BrowserToolError {
  readonly ok: false;
  readonly error: {
    readonly type:
      | "timeout"
      | "element_not_found"
      | "navigation_failed"
      | "launch_failed"
      | "invalid_argument"
      | "internal";
    readonly message: string;
    readonly selector?: string;
    readonly timeoutMs?: number;
  };
}

/** Union of success and error envelopes for tool handlers. */
export type BrowserToolOutcome<T = unknown> =
  | BrowserToolResult<T>
  | BrowserToolError;

/**
 * Handle identifying one per-agent BrowserContext binding. Used by the
 * BrowserManager internally and surfaced to Plan 02 tool handlers when
 * they need to resolve the storage path (e.g. for screenshot savePath
 * defaulting under `<workspace>/browser/screenshots/...`).
 */
export interface AgentContextHandle {
  readonly agent: string;
  readonly workspace: string;
  readonly statePath: string;
}

/**
 * Minimal pino-compatible logger interface. Kept narrow so Plan 02/03
 * can inject any structured logger (pino, a test stub, or a simple
 * console wrapper) without dragging pino's entire type surface into
 * this module.
 */
export interface BrowserLogger {
  info(obj: object, msg?: string): void;
  info(msg: string): void;
  warn(obj: object, msg?: string): void;
  warn(msg: string): void;
  error(obj: object, msg?: string): void;
  error(msg: string): void;
  debug(obj: object, msg?: string): void;
  debug(msg: string): void;
}

/**
 * Re-export Playwright's BrowserContext so Plan 02 consumers do not need
 * a direct `playwright-core` import — they only consume types via this
 * module. Keeps the browser module the sole gateway into Playwright types.
 */
export type { BrowserContext };
