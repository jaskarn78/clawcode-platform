/**
 * Phase 71 — Brave Search API client.
 *
 * Endpoint: `GET https://api.search.brave.com/res/v1/web/search`
 * Auth:     `X-Subscription-Token: <BRAVE_API_KEY>` header
 *
 * Design rules (per 71-CONTEXT + CLAUDE.md):
 *  - NEVER throws — every path returns a `SearchToolOutcome<SearchResponse>`.
 *  - Lazy API-key read: `createBraveClient(config, env)` does NOT read the
 *    key at construction. The key is fetched from `env[config.brave.apiKeyEnv]`
 *    on each `search()` call so missing keys at daemon boot surface as
 *    `invalid_argument` errors on the first actual call (not as daemon crashes).
 *  - Frozen envelopes: every returned object (outer, nested `results[]`, any
 *    error) is `Object.freeze`d.
 *  - Zero npm deps: native `fetch` + `URLSearchParams`.
 */

import { CLAWCODE_VERSION } from "../../shared/version.js";
import type {
  SearchResponse,
  SearchResultItem,
  SearchToolOutcome,
} from "../types.js";
import type { SearchConfig } from "../../config/schema.js";
import { makeError, toSearchToolError } from "../errors.js";

const USER_AGENT = `ClawCode/${CLAWCODE_VERSION} (+https://github.com/example-user/clawcode)`;

const BRAVE_ENDPOINT = "https://api.search.brave.com/res/v1/web/search";

export interface BraveSearchOpts {
  readonly numResults?: number;
}

export interface BraveClient {
  search(
    query: string,
    opts?: BraveSearchOpts,
  ): Promise<SearchToolOutcome<SearchResponse>>;
}

interface BraveRawResult {
  title?: string;
  url?: string;
  description?: string;
  age?: string;
}

interface BraveRawResponse {
  web?: { results?: BraveRawResult[] };
}

/** Shape a raw Brave result into our normalized SearchResultItem (frozen). */
function normalizeResult(raw: BraveRawResult): SearchResultItem {
  const item: Partial<SearchResultItem> & { title: string; url: string; snippet: string } = {
    title: raw.title ?? "",
    url: raw.url ?? "",
    snippet: raw.description ?? "",
  };
  if (raw.age && raw.age.length > 0) {
    (item as { publishedDate?: string }).publishedDate = raw.age;
  }
  return Object.freeze(item) as SearchResultItem;
}

/** Build the outcome envelope and freeze everything the caller may touch. */
function okResponse(
  query: string,
  raw: BraveRawResponse,
): SearchToolOutcome<SearchResponse> {
  const results = (raw.web?.results ?? []).map(normalizeResult);
  const response: SearchResponse = Object.freeze({
    results: Object.freeze(results),
    total: results.length,
    provider: "brave",
    query,
  });
  return Object.freeze({ ok: true as const, data: response });
}

/**
 * Factory. Construction is zero-cost: no network, no env read, no validation
 * beyond what Zod already did on `config`.
 */
export function createBraveClient(
  config: SearchConfig,
  env: NodeJS.ProcessEnv = process.env,
): BraveClient {
  async function search(
    query: string,
    opts: BraveSearchOpts = {},
  ): Promise<SearchToolOutcome<SearchResponse>> {
    // Input guards (sync — no network).
    if (!query || query.length === 0) {
      return Object.freeze({
        ok: false as const,
        error: makeError("invalid_argument", "query must be a non-empty string"),
      });
    }
    const apiKey = env[config.brave.apiKeyEnv];
    if (!apiKey || apiKey.length === 0) {
      return Object.freeze({
        ok: false as const,
        error: makeError(
          "invalid_argument",
          `missing Brave API key (env var ${config.brave.apiKeyEnv} is unset)`,
        ),
      });
    }

    const count = Math.max(1, Math.min(opts.numResults ?? config.maxResults, config.maxResults));

    const params = new URLSearchParams({
      q: query,
      count: String(count),
      safesearch: config.brave.safeSearch,
      country: config.brave.country,
    });
    const url = `${BRAVE_ENDPOINT}?${params.toString()}`;

    let res: Response;
    try {
      res = await fetch(url, {
        method: "GET",
        headers: {
          "X-Subscription-Token": apiKey,
          Accept: "application/json",
          "User-Agent": USER_AGENT,
        },
        signal: AbortSignal.timeout(config.timeoutMs),
      });
    } catch (err) {
      return Object.freeze({
        ok: false as const,
        error: toSearchToolError(err, "network"),
      });
    }

    if (!res.ok) {
      // 429 → rate_limit; everything else → network (including 401/403 which
      // are auth/authorization gates at the API layer — agents should surface
      // to the user / try the other backend, not keep retrying).
      if (res.status === 429) {
        const retryAfterHeader = res.headers.get("retry-after");
        const retryAfter = retryAfterHeader
          ? Number.parseInt(retryAfterHeader, 10)
          : undefined;
        return Object.freeze({
          ok: false as const,
          error: makeError("rate_limit", "Brave API rate limit exceeded", {
            status: 429,
            ...(Number.isFinite(retryAfter) && retryAfter !== undefined
              ? { retryAfter }
              : {}),
          }),
        });
      }
      return Object.freeze({
        ok: false as const,
        error: makeError("network", `Brave API HTTP ${res.status}`, {
          status: res.status,
        }),
      });
    }

    let body: BraveRawResponse;
    try {
      body = (await res.json()) as BraveRawResponse;
    } catch (err) {
      return Object.freeze({
        ok: false as const,
        error: toSearchToolError(err, "internal"),
      });
    }

    return okResponse(query, body);
  }

  return { search };
}

/** Legacy-style class-y alias for callers that prefer a class import. */
export type { BraveClient as BraveClientInterface };
