import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod/v4";

import { sendIpcRequest } from "../ipc/client.js";
import { SOCKET_PATH } from "../manager/daemon.js";
import { TOOL_DEFINITIONS } from "./tools.js";
import { encodeScreenshot } from "./screenshot.js";
import type { BrowserToolOutcome } from "./types.js";
import type { IpcBrowserToolCallParams } from "../ipc/types.js";

/**
 * Phase 70 Plan 02 — out-of-process MCP server for browser tools.
 *
 * Architecture (70-RESEARCH.md Open Question #3 resolution):
 *   Claude SDK spawns `clawcode browser-mcp` per agent session → this
 *   module starts a StdioServerTransport MCP server → each tool call
 *   forwards to the daemon via `sendIpcRequest(SOCKET_PATH,
 *   "browser-tool-call", {agent, toolName, args})`. The daemon owns the
 *   singleton BrowserManager; this subprocess is a thin translator.
 *
 * Parallels the `src/mcp/server.ts` pattern that already handles the
 * `clawcode` MCP server. Auto-injection wiring lives in Plan 03.
 */

/** MCP content envelope shape we emit. */
type McpContent =
  | { readonly type: "text"; readonly text: string }
  | {
      readonly type: "image";
      readonly data: string;
      readonly mimeType: string;
    };

interface McpToolResponse {
  content: McpContent[];
  isError?: boolean;
}

/* ------------------------------------------------------------------ */
/*  Response builder — shapes a BrowserToolOutcome into MCP content    */
/* ------------------------------------------------------------------ */

function buildMcpResponse(
  outcome: BrowserToolOutcome,
  toolName: string,
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

  // Screenshot success with inline data — emit both text + image items
  // so Claude's vision ingests the screenshot on this turn.
  if (toolName === "browser_screenshot") {
    const data = outcome.data as {
      path: string;
      bytes: number;
      inlineBase64?: string;
    };
    if (data.inlineBase64) {
      // Reconstruct a buffer to reuse encodeScreenshot's envelope logic.
      // Using Buffer.from on the already-encoded base64 gives us bytes
      // that encodeScreenshot will re-encode — to avoid that round-trip,
      // emit the content items directly.
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              path: data.path,
              bytes: data.bytes,
              inline: true,
            }),
          },
          {
            type: "image" as const,
            data: data.inlineBase64,
            mimeType: "image/png",
          },
        ],
      };
    }
    // Path-only variant — mirrors encodeScreenshot's overflow branch.
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            path: data.path,
            bytes: data.bytes,
            inline: false,
            note: "Screenshot too large to inline; use Read tool on the path.",
          }),
        },
      ],
    };
  }

  return {
    content: [
      { type: "text" as const, text: JSON.stringify(outcome.data) },
    ],
  };
}

/* ------------------------------------------------------------------ */
/*  Handler factory — DI seam for unit tests                           */
/* ------------------------------------------------------------------ */

/** Dependencies a handler needs — lets tests inject a mock IPC client. */
export interface BrowserMcpHandlerDeps {
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
  toolName: IpcBrowserToolCallParams["toolName"],
  deps: BrowserMcpHandlerDeps = {},
): (args: Record<string, unknown>) => Promise<McpToolResponse> {
  const sendIpc = deps.sendIpc ?? sendIpcRequest;
  const env = deps.env ?? process.env;

  return async (args: Record<string, unknown>): Promise<McpToolResponse> => {
    // Extract agent from arg or env; reject when absent from both.
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
      const outcome = (await sendIpc(SOCKET_PATH, "browser-tool-call", {
        agent,
        toolName,
        args: toolArgs,
      })) as BrowserToolOutcome;
      return buildMcpResponse(outcome, toolName);
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
 * Returns the exact handler function that `createBrowserMcpServer`
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

/**
 * Re-export `encodeScreenshot` from this module so downstream callers
 * can import the Playwright-adjacent helpers through one gateway.
 * (Also keeps the screenshot.ts module considered "used" by this file
 * for future refactors that route path-only envelopes through it.)
 */
export { encodeScreenshot };

/* ------------------------------------------------------------------ */
/*  Server factory                                                     */
/* ------------------------------------------------------------------ */

/**
 * Create a fully-configured browser MCP server.
 *
 * Loops over `TOOL_DEFINITIONS` and registers each tool with a handler
 * that IPCs to the daemon. Returns the `McpServer` ready to be connected
 * to a transport (typically `StdioServerTransport` via
 * `startBrowserMcpServer`).
 */
export function createBrowserMcpServer(
  deps: BrowserMcpHandlerDeps = {},
): McpServer {
  const server = new McpServer(
    { name: "browser", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  for (const def of TOOL_DEFINITIONS) {
    const schema = def.schemaBuilder(z);
    const handler = buildHandler(def.name, deps);
    // MCP SDK's `server.tool` overloads want a specific ZodRawShape generic;
    // our `schemaBuilder` returns a type-erased Record for polymorphism.
    // Cast through `unknown` so we can register all 6 tools in a loop
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
 * Entry point for `clawcode browser-mcp` — start a stdio MCP server.
 *
 * Mirrors `src/mcp/server.ts startMcpServer()` exactly. The Claude SDK
 * spawns this process per agent session; the subprocess inherits
 * CLAWCODE_AGENT via the env block in the auto-inject config (Plan 03).
 */
export async function startBrowserMcpServer(): Promise<void> {
  const server = createBrowserMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
