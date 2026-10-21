// RED — Phase 108-00 — Wave 0 scaffolding. Production target: src/mcp/broker/broker.ts.
/**
 * Phase 108 Plan 00 — OnePasswordMcpBroker RED tests.
 *
 * Pins control-plane behavior for the broker that owns one PooledChild
 * per service-account token and fans agent connections onto the shared
 * children:
 *
 *   - Token grouping (POOL-01): N agents on token A + M agents on token
 *     B → exactly 2 PooledChild instances spawned.
 *   - Last-ref SIGTERM with drain (POOL-04 / Pitfall 3): when last agent
 *     disconnects, broker waits up to 2s for inflight to drain, then
 *     SIGTERMs the child. If drain ceiling is hit, in-flight calls are
 *     failed with a structured error BEFORE the kill.
 *   - Auto-respawn on crash (POOL-04): broker spawns new child within 2s
 *     of pool exit if any agent connections are still attached.
 *   - Per-agent semaphore (POOL-05): max 4 concurrent in-flight per agent;
 *     5th queues FIFO until one completes.
 *   - Audit log fields (POOL-06): every dispatched call emits a pino line
 *     with component, pool, agent, turnId, tool fields.
 *   - Token redaction (Phase 104 SEC-07): no log line ever contains the
 *     literal token string.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Writable } from "node:stream";
import pino from "pino";

import { FakePooledChild } from "../../../../tests/__fakes__/fake-pooled-child.js";

// Production target — does NOT exist yet (intentional RED at import).
import {
  OnePasswordMcpBroker,
  type BrokerDeps,
  type BrokerSpawnFn,
  type BrokerAgentConnection,
  BROKER_ERROR_CODE_DRAIN_TIMEOUT,
  BROKER_ERROR_CODE_POOL_UNAVAILABLE,
} from "../broker.js";

const TEST_TOKEN_LITERAL = "ops_TESTTOKEN_FAKE_XYZ";
const TEST_TOKEN_LITERAL_B = "ops_TESTTOKEN_FAKE_QQQ";

type CapturedLog = ReturnType<typeof captureLogger>;

function captureLogger() {
  const chunks: string[] = [];
  const sink = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(String(chunk));
      cb();
    },
  });
  const log = pino({ level: "debug" }, sink);
  const lines = () =>
    chunks
      .join("")
      .split("\n")
      .filter((s) => s.length > 0)
      .map((s) => JSON.parse(s) as Record<string, unknown>);
  const raw = () => chunks.join("");
  return { log, lines, raw };
}

/**
 * Build a spawnFn that returns a fresh FakePooledChild per call. Tracks
 * every spawn so tests can assert pool cardinality.
 */
function makeSpawnFn(): {
  spawnFn: BrokerSpawnFn;
  spawned: FakePooledChild[];
} {
  const spawned: FakePooledChild[] = [];
  const spawnFn: BrokerSpawnFn = (_args) => {
    const child = new FakePooledChild();
    spawned.push(child);
    return child as unknown as import("node:child_process").ChildProcess;
  };
  return { spawnFn, spawned };
}

/**
 * Minimal BrokerAgentConnection fake. Captures everything the broker
 * sends back to the agent so tests can assert the per-agent stream.
 */
function makeAgentConn(
  agentName: string,
  tokenHash: string,
  rawToken: string,
): BrokerAgentConnection & {
  received: Array<Record<string, unknown>>;
  closeListeners: Array<() => void>;
  triggerClose: () => void;
} {
  const received: Array<Record<string, unknown>> = [];
  const closeListeners: Array<() => void> = [];
  const conn: BrokerAgentConnection = {
    agentName,
    tokenHash,
    rawToken, // broker MUST NOT log this
    send(msg) {
      received.push(msg as Record<string, unknown>);
    },
    onClose(fn) {
      closeListeners.push(fn);
    },
  };
  return Object.assign(conn, {
    received,
    closeListeners,
    triggerClose: () => {
      for (const fn of closeListeners) fn();
    },
  });
}

describe("Broker — token grouping (POOL-01)", () => {
  let cap: CapturedLog;

  beforeEach(() => {
    cap = captureLogger();
  });

  it("three agents on token A and one agent on token B spawn exactly 2 pool children", async () => {
    const { spawnFn, spawned } = makeSpawnFn();
    const broker = new OnePasswordMcpBroker({
      log: cap.log,
      spawnFn,
    } satisfies BrokerDeps);

    const a1 = makeAgentConn("agent-a1", "tokenA01", TEST_TOKEN_LITERAL);
    const a2 = makeAgentConn("agent-a2", "tokenA01", TEST_TOKEN_LITERAL);
    const a3 = makeAgentConn("agent-a3", "tokenA01", TEST_TOKEN_LITERAL);
    const b1 = makeAgentConn("agent-b1", "tokenB02", TEST_TOKEN_LITERAL_B);

    await broker.acceptConnection(a1);
    await broker.acceptConnection(a2);
    await broker.acceptConnection(a3);
    await broker.acceptConnection(b1);

    expect(spawned).toHaveLength(2);
    // Pool status reflects two distinct tokenHashes.
    const status = broker.getPoolStatus();
    expect(status).toHaveLength(2);
    const hashes = status.map((s) => s.tokenHash).sort();
    expect(hashes).toEqual(["tokenA01", "tokenB02"]);
    const refsByHash = Object.fromEntries(status.map((s) => [s.tokenHash, s.agentRefCount]));
    expect(refsByHash).toEqual({ tokenA01: 3, tokenB02: 1 });
  });

  it("broker does not cross-route between token pools", async () => {
    const { spawnFn, spawned } = makeSpawnFn();
    const broker = new OnePasswordMcpBroker({ log: cap.log, spawnFn });

    const a = makeAgentConn("agent-a", "tokenA01", TEST_TOKEN_LITERAL);
    const b = makeAgentConn("agent-b", "tokenB02", TEST_TOKEN_LITERAL_B);
    await broker.acceptConnection(a);
    await broker.acceptConnection(b);

    expect(spawned).toHaveLength(2);
    const [childA, childB] = spawned;

    // Agent A dispatches a tools/call.
    await broker.handleAgentMessage(a, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "password_read" },
    });

    // Only childA (the one spawned for tokenA01) should have received the
    // dispatch. childB stdin must be untouched.
    expect(childA!.consumeStdinJson()).toHaveLength(1);
    expect(childB!.consumeStdinJson()).toHaveLength(0);
  });
});

describe("Broker — last-ref SIGTERM with drain (POOL-04, Pitfall 3)", () => {
  let cap: CapturedLog;
  beforeEach(() => {
    cap = captureLogger();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("last-ref disconnect waits up to 2s for inflight to drain, then SIGTERMs the child", async () => {
    const { spawnFn, spawned } = makeSpawnFn();
    const broker = new OnePasswordMcpBroker({ log: cap.log, spawnFn });

    const a = makeAgentConn("agent-a", "tokenA01", TEST_TOKEN_LITERAL);
    await broker.acceptConnection(a);
    expect(spawned).toHaveLength(1);
    const child = spawned[0]!;

    // One in-flight call.
    await broker.handleAgentMessage(a, {
      jsonrpc: "2.0",
      id: 42,
      method: "tools/call",
      params: { name: "password_read" },
    });
    expect(child.consumeStdinJson()).toHaveLength(1);

    // Agent disconnects — broker decrements ref to 0.
    a.triggerClose();

    // Within 100ms broker should NOT have killed yet (waiting for drain).
    await vi.advanceTimersByTimeAsync(100);
    expect(child.killCallCount).toBe(0);

    // Drain ceiling is 2s — at 2s mark broker MUST have failed inflight
    // with structured error AND SIGTERMed the child.
    await vi.advanceTimersByTimeAsync(2000);

    expect(a.received).toHaveLength(1);
    const errMsg = a.received[0]!;
    expect(errMsg.id).toBe(42);
    expect((errMsg.error as { code: number }).code).toBe(BROKER_ERROR_CODE_DRAIN_TIMEOUT);
    expect(child.killCallCount).toBe(1);
    expect(child.lastKillSignal).toBe("SIGTERM");
  });

  it("if inflight drains before ceiling, SIGTERM fires immediately after the last response", async () => {
    const { spawnFn, spawned } = makeSpawnFn();
    const broker = new OnePasswordMcpBroker({ log: cap.log, spawnFn });

    const a = makeAgentConn("agent-a", "tokenA01", TEST_TOKEN_LITERAL);
    await broker.acceptConnection(a);
    const child = spawned[0]!;

    await broker.handleAgentMessage(a, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "password_read" },
    });
    const writes = child.consumeStdinJson() as Array<{ id: number }>;

    a.triggerClose();
    // Child responds after 50ms.
    await vi.advanceTimersByTimeAsync(50);
    child.pushStdoutLine({ jsonrpc: "2.0", id: writes[0]!.id, result: { ok: true } });
    await vi.advanceTimersByTimeAsync(10);

    expect(child.killCallCount).toBe(1);
  });
});

describe("Broker — auto-respawn on crash (POOL-04)", () => {
  let cap: CapturedLog;
  beforeEach(() => {
    cap = captureLogger();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("when child exits while agents are still attached, broker spawns a new child within 2s", async () => {
    const { spawnFn, spawned } = makeSpawnFn();
    const broker = new OnePasswordMcpBroker({ log: cap.log, spawnFn });

    const a = makeAgentConn("agent-a", "tokenA01", TEST_TOKEN_LITERAL);
    await broker.acceptConnection(a);
    expect(spawned).toHaveLength(1);

    // First child crashes.
    spawned[0]!.simulateExit(137, "SIGKILL");
    await vi.advanceTimersByTimeAsync(2000);

    // Broker must have respawned because agent A is still attached.
    expect(spawned.length).toBeGreaterThanOrEqual(2);
    expect(spawned[1]!.pid).not.toBe(spawned[0]!.pid);
  });

  it("does NOT respawn if no agents remain attached", async () => {
    const { spawnFn, spawned } = makeSpawnFn();
    const broker = new OnePasswordMcpBroker({ log: cap.log, spawnFn });

    const a = makeAgentConn("agent-a", "tokenA01", TEST_TOKEN_LITERAL);
    await broker.acceptConnection(a);
    a.triggerClose(); // ref drops to 0
    await vi.advanceTimersByTimeAsync(2100); // past drain ceiling
    spawned[0]!.simulateExit(0); // child dies after broker SIGTERM

    await vi.advanceTimersByTimeAsync(2000);
    expect(spawned).toHaveLength(1); // no respawn
  });
});

describe("Broker — per-agent semaphore (POOL-05)", () => {
  let cap: CapturedLog;
  beforeEach(() => {
    cap = captureLogger();
  });

  it("a single agent dispatching 5 concurrent calls sees max 4 in-flight; 5th waits in FIFO queue", async () => {
    const { spawnFn, spawned } = makeSpawnFn();
    const broker = new OnePasswordMcpBroker({ log: cap.log, spawnFn });

    const a = makeAgentConn("agent-a", "tokenA01", TEST_TOKEN_LITERAL);
    await broker.acceptConnection(a);
    const child = spawned[0]!;

    // Dispatch 5 concurrent.
    for (let i = 1; i <= 5; i++) {
      await broker.handleAgentMessage(a, {
        jsonrpc: "2.0",
        id: i,
        method: "tools/call",
        params: { name: "password_read" },
      });
    }

    // Only 4 should have reached the child.
    let written = child.consumeStdinJson() as Array<{ id: number }>;
    expect(written).toHaveLength(4);

    // Status reports queue depth = 1.
    const status = broker.getPoolStatus()[0]!;
    expect(status.queueDepth).toBe(1);

    // Respond to one of the in-flight to free a slot.
    child.pushStdoutLine({ jsonrpc: "2.0", id: written[0]!.id, result: { ok: 1 } });
    await new Promise((r) => setImmediate(r));

    // Now the queued 5th call should be dispatched.
    written = child.consumeStdinJson() as Array<{ id: number }>;
    expect(written).toHaveLength(1);

    // And queue depth back to 0.
    expect(broker.getPoolStatus()[0]!.queueDepth).toBe(0);
  });
});

describe("Broker — audit log fields (POOL-06)", () => {
  it("every dispatched call emits a pino line with component, pool, agent, turnId, tool fields", async () => {
    const cap = captureLogger();
    const { spawnFn } = makeSpawnFn();
    const broker = new OnePasswordMcpBroker({ log: cap.log, spawnFn });

    const a = makeAgentConn("agent-a", "tokenA01", TEST_TOKEN_LITERAL);
    await broker.acceptConnection(a);

    await broker.handleAgentMessage(a, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "password_read", _meta: { turnId: "turn-uuid-123" } },
    });

    const dispatched = cap.lines().filter(
      (l) =>
        l.component === "mcp-broker" &&
        typeof l.tool === "string" &&
        l.tool === "password_read",
    );
    expect(dispatched.length).toBeGreaterThanOrEqual(1);
    const line = dispatched[0]!;
    expect(line.component).toBe("mcp-broker");
    expect(line.pool).toBe("1password-mcp:tokenA01");
    expect(line.agent).toBe("agent-a");
    expect(line.turnId).toBe("turn-uuid-123");
    expect(line.tool).toBe("password_read");
  });
});

describe("Broker — token redaction (Phase 104 SEC-07)", () => {
  it("no log line ever contains the literal OP_SERVICE_ACCOUNT_TOKEN value", async () => {
    const cap = captureLogger();
    const { spawnFn } = makeSpawnFn();
    const broker = new OnePasswordMcpBroker({ log: cap.log, spawnFn });

    const a = makeAgentConn("agent-a", "tokenA01", TEST_TOKEN_LITERAL);
    await broker.acceptConnection(a);

    await broker.handleAgentMessage(a, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "password_read" },
    });

    // Trigger a crash to exercise error-path logging.
    // (We don't have direct access to the spawned child here without the
    // test introspection; instead force broker to log an error path via
    // an explicit unsupported method.)
    await broker.handleAgentMessage(a, {
      jsonrpc: "2.0",
      id: 2,
      method: "wholly/invalid",
    });

    const raw = cap.raw();
    expect(raw).not.toContain(TEST_TOKEN_LITERAL);
    // tokenHash IS expected in audit lines.
    expect(raw).toContain("tokenA01");
  });

  it("no log line contains any string starting with 'ops_' (1Password service-account prefix)", async () => {
    const cap = captureLogger();
    const { spawnFn } = makeSpawnFn();
    const broker = new OnePasswordMcpBroker({ log: cap.log, spawnFn });

    const a = makeAgentConn("agent-a", "tokenA01", TEST_TOKEN_LITERAL);
    await broker.acceptConnection(a);
    await broker.handleAgentMessage(a, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "password_read" },
    });

    const raw = cap.raw();
    // Any literal `ops_` followed by capital letters / digits would be
    // a service-account token leak. tokenHash uses hex (lowercase).
    expect(raw).not.toMatch(/ops_[A-Z0-9_]/);
  });
});

describe("Broker — module shape", () => {
  it("exports BROKER_ERROR_CODE_DRAIN_TIMEOUT in JSON-RPC server-defined error range", () => {
    expect(typeof BROKER_ERROR_CODE_DRAIN_TIMEOUT).toBe("number");
    expect(BROKER_ERROR_CODE_DRAIN_TIMEOUT).toBeGreaterThanOrEqual(-32099);
    expect(BROKER_ERROR_CODE_DRAIN_TIMEOUT).toBeLessThanOrEqual(-32000);
  });

  it("exports BROKER_ERROR_CODE_POOL_UNAVAILABLE in JSON-RPC server-defined error range", () => {
    expect(typeof BROKER_ERROR_CODE_POOL_UNAVAILABLE).toBe("number");
    expect(BROKER_ERROR_CODE_POOL_UNAVAILABLE).toBeGreaterThanOrEqual(-32099);
    expect(BROKER_ERROR_CODE_POOL_UNAVAILABLE).toBeLessThanOrEqual(-32000);
    expect(BROKER_ERROR_CODE_POOL_UNAVAILABLE).not.toBe(
      BROKER_ERROR_CODE_DRAIN_TIMEOUT,
    );
  });
});

// INC-2026-07-27 — the daemon's spawnFn threw on an unresolvable rawToken;
// the throw escaped the broker (un-awaited acceptConnection → unhandled
// rejection; 'exit'-listener respawn → uncaughtException) and the daemon
// process.exit(1)-ed five times until systemd gave up. FLEET DOWN over one
// agent's token. These pin the non-fatal contract at the broker seam.
describe("Broker — refused pool spawn is non-fatal (INC-2026-07-27)", () => {
  let cap: CapturedLog;
  beforeEach(() => {
    cap = captureLogger();
  });

  /** spawnFn that refuses (or throws) for `badHash`, succeeds otherwise. */
  function makeSelectiveSpawnFn(
    badHash: string,
    mode: "null" | "throw",
  ): { spawnFn: BrokerSpawnFn; spawned: FakePooledChild[] } {
    const spawned: FakePooledChild[] = [];
    const spawnFn: BrokerSpawnFn = ({ tokenHash }) => {
      if (tokenHash === badHash) {
        if (mode === "throw") throw new Error("empty rawToken");
        return null;
      }
      const child = new FakePooledChild();
      spawned.push(child);
      return child as unknown as import("node:child_process").ChildProcess;
    };
    return { spawnFn, spawned };
  }

  it("a refused spawn does not throw out of acceptConnection and registers no pool", async () => {
    const { spawnFn } = makeSelectiveSpawnFn("badhash1", "null");
    const broker = new OnePasswordMcpBroker({ log: cap.log, spawnFn });
    const a = makeAgentConn("agent-a", "badhash1", "");

    await expect(broker.acceptConnection(a)).resolves.toBeUndefined();

    // Pool map is NOT poisoned — no entry at all, so no null child.
    expect(broker.getPoolStatus()).toEqual([]);
    // The attaching agent (and only it) sees the typed error.
    expect(a.received).toHaveLength(1);
    expect((a.received[0]!.error as { code: number }).code).toBe(
      BROKER_ERROR_CODE_POOL_UNAVAILABLE,
    );
  });

  it("a spawnFn that THROWS is caught at the broker seam (never reaches the daemon)", async () => {
    const { spawnFn } = makeSelectiveSpawnFn("badhash1", "throw");
    const broker = new OnePasswordMcpBroker({ log: cap.log, spawnFn });
    const a = makeAgentConn("agent-a", "badhash1", "");

    await expect(broker.acceptConnection(a)).resolves.toBeUndefined();
    expect(broker.getPoolStatus()).toEqual([]);
    expect(a.received).toHaveLength(1);
  });

  it("one agent's bad token degrades ONLY that agent — healthy pools keep serving", async () => {
    const { spawnFn, spawned } = makeSelectiveSpawnFn("badhash1", "null");
    const broker = new OnePasswordMcpBroker({ log: cap.log, spawnFn });

    const bad = makeAgentConn("agent-bad", "badhash1", "");
    const good = makeAgentConn("agent-good", "tokenA01", TEST_TOKEN_LITERAL);
    await broker.acceptConnection(bad);
    await broker.acceptConnection(good);

    // Healthy agent still got a pool and dispatches normally.
    expect(spawned).toHaveLength(1);
    await broker.handleAgentMessage(good, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "password_read" },
    });
    expect(spawned[0]!.consumeStdinJson()).toHaveLength(1);

    // The degraded agent's later calls get a structured error carrying
    // their own id (handleAgentMessage's "No pool for tokenHash" branch).
    await broker.handleAgentMessage(bad, {
      jsonrpc: "2.0",
      id: 99,
      method: "tools/call",
      params: { name: "password_read" },
    });
    const last = bad.received[bad.received.length - 1]!;
    expect(last.id).toBe(99);
    expect((last.error as { code: number }).code).toBeLessThanOrEqual(-32000);

    const status = broker.getPoolStatus();
    expect(status).toHaveLength(1);
    expect(status[0]!.tokenHash).toBe("tokenA01");
  });

  it("a refused RESPAWN removes the pool instead of poisoning it with a null child", async () => {
    // First spawn succeeds; the post-crash respawn is refused.
    const spawned: FakePooledChild[] = [];
    let calls = 0;
    const spawnFn: BrokerSpawnFn = () => {
      calls += 1;
      if (calls > 1) return null;
      const child = new FakePooledChild();
      spawned.push(child);
      return child as unknown as import("node:child_process").ChildProcess;
    };
    const broker = new OnePasswordMcpBroker({ log: cap.log, spawnFn });

    const a = makeAgentConn("agent-a", "tokenA01", TEST_TOKEN_LITERAL);
    await broker.acceptConnection(a);
    // Saturate the per-agent semaphore (4) + 1 queued so the queue-failure
    // branch of the respawn teardown is exercised.
    for (let i = 1; i <= 5; i++) {
      await broker.handleAgentMessage(a, {
        jsonrpc: "2.0",
        id: i,
        method: "tools/call",
        params: { name: "password_read" },
      });
    }
    expect(broker.getPoolStatus()[0]!.queueDepth).toBe(1);

    // FakePooledChild.simulateExit emits 'exit' SYNCHRONOUSLY, so a throw
    // from the respawn path would surface right here — in production it
    // became an uncaughtException and killed the daemon.
    expect(() => spawned[0]!.simulateExit(137, "SIGKILL")).not.toThrow();

    // Pool gone from the map — never registered with a null child.
    expect(broker.getPoolStatus()).toEqual([]);
    // 4 inflight + 1 queued all answered with structured errors.
    expect(a.received).toHaveLength(5);
    const codes = a.received.map((m) => (m.error as { code: number }).code);
    expect(
      codes.filter((c) => c === BROKER_ERROR_CODE_POOL_UNAVAILABLE),
    ).toHaveLength(1);
    for (const c of codes) {
      expect(c).toBeGreaterThanOrEqual(-32099);
      expect(c).toBeLessThanOrEqual(-32000);
    }
  });

  it("a respawn spawnFn that THROWS is caught (no uncaughtException from the exit handler)", async () => {
    const spawned: FakePooledChild[] = [];
    let calls = 0;
    const spawnFn: BrokerSpawnFn = () => {
      calls += 1;
      if (calls > 1) throw new Error("resolveBrokerChildSpawn exploded");
      const child = new FakePooledChild();
      spawned.push(child);
      return child as unknown as import("node:child_process").ChildProcess;
    };
    const broker = new OnePasswordMcpBroker({ log: cap.log, spawnFn });

    const a = makeAgentConn("agent-a", "tokenA01", TEST_TOKEN_LITERAL);
    await broker.acceptConnection(a);

    expect(() => spawned[0]!.simulateExit(1)).not.toThrow();
    expect(broker.getPoolStatus()).toEqual([]);
  });

  it("refusal log lines never contain the literal token (SEC-07)", async () => {
    const { spawnFn } = makeSelectiveSpawnFn("badhash1", "null");
    const broker = new OnePasswordMcpBroker({ log: cap.log, spawnFn });
    await broker.acceptConnection(
      makeAgentConn("agent-a", "badhash1", TEST_TOKEN_LITERAL),
    );

    const raw = cap.raw();
    expect(raw).not.toContain(TEST_TOKEN_LITERAL);
    expect(raw).not.toMatch(/ops_[A-Z0-9_]/);
    expect(raw).toContain("badhash1");
  });
});

describe("Broker — token rotation rebind (Phase 999.26)", () => {
  // Reproduces the 2026-05-01 production incident: fin-client's
  // OP_SERVICE_ACCOUNT_TOKEN env changed between shim respawns (legitimate
  // 1Password rotation OR scope-resolver returning a different token), so
  // the agent's tokenHash flipped from `aa18cf6f` → `dcfc03f8`. The pre-fix
  // broker REJECTED every reconnect with "daemon restart required"; the
  // SDK respawn loop hit it every ~3s for 20+ minutes, saturating MCP
  // capacity and causing QUEUE_FULL on user messages. The fix: rebind to
  // the new pool, drain the old one if refCount hits 0.
  let cap: CapturedLog;
  beforeEach(() => {
    cap = captureLogger();
  });

  it("agent reconnect with rotated tokenHash rebinds to new pool (no rejection)", async () => {
    const { spawnFn, spawned } = makeSpawnFn();
    const broker = new OnePasswordMcpBroker({ log: cap.log, spawnFn });

    // Original connection on token A.
    const a1 = makeAgentConn(
      "fin-client",
      "aa18cf6f",
      TEST_TOKEN_LITERAL,
    );
    await broker.acceptConnection(a1);
    expect(spawned).toHaveLength(1);

    // Token rotates — same agent reconnects with a NEW tokenHash.
    const a2 = makeAgentConn(
      "fin-client",
      "dcfc03f8",
      TEST_TOKEN_LITERAL_B,
    );
    await broker.acceptConnection(a2);

    // No JSON-RPC error response was sent to the new connection — it was
    // accepted (the pre-fix behavior would have sent an error here).
    expect(a2.received).toHaveLength(0);

    // A new pool was spawned for the new tokenHash.
    expect(spawned).toHaveLength(2);
    const status = broker.getPoolStatus();
    const byHash = Object.fromEntries(status.map((s) => [s.tokenHash, s]));
    // New pool active with the rebound agent.
    expect(byHash["dcfc03f8"]?.agentRefCount).toBe(1);
    // Old pool dropped its sole reference — drain triggered, pool gone
    // from the live status (or refCount==0). Either represents successful
    // detachment; the multi-agent test below pins the partial-detach case.
    const oldStatus = byHash["aa18cf6f"];
    if (oldStatus !== undefined) {
      expect(oldStatus.agentRefCount).toBe(0);
    }
  });

  it("rebind logs warn (not error) with oldHash + newHash for audit trail", async () => {
    const { spawnFn } = makeSpawnFn();
    const broker = new OnePasswordMcpBroker({ log: cap.log, spawnFn });

    const a1 = makeAgentConn(
      "fin-client",
      "aa18cf6f",
      TEST_TOKEN_LITERAL,
    );
    await broker.acceptConnection(a1);

    const a2 = makeAgentConn(
      "fin-client",
      "dcfc03f8",
      TEST_TOKEN_LITERAL_B,
    );
    await broker.acceptConnection(a2);

    const rotateLogs = cap.lines().filter((l) =>
      String(l.msg).includes("token rotated"),
    );
    expect(rotateLogs.length).toBeGreaterThanOrEqual(1);
    const log = rotateLogs[0]!;
    expect(log.level).toBe(40); // pino warn
    expect(log.agent).toBe("fin-client");
    expect(log.oldHash).toBe("aa18cf6f");
    expect(log.newHash).toBe("dcfc03f8");
  });

  it("rebind does NOT send a JSON-RPC error to the new connection (no respawn loop)", async () => {
    const { spawnFn } = makeSpawnFn();
    const broker = new OnePasswordMcpBroker({ log: cap.log, spawnFn });

    const a1 = makeAgentConn(
      "fin-client",
      "aa18cf6f",
      TEST_TOKEN_LITERAL,
    );
    await broker.acceptConnection(a1);

    const a2 = makeAgentConn(
      "fin-client",
      "dcfc03f8",
      TEST_TOKEN_LITERAL_B,
    );
    await broker.acceptConnection(a2);

    // The pre-fix behavior was: send a JSON-RPC error with code
    // BROKER_ERROR_CODE_DRAIN_TIMEOUT and message "daemon restart required".
    // That triggered the SDK respawn loop. Post-fix: zero error responses.
    expect(a2.received).toHaveLength(0);
    // Sanity: a normal dispatch on the new connection routes correctly.
    await broker.handleAgentMessage(a2, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "password_read" },
    });
    // No error came back — the dispatch landed on the pool.
    expect(a2.received).toHaveLength(0);
  });

  it("rebind preserves other agents on the old pool (refCount only decrements by 1)", async () => {
    const { spawnFn, spawned } = makeSpawnFn();
    const broker = new OnePasswordMcpBroker({ log: cap.log, spawnFn });

    // Two other agents share the old pool — they should not be disturbed.
    const other1 = makeAgentConn(
      "acme-content-creator",
      "aa18cf6f",
      TEST_TOKEN_LITERAL,
    );
    const other2 = makeAgentConn(
      "fin-research",
      "aa18cf6f",
      TEST_TOKEN_LITERAL,
    );
    await broker.acceptConnection(other1);
    await broker.acceptConnection(other2);

    const a1 = makeAgentConn(
      "fin-client",
      "aa18cf6f",
      TEST_TOKEN_LITERAL,
    );
    await broker.acceptConnection(a1);
    expect(spawned).toHaveLength(1); // single pool so far

    // fin-client rebinds to a new token.
    const a2 = makeAgentConn(
      "fin-client",
      "dcfc03f8",
      TEST_TOKEN_LITERAL_B,
    );
    await broker.acceptConnection(a2);

    const status = broker.getPoolStatus();
    const byHash = Object.fromEntries(status.map((s) => [s.tokenHash, s]));
    // Old pool retains the two non-rotated agents.
    expect(byHash["aa18cf6f"]?.agentRefCount).toBe(2);
    // New pool has just fin-client.
    expect(byHash["dcfc03f8"]?.agentRefCount).toBe(1);
  });

  it("rebind survives multiple rotations for the same agent (no permanent latch)", async () => {
    const { spawnFn } = makeSpawnFn();
    const broker = new OnePasswordMcpBroker({ log: cap.log, spawnFn });

    // Agent rotates A → B → C across three reconnects.
    const a = makeAgentConn("fin-client", "hashAAAA", TEST_TOKEN_LITERAL);
    await broker.acceptConnection(a);

    const b = makeAgentConn("fin-client", "hashBBBB", TEST_TOKEN_LITERAL_B);
    await broker.acceptConnection(b);

    const c = makeAgentConn(
      "fin-client",
      "hashCCCC",
      "ops_TESTTOKEN_FAKE_THIRD",
    );
    await broker.acceptConnection(c);

    // No JSON-RPC errors anywhere (no rejection loop).
    expect(a.received).toHaveLength(0);
    expect(b.received).toHaveLength(0);
    expect(c.received).toHaveLength(0);

    // Active pool is the latest hash.
    const status = broker.getPoolStatus();
    const active = status.filter((s) => s.agentRefCount > 0);
    expect(active).toHaveLength(1);
    expect(active[0]!.tokenHash).toBe("hashCCCC");
  });
});

// Phase 109-A — cross-fleet 1P observability. Pins the new fields on
// PoolStatus (rpsLastMin, throttleEvents24h, lastRetryAfterSec) and the
// throttle classifier behavior on child error responses.
describe("Broker — Phase 109-A observability", () => {
  let cap: CapturedLog;
  beforeEach(() => {
    cap = captureLogger();
  });

  it("rpsLastMin counts dispatched calls in the trailing 60s window", async () => {
    const { spawnFn } = makeSpawnFn();
    const broker = new OnePasswordMcpBroker({ log: cap.log, spawnFn });
    const a = makeAgentConn("agent-a", "tokenA01", TEST_TOKEN_LITERAL);
    await broker.acceptConnection(a);

    for (let i = 1; i <= 3; i++) {
      await broker.handleAgentMessage(a, {
        jsonrpc: "2.0",
        id: i,
        method: "tools/call",
        params: { name: "password_read" },
      });
    }

    const status = broker.getPoolStatus()[0]!;
    expect(status.rpsLastMin).toBe(3);
  });

  it("throttleEvents24h increments + lastRetryAfterSec parses retryAfter from error.data", async () => {
    const { spawnFn, spawned } = makeSpawnFn();
    const broker = new OnePasswordMcpBroker({ log: cap.log, spawnFn });
    const a = makeAgentConn("agent-a", "tokenA01", TEST_TOKEN_LITERAL);
    await broker.acceptConnection(a);

    await broker.handleAgentMessage(a, {
      jsonrpc: "2.0",
      id: 42,
      method: "tools/call",
      params: { name: "password_read" },
    });
    const child = spawned[0]!;
    const written = child.consumeStdinJson() as Array<{ id: number }>;
    const poolId = written[0]!.id;

    // Simulate an upstream rate-limit response carrying retryAfter=5.
    child.pushStdoutLine({
      jsonrpc: "2.0",
      id: poolId,
      error: { code: -32000, message: "429 rate limited", data: { retryAfter: 5 } },
    });
    await new Promise((r) => setImmediate(r));

    const status = broker.getPoolStatus()[0]!;
    expect(status.throttleEvents24h).toBe(1);
    expect(status.lastRetryAfterSec).toBe(5);

    const throttleLog = cap.lines().find(
      (l) =>
        l.component === "mcp-broker" &&
        typeof l.msg === "string" &&
        l.msg.includes("throttle response from pool child"),
    );
    expect(throttleLog).toBeDefined();
    expect(throttleLog!.retryAfterSec).toBe(5);
    expect(throttleLog!.tool).toBe("password_read");
  });

  it("non-throttle errors do NOT increment throttleEvents24h", async () => {
    const { spawnFn, spawned } = makeSpawnFn();
    const broker = new OnePasswordMcpBroker({ log: cap.log, spawnFn });
    const a = makeAgentConn("agent-a", "tokenA01", TEST_TOKEN_LITERAL);
    await broker.acceptConnection(a);

    await broker.handleAgentMessage(a, {
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: { name: "password_read" },
    });
    const child = spawned[0]!;
    const written = child.consumeStdinJson() as Array<{ id: number }>;
    child.pushStdoutLine({
      jsonrpc: "2.0",
      id: written[0]!.id,
      error: { code: -32602, message: "Invalid params" },
    });
    await new Promise((r) => setImmediate(r));

    const status = broker.getPoolStatus()[0]!;
    expect(status.throttleEvents24h).toBe(0);
    expect(status.lastRetryAfterSec).toBeNull();
  });

  it("throttle log line never contains the literal token (SEC-07)", async () => {
    const { spawnFn, spawned } = makeSpawnFn();
    const broker = new OnePasswordMcpBroker({ log: cap.log, spawnFn });
    const a = makeAgentConn("agent-a", "tokenA01", TEST_TOKEN_LITERAL);
    await broker.acceptConnection(a);

    await broker.handleAgentMessage(a, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "password_read" },
    });
    const child = spawned[0]!;
    const written = child.consumeStdinJson() as Array<{ id: number }>;
    child.pushStdoutLine({
      jsonrpc: "2.0",
      id: written[0]!.id,
      error: {
        code: -32000,
        message: "rate limit exceeded",
        data: { retryAfter: 2 },
      },
    });
    await new Promise((r) => setImmediate(r));

    const raw = cap.raw();
    expect(raw).not.toContain(TEST_TOKEN_LITERAL);
    expect(raw).not.toMatch(/ops_[A-Z0-9_]/);
  });
});
