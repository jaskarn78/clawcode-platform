/**
 * 999.175 — OpenAI function calling on the native driver.
 *
 * A client that sends `tools` (Peekaboo's app/see/click…) expects the model to
 * CALL them: the response carries `tool_calls`, the client runs them on its own
 * machine, and the next request brings the results as `role:"tool"` messages.
 * Until now the driver only wrote the tool names into the prompt as text, so
 * the model could describe clicks but never make one (2026-09-24, Mac run:
 * "Task completed in 17.9s with ⚒ 0 tools").
 *
 * The bridge exposes the client's tools to the Claude Code session as an
 * in-process MCP server (`mcp__c__<name>`). When the model calls one, the tool
 * handler PARKS: the driver ends the current HTTP response with `tool_calls`
 * while the SDK turn stays suspended, and the next request's tool results
 * resolve the parked handlers so the SAME turn continues (native tool_use /
 * tool_result pairing, no transcript re-stuffing). Proven against the real
 * CLI (2.1.281) before this was written: 12 tools listed, two sequential
 * calls each parked 70 s, turn resumed and finished.
 *
 * Schemas pass through verbatim: the low-level `tools/list` handler returns the
 * client's JSON Schema as-is (the SDK `tool()` helper only takes Zod shapes).
 */
import { createHash } from "node:crypto";
import { nanoid } from "nanoid";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";

import type { ClaudeToolDef, ClaudeToolResultBlock } from "./types.js";

/** One-letter server name: the model sees `mcp__c__<tool>`. */
export const CLIENT_TOOL_SERVER = "c";
/** `mcp__c__` prefix + name must fit the API's 64-char tool-name limit. */
const MAX_CLIENT_TOOL_NAME = 64 - `mcp__${CLIENT_TOOL_SERVER}__`.length;
const TOOL_NAME_RE = /^[a-zA-Z0-9_-]+$/;
/** How long a parked call waits for the client's result before it fails. */
export const CLIENT_TOOL_WAIT_MS = 5 * 60_000;
/** Parallel calls parked within this window go out in ONE response. */
export const PARALLEL_CALL_WINDOW_MS = 150;

export interface ParkedCall {
  /** OpenAI `tool_calls[].id`; the client echoes it back as `tool_call_id`. */
  readonly id: string;
  readonly name: string;
  readonly args: Record<string, unknown>;
}

export interface ClientToolBridgeOptions {
  /** Fired once per batch of parked calls (after the parallel window). */
  readonly onParked: (calls: readonly ParkedCall[]) => void;
  readonly waitMs?: number;
  readonly windowMs?: number;
}

interface Pending extends ParkedCall {
  readonly resolve: (result: CallToolResult) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

/** Stable fingerprint of a tool set — part of the transient cache key. */
export function clientToolsFingerprint(tools: readonly ClaudeToolDef[]): string {
  const canonical = JSON.stringify(tools.map((t) => [t.name, t.description, t.input_schema]));
  return createHash("sha256").update(canonical).digest("hex").slice(0, 12);
}

/** Tools the API can accept; names that would overflow `mcp__c__…` are dropped. */
export function usableClientTools(tools: readonly ClaudeToolDef[]): ClaudeToolDef[] {
  return tools.filter((t) => t.name.length <= MAX_CLIENT_TOOL_NAME && TOOL_NAME_RE.test(t.name));
}

const errorResult = (text: string): CallToolResult => ({ content: [{ type: "text", text }], isError: true });

export class ClientToolBridge {
  readonly mcpConfig: { readonly type: "sdk"; readonly name: string; readonly instance: McpServer };
  private readonly pending = new Map<string, Pending>();
  private batch: ParkedCall[] = [];
  private batchTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly waitMs: number;
  private readonly windowMs: number;

  constructor(
    private readonly tools: readonly ClaudeToolDef[],
    private readonly opts: ClientToolBridgeOptions,
  ) {
    this.waitMs = opts.waitMs ?? CLIENT_TOOL_WAIT_MS;
    this.windowMs = opts.windowMs ?? PARALLEL_CALL_WINDOW_MS;
    const server = new McpServer({ name: CLIENT_TOOL_SERVER, version: "1.0.0" }, { capabilities: { tools: {} } });
    const byName = new Map(tools.map((t) => [t.name, t]));
    server.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: tools.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.input_schema as { type: "object" },
        // Never defer these behind tool search: with built-ins off there is none.
        _meta: { "anthropic/alwaysLoad": true },
      })),
    }));
    server.server.setRequestHandler(CallToolRequestSchema, async (req) => {
      if (!byName.has(req.params.name)) return errorResult(`Unknown tool: ${req.params.name}`);
      return this.park(req.params.name, (req.params.arguments ?? {}) as Record<string, unknown>);
    });
    this.mcpConfig = { type: "sdk", name: CLIENT_TOOL_SERVER, instance: server };
  }

  /** Ids of calls still waiting on the client. */
  pendingIds(): string[] {
    return [...this.pending.keys()];
  }

  /** Calls still waiting on the client (a retried request gets them again). */
  pendingCalls(): ParkedCall[] {
    return [...this.pending.values()].map(({ id, name, args }) => ({ id, name, args }));
  }

  /**
   * Resolve parked calls from a request's `role:"tool"` results. Returns how
   * many matched; results for unknown ids are ignored (the caller decides
   * whether that makes the request a continuation at all).
   */
  resolveResults(results: readonly ClaudeToolResultBlock[]): number {
    let matched = 0;
    for (const r of results) {
      const p = this.pending.get(r.tool_use_id);
      if (!p) continue;
      this.settle(p, { content: [{ type: "text", text: r.content }] });
      matched++;
    }
    return matched;
  }

  /** Fail every parked call (superseded turn, shutdown). */
  abandon(reason: string): void {
    for (const p of [...this.pending.values()]) this.settle(p, errorResult(reason));
    this.batch = [];
    if (this.batchTimer) clearTimeout(this.batchTimer);
    this.batchTimer = null;
  }

  private park(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
    return new Promise<CallToolResult>((resolve) => {
      const id = `call_${nanoid(24)}`;
      const timer = setTimeout(() => {
        const p = this.pending.get(id);
        if (p) this.settle(p, errorResult("The client did not return a result for this tool call in time."));
      }, this.waitMs);
      timer.unref?.();
      this.pending.set(id, { id, name, args, resolve, timer });
      this.batch.push({ id, name, args });
      if (!this.batchTimer) {
        this.batchTimer = setTimeout(() => this.flush(), this.windowMs);
        this.batchTimer.unref?.();
      }
    });
  }

  private flush(): void {
    this.batchTimer = null;
    const calls = this.batch.filter((c) => this.pending.has(c.id));
    this.batch = [];
    if (calls.length > 0) this.opts.onParked(calls);
  }

  private settle(p: Pending, result: CallToolResult): void {
    clearTimeout(p.timer);
    this.pending.delete(p.id);
    p.resolve(result);
  }
}
