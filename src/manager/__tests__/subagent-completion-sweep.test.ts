import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Writable } from "node:stream";
import pino from "pino";
import {
  handleSubagentQuiescenceRelay,
  scanQuiescentBindings,
  tickSubagentCompletionSweep,
  type CompletionSweepCandidate,
  type RunningSessionInfo,
} from "../subagent-completion-sweep.js";
import type { ThreadBinding, ThreadBindingRegistry } from "../../discord/thread-types.js";
import type { RelayAndMarkCompletedDeps } from "../relay-and-mark-completed.js";

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
const MIN_MS = 60_000;
const SUB_NAME = "fin-client-via-fin-research-AbC123";
const SUB_NAME_2 = "Admin Clawdy-sub-XyZ987";
const OPERATOR_NAME = "fin-client";

function session(
  overrides: Partial<RunningSessionInfo> = {},
): RunningSessionInfo {
  return { name: SUB_NAME, status: "running", ...overrides };
}

function binding(overrides: Partial<ThreadBinding> = {}): ThreadBinding {
  return {
    threadId: "thread-1",
    parentChannelId: "ch-1",
    agentName: SUB_NAME,
    sessionName: SUB_NAME,
    createdAt: NOW - 30 * MIN_MS,
    lastActivity: NOW - 10 * MIN_MS, // 10 min idle by default — past 5min threshold
    ...overrides,
  };
}

const DEFAULT_SCAN = {
  quiescenceMinutes: 5,
  now: NOW,
};

describe("scanQuiescentBindings", () => {
  it("returns a candidate when subagent binding is past the quiescence window", () => {
    const out = scanQuiescentBindings({
      sessions: [session()],
      bindings: [binding()],
      ...DEFAULT_SCAN,
    });
    expect(out).toHaveLength(1);
    expect(out[0]!.sessionName).toBe(SUB_NAME);
    expect(out[0]!.threadId).toBe("thread-1");
    expect(out[0]!.idleSec).toBe(10 * 60);
    // Candidate carries the gate fields from the binding so the dispatch
    // helper can decide relay-vs-warn without re-reading the registry.
    // Default binding has neither stamped — both fields default to null.
    expect(out[0]!.lastDeliveryAt).toBeNull();
    expect(out[0]!.producedRealContent).toBeNull();
  });

  it("propagates lastDeliveryAt and producedRealContent from the binding", () => {
    const out = scanQuiescentBindings({
      sessions: [session()],
      bindings: [
        binding({ lastDeliveryAt: NOW - 30_000, producedRealContent: true }),
      ],
      ...DEFAULT_SCAN,
    });
    expect(out).toHaveLength(1);
    expect(out[0]!.lastDeliveryAt).toBe(NOW - 30_000);
    expect(out[0]!.producedRealContent).toBe(true);
  });

  it("normalizes undefined producedRealContent to null (legacy bindings)", () => {
    // Legacy bindings written before producedRealContent existed parse as
    // undefined. The dispatch helper refuses to relay unless the value is
    // explicitly `true`, so the scan normalizes to `null` for clarity.
    const out = scanQuiescentBindings({
      sessions: [session()],
      bindings: [binding({ lastDeliveryAt: NOW - 30_000 })],
      ...DEFAULT_SCAN,
    });
    expect(out).toHaveLength(1);
    expect(out[0]!.producedRealContent).toBeNull();
  });

  it("skips bindings where completedAt is already set (idempotence)", () => {
    const out = scanQuiescentBindings({
      sessions: [session()],
      bindings: [binding({ completedAt: NOW - 60_000 })],
      ...DEFAULT_SCAN,
    });
    expect(out).toEqual([]);
  });

  it("skips operator-defined session names (not subagent-shaped)", () => {
    const out = scanQuiescentBindings({
      sessions: [{ name: OPERATOR_NAME, status: "running" }],
      bindings: [
        binding({
          sessionName: OPERATOR_NAME,
          agentName: OPERATOR_NAME,
        }),
      ],
      ...DEFAULT_SCAN,
    });
    expect(out).toEqual([]);
  });

  it("skips bindings whose session is not `running` (skip starting/stopped/etc.)", () => {
    const startingOut = scanQuiescentBindings({
      sessions: [session({ status: "starting" })],
      bindings: [binding()],
      ...DEFAULT_SCAN,
    });
    expect(startingOut).toEqual([]);

    const stoppedOut = scanQuiescentBindings({
      sessions: [session({ status: "stopped" })],
      bindings: [binding()],
      ...DEFAULT_SCAN,
    });
    expect(stoppedOut).toEqual([]);
  });

  it("skips bindings whose session is missing from the registry entirely", () => {
    const out = scanQuiescentBindings({
      sessions: [], // no matching session
      bindings: [binding()],
      ...DEFAULT_SCAN,
    });
    expect(out).toEqual([]);
  });

  it("skips bindings still inside the quiescence window", () => {
    const out = scanQuiescentBindings({
      sessions: [session()],
      bindings: [binding({ lastActivity: NOW - 2 * MIN_MS })], // 2 min idle
      ...DEFAULT_SCAN, // quiescenceMinutes: 5
    });
    expect(out).toEqual([]);
  });

  it("treats completedAt === null as not-completed (back-compat)", () => {
    const out = scanQuiescentBindings({
      sessions: [session()],
      bindings: [binding({ completedAt: null })],
      ...DEFAULT_SCAN,
    });
    expect(out).toHaveLength(1);
  });

  it("returns multiple candidates with stable input order", () => {
    const out = scanQuiescentBindings({
      sessions: [session(), session({ name: SUB_NAME_2 })],
      bindings: [
        binding(),
        binding({
          threadId: "thread-2",
          sessionName: SUB_NAME_2,
          agentName: SUB_NAME_2,
        }),
      ],
      ...DEFAULT_SCAN,
    });
    expect(out.map((c) => c.sessionName)).toEqual([SUB_NAME, SUB_NAME_2]);
  });
});

describe("tickSubagentCompletionSweep", () => {
  let cap: ReturnType<typeof captureLogger>;

  beforeEach(() => {
    cap = captureLogger();
    delete process.env.CLAWCODE_SUBAGENT_COMPLETION_DISABLE;
  });
  afterEach(() => {
    delete process.env.CLAWCODE_SUBAGENT_COMPLETION_DISABLE;
  });

  it("noops when enabled=false", async () => {
    const onQuiescent = vi.fn();
    await tickSubagentCompletionSweep({
      sessions: [session()],
      bindings: [binding()],
      ...DEFAULT_SCAN,
      enabled: false,
      log: cap.log,
      onQuiescent,
    });
    expect(onQuiescent).not.toHaveBeenCalled();
    expect(cap.lines()).toEqual([]);
  });

  it("noops when CLAWCODE_SUBAGENT_COMPLETION_DISABLE=1", async () => {
    process.env.CLAWCODE_SUBAGENT_COMPLETION_DISABLE = "1";
    const onQuiescent = vi.fn();
    await tickSubagentCompletionSweep({
      sessions: [session()],
      bindings: [binding()],
      ...DEFAULT_SCAN,
      enabled: true,
      log: cap.log,
      onQuiescent,
    });
    expect(onQuiescent).not.toHaveBeenCalled();
  });

  it("invokes onQuiescent per candidate (Phase 999.36 sub-bug D — quiescence is observational)", async () => {
    const onQuiescent = vi.fn().mockResolvedValue({ ok: true });
    await tickSubagentCompletionSweep({
      sessions: [session(), session({ name: SUB_NAME_2 })],
      bindings: [
        binding(),
        binding({
          threadId: "thread-2",
          sessionName: SUB_NAME_2,
          agentName: SUB_NAME_2,
        }),
      ],
      ...DEFAULT_SCAN,
      enabled: true,
      log: cap.log,
      onQuiescent,
    });
    expect(onQuiescent).toHaveBeenCalledTimes(2);
    // Handler receives a CompletionSweepCandidate (not threadId)
    const firstArg = onQuiescent.mock.calls[0]![0] as { threadId: string };
    const secondArg = onQuiescent.mock.calls[1]![0] as { threadId: string };
    expect(firstArg.threadId).toBe("thread-1");
    expect(secondArg.threadId).toBe("thread-2");

    // The sweep itself no longer logs "firing completion relay" —
    // operator-visibility is the handler's concern now.
    const lines = cap.lines();
    expect(
      lines.find((l) => l.msg === "subagent quiescent — firing completion relay"),
    ).toBeUndefined();
  });

  it("does not log error when onQuiescent reports ok=false (handler return ignored)", async () => {
    const onQuiescent = vi
      .fn()
      .mockResolvedValue({ ok: false, reason: "deduped" });
    await tickSubagentCompletionSweep({
      sessions: [session()],
      bindings: [binding()],
      ...DEFAULT_SCAN,
      enabled: true,
      log: cap.log,
      onQuiescent,
    });
    expect(onQuiescent).toHaveBeenCalledTimes(1);
    const lines = cap.lines();
    expect(lines.find((l) => l.level === 50)).toBeUndefined();
  });

  it("logs error level for unexpected throws but does not propagate", async () => {
    const onQuiescent = vi
      .fn()
      .mockRejectedValueOnce(new Error("disk full"));
    await expect(
      tickSubagentCompletionSweep({
        sessions: [session()],
        bindings: [binding()],
        ...DEFAULT_SCAN,
        enabled: true,
        log: cap.log,
        onQuiescent,
      }),
    ).resolves.toBeUndefined();
    const errors = cap.lines().filter((l) => l.level === 50);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.err).toBe("disk full");
    expect(errors[0]!.action).toBe("onQuiescent-failed");
  });

  it("continues to the next candidate after a failure on the first", async () => {
    const onQuiescent = vi
      .fn()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce({ ok: true });
    await tickSubagentCompletionSweep({
      sessions: [session(), session({ name: SUB_NAME_2 })],
      bindings: [
        binding(),
        binding({
          threadId: "thread-2",
          sessionName: SUB_NAME_2,
          agentName: SUB_NAME_2,
        }),
      ],
      ...DEFAULT_SCAN,
      enabled: true,
      log: cap.log,
      onQuiescent,
    });
    expect(onQuiescent).toHaveBeenCalledTimes(2);
  });
});

describe("handleSubagentQuiescenceRelay (gated quiescence-relay path)", () => {
  // The dispatch helper is the seam between the sweep and the unified
  // `relayAndMarkCompletedByThreadId` path. Each test stubs the relay
  // deps with vi.fn() and asserts the helper either fires the relay or
  // returns a "needs-warning" outcome with a specific reason.

  let cap: ReturnType<typeof captureLogger>;
  beforeEach(() => {
    cap = captureLogger();
  });

  function candidate(
    overrides: Partial<CompletionSweepCandidate> = {},
  ): CompletionSweepCandidate {
    return {
      sessionName: SUB_NAME,
      threadId: "thread-1",
      idleSec: 10 * 60,
      lastDeliveryAt: NOW - 30_000,
      producedRealContent: true,
      ...overrides,
    };
  }

  function depsForRelay(opts: {
    bindings?: readonly ThreadBinding[];
    spawnerAvailable?: boolean;
  }): {
    deps: RelayAndMarkCompletedDeps;
    relayCall: ReturnType<typeof vi.fn>;
    mutateCall: ReturnType<typeof vi.fn>;
  } {
    const initialRegistry: ThreadBindingRegistry = {
      bindings: opts.bindings ?? [
        binding({ lastDeliveryAt: NOW - 30_000, producedRealContent: true }),
      ],
      updatedAt: NOW - 60_000,
    };
    let liveRegistry = initialRegistry;
    const relayCall = vi.fn().mockResolvedValue(null);
    const mutateCall = vi
      .fn()
      .mockImplementation(
        async (mutator: (r: ThreadBindingRegistry) => ThreadBindingRegistry) => {
          liveRegistry = mutator(liveRegistry);
          return liveRegistry;
        },
      );
    const deps: RelayAndMarkCompletedDeps = {
      readThreadRegistry: async () => liveRegistry,
      mutateThreadRegistry: mutateCall,
      relayCompletionToParent:
        opts.spawnerAvailable === false ? null : relayCall,
      now: () => NOW,
      log: cap.log,
      enabled: true,
      sleep: () => Promise.resolve(),
      deliveryRetry: { attempts: 1, delayMs: 0 },
    };
    return { deps, relayCall, mutateCall };
  }

  it("fires the relay when lastDeliveryAt stamped AND producedRealContent true", async () => {
    const { deps, relayCall, mutateCall } = depsForRelay({});
    const out = await handleSubagentQuiescenceRelay({
      candidate: candidate(),
      enabled: true,
      relayDeps: deps,
      log: cap.log,
    });
    expect(out.outcome).toBe("relayed");
    expect(relayCall).toHaveBeenCalledWith("thread-1");
    // completedAt is stamped via the critical-section mutator.
    expect(mutateCall).toHaveBeenCalled();
  });

  it("returns skipped-needs-warning when lastDeliveryAt is null (stamp not landed)", async () => {
    const { deps, relayCall } = depsForRelay({});
    const out = await handleSubagentQuiescenceRelay({
      candidate: candidate({ lastDeliveryAt: null }),
      enabled: true,
      relayDeps: deps,
      log: cap.log,
    });
    expect(out).toEqual({
      outcome: "skipped-needs-warning",
      reason: "no-delivery-stamp",
    });
    expect(relayCall).not.toHaveBeenCalled();
  });

  it("returns skipped-needs-warning when producedRealContent is false (placeholder-only turn)", async () => {
    const { deps, relayCall } = depsForRelay({});
    const out = await handleSubagentQuiescenceRelay({
      candidate: candidate({ producedRealContent: false }),
      enabled: true,
      relayDeps: deps,
      log: cap.log,
    });
    expect(out).toEqual({
      outcome: "skipped-needs-warning",
      reason: "no-real-content",
    });
    expect(relayCall).not.toHaveBeenCalled();
  });

  it("returns skipped-needs-warning when producedRealContent is null (legacy binding — unknown)", async () => {
    const { deps, relayCall } = depsForRelay({});
    const out = await handleSubagentQuiescenceRelay({
      candidate: candidate({ producedRealContent: null }),
      enabled: true,
      relayDeps: deps,
      log: cap.log,
    });
    expect(out).toEqual({
      outcome: "skipped-needs-warning",
      reason: "no-real-content",
    });
    expect(relayCall).not.toHaveBeenCalled();
  });

  it("returns skipped-needs-warning when the operator rollback knob disables relay-on-quiescence", async () => {
    const { deps, relayCall } = depsForRelay({});
    const out = await handleSubagentQuiescenceRelay({
      candidate: candidate(),
      enabled: false,
      relayDeps: deps,
      log: cap.log,
    });
    expect(out).toEqual({
      outcome: "skipped-needs-warning",
      reason: "disabled",
    });
    expect(relayCall).not.toHaveBeenCalled();
  });

  it("returns relayed=already-completed when the binding is already terminal (dedupe)", async () => {
    // The unified relay path checks `completedAt` and returns
    // `already-completed` idempotently. Our dispatcher passes that through
    // as a terminal outcome so the caller skips the idle warning.
    const { deps, relayCall } = depsForRelay({
      bindings: [
        binding({
          lastDeliveryAt: NOW - 30_000,
          producedRealContent: true,
          completedAt: NOW - 60_000,
        }),
      ],
    });
    const out = await handleSubagentQuiescenceRelay({
      candidate: candidate(),
      enabled: true,
      relayDeps: deps,
      log: cap.log,
    });
    expect(out).toEqual({ outcome: "relayed", reason: "already-completed" });
    expect(relayCall).not.toHaveBeenCalled();
  });

  it("falls back to skipped-needs-warning when the spawner is unavailable", async () => {
    const { deps } = depsForRelay({ spawnerAvailable: false });
    const out = await handleSubagentQuiescenceRelay({
      candidate: candidate(),
      enabled: true,
      relayDeps: deps,
      log: cap.log,
    });
    expect(out.outcome).toBe("skipped-needs-warning");
  });
});
