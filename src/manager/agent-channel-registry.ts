/**
 * Phase 140 Plan 07 (#14) — per-agent ClawCode channel wiring (daemon-side).
 *
 * The FIRST production instantiation of `AgentChannelBridge` + the Unix-socket
 * listener. Stage 1.5 / Plan 03 built and proved both halves against a mock
 * transport, but nothing in the daemon wired them together — so daemon→agent
 * channel delivery (cron / a2a / steer to a v3 agent) was dormant. This module
 * is the seam that activates it.
 *
 * Topology (per `unix-socket-transport.ts`):
 *
 *   AgentChannelBridge ──send──► DaemonSocketListener ──socket──► agent MCP server
 *          ▲                            │
 *          └──── onToolCall ◄───────────┘  (clawcode_* relays, agent → daemon)
 *
 * `wireAgentChannel` ties the two together: the bridge's `ChannelMessageSink`
 * is the listener's `send`, and the listener's `onToolCall` dispatches each
 * relayed tool call back into the bridge's `ChannelDaemonLink` methods.
 *
 * **Lifecycle = daemon lifecycle, NOT session lifecycle.** Bridges are created
 * once in the daemon's per-agent boot loop and torn down at daemon shutdown via
 * `closeAll()`. A v3 agent that respawns reuses the same socket — its MCP-server
 * client just reconnects (1s cadence, see `connectChannelServerClient`). This is
 * why there is no per-`stopAgent` teardown here.
 *
 * **Backend gate (`feedback_silent_path_bifurcation`).** `wireForConfig` wires
 * ONLY an agent whose CONFIGURED backend is `claude-code-interactive`; a v2
 * agent gets nothing (no socket). Runtime FAILOVER flips (a v2 agent flipped to
 * v3 at turn time via `failoverStateReader`) do NOT create/destroy bridges
 * mid-life — that failover-aware lifecycle is a documented deferred follow-up.
 * A still-running bridge with no connected client is harmless: pushes drop
 * silently (the ack round-trip is the only delivery truth, per spec).
 *
 * **Scope (#14) = push + ack + status.** The `clawcode_inbox_read` RETURN path
 * (delivering drained envelopes back to the agent) needs an async
 * request/response channel over the socket that does not exist yet, so it is a
 * documented deferred follow-up. We deliberately do NOT route inbox_read into
 * `bridge.handleInboxRead` — doing so would flip pending rows to in-flight with
 * no delivery channel, stranding them. We log + drop until the return path
 * lands. cron / a2a / steer use the push path, which is complete.
 *
 * Spec:
 *   `.planning/phases/140-claudecode-interactive-channels-backend/specs/clawcode-channel-spec.md`
 */

import {
  createDaemonChannelListener,
  createDaemonHookListener,
  type DaemonSocketListener,
  type DaemonHookListener,
} from "../channels/unix-socket-transport.js";
import { AgentChannelBridge } from "./agent-channel-bridge.js";
import { logger } from "../shared/logger.js";

const log = logger.child({ component: "agent-channel-registry" });

/** The v3 backend whose agents get a live ClawCode channel. */
const V3_BACKEND = "claude-code-interactive";

/**
 * Grace (ms) between a `turn_complete` Stop-hook frame and the
 * `handleTurnComplete` fallback. `clawcode_ack` is relayed mid-turn (before the
 * Stop hook fires at turn-end), so in the acked case `handleTurnComplete` is
 * already a no-op. This grace only guards the rare socket-reorder where the
 * hook frame races ahead of the ack relay — it lets an in-flight ack land
 * first. It adds latency ONLY to the un-acked fallback path; the acked
 * fast-path resolves immediately on the ack.
 */
const TURN_COMPLETE_SETTLE_MS = 300;

/** A daemon-side bridge paired with its socket listeners for one v3 agent. */
export interface WiredAgentChannel {
  readonly bridge: AgentChannelBridge;
  readonly listener: DaemonSocketListener;
  /** Stop-hook socket — the deterministic delivery fallback. */
  readonly hookListener: DaemonHookListener;
}

export interface WireAgentChannelOptions {
  /** Override the per-agent socket path (tests). Defaults to the per-agent path. */
  readonly socketPath?: string;
  /** Override the per-agent Stop-hook socket path (tests). */
  readonly hookSocketPath?: string;
  /**
   * 999.103 WS-1 — sink for TodoWrite mirror frames. Late-bound by the daemon
   * (the TodoMirror needs the webhook manager, which exists only after Discord
   * login), so the closure must read its target ref at FIRE time. Optional:
   * absent → todo frames are dropped at the listener, exactly like onProgress.
   */
  readonly onTodo?: (frame: import("../channels/unix-socket-transport.js").TodoFrame) => void;
}

/** Structural subset of an agent config the backend gate reads. */
export interface ChannelAgentConfigLike {
  readonly name: string;
  readonly llmRuntime?: { readonly backend?: string };
}

/**
 * Wire one agent's bridge to a fresh Unix-socket listener. The listener's
 * inbound relays are dispatched into the bridge's `ChannelDaemonLink` methods;
 * the bridge sends outbound daemon events through the listener. Returns both so
 * the caller can reach the bridge (push / awaitReply) and close the listener.
 */
export function wireAgentChannel(
  agent: string,
  opts: WireAgentChannelOptions = {},
): WiredAgentChannel {
  // The bridge and the listener reference each other; break the cycle with a
  // `let` that the listener's (deferred) onToolCall closure reads after the
  // bridge is assigned below. The closure never fires before construction
  // completes, but the null guard keeps TS honest and is correct under any
  // pathological early inbound.
  let bridge: AgentChannelBridge | null = null;

  const listener = createDaemonChannelListener(agent, {
    socketPath: opts.socketPath,
    onToolCall: (call) => {
      if (!bridge) return;
      switch (call.tool) {
        case "clawcode_ack":
          bridge.handleAck(call.input);
          break;
        case "clawcode_status":
          bridge.handleStatus(call.input);
          break;
        case "clawcode_inbox_read":
          // #14 scope = push + ack only. The inbox-read RETURN path is a
          // deferred follow-up (no async response channel over the socket yet).
          // Do NOT call bridge.handleInboxRead — it would flip pending rows to
          // in-flight with no way to deliver them. Log + drop until that lands.
          log.debug(
            { agent },
            "clawcode_inbox_read relay received; return path deferred (#14 follow-up)",
          );
          break;
      }
    },
  });

  // Stop-hook socket — the deterministic delivery fallback. The agent's
  // turn-end hook connects here and sends a `turn_complete` frame; we resolve
  // any STILL-PENDING awaitReply with the agent's final message after a short
  // settle grace (so a mid-turn ack wins the race; see TURN_COMPLETE_SETTLE_MS).
  const hookListener = createDaemonHookListener(agent, {
    socketPath: opts.hookSocketPath,
    onTurnComplete: (frame) => {
      if (!bridge) return;
      const b = bridge;
      // Pipe-proof + telemetry: a frame arrived for every turn-end. `resolved`
      // below tells us whether the model had ALREADY acked (0 = fast-path hit,
      // fallback idle) or forgot (>0 = fallback delivered) — i.e. the ack-miss
      // rate, the very fragility this mechanism backstops.
      log.info(
        { agent, session: frame.session_id },
        "phase140-turn-complete frame received",
      );
      const timer = setTimeout(() => {
        const resolved = b.handleTurnComplete(frame.last_assistant_message);
        log.info(
          { agent, resolved, session: frame.session_id },
          resolved > 0
            ? "phase140-turn-complete-fallback delivered un-acked reply"
            : "phase140-turn-complete no pending reply (agent acked — fallback idle)",
        );
      }, TURN_COMPLETE_SETTLE_MS);
      timer.unref?.();
    },
    // Phase 999.82 — block-level streaming. A PostToolUse hook ships a progress
    // frame mid-turn over the SAME hook.sock; fan it out to the bridge's live
    // editor sink. Best-effort COSMETIC: onProgress is structurally forbidden
    // from resolving a pending awaitReply (delivery truth = ack/turn_complete).
    onProgress: (frame) => {
      if (!bridge) return;
      bridge.onProgress(frame.accumulated_text);
    },
    // 999.103 WS-1 — todo frames go STRAIGHT to the daemon-side TodoMirror,
    // not through the AgentChannelBridge: the mirror owns its own message id
    // and must not contend with the single-slot progress callback
    // (agent-channel-bridge.ts:166). Same COSMETIC contract as progress.
    ...(opts.onTodo ? { onTodo: opts.onTodo } : {}),
  });

  bridge = new AgentChannelBridge(agent, (msg) => listener.send(msg));
  return { bridge, listener, hookListener };
}

/**
 * Daemon-owned registry of per-agent ClawCode channels. Constructed once in the
 * daemon boot loop; `wireForConfig` is called per agent (gated to v3) and
 * `closeAll` runs in the shutdown closure. IPC handlers (ask-agent / cron / a2a
 * / steer) reach a v3 agent's bridge via `get(agent)`.
 */
export class AgentChannelRegistry {
  private readonly channels = new Map<string, WiredAgentChannel>();

  /**
   * Gate + wire. Instantiates a bridge + socket listener ONLY for an agent whose
   * CONFIGURED backend is `claude-code-interactive`. Returns the wired channel,
   * or `null` for a non-v3 agent (no socket created, nothing stored).
   * Idempotent: a second call for an already-wired agent returns the existing
   * channel without opening a second socket.
   */
  wireForConfig(
    cfg: ChannelAgentConfigLike,
    opts?: WireAgentChannelOptions,
  ): WiredAgentChannel | null {
    if (cfg.llmRuntime?.backend !== V3_BACKEND) return null;

    const existing = this.channels.get(cfg.name);
    if (existing) return existing;

    const wired = wireAgentChannel(cfg.name, opts);
    this.channels.set(cfg.name, wired);
    log.info(
      { agent: cfg.name, socket: wired.listener.socketPath },
      "wired v3 agent channel (bridge + socket listener)",
    );
    return wired;
  }

  /** The wired channel for an agent, or undefined if it has none (non-v3). */
  get(agent: string): WiredAgentChannel | undefined {
    return this.channels.get(agent);
  }

  has(agent: string): boolean {
    return this.channels.has(agent);
  }

  /** Names of all agents with a live channel (insertion order). */
  agents(): readonly string[] {
    return Array.from(this.channels.keys());
  }

  /**
   * Phase 999.82-03 — per-agent teardown for DYNAMIC subagent bridges.
   *
   * Boot-wired bridges (`wireForConfig` in the daemon boot loop) live for the
   * daemon's lifetime and are torn down only by `closeAll` at shutdown — there
   * is deliberately NO per-`stopAgent` teardown for them (a respawning v3 agent
   * reuses the same socket; its MCP client just reconnects — see the module
   * doc "Lifecycle = daemon lifecycle").
   *
   * A subagent bridge is different: it is wired DYNAMICALLY at spawn
   * (`SubagentThreadSpawner` → `wireChannelForSubagent`) and the subagent's
   * session ends on thread completion/archive. If it were never torn down, every
   * subagent spawn would leak its `daemon.sock` + `hook.sock` listeners for the
   * rest of daemon uptime (threat T-999.82-03-02). So the spawner calls this on
   * session end. Idempotent: an unknown name (or a double teardown) is a no-op
   * — the entry is popped before closing so a concurrent caller can't double the
   * close. Best-effort swallow mirrors `closeAll`.
   */
  async unwireForAgent(agentName: string): Promise<void> {
    const wired = this.channels.get(agentName);
    if (!wired) return; // no-op for an unknown / already-unwired name
    this.channels.delete(agentName);
    await Promise.all([
      wired.listener.close().catch((err: unknown) => {
        log.warn(
          { agent: agentName, error: (err as Error)?.message },
          "subagent channel listener close threw (non-fatal)",
        );
      }),
      wired.hookListener.close().catch((err: unknown) => {
        log.warn(
          { agent: agentName, error: (err as Error)?.message },
          "subagent hook listener close threw (non-fatal)",
        );
      }),
    ]);
    log.info({ agent: agentName }, "unwired dynamic subagent channel (teardown)");
  }

  /**
   * Close every wired listener and clear the registry. Best-effort: a listener
   * close that rejects is swallowed so one bad socket can't block shutdown.
   * Called from the daemon shutdown closure.
   */
  async closeAll(): Promise<void> {
    const all = Array.from(this.channels.values());
    this.channels.clear();
    await Promise.all(
      all.flatMap((c) => [
        c.listener.close().catch((err: unknown) => {
          log.warn(
            { error: (err as Error)?.message },
            "agent channel listener close threw (non-fatal)",
          );
        }),
        c.hookListener.close().catch((err: unknown) => {
          log.warn(
            { error: (err as Error)?.message },
            "agent hook listener close threw (non-fatal)",
          );
        }),
      ]),
    );
  }
}
