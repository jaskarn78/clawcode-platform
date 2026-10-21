// RED — Phase 108-00 — Wave 0 scaffolding. Production target: src/heartbeat/checks/mcp-broker.ts.
/**
 * Phase 108 Plan 00 — `mcp-broker` heartbeat check RED tests (POOL-07).
 *
 * Per RESEARCH.md §"Lifecycle Integration Recommendations" §"Heartbeat
 * health check": the check polls broker.getPoolStatus() — it must NOT
 * send any synthetic password_read (would consume rate-limit budget,
 * defeating the whole point of pooling).
 *
 * Status values used (from src/heartbeat/types.ts):
 *   - "healthy"  — every referenced pool has alive=true
 *   - "critical" — any referenced pool has alive=false AND agentRefCount>0
 *
 * Pools with alive=false AND agentRefCount=0 are ignored (they were
 * cleanly drained by the broker; not a pool failure).
 */
import { describe, it, expect, vi } from "vitest";

import type {
  CheckContext,
  CheckResult,
  HeartbeatConfig,
} from "../../types.js";

// Production target — does NOT exist yet.
import mcpBrokerCheck, {
  type BrokerStatusProvider,
  type BrokerPoolStatus,
} from "../mcp-broker.js";

// Minimal HeartbeatConfig stub.
function makeConfig(): HeartbeatConfig {
  return {
    enabled: true,
    intervalSeconds: 60,
    checkTimeoutSeconds: 10,
    contextFill: { warningThreshold: 0.7, criticalThreshold: 0.9 },
  };
}

/**
 * Build a CheckContext with an injected BrokerStatusProvider. The check
 * MUST consume the provider via the context (production wiring exposes
 * it via a deps interface — RED tests pin the shape).
 */
function makeContext(
  pools: BrokerPoolStatus[],
  spy?: { calls: BrokerPoolStatus[][] },
): CheckContext & { brokerStatusProvider: BrokerStatusProvider } {
  const provider: BrokerStatusProvider = {
    getPoolStatus: () => {
      if (spy) spy.calls.push(pools);
      return pools;
    },
  };
  return {
    agentName: "any-agent",
    sessionManager: {} as never,
    registry: {} as never,
    config: makeConfig(),
    brokerStatusProvider: provider,
  };
}

describe("mcpBrokerCheck — module shape", () => {
  it("exports a CheckModule with name='mcp-broker' and a 60s interval", () => {
    expect(mcpBrokerCheck.name).toBe("mcp-broker");
    expect(mcpBrokerCheck.interval).toBe(60);
    expect(typeof mcpBrokerCheck.execute).toBe("function");
  });
});

describe("mcpBrokerCheck — passes when all referenced pools alive", () => {
  it("returns healthy when every pool has alive=true", async () => {
    const ctx = makeContext([
      { tokenHash: "h1", alive: true, agentRefCount: 3, inflightCount: 0, queueDepth: 0, respawnCount24h: 0 },
      { tokenHash: "h2", alive: true, agentRefCount: 1, inflightCount: 0, queueDepth: 0, respawnCount24h: 0 },
    ]);

    const result: CheckResult = await mcpBrokerCheck.execute(ctx);
    expect(result.status).toBe("healthy");
  });

  it("returns healthy when there are zero pools (broker idle, no agents using 1Password yet)", async () => {
    const ctx = makeContext([]);
    const result: CheckResult = await mcpBrokerCheck.execute(ctx);
    expect(result.status).toBe("healthy");
  });
});

describe("mcpBrokerCheck — fails when any referenced pool dead", () => {
  it("returns critical when a pool with agentRefCount>0 has alive=false", async () => {
    const ctx = makeContext([
      { tokenHash: "h1", alive: true, agentRefCount: 2, inflightCount: 0, queueDepth: 0, respawnCount24h: 0 },
      { tokenHash: "h2", alive: false, agentRefCount: 1, inflightCount: 0, queueDepth: 0, respawnCount24h: 4 },
    ]);

    const result: CheckResult = await mcpBrokerCheck.execute(ctx);
    expect(result.status).toBe("critical");
    expect(result.message.toLowerCase()).toContain("h2");
    // Metadata should expose the failing tokenHash.
    expect(result.metadata?.failedPools).toBeDefined();
  });
});

describe("mcpBrokerCheck — ignores dead pools with zero refs", () => {
  it("returns healthy when alive=false coincides with agentRefCount=0 (cleanly drained)", async () => {
    const ctx = makeContext([
      { tokenHash: "h1", alive: false, agentRefCount: 0, inflightCount: 0, queueDepth: 0, respawnCount24h: 0 },
    ]);

    const result: CheckResult = await mcpBrokerCheck.execute(ctx);
    expect(result.status).toBe("healthy");
  });

  it("a mix of (alive,refs>0) + (dead,refs=0) is healthy", async () => {
    const ctx = makeContext([
      { tokenHash: "h1", alive: true, agentRefCount: 3, inflightCount: 0, queueDepth: 0, respawnCount24h: 0 },
      { tokenHash: "h2", alive: false, agentRefCount: 0, inflightCount: 0, queueDepth: 0, respawnCount24h: 0 },
    ]);

    const result: CheckResult = await mcpBrokerCheck.execute(ctx);
    expect(result.status).toBe("healthy");
  });
});

describe("mcpBrokerCheck — does NOT poll 1Password (no synthetic password_read)", () => {
  it("calls only getPoolStatus on the provider; never invokes any tool dispatch path", async () => {
    const calls: BrokerPoolStatus[][] = [];
    const provider: BrokerStatusProvider = {
      getPoolStatus: vi.fn(() => {
        calls.push([]);
        return [];
      }),
    };
    // Explicitly NO dispatch / call-tool method on the provider — the
    // type for BrokerStatusProvider must NOT include one. (If a future
    // PR adds dispatch to the provider for unrelated reasons, this test
    // still gates by asserting only getPoolStatus is invoked.)
    const ctx: CheckContext & { brokerStatusProvider: BrokerStatusProvider } = {
      agentName: "any-agent",
      sessionManager: {} as never,
      registry: {} as never,
      config: makeConfig(),
      brokerStatusProvider: provider,
    };

    await mcpBrokerCheck.execute(ctx);
    expect(provider.getPoolStatus).toHaveBeenCalled();

    // Type-level assertion: BrokerStatusProvider MUST NOT expose a
    // dispatch/callTool/sendRequest method. (If you find yourself
    // adding one, stop and rethink — the heartbeat must not consume
    // 1Password rate-limit budget.)
    const providerKeys = Object.keys(provider);
    expect(providerKeys).toEqual(["getPoolStatus"]);
  });
});
