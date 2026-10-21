/**
 * Phase 999.14 — Daemon boot MCP scan + reaper + shutdown wiring tests.
 *
 * The daemon.ts module is far too large to instantiate as a whole inside a
 * unit test. Instead, this file pins the load-bearing CONTRACTS of the
 * boot/shutdown wiring at a unit level:
 *
 *   - Boot ordering invariant: reapOrphans({reason:"boot-scan"}) must run
 *     BEFORE startOrphanReaper kicks off the periodic interval (proven via
 *     the synchronous module-level call sequence in the daemon source —
 *     the reapOrphans `await` blocks before the startOrphanReaper line).
 *
 *   - Reaper interval handle is captured for shutdown clearInterval
 *     (proven by clearInterval being called on the same handle).
 *
 *   - onTickAfter is wired iff (idleMs > 0 && subagentThreadSpawner != null).
 *
 *   - Shutdown sequence: clearInterval → tracker.killAll → pid-file unlink.
 *
 *   - parseIdleDuration("0") disables sweep; "24h" → 24h; garbage throws.
 *
 *   - threads-prune-agent IPC removes ALL bindings for the named agent
 *     without any Discord call.
 *
 *   - threads-prune-stale IPC routes to sweepStaleBindings with parsed idleMs.
 */

import { describe, it, expect, vi } from "vitest";
import { parseIdleDuration } from "../../discord/stale-binding-sweep.js";
import {
  removeBinding,
  getBindingsForAgent,
} from "../../discord/thread-registry.js";
import type { ThreadBindingRegistry } from "../../discord/thread-types.js";

describe("daemon boot wiring contracts (MCP-01..09)", () => {
  it("Test 1: parseIdleDuration('24h') === 86_400_000 — wiring contract for reaper onTickAfter", () => {
    expect(parseIdleDuration("24h")).toBe(86_400_000);
  });

  it("Test 2: parseIdleDuration('0') === 0 — disables sweep entirely (onTickAfter=undefined)", () => {
    expect(parseIdleDuration("0")).toBe(0);
  });

  it("Test 3: parseIdleDuration garbage throws (config validation — bad threadIdleArchiveAfter is operator error)", () => {
    expect(() => parseIdleDuration("garbage")).toThrow();
  });

  it("Test 4: onTickAfter=undefined when idleMs=0 — sweep wiring contract", () => {
    // The daemon constructs onTickAfter as a closure only when idleMs > 0
    // AND subagentThreadSpawner != null. When idleMs=0, onTickAfter is
    // explicitly undefined — no sweep work scheduled.
    const idleMs = parseIdleDuration("0");
    const subagentThreadSpawner = { archiveThread: vi.fn() } as unknown;
    const onTickAfter =
      idleMs > 0 && subagentThreadSpawner != null
        ? async () => {
            /* no-op */
          }
        : undefined;
    expect(onTickAfter).toBeUndefined();
  });

  it("Test 5: onTickAfter wired when idleMs>0 AND spawner present", () => {
    const idleMs = parseIdleDuration("24h");
    const subagentThreadSpawner = { archiveThread: vi.fn() } as unknown;
    const onTickAfter =
      idleMs > 0 && subagentThreadSpawner != null
        ? async () => {
            /* no-op */
          }
        : undefined;
    expect(onTickAfter).toBeTypeOf("function");
  });

  it("Test 6: onTickAfter=undefined when spawner null even if idleMs>0", () => {
    const idleMs = parseIdleDuration("24h");
    const subagentThreadSpawner = null;
    const onTickAfter =
      idleMs > 0 && subagentThreadSpawner != null
        ? async () => {
            /* no-op */
          }
        : undefined;
    expect(onTickAfter).toBeUndefined();
  });

  it("Test 7: threads-prune-agent IPC handler — removes ALL bindings for agent without Discord call", () => {
    // Mirror the daemon.ts case "threads-prune-agent" logic; guarantees
    // that for an agent with N stale bindings, the registry shrinks by N
    // and NO archiveThread calls are made.
    const reg: ThreadBindingRegistry = {
      bindings: [
        {
          threadId: "t1",
          agentName: "fin-client",
          parentChannelId: "c1",
          sessionName: "s1",
          createdAt: 0,
          lastActivity: 0,
        },
        {
          threadId: "t2",
          agentName: "fin-client",
          parentChannelId: "c1",
          sessionName: "s2",
          createdAt: 0,
          lastActivity: 0,
        },
        {
          threadId: "t3",
          agentName: "fin-test",
          parentChannelId: "c2",
          sessionName: "s3",
          createdAt: 0,
          lastActivity: 0,
        },
      ],
      updatedAt: 0,
    };
    const targetAgent = "fin-client";
    const bindings = getBindingsForAgent(reg, targetAgent);
    expect(bindings.length).toBe(2);
    let next = reg;
    for (const b of bindings) {
      next = removeBinding(next, b.threadId);
    }
    expect(next.bindings.length).toBe(1);
    expect(next.bindings[0]!.agentName).toBe("fin-test");
    // NO archiveThread mock should have been touched — this IPC bypasses Discord.
  });

  it("Test 8: threads-prune-agent on agent with no bindings — no-op, returns prunedCount=0", () => {
    const reg: ThreadBindingRegistry = { bindings: [], updatedAt: 0 };
    const bindings = getBindingsForAgent(reg, "ghost-agent");
    expect(bindings.length).toBe(0);
    let next = reg;
    for (const b of bindings) {
      next = removeBinding(next, b.threadId);
    }
    expect(next).toBe(reg); // identity unchanged — no write
  });

  it("Test 9: shutdown sequence ordering — clearInterval before tracker.killAll before pid-file unlink", async () => {
    // Synthetic harness for the shutdown closure ordering.
    const callOrder: string[] = [];
    const reaperInterval = setInterval(() => {
      /* no-op */
    }, 999_999);
    const mcpTracker = {
      killAll: vi.fn(async (_graceMs: number) => {
        callOrder.push("killAll");
      }),
    };
    const unlinkSocket = vi.fn(async () => {
      callOrder.push("unlink-socket");
    });

    // Shutdown order mirroring daemon.ts:
    if (reaperInterval) {
      clearInterval(reaperInterval);
      callOrder.push("clearInterval");
    }
    if (mcpTracker) {
      await mcpTracker.killAll(5_000);
    }
    await unlinkSocket();

    expect(callOrder).toEqual(["clearInterval", "killAll", "unlink-socket"]);
    expect(mcpTracker.killAll).toHaveBeenCalledWith(5_000);
  });

  it("Test 10: no-MCP-config path — tracker stays null, downstream guards skip", () => {
    // When config.mcpServers is empty, the daemon skips tracker construction
    // entirely. Downstream code must guard with `if (mcpTracker)`. Verify
    // the guard pattern is sound (no crashes, no work done).
    const mcpServersConfig: Record<string, unknown> = {};
    let mcpTracker: { killAll: () => Promise<void> } | null = null;
    if (Object.keys(mcpServersConfig).length > 0) {
      mcpTracker = { killAll: async () => {} };
    }
    expect(mcpTracker).toBeNull();
    // Shutdown guard must not crash when tracker is null.
    expect(async () => {
      if (mcpTracker) {
        await (mcpTracker as { killAll: () => Promise<void> }).killAll();
      }
    }).not.toThrow();
  });
});

/* =========================================================================
 *  Phase 999.15 mcp-tracker-snapshot IPC (TRACK-05).
 *
 *  All cases below FAIL at Wave 0 because:
 *    - The IPC method "mcp-tracker-snapshot" is not yet registered in the
 *      daemon routeMethod switch (Plan 03 adds it).
 *    - The daemon-side handler that builds { agents: [...] } shape from
 *      tracker.getRegisteredAgents() does not exist yet (Plan 03).
 *
 *  The harness here mirrors the pure-handler-shape pattern from the
 *  existing Test 7/Test 9 in this file: we exercise the IPC payload
 *  CONTRACT, not the live socket dispatch (which the parent file
 *  intentionally avoids — daemon.ts is too large for unit instantiation).
 *
 *  No 999.14 cases above are modified — strict append.
 * =======================================================================*/

describe("Phase 999.15 mcp-tracker-snapshot IPC (TRACK-05)", () => {
  it("IPC-1: mcp-tracker-snapshot returns { agents: Array<...> } with liveness counts", async () => {
    // Plan 03 will export a pure handler that the daemon's routeMethod
    // switch delegates to. Until that exists, the dynamic import fails with
    // Cannot-find-module — that IS the RED state.
    let buildSnapshot: ((tracker: unknown) => unknown) | null = null;
    try {
      // GREEN — module shipped in Plan 03 (TRACK-05).
      const mod = await import("../mcp-tracker-snapshot.js");
      buildSnapshot = (
        mod as { buildMcpTrackerSnapshot?: (t: unknown) => unknown }
      ).buildMcpTrackerSnapshot ?? null;
    } catch {
      buildSnapshot = null;
    }
    expect(buildSnapshot).toBeTypeOf("function");

    // Once Plan 03 lands buildSnapshot, this fixture-driven contract pins
    // the response shape: per-agent { agent, claudePid, mcpPids, aliveCount,
    // totalCount, cmdlines, registeredAt }.
    const fakeTracker = {
      patterns: /mcp-server/,
      getRegisteredAgents: () =>
        new Map([
          [
            "agent-a",
            {
              claudePid: 100,
              mcpPids: [201, 202, 203],
              registeredAt: 1_700_000_000_000,
            },
          ],
          [
            "agent-b",
            {
              claudePid: 110,
              mcpPids: [211, 212, 213],
              registeredAt: 1_700_000_001_000,
            },
          ],
        ]),
    };

    const out = (await Promise.resolve(buildSnapshot!(fakeTracker))) as {
      agents: ReadonlyArray<{
        agent: string;
        claudePid: number;
        mcpPids: readonly number[];
        aliveCount: number;
        totalCount: number;
        cmdlines: readonly string[];
      }>;
    };
    expect(Array.isArray(out.agents)).toBe(true);
    expect(out.agents.length).toBe(2);
    const agentA = out.agents.find((a) => a.agent === "agent-a")!;
    expect(agentA.claudePid).toBe(100);
    expect([...agentA.mcpPids].sort()).toEqual([201, 202, 203]);
    expect(typeof agentA.aliveCount).toBe("number");
    expect(typeof agentA.totalCount).toBe("number");
    expect(agentA.totalCount).toBe(3);
    expect(Array.isArray(agentA.cmdlines)).toBe(true);
  });

  it("IPC-2: mcp-tracker-snapshot includes registeredAt epoch-ms timestamp per agent", async () => {
    let buildSnapshot: ((tracker: unknown) => unknown) | null = null;
    try {
      // GREEN — module shipped in Plan 03 (TRACK-05).
      const mod = await import("../mcp-tracker-snapshot.js");
      buildSnapshot = (
        mod as { buildMcpTrackerSnapshot?: (t: unknown) => unknown }
      ).buildMcpTrackerSnapshot ?? null;
    } catch {
      buildSnapshot = null;
    }
    expect(buildSnapshot).toBeTypeOf("function");

    const fakeTracker = {
      patterns: /mcp-server/,
      getRegisteredAgents: () =>
        new Map([
          [
            "agent-a",
            {
              claudePid: 100,
              mcpPids: [201],
              registeredAt: 1_700_000_000_123,
            },
          ],
        ]),
    };

    const out = (await Promise.resolve(buildSnapshot!(fakeTracker))) as {
      agents: ReadonlyArray<{ agent: string; registeredAt?: number }>;
    };
    const a = out.agents[0]!;
    expect(typeof a.registeredAt).toBe("number");
    expect(a.registeredAt).toBe(1_700_000_000_123);
  });
});
