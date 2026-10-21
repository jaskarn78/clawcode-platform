import { describe, it, expect, vi, afterEach } from "vitest";
import { createExaClient } from "../providers/exa.js";
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

describe("createExaClient", () => {
  it("E1: 200 results[] → normalized SearchResponse with provider=exa", async () => {
    const body = {
      results: [
        {
          title: "Claude on Exa",
          url: "https://example.com/claude",
          text: "Exa returns snippet as `text`",
          publishedDate: "2026-03-15",
        },
        {
          title: "No date result",
          url: "https://example.com/other",
          text: "no date field",
        },
      ],
    };
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } }),
    );

    const client = createExaClient(makeConfig(), { EXA_API_KEY: "exa-sk" } as NodeJS.ProcessEnv);
    const outcome = await client.search("claude");

    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.data.provider).toBe("exa");
      expect(outcome.data.query).toBe("claude");
      expect(outcome.data.results).toHaveLength(2);
      expect(outcome.data.results[0]).toEqual({
        title: "Claude on Exa",
        url: "https://example.com/claude",
        snippet: "Exa returns snippet as `text`",
        publishedDate: "2026-03-15",
      });
      expect(outcome.data.results[1]).toEqual({
        title: "No date result",
        url: "https://example.com/other",
        snippet: "no date field",
      });
      expect(outcome.data.total).toBe(2);
    }
  });

  it("E2: emits x-api-key + content-type headers on outbound POST", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ results: [] }), { status: 200 }),
    );
    const client = createExaClient(makeConfig(), { EXA_API_KEY: "exa-secret" } as NodeJS.ProcessEnv);
    await client.search("claude");

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const init = fetchSpy.mock.calls[0][1] as RequestInit;
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe("exa-secret");
    expect(headers["content-type"]).toBe("application/json");
    expect(headers["User-Agent"]).toMatch(/^ClawCode\//);
  });

  it("E3: forwards useAutoprompt from config into JSON body (default false)", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ results: [] }), { status: 200 }),
    );
    const client = createExaClient(makeConfig(), { EXA_API_KEY: "exa-sk" } as NodeJS.ProcessEnv);
    await client.search("claude");

    const init = fetchSpy.mock.calls[0][1] as RequestInit;
    const body = JSON.parse(init.body as string);
    expect(body.query).toBe("claude");
    expect(body.useAutoprompt).toBe(false);
    expect(body.numResults).toBe(20); // default maxResults
  });

  it("E4: missing API key → synchronous invalid_argument, no network call", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const client = createExaClient(makeConfig(), {} as NodeJS.ProcessEnv);
    const outcome = await client.search("claude");
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error.type).toBe("invalid_argument");
      expect(outcome.error.message).toMatch(/api key/i);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("E5: 429 → rate_limit error", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response("Too Many Requests", {
        status: 429,
        headers: { "retry-after": "7" },
      }),
    );
    const client = createExaClient(makeConfig(), { EXA_API_KEY: "exa-sk" } as NodeJS.ProcessEnv);
    const outcome = await client.search("claude");
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error.type).toBe("rate_limit");
      expect(outcome.error.retryAfter).toBe(7);
      expect(outcome.error.status).toBe(429);
    }
  });

  it("useAutoprompt=true when config opts in", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ results: [] }), { status: 200 }),
    );
    const client = createExaClient(
      makeConfig({ exa: { apiKeyEnv: "EXA_API_KEY", useAutoprompt: true } }),
      { EXA_API_KEY: "exa-sk" } as NodeJS.ProcessEnv,
    );
    await client.search("claude");
    const init = fetchSpy.mock.calls[0][1] as RequestInit;
    const body = JSON.parse(init.body as string);
    expect(body.useAutoprompt).toBe(true);
  });
});
