/**
 * Phase 140 — ClawCode channel: agent-side protocol core.
 *
 * Every v3 agent is a `claude --channels` session subscribed to two channels:
 * Discord (user → agent, via the official plugin) and **ClawCode** (this file,
 * daemon → agent). This module owns the agent-side relay: it turns
 * daemon-pushed events into MCP `notifications/claude/channel` notifications,
 * and relays the agent's reply tools (`clawcode_ack`, `clawcode_inbox_read`,
 * `clawcode_status`) back to the daemon.
 *
 * **Transport-agnostic by design.** The protocol semantics — the part most
 * likely to be subtly wrong — live in `ClawcodeChannelServerCore` and the
 * daemon-side `AgentChannelBridge` (`../manager/agent-channel-bridge.ts`),
 * both wired through injected sinks. In production the two are connected by a
 * per-agent Unix socket (NDJSON) and the core is bound to a real MCP `Server`;
 * in tests they're connected by an in-process mock so the full push / ack /
 * inbox / ordering / drop contract is provable with no PTY and no real claude.
 * The MCP `Server` + Unix-socket adapters are Stage 2 (this PR ships the core).
 *
 * Spec:
 *   `.planning/phases/140-claudecode-interactive-channels-backend/specs/clawcode-channel-spec.md`
 */

/** Event types the daemon pushes over the channel (spec "Event taxonomy"). */
export type ChannelEventType =
  | "a2a"
  | "cron"
  | "dream"
  | "inbox"
  | "memory"
  | "wake"
  | "permission_request";

/** Delivery priority carried in `meta` (spec NDJSON shape). */
export type ChannelPriority = "low" | "normal" | "high";

/**
 * Daemon → channel-server message (NDJSON over the per-agent Unix socket).
 * Mirrors the spec "Daemon → channel server message shape".
 */
export interface DaemonChannelMessage {
  readonly type: ChannelEventType;
  readonly message_id: string;
  readonly content: string;
  readonly meta?: {
    readonly source_agent?: string;
    readonly priority?: ChannelPriority;
    readonly reply_correlation_id?: string;
    readonly [key: string]: unknown;
  };
}

/**
 * Channel-server → claude MCP notification (spec "Channel server → claude").
 * The `meta.type` / `meta.message_id` flattening is what lets claude render
 * the `<channel source="clawcode" type="..." message_id="...">` envelope.
 */
export interface ChannelNotification {
  readonly method: "notifications/claude/channel";
  readonly params: {
    readonly content: string;
    readonly meta: {
      readonly type: ChannelEventType;
      readonly message_id: string;
      readonly [key: string]: unknown;
    };
  };
}

/** `clawcode_ack` tool input (spec). */
export interface AckInput {
  readonly message_id: string;
  readonly status: "processed" | "deferred" | "rejected";
  readonly result?: string;
}

/** `clawcode_inbox_read` tool input (spec). */
export interface InboxReadInput {
  readonly max_count?: number;
  readonly filter_type?: ChannelEventType;
}

/** `clawcode_status` tool input (spec, optional telemetry). */
export interface StatusInput {
  readonly state: "idle" | "working" | "blocked";
  readonly last_message_id?: string;
  readonly context_pct?: number;
}

/** A drained inbox envelope returned to the agent by `clawcode_inbox_read`. */
export interface InboxEnvelope {
  readonly type: ChannelEventType;
  readonly message_id: string;
  readonly content: string;
  readonly meta?: DaemonChannelMessage["meta"];
}

/**
 * The daemon-facing surface the channel server relays tool calls into. In
 * production this is a NDJSON client to the per-agent Unix socket; in tests it
 * is the `AgentChannelBridge` directly (in-process). Kept narrow so the socket
 * adapter is a thin shim.
 */
export interface ChannelDaemonLink {
  handleAck(input: AckInput): void;
  handleInboxRead(input: InboxReadInput): readonly InboxEnvelope[];
  handleStatus(input: StatusInput): void;
}

/** MCP-notification sink. Production binds `server.notification`; tests collect. */
export type ChannelNotifySink = (notification: ChannelNotification) => void;

/**
 * Convert a daemon message into the MCP notification envelope. Pure — exported
 * for direct assertion in tests.
 */
export function toChannelNotification(
  msg: DaemonChannelMessage,
): ChannelNotification {
  const { type, message_id, ...restMeta } = {
    type: msg.type,
    message_id: msg.message_id,
    ...(msg.meta ?? {}),
  };
  return {
    method: "notifications/claude/channel",
    params: {
      content: msg.content,
      meta: { type, message_id, ...restMeta },
    },
  };
}

/**
 * Agent-side channel relay. Stateless: the inbox + ack correlation state lives
 * on the daemon-side `AgentChannelBridge` (the daemon is the source of truth —
 * spec "Failure modes": the ack round-trip is the only delivery truth).
 */
export class ClawcodeChannelServerCore {
  constructor(
    private readonly notify: ChannelNotifySink,
    private readonly daemon: ChannelDaemonLink,
  ) {}

  /** Daemon pushed an event → emit it as an MCP notification to claude. */
  onDaemonMessage(msg: DaemonChannelMessage): void {
    this.notify(toChannelNotification(msg));
  }

  /** Agent called `clawcode_ack` → relay to the daemon. */
  onAckTool(input: AckInput): void {
    this.daemon.handleAck(input);
  }

  /** Agent called `clawcode_inbox_read` → drain via the daemon, return to agent. */
  onInboxReadTool(input: InboxReadInput): readonly InboxEnvelope[] {
    return this.daemon.handleInboxRead(input);
  }

  /** Agent called `clawcode_status` → relay to the daemon. */
  onStatusTool(input: StatusInput): void {
    this.daemon.handleStatus(input);
  }
}
