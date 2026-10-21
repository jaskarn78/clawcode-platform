/**
 * Phase 71 — pure tool handlers for `web_search` and `web_fetch_url`.
 *
 * Both handlers follow Phase 70's `browser/tools.ts` pattern:
 *   - Pure functions with explicit dependency injection. Every I/O boundary
 *     (HTTP clients, URL fetcher, article extractor) is a seam the test
 *     suite substitutes with `vi.fn()`. No module-level singletons.
 *   - Never throw. All failure paths return
 *     `{ ok: false, error: SearchError }`. Callers branch on `ok`.
 *   - Every returned object is `Object.freeze`d (both envelope and nested
 *     error) per CLAUDE.md immutability rule.
 *
 * Plan 02 will wire these handlers into an MCP stdio server + the daemon
 * auto-inject path. This plan ships the handlers in isolation so the
 * behavioural contract is pinned before the transport layer gets built.
 */

import { z } from "zod/v4";
import type { SearchConfig } from "../config/schema.js";
import { extractArticle } from "./readability.js";
import { makeError, toSearchToolError } from "./errors.js";
import type {
  FetchUrlResult,
  SearchError,
  SearchResponse,
  SearchToolOutcome,
} from "./types.js";

/** Minimal provider shape both concrete providers satisfy. */
export interface SearchProvider {
  search(
    query: string,
    opts?: { numResults?: number },
  ): Promise<SearchToolOutcome<SearchResponse>>;
}

/** Fetcher shape satisfied by src/search/fetcher.ts `fetchUrl`. */
export type SearchFetcher = (
  url: string,
  opts: { timeoutMs: number; maxBytes: number; userAgentSuffix: string | null },
) => Promise<
  | {
      readonly ok: true;
      readonly status: number;
      readonly headers: Record<string, string>;
      readonly body: Buffer;
    }
  | { readonly ok: false; readonly error: SearchError }
>;

/**
 * Injected dependencies for the search tool handlers.
 *
 * `extractArticle` is optional — the default comes from ./readability.ts,
 * but tests can swap in a vi.fn() to bypass Readability+JSDOM. Providers
 * and fetcher are required so tests can't accidentally hit the real network.
 */
export interface SearchToolDeps {
  readonly config: SearchConfig;
  readonly braveClient: SearchProvider;
  readonly exaClient: SearchProvider;
  readonly fetcher: SearchFetcher;
  readonly extractArticle?: typeof extractArticle;
}

/** Supported content-type families for `mode="readability"` extraction. */
const TEXT_CONTENT_TYPES = ["text/html", "application/xhtml+xml", "text/plain"];

function isTextContentType(contentType: string | undefined): boolean {
  if (!contentType) return true; // missing header — allow; body may still be HTML
  const [base] = contentType.split(";", 1);
  return TEXT_CONTENT_TYPES.includes(base.trim().toLowerCase());
}

/** Freeze-and-return a failure envelope (helper to keep call sites terse). */
function fail<T>(error: SearchError): SearchToolOutcome<T> {
  return Object.freeze({ ok: false as const, error });
}

/** Freeze-and-return a success envelope. */
function success<T>(data: T): SearchToolOutcome<T> {
  return Object.freeze({ ok: true as const, data });
}

/** Count words — agents use this as a cheap "how much to read" signal. */
function countWords(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

/**
 * `web_search(query, numResults?)` — dispatches to Brave or Exa per
 * `config.backend`. Clamps `numResults` to `[1, config.maxResults]` with
 * negative values rejected as `invalid_argument`.
 */
export async function webSearch(
  args: { query: string; numResults?: number },
  deps: SearchToolDeps,
): Promise<SearchToolOutcome<SearchResponse>> {
  if (!args.query || typeof args.query !== "string" || args.query.length === 0) {
    return fail(makeError("invalid_argument", "query must be a non-empty string"));
  }
  if (args.numResults !== undefined) {
    if (!Number.isInteger(args.numResults) || args.numResults < 1) {
      return fail(
        makeError("invalid_argument", "numResults must be a positive integer"),
      );
    }
  }

  const clamped =
    args.numResults !== undefined
      ? Math.min(args.numResults, deps.config.maxResults)
      : undefined;

  const provider: SearchProvider =
    deps.config.backend === "exa" ? deps.exaClient : deps.braveClient;

  try {
    return await provider.search(
      args.query,
      clamped !== undefined ? { numResults: clamped } : undefined,
    );
  } catch (err) {
    // Providers are contracted to never throw, but defence-in-depth: if the
    // DI substitute (e.g., a test mock) throws, map it into the taxonomy
    // instead of propagating.
    return fail(toSearchToolError(err, "internal"));
  }
}

/**
 * `web_fetch_url(url, mode?, maxBytes?)` — fetches `url` with the injected
 * fetcher, then either extracts a clean article via Readability
 * (mode="readability", default) or returns raw HTML + stripped text
 * (mode="raw").
 */
export async function webFetchUrl(
  args: { url: string; mode?: "readability" | "raw"; maxBytes?: number },
  deps: SearchToolDeps,
): Promise<SearchToolOutcome<FetchUrlResult>> {
  // Mode guard — handled before URL validation so an unknown mode is a clear
  // argument error rather than a confusing "invalid_url".
  const mode = args.mode ?? "readability";
  if (mode !== "readability" && mode !== "raw") {
    return fail(
      makeError("invalid_argument", `unknown mode: ${String(args.mode)}`),
    );
  }

  // URL guard — parse + http/https check.
  if (!args.url || typeof args.url !== "string" || args.url.length === 0) {
    return fail(makeError("invalid_url", "url must be a non-empty string"));
  }
  try {
    const parsed = new URL(args.url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return fail(
        makeError("invalid_url", `unsupported URL scheme: ${parsed.protocol}`),
      );
    }
  } catch {
    return fail(makeError("invalid_url", `invalid URL: ${args.url}`));
  }

  const fetchOpts = {
    timeoutMs: deps.config.fetch.timeoutMs,
    maxBytes: args.maxBytes ?? deps.config.fetch.maxBytes,
    userAgentSuffix: deps.config.fetch.userAgentSuffix,
  };

  let fetched: Awaited<ReturnType<SearchFetcher>>;
  try {
    fetched = await deps.fetcher(args.url, fetchOpts);
  } catch (err) {
    return fail(toSearchToolError(err, "network"));
  }
  if (!fetched.ok) {
    return fail(fetched.error);
  }

  // Content-type guard — mode="raw" still runs through jsdom, which needs
  // HTML-like input. Serving a PDF through Readability would produce garbage.
  const contentType = fetched.headers["content-type"];
  if (!isTextContentType(contentType)) {
    return fail(
      makeError(
        "extraction_failed",
        `unsupported content type: ${contentType ?? "unknown"}`,
        { details: { contentType: contentType ?? null } },
      ),
    );
  }

  const html = fetched.body.toString("utf8");

  if (mode === "raw") {
    // Use jsdom's innerText for the raw-mode text — matches what agents see
    // in a browser reader. Lazy-import so tests that never hit raw mode
    // don't pay the jsdom cost.
    let text: string;
    try {
      const { JSDOM } = await import("jsdom");
      const dom = new JSDOM(html, { url: args.url });
      try {
        text = dom.window.document.body?.textContent?.replace(/\s+/g, " ").trim() ?? "";
      } finally {
        dom.window.close();
      }
    } catch (err) {
      return fail(toSearchToolError(err, "internal"));
    }
    const result: FetchUrlResult = Object.freeze({
      url: args.url,
      title: null,
      byline: null,
      publishedDate: null,
      text,
      html,
      wordCount: countWords(text),
      mode: "raw" as const,
    });
    return success(result);
  }

  // mode === "readability"
  const extractor = deps.extractArticle ?? extractArticle;
  let article;
  try {
    article = await extractor(html, args.url);
  } catch (err) {
    return fail(toSearchToolError(err, "internal"));
  }
  if (!article) {
    return fail(
      makeError("extraction_failed", "page is not an article (Readability returned null)"),
    );
  }

  const result: FetchUrlResult = Object.freeze({
    url: args.url,
    title: article.title,
    byline: article.byline,
    publishedDate: article.publishedTime,
    text: article.text,
    html: article.html,
    wordCount: countWords(article.text),
    mode: "readability" as const,
  });
  return success(result);
}

// ---------------------------------------------------------------------------
// TOOL_DEFINITIONS — the MCP tool schemas Plan 02 will register.
// ---------------------------------------------------------------------------

export interface ToolDefinition {
  readonly name: "web_search" | "web_fetch_url";
  readonly description: string;
  readonly schemaBuilder: (z_: typeof z) => Record<string, unknown>;
}

export const TOOL_DEFINITIONS: ReadonlyArray<ToolDefinition> = Object.freeze([
  Object.freeze({
    name: "web_search" as const,
    description:
      "Search the live web (Brave by default, Exa optional per config). Returns ranked results with title, URL, snippet, and published date when available. Cached intra-turn: duplicate queries within one turn return instantly.",
    schemaBuilder: (z_: typeof z) => ({
      query: z_.string().min(1).describe("Search query"),
      numResults: z_
        .number()
        .int()
        .min(1)
        .max(20)
        .optional()
        .describe("Max 20; clamped to config.maxResults"),
    }),
  }),
  Object.freeze({
    name: "web_fetch_url" as const,
    description:
      "Fetch a URL and return clean article text (Mozilla Readability) plus metadata (title, byline, published date). Use after web_search to read a specific result. 1 MB size cap, 30s timeout. Cached intra-turn.",
    schemaBuilder: (z_: typeof z) => ({
      url: z_.string().url(),
      mode: z_.enum(["readability", "raw"]).optional(),
      maxBytes: z_.number().int().min(1).optional(),
    }),
  }),
]);
