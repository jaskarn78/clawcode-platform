/**
 * Phase 140 Stage 2 (Plan 03) — MCP Server adapter for the ClawCode channel.
 *
 * Drives `bindChannelToServer` with a hand-rolled mock MCP server + a mock
 * `ChannelDaemonLink` — no real `StdioServerTransport`, no `connect()`, no
 * socket. Proves: daemon message → `notifications/claude/channel`; the three
 * tool relays; capability + tool inputSchemas match the spec.
 */

import { describe, it, expect, vi } from "vitest";

import {
  bindChannelToServer,
  readChannelEnv,
  CHANNEL_CAPABILITIES,
  CHANNEL_TOOLS,
  type ChannelMcpServerLike,
} from "../clawcode-channel-mcp-server.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type {
  AckInput,
  ChannelDaemonLink,
  ChannelNotification,
  InboxEnvelope,
  InboxReadInput,
  StatusInput,
} from "../clawcode-channel-server.js";

/** A mock MCP server capturing notifications + handlers, plus oninitialized. */
function makeMockServer() {
  const notifications: ChannelNotification[] = [];
  const handlers = new Map<
    unknown,
    (req: {
      params: { name: string; arguments?: Record<string, unknown> };
    }) => unknown
  >();
  const server: ChannelMcpServerLike = {
    notification: vi.fn((n: ChannelNotification) => {
      notifications.push(n);
      return Promise.resolve();
    }),
    setRequestHandler: (schema, handler) => {
      handlers.set(schema, handler);
    },
  };
  return { server, notifications, handlers };
}

/** A mock daemon link recording every relayed tool call. */
function makeMockDaemon() {
  const acks: AckInput[] = [];
  const reads: InboxReadInput[] = [];
  const statuses: StatusInput[] = [];
  let drainResult: readonly InboxEnvelope[] = [];
  const daemon: ChannelDaemonLink = {
    handleAck: (input) => {
      acks.push(input);
    },
    handleInboxRead: (input) => {
      reads.push(input);
      return drainResult;
    },
    handleStatus: (input) => {
      statuses.push(input);
    },
  };
  return {
    daemon,
    acks,
    reads,
    statuses,
    setDrainResult(r: readonly InboxEnvelope[]) {
      drainResult = r;
    },
  };
}

function callTool(
  handlers: Map<unknown, (req: { params: { name: string; arguments?: Record<string, unknown> } }) => unknown>,
  name: string,
  args: Record<string, unknown>,
): { content: { type: string; text: string }[]; isError?: boolean } {
  const handler = handlers.get(CallToolRequestSchema);
  if (!handler) throw new Error("CallTool handler not registered");
  return handler({ params: { name, arguments: args } }) as {
    content: { type: string; text: string }[];
    isError?: boolean;
  };
}

describe("bindChannelToServer — notification push", () => {
  it("a daemon message routes through to server.notification with the channel method + flattened meta", () => {
    const { server, notifications } = makeMockServer();
    const { daemon } = makeMockDaemon();
    const { core } = bindChannelToServer(server, daemon);

    core.onDaemonMessage({
      type: "a2a",
      message_id: "msg_1",
      content: "ping",
      meta: { source_agent: "research", priority: "high" },
    });

    expect(server.notification).toHaveBeenCalledTimes(1);
    expect(notifications).toHaveLength(1);
    const n = notifications[0]!;
    expect(n.method).toBe("notifications/claude/channel");
    expect(n.params.content).toBe("ping");
    expect(n.params.meta).toEqual({
      type: "a2a",
      message_id: "msg_1",
      source_agent: "research",
      priority: "high",
    });
  });

  it("a notification rejection is swallowed (fire-and-forget, never throws)", () => {
    const { server } = makeMockServer();
    (server.notification as ReturnType<typeof vi.fn>).mockReturnValue(
      Promise.reject(new Error("transport gone")),
    );
    const { daemon } = makeMockDaemon();
    const { core } = bindChannelToServer(server, daemon);

    expect(() =>
      core.onDaemonMessage({ type: "wake", message_id: "m", content: "c" }),
    ).not.toThrow();
  });
});

describe("bindChannelToServer — tool relays", () => {
  it("clawcode_ack relays the parsed input into ChannelDaemonLink.handleAck", () => {
    const { server, handlers } = makeMockServer();
    const { daemon, acks } = makeMockDaemon();
    bindChannelToServer(server, daemon);

    const res = callTool(handlers, "clawcode_ack", {
      message_id: "msg_1",
      status: "processed",
      result: "done",
    });
    expect(res.isError).toBeFalsy();
    expect(acks).toEqual([
      { message_id: "msg_1", status: "processed", result: "done" },
    ]);
  });

  it("clawcode_ack rejects a missing status without throwing", () => {
    const { server, handlers } = makeMockServer();
    const { daemon, acks } = makeMockDaemon();
    bindChannelToServer(server, daemon);

    const res = callTool(handlers, "clawcode_ack", { message_id: "m" });
    expect(res.isError).toBe(true);
    expect(acks).toHaveLength(0);
  });

  it("clawcode_inbox_read relays into handleInboxRead and returns drained envelopes", () => {
    const { server, handlers } = makeMockServer();
    const mock = makeMockDaemon();
    mock.setDrainResult([
      { type: "a2a", message_id: "m1", content: "one" },
      { type: "memory", message_id: "m2", content: "fact" },
    ]);
    bindChannelToServer(server, mock.daemon);

    const res = callTool(handlers, "clawcode_inbox_read", {
      max_count: 5,
      filter_type: "a2a",
    });
    expect(mock.reads).toEqual([{ max_count: 5, filter_type: "a2a" }]);
    const payload = JSON.parse(res.content[0]!.text) as {
      envelopes: InboxEnvelope[];
    };
    expect(payload.envelopes.map((e) => e.message_id)).toEqual(["m1", "m2"]);
  });

  it("clawcode_status relays the parsed input into handleStatus", () => {
    const { server, handlers } = makeMockServer();
    const { daemon, statuses } = makeMockDaemon();
    bindChannelToServer(server, daemon);

    const res = callTool(handlers, "clawcode_status", {
      state: "working",
      context_pct: 42,
    });
    expect(res.isError).toBeFalsy();
    expect(statuses).toEqual([{ state: "working", context_pct: 42 }]);
  });

  it("an unknown tool name is a non-throwing error result", () => {
    const { server, handlers } = makeMockServer();
    const { daemon } = makeMockDaemon();
    bindChannelToServer(server, daemon);

    const res = callTool(handlers, "nope", {});
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain("unknown tool");
  });
});

describe("bindChannelToServer — ready signal", () => {
  it("ready resolves when oninitialized fires", async () => {
    const { server } = makeMockServer();
    const { daemon } = makeMockDaemon();
    const { ready } = bindChannelToServer(server, daemon);

    expect(server.oninitialized).toBeTypeOf("function");
    server.oninitialized!();
    await expect(ready).resolves.toBeUndefined();
  });
});

describe("capability + tool schemas (spec contract)", () => {
  it("declares experimental['claude/channel'] and tools, NOT permission", () => {
    expect(CHANNEL_CAPABILITIES.experimental).toHaveProperty("claude/channel");
    expect(CHANNEL_CAPABILITIES).toHaveProperty("tools");
    expect(CHANNEL_CAPABILITIES.experimental).not.toHaveProperty(
      "claude/channel/permission",
    );
  });

  it("registers exactly the three spec tools via ListTools", () => {
    const { server, handlers } = makeMockServer();
    const { daemon } = makeMockDaemon();
    bindChannelToServer(server, daemon);

    const listHandler = handlers.get(ListToolsRequestSchema);
    expect(listHandler).toBeTypeOf("function");
    const { tools } = listHandler!({
      params: { name: "tools/list" },
    }) as { tools: { name: string }[] };
    expect(tools.map((t) => t.name)).toEqual([
      "clawcode_ack",
      "clawcode_inbox_read",
      "clawcode_status",
    ]);
  });

  it("tool inputSchemas match the spec required/default fields", () => {
    // CHANNEL_TOOLS is `as const`, so each element has a distinct literal
    // shape. Read inputSchemas through a loose JSON-schema view to assert the
    // spec-relevant fields without per-element union narrowing.
    type SchemaView = {
      properties: Record<string, Record<string, unknown>>;
      required?: string[];
    };
    const schemaOf = (name: string): SchemaView => {
      const tool = CHANNEL_TOOLS.find((t) => t.name === name);
      if (!tool) throw new Error(`tool ${name} not found`);
      return tool.inputSchema as unknown as SchemaView;
    };

    // ack: message_id + status required; status enum exact.
    const ack = schemaOf("clawcode_ack");
    expect(ack.required).toEqual(["message_id", "status"]);
    expect(ack.properties.status!.enum).toEqual([
      "processed",
      "deferred",
      "rejected",
    ]);

    // inbox_read: max_count default 10, nothing required.
    const inbox = schemaOf("clawcode_inbox_read");
    expect(inbox.properties.max_count!.default).toBe(10);
    expect(inbox.required).toBeUndefined();

    // status: state required.
    expect(schemaOf("clawcode_status").required).toEqual(["state"]);
  });
});

describe("readChannelEnv", () => {
  it("requires CLAWCODE_AGENT_NAME", () => {
    expect(() => readChannelEnv({})).toThrow(/CLAWCODE_AGENT_NAME/);
  });

  it("derives the socket path from the agent name when not overridden", () => {
    const env = readChannelEnv({
      CLAWCODE_AGENT_NAME: "personal",
      HOME: "/home/test",
    } as NodeJS.ProcessEnv);
    expect(env.agent).toBe("personal");
    expect(env.socketPath).toContain("channels-state/personal/daemon.sock");
  });

  it("honours CLAWCODE_DAEMON_SOCKET override", () => {
    const env = readChannelEnv({
      CLAWCODE_AGENT_NAME: "personal",
      CLAWCODE_DAEMON_SOCKET: "/custom/path.sock",
    } as NodeJS.ProcessEnv);
    expect(env.socketPath).toBe("/custom/path.sock");
  });
});
