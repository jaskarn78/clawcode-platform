import { describe, it, expect, vi } from "vitest";

import { handleSearchToolCall } from "../../search/daemon-handler.js";
import type { SearchDaemonHandlerDeps } from "../../search/daemon-handler.js";
import type { SearchConfig } from "../../config/schema.js";
import type { ResolvedAgentConfig } from "../../shared/types.js";
import type { SearchFetcher } from "../../search/tools.js";
import type {
  SearchResponse,
  SearchToolOutcome,
} from "../../search/types.js";
import type { IpcSearchToolCallParams } from "../types.js";

/**
 * Phase 71 Plan 02 — `search-tool-call` IPC handler tests.
 *
 * Drives the real `handleSearchToolCall` against vi.fn() provider clients
 * and fetcher. No real HTTP, no real daemon. Mirrors Phase 70
 * browser-tool-call.test.ts structure.
 *
 * Seven cases pin the handler contract:
 *   D1 — internal when search MCP is globally disabled
 *   D2 — invalid_argument when agent is unknown
 *   D3 — routes web_search to the pure handler, returns outcome verbatim
 *   D4 — routes web_fetch_url to the pure handler, returns outcome verbatim
 *   D5 — invalid_argument when toolName is unknown
 *   D6 — backend switch (exa vs brave) routes to the right client
 *   D7 — never throws: mock client rejection → internal error envelope
 */

// --- fixtures --------------------------------------------------------------

const BASE_SEARCH_CFG: SearchConfig = {
  enabled: true,
  backend: "brave",
  brave: { apiKeyEnv: "BRAVE_API_KEY", safeSearch: "moderate", country: "us" },
  exa: { apiKeyEnv: "EXA_API_KEY", useAutoprompt: false },
  maxResults: 20,
  timeoutMs: 10000,
  fetch: { timeoutMs: 30000, maxBytes: 1048576, userAgentSuffix: null },
};

function makeAgent(name: string): ResolvedAgentConfig {
  return {
    name,
    workspace: `/tmp/${name}`,
    channels: [],
    model: "sonnet",
    effort: "low",
    skills: [],
    skillsPath: "/tmp/skills",
    schedules: [],
    admin: false,
    reactions: true,
    mcpServers: [],
    slashCommands: [],
  } as unknown as ResolvedAgentConfig;
}

const SUCCESS_SEARCH_RESPONSE: SearchResponse = Object.freeze({
  results: Object.freeze([
    Object.freeze({ title: "T", url: "https://x.test/a", snippet: "s" }),
  ]),
  total: 1,
  provider: "brave",
  query: "hello",
});

function makeDeps(
  overrides: Partial<SearchDaemonHandlerDeps> = {},
): SearchDaemonHandlerDeps {
  const braveClient = {
    search: vi.fn(
      async () =>
        Object.freeze({
          ok: true as const,
          data: SUCCESS_SEARCH_RESPONSE,
        }) satisfies SearchToolOutcome<SearchResponse>,
    ),
  };
  const exaClient = {
    search: vi.fn(
      async () =>
        Object.freeze({
          ok: true as const,
          data: Object.freeze({
            ...SUCCESS_SEARCH_RESPONSE,
            provider: "exa" as const,
          }),
        }) satisfies SearchToolOutcome<SearchResponse>,
    ),
  };
  const fetcher = vi.fn(async (_url: string) =>
    Object.freeze({
      ok: true as const,
      status: 200,
      headers: { "content-type": "text/html" },
      body: Buffer.from("<html><body><article><h1>T</h1><p>Body body body body body body body body body body.</p></article></body></html>"),
    }),
  ) as unknown as SearchFetcher;

  return {
    searchConfig: BASE_SEARCH_CFG,
    resolvedAgents: [makeAgent("clawdy")],
    braveClient,
    exaClient,
    fetcher,
    ...overrides,
  };
}

describe("handleSearchToolCall (Phase 71 Plan 02)", () => {
  it("D1: returns internal when search MCP is globally disabled", async () => {
    const deps = makeDeps({
      searchConfig: { ...BASE_SEARCH_CFG, enabled: false },
    });
    const params: IpcSearchToolCallParams = {
      agent: "clawdy",
      toolName: "web_search",
      args: { query: "x" },
    };
    const outcome = await handleSearchToolCall(deps, params);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error.type).toBe("internal");
      expect(outcome.error.message).toMatch(/search MCP disabled/i);
    }
  });

  it("D2: returns invalid_argument when the agent is unknown", async () => {
    const deps = makeDeps();
    const outcome = await handleSearchToolCall(deps, {
      agent: "ghost",
      toolName: "web_search",
      args: { query: "x" },
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error.type).toBe("invalid_argument");
      expect(outcome.error.message).toMatch(/unknown agent/i);
      expect(outcome.error.message).toContain("ghost");
    }
  });

  it("D3: routes web_search to the pure handler and returns its outcome", async () => {
    const deps = makeDeps();
    const outcome = await handleSearchToolCall(deps, {
      agent: "clawdy",
      toolName: "web_search",
      args: { query: "hello", numResults: 3 },
    });
    expect(outcome.ok).toBe(true);
    expect((deps.braveClient.search as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1);
    expect((deps.braveClient.search as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(
      "hello",
      { numResults: 3 },
    );
    if (outcome.ok) {
      const data = outcome.data as SearchResponse;
      expect(data.provider).toBe("brave");
      expect(data.results.length).toBe(1);
    }
  });

  it("D4: routes web_fetch_url to the pure handler and returns its outcome", async () => {
    const deps = makeDeps();
    const outcome = await handleSearchToolCall(deps, {
      agent: "clawdy",
      toolName: "web_fetch_url",
      args: { url: "https://x.test/a", mode: "raw" },
    });
    expect(outcome.ok).toBe(true);
    expect(deps.fetcher as unknown as ReturnType<typeof vi.fn>).toHaveBeenCalledTimes(1);
    if (outcome.ok) {
      const data = outcome.data as { url: string; mode: "readability" | "raw"; text: string };
      expect(data.url).toBe("https://x.test/a");
      expect(data.mode).toBe("raw");
      expect(typeof data.text).toBe("string");
    }
  });

  it("D5: returns invalid_argument for unknown toolName", async () => {
    const deps = makeDeps();
    const outcome = await handleSearchToolCall(deps, {
      agent: "clawdy",
      toolName: "web_explode" as unknown as IpcSearchToolCallParams["toolName"],
      args: {},
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error.type).toBe("invalid_argument");
      expect(outcome.error.message).toMatch(/unknown search tool/i);
      expect(outcome.error.message).toContain("web_explode");
    }
  });

  it("D6: backend switch — exa config routes to exaClient; brave config routes to braveClient", async () => {
    // exa backend
    const exaDeps = makeDeps({
      searchConfig: { ...BASE_SEARCH_CFG, backend: "exa" },
    });
    await handleSearchToolCall(exaDeps, {
      agent: "clawdy",
      toolName: "web_search",
      args: { query: "q" },
    });
    expect(exaDeps.exaClient.search as ReturnType<typeof vi.fn>).toHaveBeenCalledTimes(1);
    expect(exaDeps.braveClient.search as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();

    // brave backend
    const braveDeps = makeDeps({
      searchConfig: { ...BASE_SEARCH_CFG, backend: "brave" },
    });
    await handleSearchToolCall(braveDeps, {
      agent: "clawdy",
      toolName: "web_search",
      args: { query: "q" },
    });
    expect(braveDeps.braveClient.search as ReturnType<typeof vi.fn>).toHaveBeenCalledTimes(1);
    expect(braveDeps.exaClient.search as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
  });

  it("D7: never throws — mock client rejection → internal error envelope", async () => {
    const deps = makeDeps({
      braveClient: {
        search: vi.fn(async () => {
          throw new Error("boom");
        }),
      },
    });
    const outcome = await handleSearchToolCall(deps, {
      agent: "clawdy",
      toolName: "web_search",
      args: { query: "q" },
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      // webSearch's try/catch maps unexpected rejections to "internal"
      expect(outcome.error.type).toBe("internal");
      expect(outcome.error.message).toMatch(/boom/);
    }
  });
});
