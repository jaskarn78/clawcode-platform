/**
 * Phase 108 Plan 01 — PooledChild.
 *
 * Owns one already-spawned `@takescake/1password-mcp` child_process and
 * is the data-plane primitive of the 1Password broker. The parent
 * `OnePasswordMcpBroker` (Plan 108-02) constructs one PooledChild per
 * unique service-account token and decides when to spawn / kill / respawn.
 *
 * Responsibilities:
 *   - Newline-framed JSON-RPC reads from `child.stdout` (readline).
 *   - JSON-RPC `id` rewriting: agent ids → broker pool ids; responses
 *     routed back via the originating agent's `deliver()`.
 *   - `initialize` cache-and-replay (Pitfall 1): upstream MCP handles
 *     `initialize` once per process lifetime; broker synthesizes
 *     responses for every subsequent agent connect from the cache.
 *   - Crash → in-flight error fanout: on child 'exit' every non-cancelled
 *     inflight call resolves with a structured JSON-RPC error, then
 *     `onExit(code, signal)` fires for the parent broker to decide
 *     whether to respawn.
 *   - Notification drop: lines without `id` are debug-logged and
 *     dropped (1password-mcp does not emit notifications today).
 *
 * Non-responsibilities (live in broker.ts, plan 108-02):
 *   spawning, auto-respawn, per-agent semaphore, drain-and-SIGTERM,
 *   token-grouping.
 *
 * SEC-07 (Phase 104): the token literal is NEVER referenced here;
 * PooledChild only knows the short `tokenHash` for the log `pool` field.
 */

import { createInterface, type Interface as ReadlineInterface } from "node:readline";
import type { ChildProcess } from "node:child_process";
import type { Logger } from "pino";

import {
  BrokerErrorCode,
  type BrokerLogFields,
  type JsonRpcId,
  type JsonRpcRequest,
  type JsonRpcResponse,
} from "./types.js";

// Test asserts numeric constant in JSON-RPC server-defined range -32099..-32000.
export const BROKER_ERROR_CODE_POOL_CRASH = BrokerErrorCode.PoolChildCrashed;

/** A registered agent connection. Broker (108-02) creates one per shim socket. */
export type AgentRoute = {
  readonly agentName: string;
  readonly tokenHash: string;
  /** PooledChild calls this to route a response (or synthesized error) back to the agent. */
  deliver(msg: JsonRpcResponse): void;
};

export type PooledChildDeps = {
  /** Already-spawned child. PooledChild does NOT spawn. */
  readonly child: ChildProcess;
  /** sha256(OP_SERVICE_ACCOUNT_TOKEN).slice(0, 8). Never the literal. */
  readonly tokenHash: string;
  /** pino logger; should already be child-bound to {component:"mcp-broker"}. */
  readonly log: Logger;
  /** Fired once when child emits 'exit'. Broker decides whether to respawn. */
  onExit(code: number | null, signal: NodeJS.Signals | null): void;
};

type InflightEntry = {
  readonly route: AgentRoute;
  readonly agentRequestId: JsonRpcId;
  /** True if cancelInflight(route) fired before response — late response is silently dropped. */
  cancelled: boolean;
};

type PendingInitializer = {
  readonly route: AgentRoute;
  readonly agentRequestId: JsonRpcId;
};

export class PooledChild {
  private readonly deps: PooledChildDeps;
  private readonly logFields: BrokerLogFields;
  private readonly inflight = new Map<number, InflightEntry>();
  private readonly attachedAgents = new Set<AgentRoute>();
  private readonly pendingInitializers: PendingInitializer[] = [];

  private nextPoolId = 1;
  private cachedInitializeResult: JsonRpcResponse["result"] | null = null;
  /** Pool-id of the in-flight initialize round-trip, or null. */
  private inflightInitializePoolId: number | null = null;
  private exited = false;

  private readonly stdoutRl: ReadlineInterface;

  constructor(deps: PooledChildDeps) {
    this.deps = deps;
    this.logFields = {
      component: "mcp-broker",
      pool: `1password-mcp:${deps.tokenHash}`,
    };

    if (!deps.child.stdout) throw new Error("PooledChild: child has no stdout");
    if (!deps.child.stdin) throw new Error("PooledChild: child has no stdin");

    // Verified in RESEARCH.md: MCP stdio framing is plain newline-delimited JSON.
    this.stdoutRl = createInterface({ input: deps.child.stdout });
    this.stdoutRl.on("line", (line) => this.handleStdoutLine(line));

    deps.child.on("exit", (code, signal) => this.handleChildExit(code, signal));
    deps.child.on("error", (err) => {
      this.deps.log.error(
        { ...this.logFields, err: { message: err.message, name: err.name } },
        "pooled child emitted error event",
      );
    });
  }

  // -------------------------- Public API --------------------------

  /**
   * Register an agent connection. Bookkeeping-only — the broker layer
   * uses this so future per-agent notification fan-out (if upstream MCP
   * grows that surface) has a place to look up active agents.
   */
  attachAgent(route: AgentRoute): void {
    this.attachedAgents.add(route);
  }

  /**
   * Dispatch a JSON-RPC request from `route` to the pooled child.
   * `initialize` is special-cased per Pitfall 1 (cache-and-replay);
   * other methods always go through the standard id-rewriter.
   */
  dispatch(route: AgentRoute, msg: JsonRpcRequest): void {
    if (this.exited) {
      route.deliver({
        jsonrpc: "2.0",
        id: msg.id,
        error: { code: BROKER_ERROR_CODE_POOL_CRASH, message: "Pooled MCP child has exited" },
      });
      return;
    }
    this.attachedAgents.add(route);

    if (msg.method === "initialize") {
      this.dispatchInitialize(route, msg);
      return;
    }

    const poolId = this.nextPoolId++;
    this.inflight.set(poolId, { route, agentRequestId: msg.id, cancelled: false });
    this.writeToChild({ ...msg, id: poolId });
  }

  /**
   * Mark every in-flight call from `route` as cancelled. Future matching
   * responses from the child are silently dropped. Used by the broker
   * when an agent connection closes mid-call.
   */
  cancelInflight(route: AgentRoute): void {
    for (const entry of this.inflight.values()) {
      if (entry.route === route) entry.cancelled = true;
    }
    for (let i = this.pendingInitializers.length - 1; i >= 0; i -= 1) {
      if (this.pendingInitializers[i]!.route === route) {
        this.pendingInitializers.splice(i, 1);
      }
    }
    this.attachedAgents.delete(route);
  }

  isAlive(): boolean {
    return !this.exited;
  }

  inflightCount(): number {
    return this.inflight.size;
  }

  childPid(): number | null {
    return this.exited ? null : (this.deps.child.pid ?? null);
  }

  // -------------------------- Internals --------------------------

  private dispatchInitialize(route: AgentRoute, msg: JsonRpcRequest): void {
    // Cache hit — synthesize immediately, no child round-trip.
    if (this.cachedInitializeResult !== null) {
      route.deliver({
        jsonrpc: "2.0",
        id: msg.id,
        result: this.cachedInitializeResult,
      });
      return;
    }

    // Round-trip already in flight — queue this initializer.
    if (this.inflightInitializePoolId !== null) {
      this.pendingInitializers.push({ route, agentRequestId: msg.id });
      return;
    }

    // First initializer — drive the round-trip. Track in pendingInitializers
    // so the response handler can deliver to ALL initializers uniformly.
    const poolId = this.nextPoolId++;
    this.inflightInitializePoolId = poolId;
    this.pendingInitializers.push({ route, agentRequestId: msg.id });
    this.writeToChild({ ...msg, id: poolId });
  }

  private writeToChild(msg: JsonRpcRequest): void {
    const stdin = this.deps.child.stdin;
    if (!stdin || stdin.destroyed) {
      this.deps.log.warn(this.logFields, "pooled child stdin unavailable; dropping dispatch");
      return;
    }
    stdin.write(JSON.stringify(msg) + "\n");
  }

  private handleStdoutLine(line: string): void {
    if (line.length === 0) return;

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (err) {
      // Length-only — never log line content (could echo env in pathological cases).
      this.deps.log.warn(
        { ...this.logFields, parseError: (err as Error).message, lineLen: line.length },
        "pooled child emitted non-JSON line; dropping",
      );
      return;
    }

    if (typeof parsed !== "object" || parsed === null) return;
    const obj = parsed as Record<string, unknown>;
    const id = obj.id as JsonRpcId | undefined;

    // Notification (no id) — drop with debug log.
    if (id === undefined) {
      this.deps.log.debug(
        { ...this.logFields, method: obj.method },
        "pooled child notification dropped (no agent fan-out policy)",
      );
      return;
    }

    // initialize round-trip response — fan out to every pending initializer.
    if (
      typeof id === "number" &&
      this.inflightInitializePoolId !== null &&
      id === this.inflightInitializePoolId
    ) {
      this.handleInitializeResponse(obj as JsonRpcResponse);
      return;
    }

    // Standard response — match against inflight by pool-id.
    if (typeof id !== "number") {
      this.deps.log.debug(
        { ...this.logFields, id: String(id) },
        "pooled child response with non-numeric id; dropping",
      );
      return;
    }

    const entry = this.inflight.get(id);
    if (!entry) {
      // Late response (already errored-out, or broker stopped tracking).
      this.deps.log.debug(
        { ...this.logFields, poolId: id },
        "pooled child response for unknown pool-id; dropping",
      );
      return;
    }

    this.inflight.delete(id);

    // Agent disconnected before response arrived — silently drop.
    if (entry.cancelled) return;

    const restored: JsonRpcResponse = {
      ...(obj as JsonRpcResponse),
      id: entry.agentRequestId,
    };
    this.safeDeliver(entry.route, restored, "response");
  }

  private handleInitializeResponse(response: JsonRpcResponse): void {
    this.inflightInitializePoolId = null;

    if (response.error) {
      // Initialize failed at child level — fan out the error to every
      // pending initializer with their own id.
      const error = response.error;
      const queue = this.pendingInitializers.splice(0);
      for (const p of queue) {
        this.safeDeliver(
          p.route,
          { jsonrpc: "2.0", id: p.agentRequestId, error },
          "initialize-error",
        );
      }
      return;
    }

    // Cache the result — every future initializer (pending + future) gets this synthesized.
    this.cachedInitializeResult = response.result ?? null;
    const queue = this.pendingInitializers.splice(0);
    for (const p of queue) {
      this.safeDeliver(
        p.route,
        { jsonrpc: "2.0", id: p.agentRequestId, result: this.cachedInitializeResult },
        "initialize-cache",
      );
    }
  }

  private handleChildExit(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.exited) return; // idempotent
    this.exited = true;

    this.deps.log.warn(
      {
        ...this.logFields,
        event: "child_exit",
        exitCode: code,
        signal,
        inflightAtExit: this.inflight.size,
        pendingInitializersAtExit: this.pendingInitializers.length,
      },
      "pooled child exited",
    );

    // Fan out structured crash error to every (non-cancelled) inflight call.
    const entries = Array.from(this.inflight.values());
    this.inflight.clear();
    for (const entry of entries) {
      if (entry.cancelled) continue;
      this.safeDeliver(
        entry.route,
        {
          jsonrpc: "2.0",
          id: entry.agentRequestId,
          error: {
            code: BROKER_ERROR_CODE_POOL_CRASH,
            message: "Pooled MCP child exited unexpectedly",
            data: { exitCode: code, signal },
          },
        },
        "crash-fanout",
      );
    }

    // Same treatment for any pending initializers — they'll never get
    // their cached result, so error them out.
    const initQueue = this.pendingInitializers.splice(0);
    for (const p of initQueue) {
      this.safeDeliver(
        p.route,
        {
          jsonrpc: "2.0",
          id: p.agentRequestId,
          error: {
            code: BROKER_ERROR_CODE_POOL_CRASH,
            message: "Pooled MCP child exited before initialize completed",
            data: { exitCode: code, signal },
          },
        },
        "crash-fanout-init",
      );
    }

    this.stdoutRl.removeAllListeners("line");
    this.stdoutRl.close();

    try {
      this.deps.onExit(code, signal);
    } catch (err) {
      this.deps.log.error(
        { ...this.logFields, err: { message: (err as Error).message } },
        "onExit handler threw",
      );
    }
  }

  /** Defensive deliver — a misbehaving agent.deliver() must not crash the pool. */
  private safeDeliver(route: AgentRoute, msg: JsonRpcResponse, context: string): void {
    try {
      route.deliver(msg);
    } catch (err) {
      this.deps.log.warn(
        {
          ...this.logFields,
          agent: route.agentName,
          context,
          err: { message: (err as Error).message },
        },
        "agent deliver() threw; response lost",
      );
    }
  }
}
