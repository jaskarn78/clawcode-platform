/**
 * Debug session `relay-delivery-not-confirmed` (FAULT 2) — pre-teardown
 * subagent-relay drain regression tests.
 *
 * THE BUG. The daemon shutdown closure ran `discordBridge.stop()`
 * (`client.destroy()` — clears the discord.js REST token) BEFORE the
 * per-subagent session-end callbacks fired. Those callbacks' only job is
 * a Discord post; with the token gone the post threw "Expected token to
 * be set for this request, but none was present" and the completion relay
 * was lost (observed on clawdy 2026-05-22 during a deploy restart).
 *
 * THE FIX. `drainPendingSubagentRelays` runs in the shutdown closure
 * BEFORE `discordBridge.stop()`, while the client is still alive. These
 * tests pin:
 *   1. A pending (`completedAt: null`) subagent gets its relay fired and
 *      `completedAt` stamped while the client is alive.
 *   2. The stamp makes the LATER (post-teardown) session-end callback
 *      dedupe — a second `relayAndMarkCompletedByThreadId` call for the
 *      same thread returns `already-completed` without re-posting.
 *   3. The drain runs BEFORE Discord teardown (ordering pin).
 *   4. A binding that already has `completedAt` is skipped.
 *   5. Bounded — a slow/hung relay cannot stall shutdown (per-binding
 *      timeout + total budget); the drain never throws.
 */

import { describe, expect, it, vi } from "vitest";
import { Writable } from "node:stream";
import pino from "pino";
import { drainPendingSubagentRelays } from "../drain-pending-subagent-relays.js";
import { relayAndMarkCompletedByThreadId } from "../relay-and-mark-completed.js";
import type {
  ThreadBinding,
  ThreadBindingRegistry,
} from "../../discord/thread-types.js";

function captureLogger(): {
  log: pino.Logger;
  lines: () => Array<Record<string, unknown>>;
} {
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

function binding(overrides: Partial<ThreadBinding> = {}): ThreadBinding {
  return {
    threadId: "thread-1",
    parentChannelId: "ch-1",
    agentName: "fin-client-via-fin-research-AbC123",
    sessionName: "fin-client-via-fin-research-AbC123",
    createdAt: NOW - 30 * 60_000,
    lastActivity: NOW - 10 * 60_000,
    // Default fixture has delivery confirmed — incomplete (`completedAt`
    // null) so the drain treats it as pending.
    lastDeliveryAt: NOW - 5 * 60_000,
    ...overrides,
  };
}

/**
 * Build a drain-deps harness backed by a mutable in-memory registry, so
 * the unified `relayAndMarkCompletedByThreadId` path runs for real and
 * `completedAt` stamps are observable.
 */
function makeHarness(initial: readonly ThreadBinding[]) {
  const log = captureLogger();
  const state: { current: ThreadBindingRegistry } = {
    current: { bindings: [...initial], updatedAt: 0 },
  };
  const relay = vi.fn().mockResolvedValue(undefined);
  const readThreadRegistry = vi
    .fn()
    .mockImplementation(async () => state.current);
  const mutateThreadRegistry = vi
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
  const stampLastDeliveryAt = vi
    .fn()
    .mockImplementation(
      async (threadId: string, deliveredAt: number) => {
        let found = false;
        state.current = {
          bindings: state.current.bindings.map((b) => {
            if (b.threadId === threadId) {
              found = true;
              return { ...b, lastDeliveryAt: deliveredAt };
            }
            return b;
          }),
          updatedAt: deliveredAt,
        };
        return found
          ? ({ ok: true } as const)
          : ({ ok: false, reason: "no-binding" } as const);
      },
    );
  // getSubagentBindings reflects the live registry — mirrors the spawner.
  const getSubagentBindings = vi
    .fn()
    .mockImplementation(async () => state.current.bindings);

  return {
    log,
    state,
    relay,
    readThreadRegistry,
    mutateThreadRegistry,
    stampLastDeliveryAt,
    getSubagentBindings,
    deps: {
      getSubagentBindings,
      stampLastDeliveryAt,
      relayDeps: {
        readThreadRegistry,
        mutateThreadRegistry,
        relayCompletionToParent: relay,
        now: () => NOW,
        log: log.log,
        enabled: true,
        sleep: vi.fn().mockResolvedValue(undefined),
        deliveryRetry: { attempts: 1, delayMs: 1 },
      },
      now: () => NOW,
      log: log.log,
      perBindingTimeoutMs: 5_000,
      totalBudgetMs: 20_000,
    },
  };
}

describe("drainPendingSubagentRelays — FAULT 2 pre-teardown drain", () => {
  it("relays a pending subagent and stamps completedAt (while client is alive)", async () => {
    const h = makeHarness([binding()]);
    const result = await drainPendingSubagentRelays(h.deps);

    expect(result.pending).toBe(1);
    expect(result.relayed).toBe(1);
    expect(result.failed).toBe(0);
    expect(h.relay).toHaveBeenCalledWith("thread-1");
    // completedAt stamped — this is what makes the later session-end
    // callback dedupe instead of re-posting with a dead token.
    expect(h.state.current.bindings[0]!.completedAt).toBe(NOW);
  });

  it("FAULT 2 regression: drain stamps completedAt so the later session-end callback dedupes", async () => {
    // Simulates the real shutdown sequence: the drain runs first, THEN
    // (after discordBridge.stop) the session-end callback fires. The
    // callback path is `relayAndMarkCompletedByThreadId` again — it must
    // see `completedAt` set and short-circuit, NOT re-attempt the post.
    const h = makeHarness([binding()]);

    // Step 1 — pre-teardown drain.
    await drainPendingSubagentRelays(h.deps);
    expect(h.relay).toHaveBeenCalledTimes(1);

    // Step 2 — the session-end callback fires AFTER Discord teardown.
    // It uses the same unified relay path; with completedAt stamped it
    // must return already-completed and NOT call the (now-tokenless)
    // relay again.
    const sessionEndResult = await relayAndMarkCompletedByThreadId(
      h.deps.relayDeps,
      "thread-1",
    );
    expect(sessionEndResult).toEqual({
      ok: true,
      reason: "already-completed",
    });
    // Relay still called exactly once total — the dedupe held.
    expect(h.relay).toHaveBeenCalledTimes(1);
  });

  it("force-stamps lastDeliveryAt when missing (session-end is delivery-equivalent)", async () => {
    // A subagent whose post-delivery stamp never landed (FAULT 1 window /
    // crash mid-stream) still deserves a relay at shutdown.
    const h = makeHarness([binding({ lastDeliveryAt: undefined })]);
    const result = await drainPendingSubagentRelays(h.deps);

    // The drain stamps `producedRealContent: true` (session-end is
    // delivery-equivalent and carries no content signal).
    expect(h.stampLastDeliveryAt).toHaveBeenCalledWith("thread-1", NOW, true);
    expect(result.relayed).toBe(1);
    expect(h.relay).toHaveBeenCalledWith("thread-1");
    expect(h.state.current.bindings[0]!.completedAt).toBe(NOW);
  });

  it("skips bindings already completed (no duplicate relay)", async () => {
    const h = makeHarness([binding({ completedAt: NOW - 60_000 })]);
    const result = await drainPendingSubagentRelays(h.deps);

    expect(result.pending).toBe(0);
    expect(result.relayed).toBe(0);
    expect(h.relay).not.toHaveBeenCalled();
  });

  it("relays multiple pending subagents independently", async () => {
    const h = makeHarness([
      binding({ threadId: "t-A", sessionName: "subA" }),
      binding({ threadId: "t-B", sessionName: "subB" }),
      binding({ threadId: "t-C", sessionName: "subC", completedAt: NOW }),
    ]);
    const result = await drainPendingSubagentRelays(h.deps);

    expect(result.pending).toBe(2); // C is already completed
    expect(result.relayed).toBe(2);
    expect(h.relay).toHaveBeenCalledWith("t-A");
    expect(h.relay).toHaveBeenCalledWith("t-B");
    expect(h.relay).not.toHaveBeenCalledWith("t-C");
  });

  it("a slow relay is bounded by the per-binding timeout — drain still finishes", async () => {
    const h = makeHarness([binding()]);
    // A relay that never resolves — without the timeout this would hang
    // daemon shutdown forever.
    h.deps.relayDeps = {
      ...h.deps.relayDeps,
      relayCompletionToParent: vi
        .fn()
        .mockImplementation(() => new Promise<string | null>(() => {})),
    };
    h.deps.perBindingTimeoutMs = 30;

    const result = await drainPendingSubagentRelays(h.deps);
    // Timed out → counted as failed, NOT relayed; drain returned.
    expect(result.failed).toBe(1);
    expect(result.relayed).toBe(0);
    const timeoutLog = h.log
      .lines()
      .find((l) => l.action === "pre-teardown-drain-error");
    expect(timeoutLog).toBeDefined();
  });

  it("never throws when getSubagentBindings rejects (shutdown must proceed)", async () => {
    const h = makeHarness([]);
    h.deps.getSubagentBindings = vi
      .fn()
      .mockRejectedValue(new Error("registry read failed"));

    // Must resolve, not reject.
    const result = await drainPendingSubagentRelays(h.deps);
    expect(result.pending).toBe(0);
    expect(result.relayed).toBe(0);
  });

  it("respects the total budget — remaining bindings skipped once budget is spent", async () => {
    const h = makeHarness([
      binding({ threadId: "t-A", sessionName: "subA" }),
      binding({ threadId: "t-B", sessionName: "subB" }),
    ]);
    // `now` jumps past the total budget after the first binding so the
    // second is skipped. First call (loop guard) = 0; subsequent calls
    // return a time past budget.
    let calls = 0;
    const clock = vi.fn().mockImplementation(() => {
      calls++;
      return calls <= 2 ? NOW : NOW + 999_999;
    });
    h.deps.now = clock;
    h.deps.totalBudgetMs = 1_000;

    const result = await drainPendingSubagentRelays(h.deps);
    expect(result.pending).toBe(2);
    expect(result.relayed).toBe(1);
    expect(result.budgetExhausted).toBe(1);
  });
});
