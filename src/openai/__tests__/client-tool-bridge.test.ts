/**
 * 999.175 — the client-tool bridge, driven through a real MCP client over an
 * in-memory transport (the same protocol the Claude Code CLI speaks to it).
 */
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import {
  ClientToolBridge,
  clientToolsFingerprint,
  usableClientTools,
  type ParkedCall,
} from "../client-tool-bridge.js";
import type { ClaudeToolDef } from "../types.js";

const SEE: ClaudeToolDef = {
  name: "see",
  description: "Capture an app window and describe it.",
  input_schema: {
    type: "object",
    properties: { app: { type: "string" }, mode: { type: "string", enum: ["window", "screen"] } },
    required: ["app"],
  },
};
const CLICK: ClaudeToolDef = { name: "click", description: "Click an element.", input_schema: { type: "object", properties: { on: { type: "string" } } } };

const clients: Client[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close()));
});

async function connect(bridge: ClientToolBridge): Promise<Client> {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await bridge.mcpConfig.instance.connect(serverSide);
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(clientSide);
  clients.push(client);
  return client;
}

function bridgeWith(tools: ClaudeToolDef[], opts: { waitMs?: number; windowMs?: number } = {}) {
  const batches: ParkedCall[][] = [];
  const bridge = new ClientToolBridge(tools, { onParked: (c) => batches.push([...c]), windowMs: 10, ...opts });
  return { bridge, batches };
}

const text = (r: unknown) => (r as { content: Array<{ text: string }> }).content[0]?.text;

describe("ClientToolBridge", () => {
  it("lists the client's tools with their JSON Schema verbatim and always loaded", async () => {
    const { bridge } = bridgeWith([SEE, CLICK]);
    const { tools } = await (await connect(bridge)).listTools();
    expect(tools.map((t) => t.name)).toEqual(["see", "click"]);
    expect(tools[0]?.inputSchema).toEqual(SEE.input_schema);
    expect(tools[0]?._meta).toEqual({ "anthropic/alwaysLoad": true });
  });

  it("parks a call, announces it, and returns the client's result when resolved", async () => {
    const { bridge, batches } = bridgeWith([SEE]);
    const client = await connect(bridge);
    const call = client.callTool({ name: "see", arguments: { app: "Calculator" } });
    await vi_waitFor(() => batches.length === 1);
    const [parked] = batches[0]!;
    expect(parked).toMatchObject({ name: "see", args: { app: "Calculator" } });
    expect(parked!.id).toMatch(/^call_/);
    expect(bridge.pendingIds()).toEqual([parked!.id]);

    expect(bridge.resolveResults([{ type: "tool_result", tool_use_id: parked!.id, content: "Display: 1337" }])).toBe(1);
    const result = await call;
    expect(text(result)).toBe("Display: 1337");
    expect(result.isError).toBeFalsy();
    expect(bridge.pendingIds()).toEqual([]);
  });

  it("announces parallel calls in ONE batch", async () => {
    const { bridge, batches } = bridgeWith([SEE, CLICK], { windowMs: 30 });
    const client = await connect(bridge);
    const a = client.callTool({ name: "see", arguments: { app: "Calculator" } });
    const b = client.callTool({ name: "click", arguments: { on: "7" } });
    await vi_waitFor(() => batches.length === 1);
    expect(batches[0]!.map((c) => c.name).sort()).toEqual(["click", "see"]);
    bridge.resolveResults(batches[0]!.map((c) => ({ type: "tool_result" as const, tool_use_id: c.id, content: "ok" })));
    await Promise.all([a, b]);
  });

  it("ignores results for unknown ids", async () => {
    const { bridge } = bridgeWith([SEE]);
    expect(bridge.resolveResults([{ type: "tool_result", tool_use_id: "call_nope", content: "x" }])).toBe(0);
  });

  it("fails a call the client never answers, after the wait", async () => {
    const { bridge } = bridgeWith([SEE], { waitMs: 40 });
    const result = await (await connect(bridge)).callTool({ name: "see", arguments: { app: "Calculator" } });
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/did not return a result/);
    expect(bridge.pendingIds()).toEqual([]);
  });

  it("abandon() fails every parked call with the reason", async () => {
    const { bridge, batches } = bridgeWith([SEE]);
    const call = (await connect(bridge)).callTool({ name: "see", arguments: { app: "Calculator" } });
    await vi_waitFor(() => batches.length === 1);
    bridge.abandon("Superseded by a new request.");
    const result = await call;
    expect(result.isError).toBe(true);
    expect(text(result)).toBe("Superseded by a new request.");
  });

  it("rejects a tool name it does not serve", async () => {
    const { bridge, batches } = bridgeWith([SEE]);
    const result = await (await connect(bridge)).callTool({ name: "rm_rf", arguments: {} });
    expect(result.isError).toBe(true);
    expect(batches).toEqual([]);
  });
});

describe("tool-set helpers", () => {
  it("fingerprint changes with the tool set and is stable otherwise", () => {
    expect(clientToolsFingerprint([SEE, CLICK])).toBe(clientToolsFingerprint([SEE, CLICK]));
    expect(clientToolsFingerprint([SEE, CLICK])).not.toBe(clientToolsFingerprint([SEE]));
  });
  it("drops names the API cannot take once prefixed with mcp__c__", () => {
    const long = { ...SEE, name: "x".repeat(57) };
    const bad = { ...SEE, name: "has space" };
    expect(usableClientTools([SEE, long, bad, { ...SEE, name: "y".repeat(56) }]).map((t) => t.name)).toEqual([
      "see",
      "y".repeat(56),
    ]);
  });
});

async function vi_waitFor(cond: () => boolean, ms = 2000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}
