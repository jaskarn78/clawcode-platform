/**
 * Phase 72 — image generation MCP type contracts.
 *
 * Pure types — no runtime side effects. Every object returned at runtime
 * by providers / workspace / tool handlers is `Object.freeze`d per
 * CLAUDE.md immutability rule.
 *
 * Error taxonomy locked per 72-CONTEXT D-02: 8 discriminants. Adding a
 * new value requires a CONTEXT amendment — callers switch on `error.type`
 * and new values break exhaustiveness checks silently.
 */

/** Backend selector — locked union per 72-CONTEXT. */
export type ImageBackend = "openai" | "minimax" | "fal";

/**
 * Error taxonomy. Each maps to a distinct agent action (retry, fix args,
 * give up, try another backend).
 *
 *  - rate_limit            backend rate-limited (transient, retry with backoff)
 *  - invalid_input         arg / config / file path / API key issue (caller fix,
 *                          surfaced by provider-level validation)
 *  - invalid_argument      IPC-boundary argument violation (unknown agent,
 *                          unknown toolName) — mirrors the search/browser
 *                          taxonomy used by sibling daemon handlers.
 *  - backend_unavailable   backend unreachable / 5xx (try another backend)
 *  - unsupported_operation backend doesn't support requested op (e.g. minimax + edit)
 *  - content_policy        prompt rejected by safety filter (caller rephrase)
 *  - network               transport-layer failure (DNS, TLS, abort)
 *  - size_limit            generated image exceeded `maxImageBytes` cap
 *  - internal              unexpected — bug in our code or DI substitute throw
 */
export type ImageErrorType =
  | "rate_limit"
  | "invalid_input"
  | "invalid_argument"
  | "backend_unavailable"
  | "unsupported_operation"
  | "content_policy"
  | "network"
  | "size_limit"
  | "internal";

/** Structured error returned by every provider / handler. */
export interface ImageError {
  readonly type: ImageErrorType;
  readonly message: string;
  /** Backend identity when the error originated from a specific provider. */
  readonly backend?: ImageBackend;
  /** HTTP status code when the error originated from an HTTP response. */
  readonly status?: number;
  /** Provider-specific debug context (not required for agent decisions). */
  readonly details?: Record<string, unknown>;
}

/**
 * A single generated image's metadata. `path` is the absolute workspace
 * path written by `writeImageToWorkspace` — agents pass this to
 * `send_attachment` for Discord delivery.
 */
export interface GeneratedImage {
  readonly path: string;
  /** Backend's hosted URL when returned (transient — may expire). */
  readonly url?: string;
  /** Resolved size in `WxH` format (e.g. "1024x1024"). */
  readonly size: string;
  readonly backend: ImageBackend;
  readonly model: string;
  readonly prompt: string;
  /** Best-effort cost estimate in cents (per IMAGE_PRICING table). */
  readonly cost_cents: number;
}

/** Result envelope for `image_generate`. */
export interface ImageGenerateResult {
  readonly images: ReadonlyArray<GeneratedImage>;
  readonly total_cost_cents: number;
}

/** Result envelope for `image_edit`. */
export interface ImageEditResult {
  readonly images: ReadonlyArray<GeneratedImage>;
  readonly total_cost_cents: number;
}

/** Result envelope for `image_variations`. */
export interface ImageVariationsResult {
  readonly images: ReadonlyArray<GeneratedImage>;
  readonly total_cost_cents: number;
}

/**
 * Discriminated-union return type for every handler / provider call.
 * Callers branch on `ok` — never throw.
 */
export type ImageToolOutcome<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly error: ImageError };

/**
 * Cost-recording event passed from tool handlers into the UsageTracker
 * via `recordImageUsage`. Captures the backend / model / count / cost
 * dimensions distinct from token usage.
 */
export interface ImageUsageEvent {
  readonly agent: string;
  readonly backend: ImageBackend;
  readonly model: string;
  readonly count: number;
  readonly cost_cents: number;
  readonly size: string;
  readonly timestamp: string;
  readonly session_id: string;
  readonly turn_id?: string;
}

/**
 * Provider contract — re-exported from `./tools.js` so callers that import
 * type contracts from this module (the canonical types entry point) can
 * reference `ImageProvider` without reaching into `tools.ts`. Callers that
 * need both the type and the implementing helpers continue to import from
 * `./tools.js` directly.
 */
export type { ImageProvider } from "./tools.js";
