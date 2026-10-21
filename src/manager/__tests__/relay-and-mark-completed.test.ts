import { describe, expect, it, vi } from "vitest";
import { Writable } from "node:stream";
import pino from "pino";
import {
  relayAndMarkCompletedByThreadId,
  relayAndMarkCompletedByAgentName,
  DEFAULT_DELIVERY_RETRY,
  type RelayAndMarkCompletedDeps,
} from "../relay-and-mark-completed.js";
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
const SUB = "fin-client-via-fin-research-AbC123";

function binding(overrides: Partial<ThreadBinding> = {}): ThreadBinding {
  return {
    threadId: "thread-1",
    parentChannelId: "ch-1",
    agentName: SUB,
    sessionName: SUB,
    createdAt: NOW - 30 * 60_000,
    lastActivity: NOW - 10 * 60_000,
    // Phase 999.36 sub-bug D — default fixtures pass the delivery gate.
    // Tests asserting the gate's no-stamp branch override this with
    // `lastDeliveryAt: undefined` or `null` explicitly.
    lastDeliveryAt: NOW - 5 * 60_000,
    ...overrides,
  };
}

/**
 * 999.65 — `makeDeps` now models `mutateThreadRegistry`. The mock holds a
 * mutable `current` registry, runs the caller's mutator against it, and
 * commits the result — so concurrency-shaped tests can observe the
 * critical-section semantics. `read` always returns the live `current`.
 */
function makeDeps(opts: {
  registry: ThreadBindingRegistry;
  enabled?: boolean;
  spawnerAvailable?: boolean;
  /**
   * Debug session `relay-delivery-not-confirmed` (FAULT 1) — override the
   * defer-and-retry budget. Defaults to a tiny budget (3 attempts) so the
   * `delivery-not-confirmed` exhaustion tests run instantly. `sleep` is a
   * no-op so the loop never waits real time.
   */
  deliveryRetry?: { attempts: number; delayMs: number };
  /**
   * Debug session `relay-delivery-not-confirmed` (FAULT 1) — custom sleep
   * impl for tests that mutate the registry mid-retry (stamp-then-IPC
   * reorder simulation). Receives the shared `state` so the test can flip
   * `state.current` on a chosen attempt. When omitted, a plain no-op
   * `sleep` is used. `RelayAndMarkCompletedDeps.sleep` is `readonly`, so
   * the custom impl must be supplied here at construction time.
   */
  sleepImpl?: (
    state: { current: ThreadBindingRegistry },
    attempt: number,
  ) => void;
}): {
  deps: RelayAndMarkCompletedDeps;
  read: ReturnType<typeof vi.fn>;
  mutate: ReturnType<typeof vi.fn>;
  relay: ReturnType<typeof vi.fn>;
  sleep: ReturnType<typeof vi.fn>;
  log: ReturnType<typeof captureLogger>;
  state: { current: ThreadBindingRegistry };
} {
  const log = captureLogger();
  const state = { current: opts.registry };
  const read = vi.fn().mockImplementation(async () => state.current);
  const mutate = vi
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
  // No-op sleep — the defer-and-retry loop exhausts its budget instantly.
  // When `sleepImpl` is supplied, each tick invokes it with the shared
  // `state` + attempt number so the test can mutate the registry mid-loop.
  let sleepTick = 0;
  const sleep = vi.fn().mockImplementation(async () => {
    sleepTick++;
    opts.sleepImpl?.(state, sleepTick);
  });
  const deps: RelayAndMarkCompletedDeps = {
    readThreadRegistry: read,
    mutateThreadRegistry: mutate,
    relayCompletionToParent:
      opts.spawnerAvailable === false ? null : relay,
    now: () => NOW,
    log: log.log,
    enabled: opts.enabled !== false,
    sleep,
    deliveryRetry: opts.deliveryRetry ?? { attempts: 3, delayMs: 1 },
  };
  return { deps, read, mutate, relay, sleep, log, state };
}

describe("relayAndMarkCompletedByThreadId", () => {
  it("returns no-binding when threadId is unknown", async () => {
    const { deps, mutate, relay, log } = makeDeps({
      registry: { bindings: [], updatedAt: 0 },
    });
    const r = await relayAndMarkCompletedByThreadId(deps, "thread-x");
    expect(r).toEqual({ ok: false, reason: "no-binding" });
    expect(relay).not.toHaveBeenCalled();
    expect(mutate).not.toHaveBeenCalled();
    // 999.65 AC#3 — every non-relayed return emits a structured diag line.
    expect(
      log.lines().find(
        (l) =>
          l.action === "relay-skipped" && l.reason === "no-binding",
      ),
    ).toBeDefined();
  });

  it("returns disabled when enabled=false (no relay, no write)", async () => {
    const { deps, mutate, relay, log } = makeDeps({
      registry: { bindings: [binding()], updatedAt: 0 },
      enabled: false,
    });
    const r = await relayAndMarkCompletedByThreadId(deps, "thread-1");
    expect(r).toEqual({ ok: false, reason: "disabled" });
    expect(relay).not.toHaveBeenCalled();
    expect(mutate).not.toHaveBeenCalled();
    expect(
      log.lines().find(
        (l) => l.action === "relay-skipped" && l.reason === "disabled",
      ),
    ).toBeDefined();
  });

  it("returns spawner-unavailable when relayCompletionToParent is null", async () => {
    const { deps, mutate, log } = makeDeps({
      registry: { bindings: [binding()], updatedAt: 0 },
      spawnerAvailable: false,
    });
    const r = await relayAndMarkCompletedByThreadId(deps, "thread-1");
    expect(r).toEqual({ ok: false, reason: "spawner-unavailable" });
    expect(mutate).not.toHaveBeenCalled();
    expect(
      log.lines().find(
        (l) =>
          l.action === "relay-skipped" &&
          l.reason === "spawner-unavailable",
      ),
    ).toBeDefined();
  });

  it("returns already-completed when binding.completedAt is set (idempotent)", async () => {
    const { deps, mutate, relay, log } = makeDeps({
      registry: {
        bindings: [binding({ completedAt: NOW - 60_000 })],
        updatedAt: 0,
      },
    });
    const r = await relayAndMarkCompletedByThreadId(deps, "thread-1");
    expect(r).toEqual({ ok: true, reason: "already-completed" });
    expect(relay).not.toHaveBeenCalled();
    expect(mutate).not.toHaveBeenCalled();
    expect(
      log.lines().find(
        (l) =>
          l.action === "relay-skipped" &&
          l.reason === "already-completed",
      ),
    ).toBeDefined();
  });

  it("returns delivery-not-confirmed when lastDeliveryAt never lands (retry budget exhausted, logged, no relay)", async () => {
    // FAULT 1 — the gate now defer-and-retries. When `lastDeliveryAt`
    // STAYS unstamped across the whole retry budget that is a genuine
    // never-delivered subagent → `delivery-not-confirmed` (as before).
    const { deps, mutate, relay, sleep, log } = makeDeps({
      registry: {
        bindings: [binding({ lastDeliveryAt: undefined })],
        updatedAt: 0,
      },
      deliveryRetry: { attempts: 4, delayMs: 10 },
    });
    const r = await relayAndMarkCompletedByThreadId(deps, "thread-1");
    expect(r).toEqual({ ok: false, reason: "delivery-not-confirmed" });
    expect(relay).not.toHaveBeenCalled();
    expect(mutate).not.toHaveBeenCalled();
    // The loop spent its full budget before giving up.
    expect(sleep).toHaveBeenCalledTimes(4);
    const skip = log.lines().find(
      (l) =>
        l.action === "relay-skipped" &&
        l.reason === "delivery-not-confirmed",
    );
    expect(skip).toBeDefined();
    expect(skip!.threadId).toBe("thread-1");
    expect(skip!.parentAgent).toBe(SUB);
  });

  it("FAULT 1 regression: defers then relays when lastDeliveryAt is stamped mid-retry (stamp-then-IPC reorder)", async () => {
    // The explicit-tool `subagent_complete` IPC can arrive BEFORE the
    // spawner's post-delivery `stampLastDeliveryAt` commits. The gate must
    // NOT permanently drop the relay — it re-reads the registry and
    // proceeds the moment the stamp lands.
    const { deps, relay, sleep, state } = makeDeps({
      registry: {
        bindings: [binding({ lastDeliveryAt: undefined })],
        updatedAt: 0,
      },
      deliveryRetry: { attempts: 10, delayMs: 5 },
      // Simulate the spawner's stamp landing on the 3rd retry re-read.
      sleepImpl: (s, attempt) => {
        if (attempt === 3) {
          s.current = {
            bindings: s.current.bindings.map((b) =>
              b.threadId === "thread-1"
                ? { ...b, lastDeliveryAt: NOW - 1_000 }
                : b,
            ),
            updatedAt: NOW,
          };
        }
      },
    });

    const r = await relayAndMarkCompletedByThreadId(deps, "thread-1");

    // The relay fired exactly once and completedAt was stamped — the
    // not-yet-landed stamp is no longer a permanent drop.
    expect(r).toEqual({ ok: true, reason: "relayed" });
    expect(relay).toHaveBeenCalledTimes(1);
    expect(relay).toHaveBeenCalledWith("thread-1");
    expect(state.current.bindings[0]!.completedAt).toBe(NOW);
    // It stopped retrying the instant the stamp landed (attempt 3), not
    // the full 10-attempt budget.
    expect(sleep).toHaveBeenCalledTimes(3);
  });

  it("FAULT 1: defer-loop returns already-completed when a concurrent path completes the binding mid-retry", async () => {
    // While the gate is waiting for the stamp, the session-end backstop
    // (or another caller) can confirm + complete the binding. The retry
    // loop must observe `completedAt` and dedupe, not relay twice.
    const { deps, relay } = makeDeps({
      registry: {
        bindings: [binding({ lastDeliveryAt: undefined })],
        updatedAt: 0,
      },
      deliveryRetry: { attempts: 10, delayMs: 5 },
      sleepImpl: (s, attempt) => {
        if (attempt === 2) {
          s.current = {
            bindings: s.current.bindings.map((b) =>
              b.threadId === "thread-1"
                ? { ...b, lastDeliveryAt: NOW, completedAt: NOW }
                : b,
            ),
            updatedAt: NOW,
          };
        }
      },
    });

    const r = await relayAndMarkCompletedByThreadId(deps, "thread-1");
    expect(r).toEqual({ ok: true, reason: "already-completed" });
    expect(relay).not.toHaveBeenCalled();
  });

  it("FAULT 1: defer-loop returns no-binding when the binding is removed mid-retry", async () => {
    // `removeThreadSession` can race the retry loop. A vanished binding
    // means nothing to relay — return no-binding rather than spin.
    const { deps, relay } = makeDeps({
      registry: {
        bindings: [binding({ lastDeliveryAt: undefined })],
        updatedAt: 0,
      },
      deliveryRetry: { attempts: 10, delayMs: 5 },
      // Binding gone after the first sleep tick.
      sleepImpl: (s) => {
        s.current = { bindings: [], updatedAt: NOW };
      },
    });
    const r = await relayAndMarkCompletedByThreadId(deps, "thread-1");
    expect(r).toEqual({ ok: false, reason: "no-binding" });
    expect(relay).not.toHaveBeenCalled();
  });

  it("treats completedAt === null as not-completed and proceeds (back-compat)", async () => {
    const { deps, mutate, relay } = makeDeps({
      registry: {
        bindings: [binding({ completedAt: null })],
        updatedAt: 0,
      },
    });
    const r = await relayAndMarkCompletedByThreadId(deps, "thread-1");
    expect(r).toEqual({ ok: true, reason: "relayed" });
    expect(relay).toHaveBeenCalledWith("thread-1");
    expect(mutate).toHaveBeenCalledTimes(1);
  });

  it("happy path: fires relay, stamps completedAt, persists registry", async () => {
    const { deps, mutate, relay, log, state } = makeDeps({
      registry: { bindings: [binding()], updatedAt: 0 },
    });
    const r = await relayAndMarkCompletedByThreadId(deps, "thread-1");
    expect(r).toEqual({ ok: true, reason: "relayed" });
    expect(relay).toHaveBeenCalledWith("thread-1");
    expect(mutate).toHaveBeenCalledTimes(1);
    expect(state.current.bindings[0]!.completedAt).toBe(NOW);
    expect(state.current.bindings[0]!.lastActivity).toBe(
      binding().lastActivity,
    ); // untouched
    const lines = log.lines();
    expect(
      lines.find(
        (l) =>
          l.action === "marked-completed" &&
          l.component === "subagent-completion",
      ),
    ).toBeDefined();
  });

  it("propagates throws from relay (caller handles)", async () => {
    const { deps, relay, mutate } = makeDeps({
      registry: { bindings: [binding()], updatedAt: 0 },
    });
    relay.mockRejectedValueOnce(new Error("discord 5xx"));
    await expect(
      relayAndMarkCompletedByThreadId(deps, "thread-1"),
    ).rejects.toThrow("discord 5xx");
    expect(mutate).not.toHaveBeenCalled(); // didn't reach the stamp
  });

  it("999.65 regression: parallel completion of two distinct threads relays BOTH", async () => {
    // AC#2 — N concurrent completions for distinct threads produce N
    // relays; the dedupe must never collapse distinct threads.
    const bindingA = binding({ threadId: "thread-A", sessionName: "subA" });
    const bindingB = binding({ threadId: "thread-B", sessionName: "subB" });
    const { deps, relay, state } = makeDeps({
      registry: { bindings: [bindingA, bindingB], updatedAt: 0 },
    });

    // Fire both completions concurrently — the shared `mutate` mock
    // serializes the read-modify-write, modelling mutateThreadRegistry.
    const [rA, rB] = await Promise.all([
      relayAndMarkCompletedByThreadId(deps, "thread-A"),
      relayAndMarkCompletedByThreadId(deps, "thread-B"),
    ]);

    expect(rA).toEqual({ ok: true, reason: "relayed" });
    expect(rB).toEqual({ ok: true, reason: "relayed" });
    expect(relay).toHaveBeenCalledWith("thread-A");
    expect(relay).toHaveBeenCalledWith("thread-B");
    expect(relay).toHaveBeenCalledTimes(2);

    // Both bindings end stamped — neither write clobbered the other.
    const a = state.current.bindings.find((b) => b.threadId === "thread-A");
    const b = state.current.bindings.find((b) => b.threadId === "thread-B");
    expect(a!.completedAt).toBe(NOW);
    expect(b!.completedAt).toBe(NOW);
  });
});

describe("relayAndMarkCompletedByAgentName", () => {
  it("looks up by sessionName and delegates", async () => {
    const { deps, mutate, relay } = makeDeps({
      registry: { bindings: [binding()], updatedAt: 0 },
    });
    const r = await relayAndMarkCompletedByAgentName(deps, SUB);
    expect(r).toEqual({ ok: true, reason: "relayed" });
    expect(relay).toHaveBeenCalledWith("thread-1");
    expect(mutate).toHaveBeenCalledTimes(1);
  });

  it("returns no-binding when no session matches the agentName", async () => {
    const { deps, mutate, relay, log } = makeDeps({
      registry: { bindings: [binding()], updatedAt: 0 },
    });
    const r = await relayAndMarkCompletedByAgentName(deps, "ghost-agent");
    expect(r).toEqual({ ok: false, reason: "no-binding" });
    expect(relay).not.toHaveBeenCalled();
    expect(mutate).not.toHaveBeenCalled();
    expect(
      log.lines().find(
        (l) => l.action === "relay-skipped" && l.reason === "no-binding",
      ),
    ).toBeDefined();
  });

  it("returns disabled without reading the registry", async () => {
    const { deps, read } = makeDeps({
      registry: { bindings: [binding()], updatedAt: 0 },
      enabled: false,
    });
    const r = await relayAndMarkCompletedByAgentName(deps, SUB);
    expect(r).toEqual({ ok: false, reason: "disabled" });
    expect(read).not.toHaveBeenCalled();
  });
});

describe("DEFAULT_DELIVERY_RETRY budget floor (260610-qu5 CHANGE #2)", () => {
  // The existing FAULT 1 mechanics tests always inject a tiny budget
  // (`deliveryRetry: { attempts: 3, delayMs: 1 }`) via makeDeps, so they
  // exercise the retry MECHANICS but would stay green even if the PRODUCTION
  // default were left at the old ~5s. This assertion is the load-bearing
  // regression guard that locks the widened default in: a subagent whose
  // stream settles ~12s after `subagent_complete` (live 2026-06-10 diagnosis,
  // `project_fable_subagent_delivery_failure`) must not be skipped with
  // `delivery-not-confirmed` before its `lastDeliveryAt` stamp lands.
  it("pins the production worst-case budget at >= 30000 ms", () => {
    expect(
      DEFAULT_DELIVERY_RETRY.attempts * DEFAULT_DELIVERY_RETRY.delayMs,
    ).toBeGreaterThanOrEqual(30_000);
  });

  it("keeps delayMs small so the happy path returns the instant the stamp lands", () => {
    // A small per-attempt delay means a subagent that already stamped (or
    // stamps within the first attempt or two) is relayed without waiting the
    // full budget — the widened budget only costs real time on a genuine
    // never-delivered subagent.
    expect(DEFAULT_DELIVERY_RETRY.delayMs).toBeLessThanOrEqual(250);
  });
});
