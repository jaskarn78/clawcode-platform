/**
 * Phase 138 Plan 05 T-04 — `evaluateFailoverDecisions` pure-function
 * state machine + `FailoverController` I/O wrapper tests.
 *
 * The pure function is zero-I/O / zero-SQL — the full state space is
 * exercised here without SQLite or cron. The controller wraps it with
 * I/O glue (read SQL state → evaluate → apply decisions + fire alerts).
 *
 * See:
 *   - `.planning/phases/138-.../138-05-PLAN.md` T-04
 *   - `src/manager/failover-controller.ts`
 */

import { describe, it, expect, vi } from "vitest";
import {
  evaluateFailoverDecisions,
  FailoverController,
  type EvaluateInput,
  type FailoverControllerDeps,
} from "../failover-controller.js";
import type { LlmRuntimeBackend } from "../../llm-runtime/types.js";
import type { FailoverRow } from "../../usage/failover-state.js";

/** Next UTC midnight after a millis instant (mirror of the impl helper). */
function nextUtcMidnight(now: number): number {
  const d = new Date(now);
  return Date.UTC(
    d.getUTCFullYear(),
    d.getUTCMonth(),
    d.getUTCDate() + 1,
    0,
    0,
    0,
    0,
  );
}

/** Build an EvaluateInput with sensible empty defaults. */
function input(over: Partial<EvaluateInput>): EvaluateInput {
  return {
    saturatedProviders: new Set(),
    agents: [],
    currentFailoverState: new Map(),
    now: Date.UTC(2026, 4, 20, 12, 0, 0),
    ...over,
  };
}

function agent(
  name: string,
  backend: LlmRuntimeBackend,
  failoverChain: readonly LlmRuntimeBackend[],
) {
  return { name, backend, failoverChain };
}

describe("evaluateFailoverDecisions — pure state machine", () => {
  it("(a) no saturated providers → empty decisions", () => {
    const out = evaluateFailoverDecisions(
      input({
        agents: [agent("clawdy", "anthropic-agent-sdk", ["codex-cli"])],
      }),
    );
    expect(out.decisions).toEqual([]);
    expect(out.expiredAgents).toEqual([]);
  });

  it("(b) anthropic saturated + agent on anthropic with chain → 1 decision", () => {
    const out = evaluateFailoverDecisions(
      input({
        saturatedProviders: new Set(["anthropic"]),
        agents: [agent("clawdy", "anthropic-agent-sdk", ["codex-cli"])],
      }),
    );
    expect(out.decisions).toHaveLength(1);
    expect(out.decisions[0]).toMatchObject({
      agent: "clawdy",
      fromBackend: "anthropic-agent-sdk",
      toBackend: "codex-cli",
      reason: "threshold-95",
    });
    expect(out.decisions[0]?.expiresAt).toBe(
      nextUtcMidnight(Date.UTC(2026, 4, 20, 12, 0, 0)),
    );
  });

  it("(c) anthropic saturated + agent with EMPTY chain → 0 decisions (warn-only)", () => {
    const out = evaluateFailoverDecisions(
      input({
        saturatedProviders: new Set(["anthropic"]),
        agents: [agent("clawdy", "anthropic-agent-sdk", [])],
      }),
    );
    expect(out.decisions).toEqual([]);
  });

  it("(d) agent already in failover state for the provider → no duplicate", () => {
    const out = evaluateFailoverDecisions(
      input({
        saturatedProviders: new Set(["anthropic"]),
        agents: [agent("clawdy", "anthropic-agent-sdk", ["codex-cli"])],
        currentFailoverState: new Map([
          [
            "clawdy",
            { active_backend: "codex-cli", expires_at: null },
          ],
        ]),
      }),
    );
    expect(out.decisions).toEqual([]);
  });

  it("(e) expired override → emitted in expiredAgents", () => {
    const now = Date.UTC(2026, 4, 20, 12, 0, 0);
    const out = evaluateFailoverDecisions(
      input({
        now,
        currentFailoverState: new Map([
          ["stale", { active_backend: "codex-cli", expires_at: now - 1 }],
          ["fresh", { active_backend: "codex-cli", expires_at: now + 1 }],
          ["manual", { active_backend: "codex-cli", expires_at: null }],
        ]),
      }),
    );
    expect(out.expiredAgents).toEqual(["stale"]);
  });

  it("(f) two agents on the same saturated provider → 2 independent decisions", () => {
    const out = evaluateFailoverDecisions(
      input({
        saturatedProviders: new Set(["anthropic"]),
        agents: [
          agent("clawdy", "anthropic-agent-sdk", ["codex-cli"]),
          agent("client_a", "anthropic-agent-sdk", ["codex-cli"]),
        ],
      }),
    );
    expect(out.decisions.map((d) => d.agent).sort()).toEqual([
      "clawdy",
      "client_a",
    ]);
  });

  it("(g) agent on an unsaturated provider → no decision", () => {
    const out = evaluateFailoverDecisions(
      input({
        saturatedProviders: new Set(["anthropic"]),
        // Agent is on codex-cli (openai) — openai is NOT saturated.
        agents: [agent("client_a", "codex-cli", ["anthropic-agent-sdk"])],
      }),
    );
    expect(out.decisions).toEqual([]);
  });

  it("(h) manual override is never auto-overridden by the threshold-95 path", () => {
    const out = evaluateFailoverDecisions(
      input({
        saturatedProviders: new Set(["anthropic"]),
        agents: [agent("clawdy", "anthropic-agent-sdk", ["codex-cli"])],
        // Manual row (expires_at null) already present.
        currentFailoverState: new Map([
          ["clawdy", { active_backend: "codex-cli", expires_at: null }],
        ]),
      }),
    );
    // No new decision — the agent is already covered by the manual row.
    expect(out.decisions).toEqual([]);
    // And the manual (null-expiry) row is NOT in expiredAgents.
    expect(out.expiredAgents).toEqual([]);
  });

  it("(extra) chain[0] equal to the current backend → no decision", () => {
    const out = evaluateFailoverDecisions(
      input({
        saturatedProviders: new Set(["anthropic"]),
        // Misconfigured chain pointing back at the saturated backend.
        agents: [
          agent("clawdy", "anthropic-agent-sdk", ["anthropic-agent-sdk"]),
        ],
      }),
    );
    expect(out.decisions).toEqual([]);
  });
});

// ────────────────────────────────────────────────────────────────────
// FailoverController — I/O wrapper.
// ────────────────────────────────────────────────────────────────────

/** Minimal in-memory failover-state store double. */
function fakeStore(initial: readonly FailoverRow[] = []) {
  const rows = new Map<string, FailoverRow>();
  for (const r of initial) rows.set(r.agent, r);
  return {
    rows,
    set: vi.fn(
      (
        agent: string,
        backend: LlmRuntimeBackend,
        reason: string,
        expiresAt: number | null = null,
      ) => {
        rows.set(agent, {
          agent,
          active_backend: backend,
          reason,
          triggered_at: 0,
          expires_at: expiresAt,
        });
      },
    ),
    clear: vi.fn((agent: string) => {
      rows.delete(agent);
    }),
    listActive: vi.fn((now: number): readonly FailoverRow[] =>
      [...rows.values()].filter(
        (r) => r.expires_at === null || r.expires_at > now,
      ),
    ),
    listAll: vi.fn((): readonly FailoverRow[] => [...rows.values()]),
  };
}

function controllerDeps(
  over: Partial<FailoverControllerDeps> & {
    store: ReturnType<typeof fakeStore>;
  },
): FailoverControllerDeps {
  return {
    failoverStateStore: over.store,
    readSaturatedProviders: () => new Set(),
    resolveAgents: () => [],
    clock: () => Date.UTC(2026, 4, 20, 12, 0, 0),
    logger: { info: vi.fn(), warn: vi.fn() },
    ...over,
  };
}

describe("FailoverController.tick — I/O wrapper", () => {
  it("(i) reads state, evaluates, applies decisions via store.set", async () => {
    const store = fakeStore();
    const deps = controllerDeps({
      store,
      readSaturatedProviders: () => new Set(["anthropic"]),
      resolveAgents: () => [
        {
          name: "clawdy",
          backend: "anthropic-agent-sdk",
          failoverChain: ["codex-cli"],
        },
      ],
    });
    const controller = new FailoverController(deps);
    await controller.tick();
    expect(store.set).toHaveBeenCalledTimes(1);
    expect(store.set).toHaveBeenCalledWith(
      "clawdy",
      "codex-cli",
      "threshold-95",
      expect.any(Number),
    );
  });

  it("(j) webhook failure is logged, not rethrown — tick still resolves", async () => {
    const store = fakeStore();
    const webhook = {
      send: vi.fn().mockRejectedValue(new Error("discord 500")),
    };
    const logger = { info: vi.fn(), warn: vi.fn() };
    const deps = controllerDeps({
      store,
      logger,
      webhookManager: webhook,
      readSaturatedProviders: () => new Set(["anthropic"]),
      resolveAgents: () => [
        {
          name: "clawdy",
          backend: "anthropic-agent-sdk",
          failoverChain: ["codex-cli"],
        },
      ],
    });
    const controller = new FailoverController(deps);
    await expect(controller.tick()).resolves.toBeUndefined();
    // Decision still applied despite the webhook failure.
    expect(store.set).toHaveBeenCalledTimes(1);
  });

  it("(k) a second tick with no state change is idempotent — no duplicate set", async () => {
    const store = fakeStore();
    const deps = controllerDeps({
      store,
      readSaturatedProviders: () => new Set(["anthropic"]),
      resolveAgents: () => [
        {
          name: "clawdy",
          backend: "anthropic-agent-sdk",
          failoverChain: ["codex-cli"],
        },
      ],
    });
    const controller = new FailoverController(deps);
    await controller.tick();
    await controller.tick();
    // First tick sets the row; second tick sees it in listActive and
    // emits no duplicate decision.
    expect(store.set).toHaveBeenCalledTimes(1);
  });

  it("(l) expired rows are cleared at tick", async () => {
    const now = Date.UTC(2026, 4, 20, 12, 0, 0);
    const store = fakeStore([
      {
        agent: "stale",
        active_backend: "codex-cli",
        reason: "threshold-95",
        triggered_at: 0,
        expires_at: now - 1,
      },
    ]);
    // listActive filters the expired row out — controller must read raw
    // rows for the expiry sweep. Use listAll-style: simulate by having
    // listActive return [] and the controller still clearing via the
    // evaluate output. We pass the expired row through currentFailoverState
    // by making readAllRows return it.
    const deps = controllerDeps({
      store,
      readAllRows: () => [
        {
          agent: "stale",
          active_backend: "codex-cli" as LlmRuntimeBackend,
          expires_at: now - 1,
        },
      ],
    });
    const controller = new FailoverController(deps);
    await controller.tick();
    expect(store.clear).toHaveBeenCalledWith("stale");
  });
});
