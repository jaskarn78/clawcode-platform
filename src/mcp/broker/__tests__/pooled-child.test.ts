// RED — Phase 108-00 — Wave 0 scaffolding. Production target: src/mcp/broker/pooled-child.ts.
/**
 * Phase 108 Plan 00 — PooledChild RED tests.
 *
 * Pins data-plane behavior for the per-token pooled MCP child:
 *   - JSON-RPC id rewriting (POOL-03) — concurrent agent dispatches must
 *     route responses to the originating agent.
 *   - initialize cache-and-replay (Pitfall 1) — first agent's initialize
 *     round-trips to the child; subsequent agent initialize calls are
 *     answered from cache without ever reaching the child.
 *   - Crash → in-flight error fanout (POOL-04 / decision §3) — when the
 *     child emits 'exit' with calls in flight, every affected agent
 *     receives a structured JSON-RPC error response.
 *   - Notifications (no `id`) pass through unrewritten.
 *
 * All `it()` bodies are fully fleshed out — only the import target is
 * missing, so RED is "module not found", and Wave 1 GREEN is "make
 * imports resolve and assertions pass" with zero test rewrites.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

import { FakePooledChild } from "../../../../tests/__fakes__/fake-pooled-child.js";

// Production target — does NOT exist yet (intentional RED at import).
// Wave 1 (108-02) implements src/mcp/broker/pooled-child.ts.
import {
  PooledChild,
  type PooledChildDeps,
  type AgentRoute,
  BROKER_ERROR_CODE_POOL_CRASH,
} from "../pooled-child.js";

type JsonRpcMsg = {
  jsonrpc: "2.0";
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
};

/** Minimal pino-shaped logger for deps injection. */
function makeFakeLog() {
  const lines: Array<{ level: string; obj: Record<string, unknown> }> = [];
  const make = (level: string) => (objOrMsg: unknown, _msg?: string) => {
    const obj =
      typeof objOrMsg === "object" && objOrMsg !== null
        ? (objOrMsg as Record<string, unknown>)
        : { msg: objOrMsg };
    lines.push({ level, obj });
  };
  const log = {
    info: make("info"),
    warn: make("warn"),
    error: make("error"),
    debug: make("debug"),
    child: () => log,
  } as unknown as PooledChildDeps["log"];
  return { log, lines };
}

function makeAgentRoute(agentName: string): AgentRoute {
  // Capture every JSON-RPC message routed back to this agent so tests can
  // assert the per-agent response stream.
  const received: JsonRpcMsg[] = [];
  const route: AgentRoute = {
    agentName,
    tokenHash: "abcd1234",
    deliver(msg) {
      received.push(msg as JsonRpcMsg);
    },
  };
  return Object.assign(route, { received });
}

describe("PooledChild — id rewriting (POOL-03)", () => {
  it("routes concurrent id=1 dispatches from two agents back to their originating agents", async () => {
    const child = new FakePooledChild({ pid: 90100 });
    const { log } = makeFakeLog();
    const pooled = new PooledChild({
      child: child as unknown as import("node:child_process").ChildProcess,
      tokenHash: "abcd1234",
      log,
      onExit: vi.fn(),
    });

    const agentA = makeAgentRoute("agent-a") as AgentRoute & { received: JsonRpcMsg[] };
    const agentB = makeAgentRoute("agent-b") as AgentRoute & { received: JsonRpcMsg[] };

    // Both agents dispatch the same agent-side id=1 simultaneously.
    pooled.dispatch(agentA, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "password_read" },
    });
    pooled.dispatch(agentB, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "password_read" },
    });

    // The child should see TWO distinct pool-side ids (broker rewrites).
    const writtenLines = child.consumeStdinJson() as JsonRpcMsg[];
    expect(writtenLines).toHaveLength(2);
    expect(writtenLines[0]!.id).not.toBe(writtenLines[1]!.id);
    expect(typeof writtenLines[0]!.id).toBe("number");
    expect(typeof writtenLines[1]!.id).toBe("number");

    // Simulate child responding in REVERSE order (proves routing is by
    // pool-id, not arrival order).
    child.pushStdoutLine({
      jsonrpc: "2.0",
      id: writtenLines[1]!.id,
      result: { for: "agent-b" },
    });
    child.pushStdoutLine({
      jsonrpc: "2.0",
      id: writtenLines[0]!.id,
      result: { for: "agent-a" },
    });

    // Allow microtask drain (readline emits via 'line' on next tick).
    await new Promise((r) => setImmediate(r));

    // Each agent should see exactly ONE response with their original id=1.
    expect(agentA.received).toHaveLength(1);
    expect(agentA.received[0]!.id).toBe(1);
    expect(agentA.received[0]!.result).toEqual({ for: "agent-a" });

    expect(agentB.received).toHaveLength(1);
    expect(agentB.received[0]!.id).toBe(1);
    expect(agentB.received[0]!.result).toEqual({ for: "agent-b" });
  });

  it("handles string-typed agent ids (JSON-RPC allows string or number)", async () => {
    const child = new FakePooledChild({ pid: 90101 });
    const { log } = makeFakeLog();
    const pooled = new PooledChild({
      child: child as unknown as import("node:child_process").ChildProcess,
      tokenHash: "abcd1234",
      log,
      onExit: vi.fn(),
    });

    const agent = makeAgentRoute("agent-c") as AgentRoute & {
      received: JsonRpcMsg[];
    };
    pooled.dispatch(agent, {
      jsonrpc: "2.0",
      id: "req-uuid-1",
      method: "tools/list",
    });

    const written = child.consumeStdinJson() as JsonRpcMsg[];
    expect(written).toHaveLength(1);
    expect(typeof written[0]!.id).toBe("number"); // pool-side numeric

    child.pushStdoutLine({
      jsonrpc: "2.0",
      id: written[0]!.id,
      result: { tools: [] },
    });
    await new Promise((r) => setImmediate(r));

    expect(agent.received).toHaveLength(1);
    expect(agent.received[0]!.id).toBe("req-uuid-1"); // restored agent-side id
  });
});

describe("PooledChild — initialize cache-and-replay (Pitfall 1)", () => {
  it("first agent's initialize round-trips to the child; second agent's initialize is served from cache", async () => {
    const child = new FakePooledChild({ pid: 90102 });
    const { log } = makeFakeLog();
    const pooled = new PooledChild({
      child: child as unknown as import("node:child_process").ChildProcess,
      tokenHash: "abcd1234",
      log,
      onExit: vi.fn(),
    });

    const agentA = makeAgentRoute("agent-a") as AgentRoute & { received: JsonRpcMsg[] };
    const agentB = makeAgentRoute("agent-b") as AgentRoute & { received: JsonRpcMsg[] };

    // Agent A initializes first.
    pooled.dispatch(agentA, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "agent-a", version: "1.0" } },
    });

    // Child sees ONE initialize line.
    const firstWrite = child.consumeStdinJson() as JsonRpcMsg[];
    expect(firstWrite).toHaveLength(1);
    expect(firstWrite[0]!.method).toBe("initialize");

    // Child responds to initialize.
    const initResult = {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "1password-mcp", version: "2.4.2" },
    };
    child.pushStdoutLine({
      jsonrpc: "2.0",
      id: firstWrite[0]!.id,
      result: initResult,
    });
    await new Promise((r) => setImmediate(r));

    expect(agentA.received).toHaveLength(1);
    expect(agentA.received[0]!.result).toEqual(initResult);

    // Agent B initializes SECOND. Should be cached — child should see NO
    // additional stdin lines.
    pooled.dispatch(agentB, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "agent-b", version: "1.0" } },
    });
    await new Promise((r) => setImmediate(r));

    expect(child.consumeStdinJson()).toHaveLength(0); // no second initialize
    expect(agentB.received).toHaveLength(1); // cached response delivered
    expect(agentB.received[0]!.id).toBe(1); // agent's original id
    expect(agentB.received[0]!.result).toEqual(initResult);
  });

  it("multiple concurrent first-time initializers all receive the same cached result after one round-trip", async () => {
    const child = new FakePooledChild({ pid: 90103 });
    const { log } = makeFakeLog();
    const pooled = new PooledChild({
      child: child as unknown as import("node:child_process").ChildProcess,
      tokenHash: "abcd1234",
      log,
      onExit: vi.fn(),
    });

    const agents = ["a", "b", "c"].map(
      (n) => makeAgentRoute(`agent-${n}`) as AgentRoute & { received: JsonRpcMsg[] },
    );

    // All three send initialize before the child responds.
    for (const a of agents) {
      pooled.dispatch(a, {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: a.agentName, version: "1.0" } },
      });
    }

    // Only ONE initialize line should reach the child.
    const written = child.consumeStdinJson() as JsonRpcMsg[];
    expect(written).toHaveLength(1);

    const initResult = {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "1password-mcp", version: "2.4.2" },
    };
    child.pushStdoutLine({
      jsonrpc: "2.0",
      id: written[0]!.id,
      result: initResult,
    });
    await new Promise((r) => setImmediate(r));

    // All three agents must receive the same cached result with their own id.
    for (const a of agents) {
      expect(a.received).toHaveLength(1);
      expect(a.received[0]!.result).toEqual(initResult);
      expect(a.received[0]!.id).toBe(1);
    }
  });
});

describe("PooledChild — crash → in-flight error fanout", () => {
  it("when the child exits with calls in flight, every affected agent receives a structured JSON-RPC error", async () => {
    const child = new FakePooledChild({ pid: 90104 });
    const { log } = makeFakeLog();
    const onExit = vi.fn();
    const pooled = new PooledChild({
      child: child as unknown as import("node:child_process").ChildProcess,
      tokenHash: "abcd1234",
      log,
      onExit,
    });

    const agentA = makeAgentRoute("agent-a") as AgentRoute & { received: JsonRpcMsg[] };
    const agentB = makeAgentRoute("agent-b") as AgentRoute & { received: JsonRpcMsg[] };

    pooled.dispatch(agentA, {
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: { name: "password_read", arguments: { reference: "op://example-vault-19/b/c" } },
    });
    pooled.dispatch(agentB, {
      jsonrpc: "2.0",
      id: 8,
      method: "tools/call",
      params: { name: "password_read", arguments: { reference: "op://example-vault-19/b/d" } },
    });

    // Drain stdin so the dispatches happened before the crash.
    expect(child.consumeStdinJson()).toHaveLength(2);

    // Child crashes.
    child.simulateExit(137, "SIGKILL");
    await new Promise((r) => setImmediate(r));

    // Both agents must have received an error response with their original id.
    expect(agentA.received).toHaveLength(1);
    expect(agentA.received[0]!.id).toBe(7);
    expect(agentA.received[0]!.error).toBeDefined();
    expect(agentA.received[0]!.error!.code).toBe(BROKER_ERROR_CODE_POOL_CRASH);

    expect(agentB.received).toHaveLength(1);
    expect(agentB.received[0]!.id).toBe(8);
    expect(agentB.received[0]!.error).toBeDefined();
    expect(agentB.received[0]!.error!.code).toBe(BROKER_ERROR_CODE_POOL_CRASH);

    // onExit deps callback fired so broker layer can respawn.
    expect(onExit).toHaveBeenCalledTimes(1);
  });

  it("late responses arriving after agent disconnect are dropped silently (no throw)", async () => {
    const child = new FakePooledChild({ pid: 90105 });
    const { log } = makeFakeLog();
    const pooled = new PooledChild({
      child: child as unknown as import("node:child_process").ChildProcess,
      tokenHash: "abcd1234",
      log,
      onExit: vi.fn(),
    });

    const agent = makeAgentRoute("agent-a") as AgentRoute & { received: JsonRpcMsg[] };
    pooled.dispatch(agent, { jsonrpc: "2.0", id: 1, method: "tools/list" });
    const written = child.consumeStdinJson() as JsonRpcMsg[];

    // Agent disconnects (broker would call cancelInflight before close).
    pooled.cancelInflight(agent);

    // A late response arrives.
    expect(() => {
      child.pushStdoutLine({
        jsonrpc: "2.0",
        id: written[0]!.id,
        result: { tools: [] },
      });
    }).not.toThrow();

    await new Promise((r) => setImmediate(r));
    // Nothing delivered (agent was cancelled).
    expect(agent.received).toHaveLength(0);
  });
});

describe("PooledChild — notifications pass through unrewritten", () => {
  // TODO(108-02): Confirm broadcast policy in CONTEXT.md. RESEARCH.md is
  // ambiguous; current expectation is "drop unhandled notifications" since
  // 1password-mcp does not send any. If broker decides to fan-out, flip
  // the assertion to expect every-agent delivery.
  it("notification (no id) from child is dropped by default (no agent receives it)", async () => {
    const child = new FakePooledChild({ pid: 90106 });
    const { log } = makeFakeLog();
    const pooled = new PooledChild({
      child: child as unknown as import("node:child_process").ChildProcess,
      tokenHash: "abcd1234",
      log,
      onExit: vi.fn(),
    });

    const agentA = makeAgentRoute("agent-a") as AgentRoute & { received: JsonRpcMsg[] };
    const agentB = makeAgentRoute("agent-b") as AgentRoute & { received: JsonRpcMsg[] };
    pooled.attachAgent(agentA);
    pooled.attachAgent(agentB);

    // Child sends a notification (no `id`).
    child.pushStdoutLine({
      jsonrpc: "2.0",
      method: "notifications/message",
      params: { level: "info", text: "hello" },
    });
    await new Promise((r) => setImmediate(r));

    expect(agentA.received).toHaveLength(0);
    expect(agentB.received).toHaveLength(0);
  });
});

describe("PooledChild — module shape", () => {
  beforeEach(() => {
    // Sanity reset — vi.fn instances are per-test.
  });

  it("exports BROKER_ERROR_CODE_POOL_CRASH constant", () => {
    expect(typeof BROKER_ERROR_CODE_POOL_CRASH).toBe("number");
    // JSON-RPC custom errors live in -32099..-32000 range (Server-defined).
    expect(BROKER_ERROR_CODE_POOL_CRASH).toBeGreaterThanOrEqual(-32099);
    expect(BROKER_ERROR_CODE_POOL_CRASH).toBeLessThanOrEqual(-32000);
  });
});
