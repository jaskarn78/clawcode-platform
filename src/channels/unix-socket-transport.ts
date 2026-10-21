/**
 * Phase 140 Stage 2 (Plan 03) — per-agent Unix-socket NDJSON transport.
 *
 * The live wire between the daemon-side `AgentChannelBridge` and the
 * agent-side `ClawcodeChannelServerCore` (bound to an MCP `Server` in
 * `clawcode-channel-mcp-server.ts`). Replaces the in-process mock the protocol
 * core was proven against in Stage 1.5.
 *
 * Topology (spec "Outbound" + "Daemon-side integration"):
 *
 *   daemon  ──listen──►  ~/.clawcode/channels-state/<agent>/daemon.sock
 *      ▲                                                      │
 *      │  clawcode_* tool relays (server → daemon)            │ DaemonChannelMessage
 *      │                                                      ▼ (daemon → server)
 *   AgentChannelBridge                            ClawcodeChannelServerCore
 *
 * Framing: **newline-delimited JSON**, one object per line (spec). The daemon
 * listens (Unix domain socket server) and accepts ONE persistent connection;
 * the channel server connects as a client and reconnects every 1s on close
 * (spec failure-mode). A JSON object may span multiple TCP reads, so both
 * sides buffer partial lines. Malformed lines are logged + skipped, never
 * thrown (threat T-140-03-02 — drop-is-silent).
 *
 * Spec:
 *   `.planning/phases/140-claudecode-interactive-channels-backend/specs/clawcode-channel-spec.md`
 */

import {
  createServer,
  connect,
  type Server,
  type Socket,
} from "node:net";
import { mkdirSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

import { logger } from "../shared/logger.js";
import type {
  AckInput,
  DaemonChannelMessage,
  InboxReadInput,
  StatusInput,
} from "./clawcode-channel-server.js";

const log = logger.child({ component: "channel-socket" });

/** Reconnect cadence on the channel-server side when the socket drops (spec). */
const RECONNECT_INTERVAL_MS = 1_000;

// ── Fix D dispatch instrumentation (999.83-01) ───────────────────────────────
//
// Flag-gated diagnostic logs at the push-sent + hook-frame-recv seams, used to
// measure the delta between "task push sent" and "first hook frame received"
// on a v3 subagent dispatch — confirming whether the channel notification
// actually produced a turn (root-cause hypothesis H1/H3). Defaults OFF: with
// CLAWCODE_DEBUG_CHANNEL_DISPATCH unset there is ZERO behavioral change. The
// operator sets the flag only on the canary; every added log is wrapped in an
// `if (CHANNEL_DISPATCH_DEBUG)` guard so removal is a single-block delete
// (999.78 body-capture removability lesson). These logs carry TIMING + IDENTITY
// fields ONLY — never message bodies / content / result (threat T-999.83-01-ID).
//
// NOTE: read live (per-call), not a frozen import-time const — the flag is a
// debug toggle, the per-read cost is negligible, and a live read keeps the gate
// deterministically testable.
function isChannelDispatchDebug(): boolean {
  return process.env.CLAWCODE_DEBUG_CHANNEL_DISPATCH === "1";
}

/**
 * A relayed agent tool call, daemon-bound over the socket. The channel server
 * wraps each `clawcode_*` invocation in this discriminated envelope; the
 * daemon dispatches it into the `AgentChannelBridge` (which implements
 * `ChannelDaemonLink`).
 */
export type RelayedToolCall =
  | { readonly tool: "clawcode_ack"; readonly input: AckInput }
  | { readonly tool: "clawcode_inbox_read"; readonly input: InboxReadInput }
  | { readonly tool: "clawcode_status"; readonly input: StatusInput };

/** Default per-agent socket path: `~/.clawcode/channels-state/<agent>/daemon.sock`. */
export function defaultSocketPath(agent: string): string {
  return join(homedir(), ".clawcode", "channels-state", agent, "daemon.sock");
}

/**
 * Split a streamed buffer into complete NDJSON lines, returning the parsed
 * objects plus the unconsumed remainder. A JSON object may span reads, so the
 * trailing partial line is carried forward. Malformed complete lines are
 * logged + dropped (never thrown — drop-is-silent contract).
 */
function drainLines(
  buffer: string,
  onObject: (obj: unknown) => void,
): string {
  const lines = buffer.split("\n");
  // The last element is the (possibly empty) incomplete tail — carry it over.
  const remainder = lines.pop() ?? "";
  for (const line of lines) {
    if (line.trim().length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (err) {
      log.warn(
        { error: (err as Error).message, line: line.slice(0, 120) },
        "dropping malformed NDJSON line",
      );
      continue;
    }
    onObject(parsed);
  }
  return remainder;
}

// ── Daemon side ─────────────────────────────────────────────────────────────

/** Handle returned to the daemon for one agent's channel socket. */
export interface DaemonSocketListener {
  /** Path the channel server connects to. */
  readonly socketPath: string;
  /**
   * Send a daemon event to the connected channel server (NDJSON line).
   * Best-effort fire-and-forget: if no client is connected yet the message is
   * dropped (spec: notifications can be dropped silently; the ack round-trip
   * is the only delivery truth). Satisfies `ChannelMessageSink`.
   */
  send(msg: DaemonChannelMessage): void;
  /** Whether a channel server is currently connected. */
  isConnected(): boolean;
  /** Stop listening and close the socket. */
  close(): Promise<void>;
}

export interface DaemonSocketOptions {
  /** Per-agent socket path. Defaults to `defaultSocketPath(agent)`. */
  readonly socketPath?: string;
  /** Invoked for each relayed agent tool call (server → daemon). */
  readonly onToolCall: (call: RelayedToolCall) => void;
}

/**
 * Start the daemon-side Unix-socket listener for one agent. Accepts ONE
 * persistent connection (spec); a second concurrent connection is rejected so
 * the agent identity stays tied to the socket path, not the payload (threat
 * T-140-03-01). Creates the per-agent state dir (mode 0o700) and clears a
 * stale socket file before listening.
 */
export function createDaemonChannelListener(
  agent: string,
  options: DaemonSocketOptions,
): DaemonSocketListener {
  const socketPath = options.socketPath ?? defaultSocketPath(agent);

  // Per-agent state dir, owner-only (the socket is a control path).
  mkdirSync(dirname(socketPath), { recursive: true, mode: 0o700 });
  // A stale socket file from a prior run would make listen() throw EADDRINUSE.
  try {
    unlinkSync(socketPath);
  } catch {
    // ENOENT (first run) is fine; anything else surfaces at listen().
  }

  let active: Socket | null = null;

  const server: Server = createServer((socket: Socket) => {
    if (active) {
      // One persistent connection only — refuse extras (spec).
      log.warn({ agent }, "rejecting second channel connection");
      socket.destroy();
      return;
    }
    active = socket;
    log.info({ agent }, "channel server connected");

    let buffer = "";
    socket.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      buffer = drainLines(buffer, (obj) => {
        const call = parseRelayedToolCall(obj);
        if (call) options.onToolCall(call);
        else log.warn({ agent }, "dropping unknown inbound channel frame");
      });
    });
    socket.on("error", (err: Error) => {
      log.warn({ agent, error: err.message }, "channel socket error");
    });
    socket.on("close", () => {
      if (active === socket) active = null;
      log.info({ agent }, "channel server disconnected");
    });
  });

  server.on("error", (err: Error) => {
    log.error({ agent, error: err.message }, "daemon channel listener error");
  });
  server.listen(socketPath, () => {
    log.info({ agent, socket: socketPath }, "daemon channel listener up");
  });

  return {
    socketPath,
    send(msg: DaemonChannelMessage): void {
      if (!active) {
        // No channel server connected — drop (ack round-trip is the truth).
        log.debug({ agent, message_id: msg.message_id }, "no peer; dropping");
        return;
      }
      try {
        active.write(JSON.stringify(msg) + "\n");
        if (isChannelDispatchDebug()) {
          // Fix D (999.83-01): timing + identity ONLY — never msg.content / body.
          log.info(
            {
              agent,
              message_id: msg.message_id,
              type: msg.type,
              ts: Date.now(),
            },
            "channel-dispatch-debug:push-sent",
          );
        }
      } catch (err) {
        log.warn(
          { agent, error: (err as Error).message },
          "failed to write channel message",
        );
      }
    },
    isConnected(): boolean {
      return active !== null;
    },
    close(): Promise<void> {
      return new Promise<void>((resolve) => {
        active?.destroy();
        active = null;
        server.close(() => {
          try {
            unlinkSync(socketPath);
          } catch {
            // best-effort cleanup
          }
          resolve();
        });
      });
    },
  };
}

// ── Stop-hook side (deterministic delivery fallback) ────────────────────────
//
// A SECOND per-agent socket, separate from `daemon.sock`. The agent's
// `claude --channels` session fires a `Stop` hook at every turn-end (injected
// by the v3 backend via `--settings`); that hook is a short-lived process that
// connects here, writes ONE `turn_complete` frame, and disconnects. It cannot
// use `daemon.sock` — that accepts a single persistent connection already held
// by the channel MCP server. So this listener accepts MANY short-lived
// connections (one per turn) instead of one persistent one.

/** Agent → daemon: the agent's turn ended; carries its final assistant text. */
export interface TurnCompleteFrame {
  readonly type: "turn_complete";
  /** Authoritative agent identity (from `CLAWCODE_AGENT_NAME`, not cwd). */
  readonly agent: string;
  /** The `claude` session id (telemetry/correlation; optional). */
  readonly session_id?: string;
  /** The agent's final assistant message this turn (the deliverable). */
  readonly last_assistant_message: string;
}

/**
 * Phase 999.82 — agent → daemon block-level streaming.
 *
 * A `claude --channels` PostToolUse hook fires per tool call mid-turn and ships
 * the accumulated assistant text so far. It rides the SAME `hook.sock` as the
 * Stop-hook `turn_complete` frame — ONE socket per agent, `type` discriminates
 * (so we never open a second `progress.sock`). The daemon listener tries the
 * turn_complete parser first, then the progress parser, and dispatches by which
 * matched (`feedback_silent_path_bifurcation` — this listener is the single
 * inbound seam; do NOT add a parallel dispatch path elsewhere).
 *
 * Progress is best-effort COSMETIC: it feeds the live Discord editor (Plan 02)
 * and never participates in delivery truth — turn_complete / ack remain the
 * only delivery guarantees.
 */
export interface ProgressFrame {
  readonly type: "progress";
  /** Authoritative agent identity (from `CLAWCODE_AGENT_NAME`, not cwd). */
  readonly agent: string;
  /** The `claude` session id (telemetry/correlation; optional). */
  readonly session_id?: string;
  /** Accumulated assistant text for the current turn so far. */
  readonly accumulated_text: string;
}

/**
 * 999.103 WS-1 — agent → daemon TodoWrite mirror.
 *
 * The PostToolUse hook observes a `TodoWrite` tool call (the payload is already
 * on its stdin) and ships the checklist. Rides the SAME `hook.sock` as
 * turn_complete/progress — `type` discriminates; the daemon listener stays the
 * single inbound seam (feedback_silent_path_bifurcation). COSMETIC like
 * progress: feeds the live todo card, never delivery truth.
 */
export interface TodoFrame {
  readonly type: "todo";
  /** Authoritative agent identity (from `CLAWCODE_AGENT_NAME`, not cwd). */
  readonly agent: string;
  /** The `claude` session id (telemetry/correlation; optional). */
  readonly session_id?: string;
  /** The full checklist as TodoWrite's input carries it. Validated leniently
   *  here (shape only); item-level validation happens daemon-side in
   *  `parseTodoItems` (todo-mirror.ts). */
  readonly todos: readonly unknown[];
}

/** Default per-agent hook socket: `~/.clawcode/channels-state/<agent>/hook.sock`. */
export function defaultHookSocketPath(agent: string): string {
  return join(homedir(), ".clawcode", "channels-state", agent, "hook.sock");
}

/** Validate a parsed object as a `ProgressFrame` (hook → daemon). */
export function parseProgressFrame(obj: unknown): ProgressFrame | null {
  if (typeof obj !== "object" || obj === null) return null;
  const o = obj as Record<string, unknown>;
  if (o.type !== "progress") return null;
  if (typeof o.agent !== "string" || o.agent.length === 0) return null;
  if (typeof o.accumulated_text !== "string") return null;
  return obj as ProgressFrame;
}

/** Validate a parsed object as a `TodoFrame` (hook → daemon). */
export function parseTodoFrame(obj: unknown): TodoFrame | null {
  if (typeof obj !== "object" || obj === null) return null;
  const o = obj as Record<string, unknown>;
  if (o.type !== "todo") return null;
  if (typeof o.agent !== "string" || o.agent.length === 0) return null;
  if (!Array.isArray(o.todos)) return null;
  return obj as TodoFrame;
}

/** Validate a parsed object as a `TurnCompleteFrame` (hook → daemon). */
export function parseTurnCompleteFrame(obj: unknown): TurnCompleteFrame | null {
  if (typeof obj !== "object" || obj === null) return null;
  const o = obj as Record<string, unknown>;
  if (o.type !== "turn_complete") return null;
  if (typeof o.agent !== "string" || o.agent.length === 0) return null;
  if (typeof o.last_assistant_message !== "string") return null;
  return obj as TurnCompleteFrame;
}

/** Handle returned to the daemon for one agent's Stop-hook socket. */
export interface DaemonHookListener {
  readonly socketPath: string;
  close(): Promise<void>;
}

export interface DaemonHookOptions {
  /** Per-agent hook socket path. Defaults to `defaultHookSocketPath(agent)`. */
  readonly socketPath?: string;
  /** Invoked for each `turn_complete` frame (one per agent turn-end). */
  readonly onTurnComplete: (frame: TurnCompleteFrame) => void;
  /**
   * Invoked for each `progress` frame (Phase 999.82 — many per turn, one per
   * PostToolUse tool call). OPTIONAL: turn_complete-only callers keep working
   * unchanged. A progress frame with no `onProgress` registered is dropped.
   */
  readonly onProgress?: (frame: ProgressFrame) => void;
  /**
   * Invoked for each `todo` frame (999.103 WS-1 — one per TodoWrite call).
   * OPTIONAL: existing callers keep working unchanged; a todo frame with no
   * `onTodo` registered is dropped.
   */
  readonly onTodo?: (frame: TodoFrame) => void;
}

/**
 * Start the daemon-side Stop-hook listener for one agent. Unlike the channel
 * listener this accepts MANY short-lived connections (the hook connects once
 * per turn). Malformed frames are logged + dropped (drop-is-silent). Creates
 * the per-agent state dir (0o700) and clears a stale socket before listening.
 */
export function createDaemonHookListener(
  agent: string,
  options: DaemonHookOptions,
): DaemonHookListener {
  const socketPath = options.socketPath ?? defaultHookSocketPath(agent);
  mkdirSync(dirname(socketPath), { recursive: true, mode: 0o700 });
  try {
    unlinkSync(socketPath);
  } catch {
    // ENOENT (first run) is fine; anything else surfaces at listen().
  }

  const server: Server = createServer((socket: Socket) => {
    let buffer = "";
    socket.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      buffer = drainLines(buffer, (obj) => {
        // ONE socket, two frame types: try turn_complete first, then progress,
        // dispatch by which matched. Unknown frames are logged + dropped. This
        // is the single inbound hook seam (feedback_silent_path_bifurcation).
        const complete = parseTurnCompleteFrame(obj);
        if (complete) {
          if (isChannelDispatchDebug()) {
            // Fix D (999.83-01): identity + frameType + ts ONLY — never the
            // frame's last_assistant_message body. Hook frames carry no
            // message_id, so omit it (do not synthesize one).
            log.info(
              { agent, frameType: complete.type, ts: Date.now() },
              "channel-dispatch-debug:hook-frame-recv",
            );
          }
          options.onTurnComplete(complete);
          return;
        }
        const progress = parseProgressFrame(obj);
        if (progress) {
          if (isChannelDispatchDebug()) {
            // Fix D (999.83-01): identity + frameType + ts ONLY — never the
            // frame's accumulated_text body.
            log.info(
              { agent, frameType: progress.type, ts: Date.now() },
              "channel-dispatch-debug:hook-frame-recv",
            );
          }
          options.onProgress?.(progress);
          return;
        }
        const todo = parseTodoFrame(obj);
        if (todo) {
          if (isChannelDispatchDebug()) {
            // Identity + frameType + count ONLY — never item contents.
            log.info(
              { agent, frameType: todo.type, items: todo.todos.length, ts: Date.now() },
              "channel-dispatch-debug:hook-frame-recv",
            );
          }
          options.onTodo?.(todo);
          return;
        }
        log.warn({ agent }, "dropping unknown hook frame");
      });
    });
    socket.on("error", (err: Error) => {
      log.debug({ agent, error: err.message }, "hook socket error");
    });
  });

  server.on("error", (err: Error) => {
    log.error({ agent, error: err.message }, "daemon hook listener error");
  });
  server.listen(socketPath, () => {
    log.info({ agent, socket: socketPath }, "daemon hook listener up");
  });

  return {
    socketPath,
    close(): Promise<void> {
      return new Promise<void>((resolve) => {
        server.close(() => {
          try {
            unlinkSync(socketPath);
          } catch {
            // best-effort cleanup
          }
          resolve();
        });
      });
    },
  };
}

/**
 * Hook-side: connect to the daemon hook socket, write ONE `turn_complete`
 * frame, and close. Best-effort with a short timeout — a Stop hook must never
 * hang the agent's turn. Resolves whether or not delivery succeeded.
 */
export function sendTurnCompleteFrame(
  socketPath: string,
  frame: TurnCompleteFrame,
  timeoutMs = 2_000,
): Promise<void> {
  return new Promise<void>((resolve) => {
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      try {
        socket.destroy();
      } catch {
        /* ignore */
      }
      resolve();
    };
    const socket = connect(socketPath);
    const timer = setTimeout(finish, timeoutMs);
    timer.unref?.();
    socket.on("connect", () => {
      try {
        socket.write(JSON.stringify(frame) + "\n", () => finish());
      } catch {
        finish();
      }
    });
    socket.on("error", finish);
  });
}

/**
 * Hook-side: connect to the daemon hook socket, write ONE `progress` frame, and
 * close. Best-effort with a short timeout — a PostToolUse hook must NEVER hang
 * the agent's turn (same discipline as {@link sendTurnCompleteFrame}). Resolves
 * whether or not delivery succeeded. Shares `hook.sock` with turn_complete; the
 * frame's `type` discriminates daemon-side.
 */
export function sendProgressFrame(
  socketPath: string,
  // 999.103 WS-1 — also carries TodoFrame: identical wire behavior (one JSON
  // line, best-effort, short timeout), and the daemon listener discriminates
  // on `type`. A separate sender would duplicate this function verbatim.
  frame: ProgressFrame | TodoFrame,
  timeoutMs = 2_000,
): Promise<void> {
  return new Promise<void>((resolve) => {
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      try {
        socket.destroy();
      } catch {
        /* ignore */
      }
      resolve();
    };
    const socket = connect(socketPath);
    const timer = setTimeout(finish, timeoutMs);
    timer.unref?.();
    socket.on("connect", () => {
      try {
        socket.write(JSON.stringify(frame) + "\n", () => finish());
      } catch {
        finish();
      }
    });
    socket.on("error", finish);
  });
}

// ── Channel-server side ──────────────────────────────────────────────────────

/** Handle the channel server uses to talk to the daemon over the socket. */
export interface ChannelServerSocketClient {
  /** Relay an agent tool call to the daemon (NDJSON line). Best-effort. */
  relayToolCall(call: RelayedToolCall): void;
  /** Whether the client is currently connected to the daemon. */
  isConnected(): boolean;
  /**
   * Whether a reconnect attempt is currently scheduled (testable surface for
   * the spec's "retries reconnect every 1s" failure mode).
   */
  isReconnectScheduled(): boolean;
  /** Stop the client; cancels any pending reconnect and closes the socket. */
  close(): void;
}

export interface ChannelServerClientOptions {
  /** Invoked for each daemon → server message (the core's onDaemonMessage). */
  readonly onDaemonMessage: (msg: DaemonChannelMessage) => void;
  /** Reconnect cadence override (tests). Defaults to 1s (spec). */
  readonly reconnectIntervalMs?: number;
}

/**
 * Connect the channel server to the daemon socket. Maintains ONE persistent
 * connection and reconnects every `reconnectIntervalMs` (default 1s) whenever
 * the socket closes or errors — the agent is unaffected by a daemon bounce
 * (spec failure-mode). Inbound daemon messages are parsed from NDJSON and
 * handed to `onDaemonMessage`; malformed lines are dropped.
 */
export function connectChannelServerClient(
  socketPath: string,
  options: ChannelServerClientOptions,
): ChannelServerSocketClient {
  const reconnectMs = options.reconnectIntervalMs ?? RECONNECT_INTERVAL_MS;

  let socket: Socket | null = null;
  let reconnectTimer: NodeJS.Timeout | null = null;
  let closed = false;
  let buffer = "";

  function scheduleReconnect(): void {
    if (closed || reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      open();
    }, reconnectMs);
    // Don't keep the event loop alive solely for the reconnect timer.
    reconnectTimer.unref?.();
  }

  function open(): void {
    if (closed) return;
    buffer = "";
    const s = connect(socketPath);
    socket = s;

    s.on("connect", () => {
      log.info({ socket: socketPath }, "channel client connected to daemon");
    });
    s.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      buffer = drainLines(buffer, (obj) => {
        const msg = parseDaemonChannelMessage(obj);
        if (msg) options.onDaemonMessage(msg);
        else log.warn("dropping unknown daemon channel frame");
      });
    });
    s.on("error", (err: NodeJS.ErrnoException) => {
      // Daemon down / socket missing → reconnect loop (don't surface to agent).
      log.debug({ error: err.message }, "channel client socket error");
    });
    s.on("close", () => {
      if (socket === s) socket = null;
      scheduleReconnect();
    });
  }

  open();

  return {
    relayToolCall(call: RelayedToolCall): void {
      if (!socket) {
        log.debug({ tool: call.tool }, "no daemon connection; dropping relay");
        return;
      }
      try {
        socket.write(JSON.stringify(call) + "\n");
      } catch (err) {
        log.warn(
          { tool: call.tool, error: (err as Error).message },
          "failed to relay tool call",
        );
      }
    },
    isConnected(): boolean {
      return socket !== null && !socket.connecting;
    },
    isReconnectScheduled(): boolean {
      return reconnectTimer !== null;
    },
    close(): void {
      closed = true;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      socket?.destroy();
      socket = null;
    },
  };
}

// ── Shape validation (threat T-140-03-02: validate before dispatch) ──────────

/** Validate a parsed object as a `DaemonChannelMessage` (daemon → server). */
export function parseDaemonChannelMessage(
  obj: unknown,
): DaemonChannelMessage | null {
  if (typeof obj !== "object" || obj === null) return null;
  const o = obj as Record<string, unknown>;
  if (typeof o.type !== "string") return null;
  if (typeof o.message_id !== "string") return null;
  if (typeof o.content !== "string") return null;
  if (o.meta !== undefined && (typeof o.meta !== "object" || o.meta === null)) {
    return null;
  }
  return obj as DaemonChannelMessage;
}

/** Validate a parsed object as a `RelayedToolCall` (server → daemon). */
export function parseRelayedToolCall(obj: unknown): RelayedToolCall | null {
  if (typeof obj !== "object" || obj === null) return null;
  const o = obj as Record<string, unknown>;
  const input = o.input;
  if (typeof input !== "object" || input === null) return null;
  const i = input as Record<string, unknown>;
  switch (o.tool) {
    case "clawcode_ack":
      if (typeof i.message_id !== "string" || typeof i.status !== "string") {
        return null;
      }
      return { tool: "clawcode_ack", input: input as AckInput };
    case "clawcode_inbox_read":
      return { tool: "clawcode_inbox_read", input: input as InboxReadInput };
    case "clawcode_status":
      if (typeof i.state !== "string") return null;
      return { tool: "clawcode_status", input: input as StatusInput };
    default:
      return null;
  }
}
