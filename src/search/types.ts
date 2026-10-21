/**
 * Phase 71 — web search MCP type contracts.
 *
 * Pure types — no runtime side effects. Every object returned at runtime
 * by providers / fetcher / tool handlers is `Object.freeze`d per CLAUDE.md
 * immutability rule.
 *
 * Error taxonomy locked per 71-CONTEXT D-02: seven discriminants, no more.
 * Extending requires a CONTEXT amendment — callers switch on `error.type`
 * and new values break exhaustiveness checks silently.
 */

/** Single search result from Brave or Exa, normalized shape. */
export interface SearchResultItem {
  readonly title: string;
  readonly url: string;
  readonly snippet: string;
  /** ISO-8601 when the provider exposes a parseable date; omitted otherwise. */
  readonly publishedDate?: string;
}

/** Full response envelope returned by a provider client. */
export interface SearchResponse {
  readonly results: ReadonlyArray<SearchResultItem>;
  /** Provider's reported total, or `results.length` when unavailable. */
  readonly total: number;
  readonly provider: "brave" | "exa";
  readonly query: string;
}

/** Result payload from `web_fetch_url`. */
export interface FetchUrlResult {
  readonly url: string;
  readonly title: string | null;
  readonly byline: string | null;
  readonly publishedDate: string | null;
  readonly text: string;
  /** Present in mode="raw" (always) and mode="readability" (when article.html is available). */
  readonly html?: string;
  readonly wordCount: number;
  readonly mode: "readability" | "raw";
}

/**
 * Error taxonomy — exactly 7 discriminants. Each maps to a distinct agent
 * action (retry, fix args, give up, try another backend). Adding a new
 * value requires a 71-CONTEXT amendment.
 */
export type SearchErrorType =
  | "network"
  | "rate_limit"
  | "invalid_url"
  | "size_limit"
  | "extraction_failed"
  | "invalid_argument"
  | "internal";

/** Structured error returned by every provider / fetcher / handler. */
export interface SearchError {
  readonly type: SearchErrorType;
  readonly message: string;
  /** HTTP status code when the error originated from an HTTP response. */
  readonly status?: number;
  /** Seconds — populated on rate_limit when the `retry-after` header is present. */
  readonly retryAfter?: number;
  /** Provider-specific debug context (not required for agent decisions). */
  readonly details?: Record<string, unknown>;
}

/**
 * Discriminated-union return type for every handler / provider / fetcher
 * call. Callers branch on `ok` — never throw.
 */
export type SearchToolOutcome<T = unknown> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly error: SearchError };
