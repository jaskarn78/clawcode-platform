/**
 * Phase 71 Plan 02 — daemon-side handler for the `search-tool-call` IPC
 * method. Pure dispatcher over a small `{config, clients, fetcher}` deps
 * bag, mirroring Phase 70's `src/browser/daemon-handler.ts` pattern.
 *
 * Contract:
 *   - Disabled guard → `internal` error when `searchConfig.enabled=false`.
 *   - Agent resolution → `invalid_argument` when `params.agent` is
 *     unknown.
 *   - Unknown toolName → `invalid_argument` with the offending name in
 *     the message.
 *   - Dispatch → `webSearch` / `webFetchUrl` from `./tools.ts`, injecting
 *     `{config, braveClient, exaClient, fetcher}`.
 *   - NEVER throws — any unexpected rejection inside the dispatch is
 *     caught and mapped to `{type: "internal"}`. The pure tool handlers
 *     are contracted to never throw, but this is defence-in-depth for
 *     the IPC boundary.
 *
 * Unlike the browser handler, search has:
 *   - No per-agent persistent state → no `saveAgentState` trigger.
 *   - No resident warm-path → no `isReady()` / `warm()` branch.
 *
 * Clients (`braveClient`, `exaClient`) are daemon-owned singletons
 * constructed at boot in `src/manager/daemon.ts`. Missing API keys are
 * handled lazily inside `.search()` (returns `invalid_argument`), so
 * daemon boot stays cheap even when `BRAVE_API_KEY` / `EXA_API_KEY` are
 * unset.
 */

import { webSearch, webFetchUrl } from "./tools.js";
import type { SearchFetcher } from "./tools.js";
import type { SearchConfig } from "../config/schema.js";
import type { ResolvedAgentConfig } from "../shared/types.js";
import type { IpcSearchToolCallParams } from "../ipc/types.js";
import type { SearchResponse, SearchToolOutcome } from "./types.js";

/**
 * Minimal client shape the handler needs — matches both `BraveClient`
 * and `ExaClient` from `src/search/providers/*`. The outcome is widened
 * to `SearchToolOutcome<SearchResponse>` so the tool handlers can pass
 * the normalized shape straight through.
 */
export interface SearchProviderClient {
  search(
    query: string,
    opts?: { numResults?: number },
  ): Promise<SearchToolOutcome<SearchResponse>>;
}

export interface SearchDaemonHandlerDeps {
  readonly searchConfig: SearchConfig;
  readonly resolvedAgents: readonly ResolvedAgentConfig[];
  readonly braveClient: SearchProviderClient;
  readonly exaClient: SearchProviderClient;
  readonly fetcher: SearchFetcher;
}

export async function handleSearchToolCall(
  deps: SearchDaemonHandlerDeps,
  params: IpcSearchToolCallParams,
): Promise<SearchToolOutcome<unknown>> {
  const { searchConfig, resolvedAgents, braveClient, exaClient, fetcher } = deps;
  const { agent, toolName, args } = params;

  // 1. Disabled guard → internal
  if (!searchConfig.enabled) {
    return Object.freeze({
      ok: false as const,
      error: Object.freeze({
        type: "internal" as const,
        message:
          "search MCP disabled (defaults.search.enabled=false); set it to true to use web_search / web_fetch_url",
      }),
    });
  }

  // 2. Agent resolution → invalid_argument
  const resolvedAgent = resolvedAgents.find((a) => a.name === agent);
  if (!resolvedAgent) {
    return Object.freeze({
      ok: false as const,
      error: Object.freeze({
        type: "invalid_argument" as const,
        message: `unknown agent: ${agent}`,
      }),
    });
  }

  // 3. Dispatch — pure tool handlers run against injected deps. The
  //    provider dispatch happens inside webSearch (backend switch); here
  //    we just forward both clients.
  const toolDeps = Object.freeze({
    config: searchConfig,
    braveClient,
    exaClient,
    fetcher,
  });

  try {
    switch (toolName) {
      case "web_search":
        return await webSearch(
          args as { query: string; numResults?: number },
          toolDeps,
        );
      case "web_fetch_url":
        return await webFetchUrl(
          args as {
            url: string;
            mode?: "readability" | "raw";
            maxBytes?: number;
          },
          toolDeps,
        );
      default: {
        // Exhaustiveness check — the union is closed to the two tools.
        const unknownTool: string = toolName;
        return Object.freeze({
          ok: false as const,
          error: Object.freeze({
            type: "invalid_argument" as const,
            message: `unknown search tool: ${unknownTool}`,
          }),
        });
      }
    }
  } catch (err) {
    // The tool handlers catch their own errors — this is the IPC
    // boundary's last line of defence.
    const message = err instanceof Error ? err.message : String(err);
    return Object.freeze({
      ok: false as const,
      error: Object.freeze({
        type: "internal" as const,
        message,
      }),
    });
  }
}
