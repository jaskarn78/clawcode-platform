// RED — Phase 108-00 — Wave 0 scaffolding. Production target: src/mcp/broker/shim-server.ts.
/**
 * Phase 108 Plan 00 — ShimServer RED tests.
 *
 * Pins the daemon-side IPC server (per-agent unix-socket connections):
 *   - Connection handshake: shim sends `{agent, tokenHash}` as first JSON
 *     line; broker registers the agent. Missing/invalid handshake → close.
 *   - Per-connection refcount: N connections on same tokenHash increment
 *     pool refcount; last disconnect SIGTERMs the pool child.
 *   - Daemon shutdown: preDrainNotify rejects new connections; existing
 *     finish; shutdown(2000) closes all sockets and SIGTERMs pools.
 *   - Token redaction: handshake errors never echo the literal token.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Writable } from "node:stream";
import pino from "pino";

import {
  createFakeBrokerSocketPair,
  type FakeSocket,
} from "../../../../tests/__fakes__/fake-broker-socket.js";
import { FakePooledChild } from "../../../../tests/__fakes__/fake-pooled-child.js";

// Production target — does NOT exist yet.
import {
  ShimServer,
  type ShimServerDeps,
  SHIM_HANDSHAKE_ERROR_INVALID_AGENT,
  SHIM_HANDSHAKE_ERROR_MISSING_FIELDS,
} from "../shim-server.js";
import { OnePasswordMcpBroker } from "../broker.js";

const TEST_TOKEN_LITERAL = "ops_TESTTOKEN_FAKE_XYZ";

function captureLogger() {
  const chunks: string[] = [];
  const sink = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(String(chunk));
      cb();
    },
  });
  const log = pino({ level: "debug" }, sink);
  return {
    log,
    raw: () => chunks.join(""),
    lines: () =>
      chunks
        .join("")
        .split("\n")
        .filter((s) => s.length > 0)
        .map((s) => JSON.parse(s) as Record<string, unknown>),
  };
}

function makeBrokerForShim(log: pino.Logger): {
  broker: OnePasswordMcpBroker;
  spawned: FakePooledChild[];
} {
  const spawned: FakePooledChild[] = [];
  const broker = new OnePasswordMcpBroker({
    log,
    spawnFn: () => {
      const c = new FakePooledChild();
      spawned.push(c);
      return c as unknown as import("node:child_process").ChildProcess;
    },
  });
  return { broker, spawned };
}

/** Push a JSON line into the broker-side of the socket pair. */
function pushLine(socket: FakeSocket, obj: unknown): void {
  socket.write(JSON.stringify(obj) + "\n");
}

describe("ShimServer — connection handshake", () => {
  it("accepts a valid {agent, tokenHash} first line and registers the agent", async () => {
    const cap = captureLogger();
    const { broker } = makeBrokerForShim(cap.log);
    const acceptSpy = vi.spyOn(broker, "acceptConnection");

    const server = new ShimServer({
      broker,
      log: cap.log,
    } satisfies ShimServerDeps);

    const pair = createFakeBrokerSocketPair();
    server.handleConnection(pair.server);

    // Shim writes handshake.
    pushLine(pair.client, {
      agent: "fin-client",
      tokenHash: "abc12345",
    });

    await new Promise((r) => setImmediate(r));

    expect(acceptSpy).toHaveBeenCalledTimes(1);
    const conn = acceptSpy.mock.calls[0]![0];
    expect(conn.agentName).toBe("fin-client");
    expect(conn.tokenHash).toBe("abc12345");
  });

  it("rejects a handshake missing agent name with structured error and closes the socket", async () => {
    const cap = captureLogger();
    const { broker } = makeBrokerForShim(cap.log);
    const server = new ShimServer({ broker, log: cap.log });

    const pair = createFakeBrokerSocketPair();
    const writes: string[] = [];
    pair.client.on("data", (chunk: Buffer) => writes.push(chunk.toString("utf8")));

    server.handleConnection(pair.server);
    pushLine(pair.client, { tokenHash: "abc12345" }); // no agent

    await new Promise((r) => setImmediate(r));

    const errLine = writes.join("").split("\n").find((s) => s.length > 0);
    expect(errLine).toBeDefined();
    const parsed = JSON.parse(errLine!);
    expect(parsed.error?.code).toBe(SHIM_HANDSHAKE_ERROR_MISSING_FIELDS);
  });

  it("rejects a handshake with non-string agent name", async () => {
    const cap = captureLogger();
    const { broker } = makeBrokerForShim(cap.log);
    const server = new ShimServer({ broker, log: cap.log });

    const pair = createFakeBrokerSocketPair();
    const writes: string[] = [];
    pair.client.on("data", (chunk: Buffer) => writes.push(chunk.toString("utf8")));

    server.handleConnection(pair.server);
    pushLine(pair.client, { agent: 123, tokenHash: "abc12345" });
    await new Promise((r) => setImmediate(r));

    const errLine = writes.join("").split("\n").find((s) => s.length > 0);
    expect(errLine).toBeDefined();
    const parsed = JSON.parse(errLine!);
    expect(parsed.error?.code).toBe(SHIM_HANDSHAKE_ERROR_INVALID_AGENT);
  });
});

describe("ShimServer — per-connection refcount", () => {
  it("N connections on the same tokenHash increment the pool refcount; last close SIGTERMs", async () => {
    const cap = captureLogger();
    const { broker, spawned } = makeBrokerForShim(cap.log);
    const server = new ShimServer({ broker, log: cap.log });

    const pair1 = createFakeBrokerSocketPair();
    const pair2 = createFakeBrokerSocketPair();
    const pair3 = createFakeBrokerSocketPair();

    server.handleConnection(pair1.server);
    pushLine(pair1.client, { agent: "a-1", tokenHash: "tokenA01" });
    server.handleConnection(pair2.server);
    pushLine(pair2.client, { agent: "a-2", tokenHash: "tokenA01" });
    server.handleConnection(pair3.server);
    pushLine(pair3.client, { agent: "a-3", tokenHash: "tokenA01" });

    await new Promise((r) => setImmediate(r));

    // Single pool, ref=3.
    expect(spawned).toHaveLength(1);
    expect(broker.getPoolStatus()[0]!.agentRefCount).toBe(3);
  });
});

describe("ShimServer — daemon shutdown", () => {
  it("preDrainNotify rejects new connections; existing connections continue", async () => {
    const cap = captureLogger();
    const { broker } = makeBrokerForShim(cap.log);
    const server = new ShimServer({ broker, log: cap.log });

    const pair1 = createFakeBrokerSocketPair();
    server.handleConnection(pair1.server);
    pushLine(pair1.client, { agent: "a-1", tokenHash: "tokenA01" });
    await new Promise((r) => setImmediate(r));

    // Pre-drain.
    server.preDrainNotify();

    // New connection arrives — should be closed immediately with error.
    const pair2 = createFakeBrokerSocketPair();
    const writes2: string[] = [];
    pair2.client.on("data", (chunk: Buffer) => writes2.push(chunk.toString("utf8")));

    server.handleConnection(pair2.server);
    pushLine(pair2.client, { agent: "a-2", tokenHash: "tokenA01" });
    await new Promise((r) => setImmediate(r));

    // Should have received a "shutting down" error.
    const errLine = writes2.join("").split("\n").find((s) => s.length > 0);
    expect(errLine).toBeDefined();
    const parsed = JSON.parse(errLine!);
    expect(parsed.error).toBeDefined();
    expect(String(parsed.error.message).toLowerCase()).toContain("shut");
  });

  it("shutdown(ceiling) closes all sockets and SIGTERMs all pool children within the ceiling", async () => {
    const cap = captureLogger();
    const { broker, spawned } = makeBrokerForShim(cap.log);
    const server = new ShimServer({ broker, log: cap.log });

    const pair1 = createFakeBrokerSocketPair();
    server.handleConnection(pair1.server);
    pushLine(pair1.client, { agent: "a-1", tokenHash: "tokenA01" });
    await new Promise((r) => setImmediate(r));

    await server.shutdown(2000);

    // Pool child SIGTERMed.
    expect(spawned[0]!.killCallCount).toBeGreaterThanOrEqual(1);
    expect(spawned[0]!.lastKillSignal).toBe("SIGTERM");
  });
});

describe("ShimServer — token redaction in handshake errors", () => {
  it("error responses never echo the literal token even if shim accidentally sent it", async () => {
    const cap = captureLogger();
    const { broker } = makeBrokerForShim(cap.log);
    const server = new ShimServer({ broker, log: cap.log });

    const pair = createFakeBrokerSocketPair();
    const writes: string[] = [];
    pair.client.on("data", (chunk: Buffer) => writes.push(chunk.toString("utf8")));

    server.handleConnection(pair.server);
    // Bad handshake that includes the literal token (a misbehaving shim).
    pushLine(pair.client, {
      agent: "fin-client",
      // tokenHash field missing on purpose; literal in another field.
      _stray: TEST_TOKEN_LITERAL,
    });
    await new Promise((r) => setImmediate(r));

    const responseRaw = writes.join("");
    expect(responseRaw).not.toContain(TEST_TOKEN_LITERAL);
    // Logs also clean.
    expect(cap.raw()).not.toContain(TEST_TOKEN_LITERAL);
  });
});
