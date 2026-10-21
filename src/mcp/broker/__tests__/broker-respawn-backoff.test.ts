/**
 * Phase 999.106 QW-3 — pool-child respawn backoff + circuit breaker.
 *
 * Incident being pinned (2026-08-14): the broker respawned its pooled
 * `@takescake/1password-mcp` child from the child's own 'exit' listener
 * with no delay and no cap. A child that booted-then-died (1P 429 / auth
 * failure) respawned as fast as the spawn could fork — production showed
 * 44 overlapping npx process trees, none older than ~52min against a 4.6h
 * daemon, while `respawnCount` sat there as a logging-only counter.
 *
 * Contract pinned here:
 *   - a one-off crash of a healthy child still respawns IMMEDIATELY (no
 *     added latency, and the INC-2026-07-27 synchronous teardown holds);
 *   - consecutive fast exits back off exponentially (1s, 2s, 4s … capped);
 *   - a child that outlives RESPAWN_FAST_EXIT_MS resets the schedule;
 *   - RESPAWN_BREAKER_THRESHOLD fast exits inside the window OPEN the
 *     breaker: respawns stop, requests fail fast, one half-open probe is
 *     allowed after the cooldown;
 *   - a failed probe re-opens; a healthy probe closes;
 *   - no armed timer can spawn a child after the pool drains or the
 *     daemon shuts down.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Writable } from "node:stream";
import pino from "pino";

import { FakePooledChild } from "../../../../tests/__fakes__/fake-pooled-child.js";

import {
  OnePasswordMcpBroker,
  respawnBackoffMs,
  RESPAWN_BACKOFF_BASE_MS,
  RESPAWN_BACKOFF_MAX_MS,
  RESPAWN_FAST_EXIT_MS,
  RESPAWN_BREAKER_THRESHOLD,
  RESPAWN_BREAKER_COOLDOWN_MS,
  BROKER_ERROR_CODE_POOL_UNAVAILABLE,
  type BrokerAgentConnection,
  type BrokerSpawnFn,
} from "../broker.js";

const TEST_TOKEN_LITERAL = "ops_TESTTOKEN_FAKE_XYZ";
const TEST_HASH = "tokenA01";

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

function makeSpawnFn(): { spawnFn: BrokerSpawnFn; spawned: FakePooledChild[] } {
  const spawned: FakePooledChild[] = [];
  const spawnFn: BrokerSpawnFn = (_args) => {
    const child = new FakePooledChild();
    spawned.push(child);
    return child as unknown as import("node:child_process").ChildProcess;
  };
  return { spawnFn, spawned };
}

function makeAgentConn(
  agentName: string,
  tokenHash: string,
  rawToken: string,
): BrokerAgentConnection & {
  received: Array<Record<string, unknown>>;
  triggerClose: () => void;
} {
  const received: Array<Record<string, unknown>> = [];
  const closeListeners: Array<() => void> = [];
  const conn: BrokerAgentConnection = {
    agentName,
    tokenHash,
    rawToken,
    send(msg) {
      received.push(msg as Record<string, unknown>);
    },
    onClose(fn) {
      closeListeners.push(fn);
    },
  };
  return Object.assign(conn, {
    received,
    triggerClose: () => {
      for (const fn of closeListeners) fn();
    },
  });
}

/** Kill the newest child instantly — models a child that never booted. */
function crashNewest(spawned: FakePooledChild[]): void {
  spawned[spawned.length - 1]!.simulateExit(1);
}

/**
 * Drive RESPAWN_BREAKER_THRESHOLD consecutive fast exits, walking the
 * backoff timer between them. Leaves the breaker OPEN with exactly
 * RESPAWN_BREAKER_THRESHOLD children ever spawned, and the clock parked
 * ON the instant the breaker opened — the final exit arms the cooldown
 * probe, not a backoff timer, so callers measure the cooldown from here.
 */
async function tripBreaker(spawned: FakePooledChild[]): Promise<void> {
  for (let n = 1; n <= RESPAWN_BREAKER_THRESHOLD; n++) {
    crashNewest(spawned);
    if (n === RESPAWN_BREAKER_THRESHOLD) break;
    await vi.advanceTimersByTimeAsync(respawnBackoffMs(n));
  }
}

describe("respawnBackoffMs — the schedule itself", () => {
  it("is immediate for a healthy exit and for the first fast exit", () => {
    expect(respawnBackoffMs(0)).toBe(0);
    expect(respawnBackoffMs(1)).toBe(0);
  });

  it("doubles from the second consecutive fast exit onward", () => {
    expect(respawnBackoffMs(2)).toBe(RESPAWN_BACKOFF_BASE_MS);
    expect(respawnBackoffMs(3)).toBe(RESPAWN_BACKOFF_BASE_MS * 2);
    expect(respawnBackoffMs(4)).toBe(RESPAWN_BACKOFF_BASE_MS * 4);
    expect(respawnBackoffMs(5)).toBe(RESPAWN_BACKOFF_BASE_MS * 8);
    expect(respawnBackoffMs(6)).toBe(RESPAWN_BACKOFF_BASE_MS * 16);
  });

  it("saturates at RESPAWN_BACKOFF_MAX_MS and never overflows", () => {
    expect(respawnBackoffMs(20)).toBe(RESPAWN_BACKOFF_MAX_MS);
    expect(respawnBackoffMs(2000)).toBe(RESPAWN_BACKOFF_MAX_MS);
    expect(Number.isFinite(respawnBackoffMs(2000))).toBe(true);
  });
});

describe("Broker — respawn backoff on consecutive fast exits", () => {
  let cap: CapturedLog;
  beforeEach(() => {
    cap = captureLogger();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("a crash of a long-lived child still respawns immediately", async () => {
    const { spawnFn, spawned } = makeSpawnFn();
    const broker = new OnePasswordMcpBroker({ log: cap.log, spawnFn });
    const a = makeAgentConn("agent-a", TEST_HASH, TEST_TOKEN_LITERAL);
    await broker.acceptConnection(a);

    // The child proves itself, THEN dies.
    await vi.advanceTimersByTimeAsync(RESPAWN_FAST_EXIT_MS + 1);
    crashNewest(spawned);

    // Synchronous — no timer had to fire for the pool to come back.
    expect(spawned).toHaveLength(2);
    expect(broker.getPoolStatus()[0]!.alive).toBe(true);
    expect(broker.getPoolStatus()[0]!.consecutiveFastExits).toBe(0);
  });

  it("the FIRST fast exit still respawns immediately (one exit is not a loop)", async () => {
    const { spawnFn, spawned } = makeSpawnFn();
    const broker = new OnePasswordMcpBroker({ log: cap.log, spawnFn });
    await broker.acceptConnection(
      makeAgentConn("agent-a", TEST_HASH, TEST_TOKEN_LITERAL),
    );

    crashNewest(spawned);

    expect(spawned).toHaveLength(2);
    expect(broker.getPoolStatus()[0]!.consecutiveFastExits).toBe(1);
  });

  it("the SECOND consecutive fast exit is deferred by the base delay", async () => {
    const { spawnFn, spawned } = makeSpawnFn();
    const broker = new OnePasswordMcpBroker({ log: cap.log, spawnFn });
    await broker.acceptConnection(
      makeAgentConn("agent-a", TEST_HASH, TEST_TOKEN_LITERAL),
    );

    crashNewest(spawned); // #1 → immediate
    expect(spawned).toHaveLength(2);

    crashNewest(spawned); // #2 → deferred
    expect(spawned).toHaveLength(2); // NOT respawned inside the exit listener
    expect(broker.getPoolStatus()[0]!.alive).toBe(false);

    await vi.advanceTimersByTimeAsync(RESPAWN_BACKOFF_BASE_MS - 1);
    expect(spawned).toHaveLength(2);

    await vi.advanceTimersByTimeAsync(1);
    expect(spawned).toHaveLength(3);
    expect(broker.getPoolStatus()[0]!.alive).toBe(true);
  });

  it("the delay doubles on each additional consecutive fast exit", async () => {
    const { spawnFn, spawned } = makeSpawnFn();
    const broker = new OnePasswordMcpBroker({ log: cap.log, spawnFn });
    await broker.acceptConnection(
      makeAgentConn("agent-a", TEST_HASH, TEST_TOKEN_LITERAL),
    );

    crashNewest(spawned); // #1 → 0ms
    expect(spawned).toHaveLength(2);

    for (const [n, expectedDelay] of [
      [2, RESPAWN_BACKOFF_BASE_MS],
      [3, RESPAWN_BACKOFF_BASE_MS * 2],
      [4, RESPAWN_BACKOFF_BASE_MS * 4],
    ] as const) {
      const before = spawned.length;
      crashNewest(spawned);
      await vi.advanceTimersByTimeAsync(expectedDelay - 1);
      expect(spawned, `fast exit #${n} respawned early`).toHaveLength(before);
      await vi.advanceTimersByTimeAsync(1);
      expect(spawned, `fast exit #${n} never respawned`).toHaveLength(before + 1);
    }
  });

  it("a child that outlives the fast-exit window resets the schedule", async () => {
    const { spawnFn, spawned } = makeSpawnFn();
    const broker = new OnePasswordMcpBroker({ log: cap.log, spawnFn });
    await broker.acceptConnection(
      makeAgentConn("agent-a", TEST_HASH, TEST_TOKEN_LITERAL),
    );

    // Two fast exits — the schedule is now backing off.
    crashNewest(spawned);
    crashNewest(spawned);
    await vi.advanceTimersByTimeAsync(RESPAWN_BACKOFF_BASE_MS);
    expect(spawned).toHaveLength(3);
    expect(broker.getPoolStatus()[0]!.consecutiveFastExits).toBe(2);

    // This child boots and serves for longer than the fast-exit window.
    await vi.advanceTimersByTimeAsync(RESPAWN_FAST_EXIT_MS + 1);
    crashNewest(spawned);

    // Counter cleared AND the respawn was immediate again.
    expect(spawned).toHaveLength(4);
    expect(broker.getPoolStatus()[0]!.consecutiveFastExits).toBe(0);
  });

  it("queued requests are failed, not parked, when a respawn is deferred", async () => {
    const { spawnFn, spawned } = makeSpawnFn();
    const broker = new OnePasswordMcpBroker({ log: cap.log, spawnFn });
    const a = makeAgentConn("agent-a", TEST_HASH, TEST_TOKEN_LITERAL);
    await broker.acceptConnection(a);

    crashNewest(spawned); // #1 → immediate respawn, pool healthy again
    expect(spawned).toHaveLength(2);

    // Saturate the per-agent semaphore (4) and queue a 5th.
    for (let i = 1; i <= 5; i++) {
      await broker.handleAgentMessage(a, {
        jsonrpc: "2.0",
        id: i,
        method: "tools/call",
        params: { name: "password_read" },
      });
    }
    expect(broker.getPoolStatus()[0]!.queueDepth).toBe(1);

    crashNewest(spawned); // #2 → deferred; the queue must not wait for it

    expect(broker.getPoolStatus()[0]!.queueDepth).toBe(0);
    const queuedReply = a.received.find((m) => m.id === 5)!;
    expect(queuedReply).toBeDefined();
    expect((queuedReply.error as { code: number }).code).toBe(
      BROKER_ERROR_CODE_POOL_UNAVAILABLE,
    );
    // The 4 inflight were failed too — nobody is left hanging.
    expect(a.received).toHaveLength(5);
  });
});

describe("Broker — respawn circuit breaker", () => {
  let cap: CapturedLog;
  beforeEach(() => {
    cap = captureLogger();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  async function attachedBroker(): Promise<{
    broker: OnePasswordMcpBroker;
    spawned: FakePooledChild[];
    agent: ReturnType<typeof makeAgentConn>;
  }> {
    const { spawnFn, spawned } = makeSpawnFn();
    const broker = new OnePasswordMcpBroker({ log: cap.log, spawnFn });
    const agent = makeAgentConn("agent-a", TEST_HASH, TEST_TOKEN_LITERAL);
    await broker.acceptConnection(agent);
    return { broker, spawned, agent };
  }

  it("opens after THRESHOLD fast exits in the window and stops respawning", async () => {
    const { broker, spawned } = await attachedBroker();

    await tripBreaker(spawned);

    expect(spawned).toHaveLength(RESPAWN_BREAKER_THRESHOLD);
    const status = broker.getPoolStatus()[0]!;
    expect(status.breakerOpen).toBe(true);
    expect(status.alive).toBe(false);
    expect(status.consecutiveFastExits).toBe(RESPAWN_BREAKER_THRESHOLD);

    // Nothing is respawned for the whole cooldown, however long we wait.
    await vi.advanceTimersByTimeAsync(RESPAWN_BREAKER_COOLDOWN_MS - 1);
    expect(spawned).toHaveLength(RESPAWN_BREAKER_THRESHOLD);
  });

  it("emits one structured warn line carrying tokenHash when it opens", async () => {
    const { spawned } = await attachedBroker();
    await tripBreaker(spawned);

    const opened = cap
      .lines()
      .filter((l) => String(l.msg).includes("breaker OPEN"));
    expect(opened).toHaveLength(1);
    const line = opened[0]!;
    expect(line.level).toBe(40); // pino warn
    expect(line.component).toBe("mcp-broker");
    expect(line.pool).toBe(`1password-mcp:${TEST_HASH}`);
    expect(line.tokenHash).toBe(TEST_HASH);
    expect(line.consecutiveFastExits).toBe(RESPAWN_BREAKER_THRESHOLD);
    expect(line.cooldownMs).toBe(RESPAWN_BREAKER_COOLDOWN_MS);
  });

  it("fails requests fast while open instead of writing to the dead child", async () => {
    const { broker, spawned, agent } = await attachedBroker();
    await tripBreaker(spawned);

    await broker.handleAgentMessage(agent, {
      jsonrpc: "2.0",
      id: 99,
      method: "tools/call",
      params: { name: "password_read" },
    });

    expect(agent.received).toHaveLength(1);
    const reply = agent.received[0]!;
    expect(reply.id).toBe(99);
    expect((reply.error as { code: number }).code).toBe(
      BROKER_ERROR_CODE_POOL_UNAVAILABLE,
    );
    // The dead child never saw the write.
    expect(spawned[spawned.length - 1]!.consumeStdinJson()).toHaveLength(0);
  });

  it("a reconnecting agent during the cooldown does NOT spawn a child", async () => {
    // The churn vector this whole QW exists to close: the SDK reconnect
    // loop attaches every few seconds. If `acceptConnection` spawned on a
    // breaker-open pool, the reconnect loop would simply become the
    // respawn loop under another name.
    const { broker, spawned } = await attachedBroker();
    await tripBreaker(spawned);

    for (let i = 0; i < 5; i++) {
      await broker.acceptConnection(
        makeAgentConn(`agent-reconnect-${i}`, TEST_HASH, TEST_TOKEN_LITERAL),
      );
    }

    expect(spawned).toHaveLength(RESPAWN_BREAKER_THRESHOLD);
    expect(broker.getPoolStatus()[0]!.breakerOpen).toBe(true);
  });

  it("allows exactly ONE half-open probe after the cooldown", async () => {
    const { broker, spawned } = await attachedBroker();
    await tripBreaker(spawned);

    await vi.advanceTimersByTimeAsync(RESPAWN_BREAKER_COOLDOWN_MS);

    expect(spawned).toHaveLength(RESPAWN_BREAKER_THRESHOLD + 1);
    const status = broker.getPoolStatus()[0]!;
    // A probe that is serving traffic is not "open" — the pool is usable.
    expect(status.breakerOpen).toBe(false);
    expect(status.alive).toBe(true);
  });

  it("a probe that dies fast re-opens the breaker for another cooldown", async () => {
    const { broker, spawned } = await attachedBroker();
    await tripBreaker(spawned);
    await vi.advanceTimersByTimeAsync(RESPAWN_BREAKER_COOLDOWN_MS);
    const afterProbe = spawned.length;

    // The probe fails. Note the fast-exit WINDOW has long since emptied
    // (cooldown 15m > window 10m) — only the half-open state can re-open.
    crashNewest(spawned);

    expect(spawned).toHaveLength(afterProbe);
    expect(broker.getPoolStatus()[0]!.breakerOpen).toBe(true);

    await vi.advanceTimersByTimeAsync(RESPAWN_BREAKER_COOLDOWN_MS - 1);
    expect(spawned).toHaveLength(afterProbe);
    await vi.advanceTimersByTimeAsync(1);
    expect(spawned).toHaveLength(afterProbe + 1);
  });

  it("a healthy probe closes the breaker and restores immediate respawn", async () => {
    const { broker, spawned } = await attachedBroker();
    await tripBreaker(spawned);
    await vi.advanceTimersByTimeAsync(RESPAWN_BREAKER_COOLDOWN_MS);
    const afterProbe = spawned.length;

    // The probe boots and serves past the fast-exit window, then dies.
    await vi.advanceTimersByTimeAsync(RESPAWN_FAST_EXIT_MS + 1);
    crashNewest(spawned);

    // Breaker closed: the crash respawned immediately, counters cleared.
    expect(spawned).toHaveLength(afterProbe + 1);
    const status = broker.getPoolStatus()[0]!;
    expect(status.breakerOpen).toBe(false);
    expect(status.consecutiveFastExits).toBe(0);
    expect(status.alive).toBe(true);
  });

  it("no probe fires after the last agent disconnects", async () => {
    const { broker, spawned, agent } = await attachedBroker();
    await tripBreaker(spawned);

    agent.triggerClose(); // refCount → 0, pool drains and is dropped
    await vi.advanceTimersByTimeAsync(RESPAWN_BREAKER_COOLDOWN_MS * 2);

    expect(spawned).toHaveLength(RESPAWN_BREAKER_THRESHOLD);
    expect(broker.getPoolStatus()).toEqual([]);
  });

  it("no probe fires after the broker shuts down", async () => {
    const { broker, spawned } = await attachedBroker();
    await tripBreaker(spawned);

    await broker.shutdown(0);
    await vi.advanceTimersByTimeAsync(RESPAWN_BREAKER_COOLDOWN_MS * 2);

    // An armed 15-minute probe must never outlive the daemon that owns it.
    expect(spawned).toHaveLength(RESPAWN_BREAKER_THRESHOLD);
  });

  it("breaker log lines never contain the literal token (SEC-07)", async () => {
    const { spawned } = await attachedBroker();
    await tripBreaker(spawned);
    await vi.advanceTimersByTimeAsync(RESPAWN_BREAKER_COOLDOWN_MS);

    const raw = cap.raw();
    expect(raw).not.toContain(TEST_TOKEN_LITERAL);
    expect(raw).not.toMatch(/ops_[A-Z0-9_]/);
    expect(raw).toContain(TEST_HASH);
  });
});

describe("Broker — drain rescued mid-backoff re-arms the respawn (review fix)", () => {
  let cap: CapturedLog;
  beforeEach(() => {
    cap = captureLogger();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("a reconnect that cancels a drain re-arms the dropped respawn timer — no permanent zombie pool", async () => {
    const { spawnFn, spawned } = makeSpawnFn();
    const broker = new OnePasswordMcpBroker({ log: cap.log, spawnFn });
    const a = makeAgentConn("agent-a", TEST_HASH, TEST_TOKEN_LITERAL);
    await broker.acceptConnection(a);

    crashNewest(spawned); // #1 → immediate respawn (child 2)
    expect(spawned).toHaveLength(2);
    crashNewest(spawned); // #2 → deferred: respawnTimer fires at T+BASE
    expect(broker.getPoolStatus()[0]!.alive).toBe(false);

    // Offset the drain so its timer fires AFTER the respawn timer.
    await vi.advanceTimersByTimeAsync(RESPAWN_BACKOFF_BASE_MS / 2);
    a.triggerClose(); // refCount → 0, drain armed for T+BASE/2+drainDelay

    // The respawn timer fires INSIDE the drain window → dropped by
    // isPoolRespawnable (draining=true). No child spawns.
    await vi.advanceTimersByTimeAsync(RESPAWN_BACKOFF_BASE_MS / 2);
    expect(spawned).toHaveLength(2);

    // A reconnect rescues the drain before its timer fires. Pre-fix the
    // pool was now a permanent zombie: alive=false, no respawnTimer, no
    // breakerTimer — every request failing fast until daemon restart.
    const b = makeAgentConn("agent-b", TEST_HASH, TEST_TOKEN_LITERAL);
    await broker.acceptConnection(b);
    expect(broker.getPoolStatus()).toHaveLength(1); // same pool, not replaced

    // The fix resumes the pool's OWN backoff schedule (consecutive=2 → BASE).
    await vi.advanceTimersByTimeAsync(respawnBackoffMs(2));
    expect(spawned).toHaveLength(3);
    expect(broker.getPoolStatus()[0]!.alive).toBe(true);
  });

  it("a reconnect during an OPEN breaker re-arms the half-open probe, not an immediate spawn", async () => {
    const { spawnFn, spawned } = makeSpawnFn();
    const broker = new OnePasswordMcpBroker({ log: cap.log, spawnFn });
    const a = makeAgentConn("agent-a", TEST_HASH, TEST_TOKEN_LITERAL);
    await broker.acceptConnection(a);
    await tripBreaker(spawned);
    expect(broker.getPoolStatus()[0]!.breakerOpen).toBe(true);

    // The last agent detaches just SHY of the probe instant, so the probe
    // fires inside the (shorter) drain window and is dropped. This is the
    // only reachable shape: any earlier drain completes and deletes the
    // pool long before the 15-min probe.
    await vi.advanceTimersByTimeAsync(RESPAWN_BREAKER_COOLDOWN_MS - 500);
    a.triggerClose(); // drain timer fires 1s from now — after the probe
    await vi.advanceTimersByTimeAsync(500); // probe instant → dropped
    const before = spawned.length;

    // Rescue the drain. Pre-fix: zombie (breaker open, probe gone forever).
    const b = makeAgentConn("agent-b", TEST_HASH, TEST_TOKEN_LITERAL);
    await broker.acceptConnection(b);
    expect(spawned).toHaveLength(before); // no instant spawn — breaker respected

    // The re-armed probe fires after a FULL fresh cooldown.
    await vi.advanceTimersByTimeAsync(RESPAWN_BREAKER_COOLDOWN_MS);
    expect(spawned).toHaveLength(before + 1); // half-open probe child
  });
});
