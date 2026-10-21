import { describe, it, expect, vi, afterEach } from "vitest";
import { createBraveClient } from "../providers/brave.js";
import { searchConfigSchema, type SearchConfig } from "../../config/schema.js";

function makeConfig(overrides: Partial<SearchConfig> = {}): SearchConfig {
  return {
    ...searchConfigSchema.parse({}),
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("createBraveClient", () => {
  it("B1: maps 200 web.results[] → normalized SearchResponse with provider=brave", async () => {
    const body = {
      web: {
        results: [
          {
            title: "Claude",
            url: "https://anthropic.com/claude",
            description: "Claude is an AI assistant.",
            age: "2026-04-01",
          },
          {
            title: "Claude docs",
            url: "https://docs.anthropic.com/",
            description: "Docs",
          },
        ],
      },
    };
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } }),
    );

    const client = createBraveClient(makeConfig(), { BRAVE_API_KEY: "sk-test" } as NodeJS.ProcessEnv);
    const outcome = await client.search("claude");

    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.data.provider).toBe("brave");
      expect(outcome.data.query).toBe("claude");
      expect(outcome.data.results).toHaveLength(2);
      expect(outcome.data.results[0]).toEqual({
        title: "Claude",
        url: "https://anthropic.com/claude",
        snippet: "Claude is an AI assistant.",
        publishedDate: "2026-04-01",
      });
      // Second result has no age — publishedDate omitted.
      expect(outcome.data.results[1]).toEqual({
        title: "Claude docs",
        url: "https://docs.anthropic.com/",
        snippet: "Docs",
      });
      expect(outcome.data.total).toBe(2);
    }
  });

  it("B2: 401 → structured network error (bad/missing API key at the API layer)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response("Unauthorized", { status: 401 }),
    );
    const client = createBraveClient(makeConfig(), { BRAVE_API_KEY: "sk-bad" } as NodeJS.ProcessEnv);
    const outcome = await client.search("claude");
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error.type).toBe("network");
      expect(outcome.error.status).toBe(401);
    }
  });

  it("B3: 429 → rate_limit error with retryAfter from header", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response("Too Many Requests", {
        status: 429,
        headers: { "retry-after": "42" },
      }),
    );
    const client = createBraveClient(makeConfig(), { BRAVE_API_KEY: "sk-test" } as NodeJS.ProcessEnv);
    const outcome = await client.search("claude");
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error.type).toBe("rate_limit");
      expect(outcome.error.retryAfter).toBe(42);
      expect(outcome.error.status).toBe(429);
    }
  });

  it("B4: AbortSignal timeout → network error with /aborted|timeout/i message", async () => {
    // Mock fetch to reject with AbortError when the signal aborts.
    vi.spyOn(globalThis, "fetch").mockImplementationOnce(
      (_url, options) =>
        new Promise((_resolve, reject) => {
          const signal = options?.signal as AbortSignal | undefined;
          if (signal) {
            signal.addEventListener("abort", () => {
              reject(new DOMException("The operation was aborted.", "AbortError"));
            });
          }
        }),
    );
    // Short timeout so test finishes quickly.
    const config = makeConfig({ timeoutMs: 1000 });
    const client = createBraveClient(config, { BRAVE_API_KEY: "sk-test" } as NodeJS.ProcessEnv);
    const outcome = await client.search("claude");
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error.type).toBe("network");
      expect(outcome.error.message).toMatch(/aborted|timeout/i);
    }
  });

  it("B5: emits X-Subscription-Token + User-Agent headers on outbound request", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ web: { results: [] } }), { status: 200 }),
    );
    const client = createBraveClient(makeConfig(), { BRAVE_API_KEY: "sk-secret" } as NodeJS.ProcessEnv);
    await client.search("claude");

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const init = fetchSpy.mock.calls[0][1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers["X-Subscription-Token"]).toBe("sk-secret");
    expect(headers["User-Agent"]).toMatch(/^ClawCode\//);
    expect(headers["Accept"]).toBe("application/json");
  });

  it("B6: missing API key → synchronous invalid_argument, no network call", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const client = createBraveClient(makeConfig(), {} as NodeJS.ProcessEnv);
    const outcome = await client.search("claude");
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error.type).toBe("invalid_argument");
      expect(outcome.error.message).toMatch(/api key/i);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("B7: safeSearch + country from config wired into query string", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ web: { results: [] } }), { status: 200 }),
    );
    const client = createBraveClient(
      makeConfig({
        brave: { apiKeyEnv: "BRAVE_API_KEY", safeSearch: "strict", country: "gb" },
      }),
      { BRAVE_API_KEY: "sk-test" } as NodeJS.ProcessEnv,
    );
    await client.search("claude");

    const url = fetchSpy.mock.calls[0][0] as string;
    expect(url).toContain("safesearch=strict");
    expect(url).toContain("country=gb");
    expect(url).toContain("q=claude");
  });

  it("empty query → synchronous invalid_argument, no network call", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const client = createBraveClient(makeConfig(), { BRAVE_API_KEY: "sk-test" } as NodeJS.ProcessEnv);
    const outcome = await client.search("");
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error.type).toBe("invalid_argument");
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("lazy API-key read: key missing at createBraveClient but present at search() call time", async () => {
    // Start with no key — construction must not throw or validate env.
    const env: NodeJS.ProcessEnv = {};
    const client = createBraveClient(makeConfig(), env);
    // Populate key after construction.
    env.BRAVE_API_KEY = "sk-late";

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ web: { results: [] } }), { status: 200 }),
    );
    const outcome = await client.search("claude");
    expect(outcome.ok).toBe(true);
    // Late-added key must reach the request.
    const init = fetchSpy.mock.calls[0][1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers["X-Subscription-Token"]).toBe("sk-late");
  });
});
