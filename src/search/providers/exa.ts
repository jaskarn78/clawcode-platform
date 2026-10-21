/**
 * Phase 71 — Exa Search API client.
 *
 * Endpoint: `POST https://api.exa.ai/search`
 * Auth:     `x-api-key: <EXA_API_KEY>` header
 * Body:     `{ query, numResults, useAutoprompt }`
 *
 * Mirrors `createBraveClient`'s shape — same lazy-env contract, same frozen
 * envelopes, same never-throw discipline — so `tools.ts` can dispatch to
 * either provider via a single typed interface.
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

const EXA_ENDPOINT = "https://api.exa.ai/search";

export interface ExaSearchOpts {
  readonly numResults?: number;
}

export interface ExaClient {
  search(
    query: string,
    opts?: ExaSearchOpts,
  ): Promise<SearchToolOutcome<SearchResponse>>;
}

interface ExaRawResult {
  title?: string;
  url?: string;
  text?: string;
  publishedDate?: string;
}

interface ExaRawResponse {
  results?: ExaRawResult[];
}

function normalizeResult(raw: ExaRawResult): SearchResultItem {
  const item: Partial<SearchResultItem> & { title: string; url: string; snippet: string } = {
    title: raw.title ?? "",
    url: raw.url ?? "",
    snippet: raw.text ?? "",
  };
  if (raw.publishedDate && raw.publishedDate.length > 0) {
    (item as { publishedDate?: string }).publishedDate = raw.publishedDate;
  }
  return Object.freeze(item) as SearchResultItem;
}

function okResponse(
  query: string,
  raw: ExaRawResponse,
): SearchToolOutcome<SearchResponse> {
  const results = (raw.results ?? []).map(normalizeResult);
  const response: SearchResponse = Object.freeze({
    results: Object.freeze(results),
    total: results.length,
    provider: "exa",
    query,
  });
  return Object.freeze({ ok: true as const, data: response });
}

export function createExaClient(
  config: SearchConfig,
  env: NodeJS.ProcessEnv = process.env,
): ExaClient {
  async function search(
    query: string,
    opts: ExaSearchOpts = {},
  ): Promise<SearchToolOutcome<SearchResponse>> {
    if (!query || query.length === 0) {
      return Object.freeze({
        ok: false as const,
        error: makeError("invalid_argument", "query must be a non-empty string"),
      });
    }
    const apiKey = env[config.exa.apiKeyEnv];
    if (!apiKey || apiKey.length === 0) {
      return Object.freeze({
        ok: false as const,
        error: makeError(
          "invalid_argument",
          `missing Exa API key (env var ${config.exa.apiKeyEnv} is unset)`,
        ),
      });
    }

    const numResults = Math.max(
      1,
      Math.min(opts.numResults ?? config.maxResults, config.maxResults),
    );

    const body = JSON.stringify({
      query,
      numResults,
      useAutoprompt: config.exa.useAutoprompt,
    });

    let res: Response;
    try {
      res = await fetch(EXA_ENDPOINT, {
        method: "POST",
        headers: {
          "x-api-key": apiKey,
          "content-type": "application/json",
          Accept: "application/json",
          "User-Agent": USER_AGENT,
        },
        body,
        signal: AbortSignal.timeout(config.timeoutMs),
      });
    } catch (err) {
      return Object.freeze({
        ok: false as const,
        error: toSearchToolError(err, "network"),
      });
    }

    if (!res.ok) {
      if (res.status === 429) {
        const retryAfterHeader = res.headers.get("retry-after");
        const retryAfter = retryAfterHeader
          ? Number.parseInt(retryAfterHeader, 10)
          : undefined;
        return Object.freeze({
          ok: false as const,
          error: makeError("rate_limit", "Exa API rate limit exceeded", {
            status: 429,
            ...(Number.isFinite(retryAfter) && retryAfter !== undefined
              ? { retryAfter }
              : {}),
          }),
        });
      }
      return Object.freeze({
        ok: false as const,
        error: makeError("network", `Exa API HTTP ${res.status}`, {
          status: res.status,
        }),
      });
    }

    let json: ExaRawResponse;
    try {
      json = (await res.json()) as ExaRawResponse;
    } catch (err) {
      return Object.freeze({
        ok: false as const,
        error: toSearchToolError(err, "internal"),
      });
    }

    return okResponse(query, json);
  }

  return { search };
}
