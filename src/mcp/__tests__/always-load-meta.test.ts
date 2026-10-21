/**
 * Phase 999.162 (WS-1) — per-tool always-load. Exactly the hot-path tools
 * carry `_meta["anthropic/alwaysLoad"]`; every other clawcode tool defers
 * behind ToolSearch. Listed over a real MCP client/server pair so the pin is
 * asserted on the wire, not on the registration object.
 */
import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ALWAYS_LOAD_META_KEY, createMcpServer } from "../server.js";

const HOT_TOOLS = ["ask_advisor", "memory_lookup", "post_to_agent", "spawn_subagent_thread"];

describe("Phase 999.162 — per-tool always-load", () => {
  it("pins exactly the hot-path tools on tools/list; everything else defers", async () => {
    const server = createMcpServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: "phase999162-test", version: "0.0.0" });
    await client.connect(clientTransport);
    try {
      const { tools } = await client.listTools();
      const pinned = tools
        .filter((t) => t._meta?.[ALWAYS_LOAD_META_KEY] === true)
        .map((t) => t.name)
        .sort();
      expect(pinned).toEqual(HOT_TOOLS);
      // The pin is the exception, not the rule — the bulk of the surface defers.
      expect(tools.length).toBeGreaterThan(HOT_TOOLS.length * 5);
      expect(ALWAYS_LOAD_META_KEY).toBe("anthropic/alwaysLoad");
    } finally {
      await client.close();
      await server.close();
    }
  });
});
