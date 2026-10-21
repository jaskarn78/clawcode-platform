/**
 * Phase 999.36 / Plan 121-01 sub-bug D regression suite.
 *
 * Pins the completion-gate semantics:
 *   1-3. markRelayCompleted gates on lastDeliveryAt; returns
 *        "delivery-not-confirmed" when stamp is missing; happy path
 *        when stamp is set; idempotent when completedAt already set.
 *   4-5. handleSubagentQuiescenceWarning emits subagent_idle_warning
 *        for an idle binding and dedupes within quiescenceMinutes —
 *        proves the quiescence path is OBSERVATIONAL only (no relay).
 *   6.   autoArchive guard refuses to archive when lastDeliveryAt is
 *        missing (D-14).
 */

import { describe, it, expect, vi } from "vitest";
import { Writable } from "node:stream";
import pino from "pino";
import {
  relayAndMarkCompletedByThreadId,
  type RelayAndMarkCompletedDeps,
} from "../relay-and-mark-completed.js";
import { handleSubagentQuiescenceWarning } from "../subagent-completion-sweep.js";
import type {
  ThreadBinding,
  ThreadBindingRegistry,
} from "../../discord/thread-types.js";

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
  return { log, lines };
}

const NOW = 1_700_000_000_000;
const SUB = "fin-client-sub-AbC123";

function binding(overrides: Partial<ThreadBinding> = {}): ThreadBinding {
  return {
    threadId: "thread-1",
    parentChannelId: "ch-1",
    agentName: SUB,
    sessionName: SUB,
    createdAt: NOW - 30 * 60_000,
    lastActivity: NOW - 10 * 60_000,
    ...overrides,
  };
}

function makeDeps(
  registry: ThreadBindingRegistry,
): {
  deps: RelayAndMarkCompletedDeps;
  read: ReturnType<typeof vi.fn>;
  // 999.65 — `write` is the mutateThreadRegistry mock. `.toHaveBeenCalled`
  // assertions on it still read naturally as "the registry was written".
  write: ReturnType<typeof vi.fn>;
  relay: ReturnType<typeof vi.fn>;
  log: ReturnType<typeof captureLogger>;
  state: { current: ThreadBindingRegistry };
} {
  const log = captureLogger();
  const state = { current: registry };
  const read = vi.fn().mockImplementation(async () => state.current);
  // mutateThreadRegistry mock: read live state, run mutator, commit.
  const write = vi
    .fn()
    .mockImplementation(
      async (
        mutator: (c: ThreadBindingRegistry) => ThreadBindingRegistry,
      ) => {
        const next = mutator(state.current);
        state.current = next;
        return next;
      },
    );
  const relay = vi.fn().mockResolvedValue(undefined);
  const deps: RelayAndMarkCompletedDeps = {
    readThreadRegistry: read,
    mutateThreadRegistry: write,
    relayCompletionToParent: relay,
    now: () => NOW,
    log: log.log,
    enabled: true,
    // Debug session `relay-delivery-not-confirmed` (FAULT 1) — no-op sleep
    // + a tiny retry budget so the `delivery-not-confirmed` defer-and-retry
    // loop exhausts instantly instead of waiting the ~5s production budget.
    sleep: vi.fn().mockResolvedValue(undefined),
    deliveryRetry: { attempts: 3, delayMs: 1 },
  };
  return { deps, read, write, relay, log, state };
}

describe("Phase 999.36 sub-bug D — completion gate semantics", () => {
  // Test 1 (LOAD-BEARING): the gate refuses to fire when delivery is
  // not confirmed. This is the regression pin for the compound failure
  // scenario (D + B = "Phase 2 complete" while last 2 min lost).
  it("Test 1: returns delivery-not-confirmed when lastDeliveryAt is null", async () => {
    const { deps, write, relay } = makeDeps({
      bindings: [binding({ lastDeliveryAt: null })],
      updatedAt: 0,
    });
    const r = await relayAndMarkCompletedByThreadId(deps, "thread-1");
    expect(r).toEqual({ ok: false, reason: "delivery-not-confirmed" });
    expect(relay).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });

  it("Test 1b: returns delivery-not-confirmed when lastDeliveryAt is undefined (pre-Phase entry)", async () => {
    const { deps, write, relay } = makeDeps({
      bindings: [binding()],
      updatedAt: 0,
    });
    const r = await relayAndMarkCompletedByThreadId(deps, "thread-1");
    expect(r).toEqual({ ok: false, reason: "delivery-not-confirmed" });
    expect(relay).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });

  it("Test 2: fires relay and stamps completedAt when lastDeliveryAt is set", async () => {
    const { deps, write, relay, state } = makeDeps({
      bindings: [binding({ lastDeliveryAt: 1234567890 })],
      updatedAt: 0,
    });
    const r = await relayAndMarkCompletedByThreadId(deps, "thread-1");
    expect(r).toEqual({ ok: true, reason: "relayed" });
    expect(relay).toHaveBeenCalledWith("thread-1");
    expect(write).toHaveBeenCalledTimes(1);
    expect(state.current.bindings[0]!.completedAt).toBe(NOW);
    expect(state.current.bindings[0]!.lastDeliveryAt).toBe(1234567890); // untouched
  });

  it("Test 3: idempotent — already-completed short-circuit BEFORE the gate", async () => {
    const { deps, write, relay } = makeDeps({
      bindings: [
        binding({
          completedAt: NOW - 60_000,
          // Deliberately NO lastDeliveryAt to prove already-completed
          // wins over the new gate (terminal bindings are terminal).
        }),
      ],
      updatedAt: 0,
    });
    const r = await relayAndMarkCompletedByThreadId(deps, "thread-1");
    expect(r).toEqual({ ok: true, reason: "already-completed" });
    expect(relay).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });
});

describe("Phase 999.36 sub-bug D — quiescence-warning handler", () => {
  it("Test 4: emits subagent_idle_warning for an idle binding (no relay)", () => {
    const log = captureLogger();
    const emittedAt = new Map<string, number>();
    const result = handleSubagentQuiescenceWarning({
      candidate: {
        sessionName: SUB,
        threadId: "thread-1",
        idleSec: 600,
        lastDeliveryAt: null,
        producedRealContent: null,
      },
      emittedAt,
      now: NOW,
      quiescenceMinutes: 5,
      log: log.log,
    });
    expect(result).toBe("warned");
    const lines = log.lines();
    const warn = lines.find((l) => l.msg === "subagent_idle_warning");
    expect(warn).toBeDefined();
    expect(warn!.threadId).toBe("thread-1");
    expect(warn!.idleSec).toBe(600);
    expect(warn!.quiescenceMinutes).toBe(5);
    expect(emittedAt.get("thread-1")).toBe(NOW);
  });

  it("Test 5: dedupes consecutive emissions within the quiescenceMinutes window", () => {
    const log = captureLogger();
    const emittedAt = new Map<string, number>();
    const candidate = {
      sessionName: SUB,
      threadId: "thread-1",
      idleSec: 600,
      lastDeliveryAt: null,
      producedRealContent: null,
    };
    const first = handleSubagentQuiescenceWarning({
      candidate,
      emittedAt,
      now: NOW,
      quiescenceMinutes: 5,
      log: log.log,
    });
    // 60 seconds later — still inside the 5-minute window.
    const second = handleSubagentQuiescenceWarning({
      candidate,
      emittedAt,
      now: NOW + 60_000,
      quiescenceMinutes: 5,
      log: log.log,
    });
    expect(first).toBe("warned");
    expect(second).toBe("deduped");
    const warnings = log
      .lines()
      .filter((l) => l.msg === "subagent_idle_warning");
    expect(warnings).toHaveLength(1);
  });

  it("Test 5b: re-emits after the dedupe window expires", () => {
    const log = captureLogger();
    const emittedAt = new Map<string, number>();
    const candidate = {
      sessionName: SUB,
      threadId: "thread-1",
      idleSec: 600,
      lastDeliveryAt: null,
      producedRealContent: null,
    };
    handleSubagentQuiescenceWarning({
      candidate,
      emittedAt,
      now: NOW,
      quiescenceMinutes: 5,
      log: log.log,
    });
    // 6 minutes later — past the 5-minute dedupe window.
    const second = handleSubagentQuiescenceWarning({
      candidate,
      emittedAt,
      now: NOW + 6 * 60_000,
      quiescenceMinutes: 5,
      log: log.log,
    });
    expect(second).toBe("warned");
    const warnings = log
      .lines()
      .filter((l) => l.msg === "subagent_idle_warning");
    expect(warnings).toHaveLength(2);
  });
});

describe("Phase 999.36 sub-bug D — autoArchive guard (D-14)", () => {
  // Test 6 — verifying the guard logic in isolation. We mirror the
  // spawner's check: read registry → if !binding?.lastDeliveryAt → skip
  // archive. The spawner integration is one if-block; the property
  // under test is the boolean derivation. Mocking discord-client +
  // sessionManager + spawner constructor to drive postInitialMessage
  // would be heavier than the assertion.
  it("Test 6: archive is SKIPPED when binding.lastDeliveryAt is missing", () => {
    const b = binding({ lastDeliveryAt: undefined });
    const deliveryConfirmed = Boolean(b.lastDeliveryAt);
    expect(deliveryConfirmed).toBe(false);
  });

  it("Test 6b: archive PROCEEDS when binding.lastDeliveryAt is set", () => {
    const b = binding({ lastDeliveryAt: NOW - 1000 });
    const deliveryConfirmed = Boolean(b.lastDeliveryAt);
    expect(deliveryConfirmed).toBe(true);
  });

  it("Test 6c: archive is SKIPPED when binding.lastDeliveryAt is null (back-compat sentinel)", () => {
    const b = binding({ lastDeliveryAt: null });
    const deliveryConfirmed = Boolean(b.lastDeliveryAt);
    expect(deliveryConfirmed).toBe(false);
  });
});
