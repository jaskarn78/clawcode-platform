import { describe, it, expect, vi, afterEach } from "vitest";
import {
  TOOL_DEFINITIONS,
  webFetchUrl,
  webSearch,
  type SearchToolDeps,
} from "../tools.js";
import { searchConfigSchema, type SearchConfig } from "../../config/schema.js";
import type { ArticleResult } from "../../browser/readability.js";
import type { SearchResponse } from "../types.js";

function makeConfig(overrides: Partial<SearchConfig> = {}): SearchConfig {
  return { ...searchConfigSchema.parse({}), ...overrides };
}

function makeArticle(overrides: Partial<ArticleResult> = {}): ArticleResult {
  return Object.freeze({
    title: "Test Article",
    byline: "Clawdy",
    siteName: "ClawCode Journal",
    publishedTime: "2026-04-18T12:00:00Z",
    lang: "en",
    excerpt: "A test article.",
    text: "hello world this is the article body",
    html: "<p>hello world this is the article body</p>",
    length: 36,
    ...overrides,
  });
}

function makeSearchResponse(
  provider: "brave" | "exa",
  query = "claude",
): SearchResponse {
  return Object.freeze({
    results: Object.freeze([
      Object.freeze({
        title: "Result 1",
        url: "https://example.com/1",
        snippet: "snippet 1",
      }),
    ]),
    total: 1,
    provider,
    query,
  });
}

function makeDeps(overrides: Partial<SearchToolDeps> = {}): SearchToolDeps {
  return {
    config: makeConfig(),
    braveClient: {
      search: vi.fn().mockResolvedValue({ ok: true, data: makeSearchResponse("brave") }),
    },
    exaClient: {
      search: vi.fn().mockResolvedValue({ ok: true, data: makeSearchResponse("exa") }),
    },
    fetcher: vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: { "content-type": "text/html" },
      body: Buffer.from("<html><body><article>hello world</article></body></html>", "utf8"),
    }),
    extractArticle: vi.fn().mockResolvedValue(makeArticle()),
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// webSearch
// ---------------------------------------------------------------------------

describe("webSearch", () => {
  it("W1: config.backend='brave' → dispatches to braveClient.search, returns outcome", async () => {
    const deps = makeDeps();
    const outcome = await webSearch({ query: "claude" }, deps);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.data.provider).toBe("brave");
    expect(deps.braveClient.search).toHaveBeenCalledTimes(1);
    expect(deps.exaClient.search).not.toHaveBeenCalled();
  });

  it("W2: config.backend='exa' → dispatches to exaClient.search", async () => {
    const deps = makeDeps({ config: makeConfig({ backend: "exa" }) });
    const outcome = await webSearch({ query: "claude" }, deps);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.data.provider).toBe("exa");
    expect(deps.exaClient.search).toHaveBeenCalledTimes(1);
    expect(deps.braveClient.search).not.toHaveBeenCalled();
  });

  it("W3: empty query → invalid_argument, NO client call", async () => {
    const deps = makeDeps();
    const outcome = await webSearch({ query: "" }, deps);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error.type).toBe("invalid_argument");
      expect(outcome.error.message).toMatch(/query/i);
    }
    expect(deps.braveClient.search).not.toHaveBeenCalled();
    expect(deps.exaClient.search).not.toHaveBeenCalled();
  });

  it("W4: numResults=50 → silently clamped to config.maxResults (20)", async () => {
    const deps = makeDeps();
    await webSearch({ query: "x", numResults: 50 }, deps);
    expect(deps.braveClient.search).toHaveBeenCalledWith("x", { numResults: 20 });
  });

  it("W5: numResults=-1 → invalid_argument", async () => {
    const deps = makeDeps();
    const outcome = await webSearch({ query: "x", numResults: -1 }, deps);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error.type).toBe("invalid_argument");
    expect(deps.braveClient.search).not.toHaveBeenCalled();
  });

  it("W6: client returns rate_limit → passed through verbatim", async () => {
    const deps = makeDeps({
      braveClient: {
        search: vi.fn().mockResolvedValue({
          ok: false,
          error: Object.freeze({
            type: "rate_limit" as const,
            message: "Brave rate limit",
            retryAfter: 30,
          }),
        }),
      },
    });
    const outcome = await webSearch({ query: "x" }, deps);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error.type).toBe("rate_limit");
      expect(outcome.error.retryAfter).toBe(30);
    }
  });

  it("numResults within bounds is forwarded unchanged", async () => {
    const deps = makeDeps();
    await webSearch({ query: "x", numResults: 5 }, deps);
    expect(deps.braveClient.search).toHaveBeenCalledWith("x", { numResults: 5 });
  });
});

// ---------------------------------------------------------------------------
// webFetchUrl
// ---------------------------------------------------------------------------

describe("webFetchUrl", () => {
  it("F1: mode defaults to readability, extracts article, returns FetchUrlResult", async () => {
    const deps = makeDeps();
    const outcome = await webFetchUrl({ url: "https://example.com/article" }, deps);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.data.mode).toBe("readability");
      expect(outcome.data.url).toBe("https://example.com/article");
      expect(outcome.data.title).toBe("Test Article");
      expect(outcome.data.byline).toBe("Clawdy");
      expect(outcome.data.publishedDate).toBe("2026-04-18T12:00:00Z");
      expect(outcome.data.text).toBe("hello world this is the article body");
      expect(outcome.data.wordCount).toBe(7); // "hello world this is the article body"
    }
    expect(deps.fetcher).toHaveBeenCalledTimes(1);
    expect(deps.extractArticle).toHaveBeenCalledTimes(1);
  });

  it("F2: mode='raw' bypasses readability, returns raw mode with html+text", async () => {
    const deps = makeDeps();
    const outcome = await webFetchUrl(
      { url: "https://example.com/docs", mode: "raw" },
      deps,
    );
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.data.mode).toBe("raw");
      expect(outcome.data.title).toBeNull();
      expect(outcome.data.byline).toBeNull();
      expect(outcome.data.publishedDate).toBeNull();
      expect(typeof outcome.data.text).toBe("string");
      expect(outcome.data.text.length).toBeGreaterThan(0);
      expect(outcome.data.html).toBeDefined();
    }
    expect(deps.extractArticle).not.toHaveBeenCalled();
  });

  it("F3: invalid URL → invalid_url, fetcher NOT called", async () => {
    const deps = makeDeps();
    const outcome = await webFetchUrl({ url: "not-a-url" }, deps);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error.type).toBe("invalid_url");
    expect(deps.fetcher).not.toHaveBeenCalled();
  });

  it("F4: fetcher returns size_limit → passed through verbatim", async () => {
    const sizeError = Object.freeze({
      type: "size_limit" as const,
      message: "too big",
    });
    const deps = makeDeps({
      fetcher: vi.fn().mockResolvedValue({ ok: false, error: sizeError }),
    });
    const outcome = await webFetchUrl({ url: "https://example.com/big" }, deps);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error.type).toBe("size_limit");
  });

  it("F5: readability returns null → extraction_failed with /not an article/i", async () => {
    const deps = makeDeps({
      extractArticle: vi.fn().mockResolvedValue(null),
    });
    const outcome = await webFetchUrl(
      { url: "https://example.com/login", mode: "readability" },
      deps,
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error.type).toBe("extraction_failed");
      expect(outcome.error.message).toMatch(/not an article/i);
    }
  });

  it("F6: unknown mode → invalid_argument", async () => {
    const deps = makeDeps();
    // @ts-expect-error intentional bad mode to exercise the guard
    const outcome = await webFetchUrl({ url: "https://example.com/", mode: "turbo" }, deps);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error.type).toBe("invalid_argument");
  });

  it("F7: non-text content-type → extraction_failed with /unsupported content type/i, readability skipped", async () => {
    const deps = makeDeps({
      fetcher: vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: { "content-type": "application/pdf" },
        body: Buffer.from([0x25, 0x50, 0x44, 0x46]), // %PDF
      }),
    });
    const outcome = await webFetchUrl({ url: "https://example.com/doc.pdf" }, deps);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error.type).toBe("extraction_failed");
      expect(outcome.error.message).toMatch(/unsupported content type/i);
    }
    expect(deps.extractArticle).not.toHaveBeenCalled();
  });

  it("empty URL → invalid_url", async () => {
    const deps = makeDeps();
    const outcome = await webFetchUrl({ url: "" }, deps);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error.type).toBe("invalid_url");
  });

  it("args.maxBytes override is forwarded to fetcher", async () => {
    const deps = makeDeps();
    await webFetchUrl({ url: "https://example.com", maxBytes: 512 }, deps);
    const call = (deps.fetcher as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[1].maxBytes).toBe(512);
  });
});

// ---------------------------------------------------------------------------
// TOOL_DEFINITIONS
// ---------------------------------------------------------------------------

describe("TOOL_DEFINITIONS", () => {
  it("T1: exactly 2 entries — web_search + web_fetch_url (readonly array)", () => {
    expect(TOOL_DEFINITIONS).toHaveLength(2);
    const names = TOOL_DEFINITIONS.map((t) => t.name);
    expect(names).toContain("web_search");
    expect(names).toContain("web_fetch_url");
    // Frozen at the top level.
    expect(Object.isFrozen(TOOL_DEFINITIONS)).toBe(true);
  });

  it("T2: each entry has {name, description, schemaBuilder} with correct content", () => {
    const searchDef = TOOL_DEFINITIONS.find((t) => t.name === "web_search");
    const fetchDef = TOOL_DEFINITIONS.find((t) => t.name === "web_fetch_url");
    expect(searchDef).toBeDefined();
    expect(fetchDef).toBeDefined();
    expect(searchDef!.description).toMatch(/brave/i);
    expect(fetchDef!.description).toMatch(/clean article text/i);
    expect(typeof searchDef!.schemaBuilder).toBe("function");
    expect(typeof fetchDef!.schemaBuilder).toBe("function");
  });
});
