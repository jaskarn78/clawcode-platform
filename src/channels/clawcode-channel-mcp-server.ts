#!/usr/bin/env node
/**
 * Phase 140 Stage 2 (Plan 03) — ClawCode channel MCP Server adapter.
 *
 * The runnable binary the spec's `.mcp.json` points at
 * (`dist/channels/clawcode-channel-mcp-server.js`). It binds the
 * transport-agnostic `ClawcodeChannelServerCore` to:
 *
 *   - a real MCP `Server` — daemon events become
 *     `notifications/claude/channel`; the three reply tools (`clawcode_ack`,
 *     `clawcode_inbox_read`, `clawcode_status`) are registered with the spec
 *     inputSchemas and relayed into the core;
 *   - the per-agent Unix-socket client (Task 2) — the core's
 *     `ChannelDaemonLink` writes tool relays to the daemon, and inbound daemon
 *     messages drive `core.onDaemonMessage`.
 *
 * **Fire-and-forget by design.** The notify sink never awaits
 * `server.notification` (spec: "events are dropped silently with no error
 * returned"); socket writes are best-effort. There is no synchronous
 * result-bearing turn over the channel — that property is what removes the
 * hard problem. The `clawcode_ack` round-trip is the only delivery truth.
 *
 * Spec:
 *   `.planning/phases/140-claudecode-interactive-channels-backend/specs/clawcode-channel-spec.md`
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { logger } from "../shared/logger.js";
import {
  ClawcodeChannelServerCore,
  type AckInput,
  type ChannelDaemonLink,
  type ChannelEventType,
  type ChannelNotification,
  type InboxReadInput,
  type StatusInput,
} from "./clawcode-channel-server.js";
import {
  connectChannelServerClient,
  defaultSocketPath,
  type ChannelServerSocketClient,
} from "./unix-socket-transport.js";

const log = logger.child({ component: "channel-mcp" });

/** Spec capability declaration. NO `claude/channel/permission` — Phase 14X. */
export const CHANNEL_CAPABILITIES = {
  experimental: {
    "claude/channel": {},
  },
  tools: {},
} as const;

export const CHANNEL_INSTRUCTIONS =
  'Events from the ClawCode daemon arrive as <channel source="clawcode" ' +
  'type="..." source_agent="..." priority="...">payload</channel>. ' +
  "Acknowledge messages by calling clawcode_ack with the message_id from the " +
  "tag. Cross-agent messages may reference inbox JSONL entries — call " +
  "clawcode_inbox_read to drain pending envelopes when notified.";

/** The three reply tools, exactly per spec inputSchemas. */
export const CHANNEL_TOOLS = [
  {
    name: "clawcode_ack",
    description:
      "Acknowledge that a daemon-pushed event has been processed. The daemon " +
      "clears the inbox row and correlates a pending reply if present.",
    inputSchema: {
      type: "object" as const,
      properties: {
        message_id: {
          type: "string",
          description: "message_id from the <channel> tag",
        },
        status: {
          type: "string",
          enum: ["processed", "deferred", "rejected"],
        },
        result: {
          type: "string",
          description: "Optional summary of what happened",
        },
      },
      required: ["message_id", "status"],
    },
  },
  {
    name: "clawcode_inbox_read",
    description:
      "Drain pending inbox messages. Returns up to max_count envelopes; the " +
      "daemon marks them in-flight. Ack each one with clawcode_ack.",
    inputSchema: {
      type: "object" as const,
      properties: {
        max_count: { type: "integer", default: 10 },
        filter_type: {
          type: "string",
          description: "Only drain this type if set",
        },
      },
    },
  },
  {
    name: "clawcode_status",
    description:
      "Report current state (idle/working/blocked) to the daemon for the " +
      "dashboard and heartbeat probe.",
    inputSchema: {
      type: "object" as const,
      properties: {
        state: { type: "string", enum: ["idle", "working", "blocked"] },
        last_message_id: { type: "string" },
        context_pct: { type: "number" },
      },
      required: ["state"],
    },
  },
] as const;

/**
 * The minimal MCP-Server surface this adapter drives. `Server` from the SDK
 * satisfies it structurally; tests pass a hand-rolled mock so no real
 * `StdioServerTransport` / `connect()` is needed.
 */
export interface ChannelMcpServerLike {
  notification(notification: ChannelNotification): Promise<void>;
  setRequestHandler(
    schema: unknown,
    handler: (request: {
      params: { name: string; arguments?: Record<string, unknown> };
    }) => unknown,
  ): void;
  oninitialized?: () => void;
}

export interface BoundChannelServer {
  /** The bound protocol core (daemon-message entry point). */
  readonly core: ClawcodeChannelServerCore;
  /** Resolves when the MCP client has sent `initialized` (Plan 02 heartbeat). */
  readonly ready: Promise<void>;
}

/** Coerce raw tool arguments into a validated AckInput, or null. */
function toAckInput(args: Record<string, unknown>): AckInput | null {
  const { message_id, status, result } = args;
  if (typeof message_id !== "string") return null;
  if (status !== "processed" && status !== "deferred" && status !== "rejected") {
    return null;
  }
  return {
    message_id,
    status,
    ...(typeof result === "string" ? { result } : {}),
  };
}

/** Coerce raw tool arguments into an InboxReadInput (all fields optional). */
function toInboxReadInput(args: Record<string, unknown>): InboxReadInput {
  const out: { max_count?: number; filter_type?: ChannelEventType } = {};
  if (typeof args.max_count === "number") out.max_count = args.max_count;
  if (typeof args.filter_type === "string") {
    out.filter_type = args.filter_type as ChannelEventType;
  }
  return out;
}

/** Coerce raw tool arguments into a validated StatusInput, or null. */
function toStatusInput(args: Record<string, unknown>): StatusInput | null {
  const { state, last_message_id, context_pct } = args;
  if (state !== "idle" && state !== "working" && state !== "blocked") {
    return null;
  }
  return {
    state,
    ...(typeof last_message_id === "string" ? { last_message_id } : {}),
    ...(typeof context_pct === "number" ? { context_pct } : {}),
  };
}

function ok(payload: unknown) {
  return {
    content: [
      { type: "text" as const, text: JSON.stringify(payload ?? "ok") },
    ],
  };
}

function fail(message: string) {
  return {
    content: [{ type: "text" as const, text: message }],
    isError: true as const,
  };
}

/**
 * Bind a `ClawcodeChannelServerCore` to an MCP server + a daemon link.
 *
 * - The core's notify sink fires `server.notification` WITHOUT awaiting
 *   (fire-and-forget — failures are logged, never surfaced).
 * - `ListTools` returns the three spec tools; `CallTool` relays each into the
 *   core after validating the input shape.
 * - `ready` resolves on the server's `initialized` notification.
 *
 * Pure wiring — no transport construction — so tests drive it with a mock
 * server and a mock daemon link.
 */
export function bindChannelToServer(
  server: ChannelMcpServerLike,
  daemon: ChannelDaemonLink,
): BoundChannelServer {
  // Fire-and-forget notify sink: NEVER await (spec drop-is-silent contract).
  const core = new ClawcodeChannelServerCore((notification) => {
    void server.notification(notification).catch((err: unknown) => {
      log.warn(
        { error: (err as Error)?.message },
        "channel notification failed (dropped)",
      );
    });
  }, daemon);

  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: CHANNEL_TOOLS,
  }));

  server.setRequestHandler(CallToolRequestSchema, (request) => {
    const name = request.params.name;
    const args = request.params.arguments ?? {};
    try {
      switch (name) {
        case "clawcode_ack": {
          const input = toAckInput(args);
          if (!input) return fail("clawcode_ack: message_id + status required");
          core.onAckTool(input);
          return ok({ acked: input.message_id });
        }
        case "clawcode_inbox_read": {
          const drained = core.onInboxReadTool(toInboxReadInput(args));
          return ok({ envelopes: drained });
        }
        case "clawcode_status": {
          const input = toStatusInput(args);
          if (!input) return fail("clawcode_status: state required");
          core.onStatusTool(input);
          return ok({ recorded: input.state });
        }
        default:
          return fail(`unknown tool: ${name}`);
      }
    } catch (err) {
      return fail(`${name} failed: ${(err as Error).message}`);
    }
  });

  let resolveReady!: () => void;
  const ready = new Promise<void>((resolve) => {
    resolveReady = resolve;
  });
  server.oninitialized = () => {
    log.info("channel MCP server initialized");
    resolveReady();
  };

  return { core, ready };
}

/**
 * Read the spec env table. `CLAWCODE_AGENT_NAME` is required for socket
 * routing + telemetry; `CLAWCODE_DAEMON_SOCKET` overrides the derived path.
 */
export interface ChannelServerEnv {
  readonly agent: string;
  readonly socketPath: string;
}

export function readChannelEnv(
  env: NodeJS.ProcessEnv = process.env,
): ChannelServerEnv {
  const agent = env.CLAWCODE_AGENT_NAME;
  if (!agent || agent.trim().length === 0) {
    throw new Error("CLAWCODE_AGENT_NAME is required");
  }
  const socketPath = env.CLAWCODE_DAEMON_SOCKET ?? defaultSocketPath(agent);
  return { agent, socketPath };
}

/**
 * Production entrypoint: construct the real `Server`, connect the Task-2
 * Unix-socket client as the daemon link, bind them, and serve over stdio. The
 * daemon link relays tool calls over the socket and feeds inbound daemon
 * messages into the bound core.
 */
export async function main(): Promise<void> {
  const { agent, socketPath } = readChannelEnv();

  const server = new Server(
    { name: "clawcode-channel", version: "0.1.0" },
    { capabilities: CHANNEL_CAPABILITIES, instructions: CHANNEL_INSTRUCTIONS },
  );

  // Forward-declared so the daemon link can call into the bound core, which is
  // only created once `bindChannelToServer` runs below.
  let bound: BoundChannelServer | null = null;

  const client: ChannelServerSocketClient = connectChannelServerClient(
    socketPath,
    {
      onDaemonMessage: (msg) => bound?.core.onDaemonMessage(msg),
    },
  );

  // The core relays the agent's reply tools to the daemon over the socket.
  const daemonLink: ChannelDaemonLink = {
    handleAck(input: AckInput): void {
      client.relayToolCall({ tool: "clawcode_ack", input });
    },
    handleInboxRead(input: InboxReadInput) {
      // Drain is daemon-authoritative; the socket relay is fire-and-forget, so
      // the synchronous return here is an empty drain. The agent learns of
      // pending rows via the daemon's `inbox` notification + a follow-up read
      // that the daemon answers over the socket. (Inline-drain-over-socket is
      // an open spec question; baseline keeps the relay one-directional.)
      client.relayToolCall({ tool: "clawcode_inbox_read", input });
      return [];
    },
    handleStatus(input: StatusInput): void {
      client.relayToolCall({ tool: "clawcode_status", input });
    },
  };

  bound = bindChannelToServer(server, daemonLink);

  await server.connect(new StdioServerTransport());
  log.info({ agent, socket: socketPath }, "clawcode-channel MCP server serving");

  // Graceful shutdown — mirror the official discord channel server.
  let shuttingDown = false;
  const shutdown = (): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info("clawcode-channel shutting down");
    client.close();
    setTimeout(() => process.exit(0), 500).unref?.();
  };
  process.stdin.on("end", shutdown);
  process.stdin.on("close", shutdown);
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

// Run only when invoked directly (not when imported by tests).
const isDirectRun =
  typeof process.argv[1] === "string" &&
  import.meta.url === `file://${process.argv[1]}`;
if (isDirectRun) {
  main().catch((err: unknown) => {
    log.error({ error: (err as Error)?.message }, "fatal");
    process.exit(1);
  });
}
