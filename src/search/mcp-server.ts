import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod/v4";

import { sendIpcRequest } from "../ipc/client.js";
import { SOCKET_PATH } from "../manager/daemon.js";
import { TOOL_DEFINITIONS } from "./tools.js";
import type { SearchToolOutcome } from "./types.js";
import type { IpcSearchToolCallParams } from "../ipc/types.js";

/**
 * Phase 71 Plan 02 — out-of-process MCP server for web-search tools.
 *
 * Architecture (mirrors Phase 70's `src/browser/mcp-server.ts`):
 *   Claude SDK spawns `clawcode search-mcp` per agent session → this
 *   module starts a StdioServerTransport MCP server → each tool call
 *   forwards to the daemon via `sendIpcRequest(SOCKET_PATH,
 *   "search-tool-call", {agent, toolName, args})`. The daemon owns the
 *   BraveClient/ExaClient + URL fetcher; this subprocess is a thin
 *   translator.
 *
 * Agent resolution: `args.agent` > `env.CLAWCODE_AGENT` > error. The
 * auto-inject in `src/config/loader.ts` wires `CLAWCODE_AGENT` so the
 * subprocess knows which agent's identity to attach to every call.
 */

/** MCP content envelope — search tools return plain text (no images). */
type McpContent = { readonly type: "text"; readonly text: string };

interface McpToolResponse {
  content: McpContent[];
  isError?: boolean;
}

/* ------------------------------------------------------------------ */
/*  Response builder — shapes a SearchToolOutcome into MCP content     */
/* ------------------------------------------------------------------ */

function buildMcpResponse(
  outcome: SearchToolOutcome<unknown>,
): McpToolResponse {
  if (!outcome.ok) {
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({ error: outcome.error }),
        },
      ],
      isError: true,
    };
  }
  return {
    content: [{ type: "text" as const, text: JSON.stringify(outcome.data) }],
  };
}

/* ------------------------------------------------------------------ */
/*  Handler factory — DI seam for unit tests                           */
/* ------------------------------------------------------------------ */

/** Dependencies a handler needs — lets tests inject a mock IPC client. */
export interface SearchMcpHandlerDeps {
  readonly sendIpc?: typeof sendIpcRequest;
  /** Override for process.env.CLAWCODE_AGENT; tests use this. */
  readonly env?: NodeJS.ProcessEnv;
}

/**
 * Build a single tool handler that resolves the agent name from
 * arg > env > error, then forwards the call to the daemon via IPC.
 *
 * Exported as `__testOnly_buildHandler` (see below) so unit tests can
 * exercise the forward-to-daemon contract without spinning up a real
 * StdioServerTransport.
 */
function buildHandler(
  toolName: IpcSearchToolCallParams["toolName"],
  deps: SearchMcpHandlerDeps = {},
): (args: Record<string, unknown>) => Promise<McpToolResponse> {
  const sendIpc = deps.sendIpc ?? sendIpcRequest;
  const env = deps.env ?? process.env;

  return async (args: Record<string, unknown>): Promise<McpToolResponse> => {
    const argAgent = typeof args.agent === "string" ? args.agent : undefined;
    const envAgent =
      typeof env.CLAWCODE_AGENT === "string" ? env.CLAWCODE_AGENT : undefined;
    const agent = argAgent ?? envAgent;
    if (!agent || agent.length === 0) {
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              error: {
                type: "invalid_argument",
                message:
                  "agent name required — pass as arg or set CLAWCODE_AGENT env",
              },
            }),
          },
        ],
        isError: true,
      };
    }

    const toolArgs: Record<string, unknown> = { ...args };
    delete toolArgs.agent;

    try {
      const outcome = (await sendIpc(SOCKET_PATH, "search-tool-call", {
        agent,
        toolName,
        args: toolArgs,
      })) as SearchToolOutcome<unknown>;
      return buildMcpResponse(outcome);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              error: { type: "internal", message: msg },
            }),
          },
        ],
        isError: true,
      };
    }
  };
}

/**
 * Test-only export — DO NOT USE from application code.
 *
 * Returns the exact handler function that `createSearchMcpServer`
 * registers with `server.tool(...)`. Unit tests exercise it with a
 * mocked `sendIpc` to verify the forward-to-daemon contract without
 * standing up a real MCP transport.
 */
export const __testOnly_buildHandler = buildHandler;

/**
 * Re-export `buildMcpResponse` for tests that want to assert on
 * envelope shape without going through the IPC seam.
 */
export const __testOnly_buildMcpResponse = buildMcpResponse;

/* ------------------------------------------------------------------ */
/*  Server factory                                                     */
/* ------------------------------------------------------------------ */

/**
 * Create a fully-configured search MCP server.
 *
 * Loops over `TOOL_DEFINITIONS` and registers each tool with a handler
 * that IPCs to the daemon. Returns the `McpServer` ready to be connected
 * to a transport (typically `StdioServerTransport` via
 * `startSearchMcpServer`).
 */
export function createSearchMcpServer(
  deps: SearchMcpHandlerDeps = {},
): McpServer {
  const server = new McpServer(
    { name: "search", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  for (const def of TOOL_DEFINITIONS) {
    const schema = def.schemaBuilder(z);
    const handler = buildHandler(def.name, deps);
    // MCP SDK's `server.tool` overloads want a specific ZodRawShape generic;
    // our `schemaBuilder` returns a type-erased Record for polymorphism.
    // Cast through `unknown` so we can register all tools in a loop
    // without surrendering type safety at other call sites.
    const registerTool = server.tool.bind(server) as unknown as (
      name: string,
      description: string,
      paramsSchema: Record<string, unknown>,
      cb: (args: Record<string, unknown>) => Promise<McpToolResponse>,
    ) => void;
    registerTool(def.name, def.description, schema, async (args) =>
      handler(args),
    );
  }

  return server;
}

/**
 * Entry point for `clawcode search-mcp` — start a stdio MCP server.
 *
 * Mirrors `startBrowserMcpServer()` exactly. The Claude SDK spawns this
 * process per agent session; the subprocess inherits CLAWCODE_AGENT via
 * the env block in the auto-inject config (Task 2 of Plan 02).
 */
export async function startSearchMcpServer(): Promise<void> {
  const server = createSearchMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
