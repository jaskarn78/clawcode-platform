/**
 * Quick 260520-r70 — shared inbox ack-emitter tests.
 *
 * Proves the agent-to-agent acknowledgment loop is correct:
 *  - Loop prevention: consuming a kind "ack" message produces NO further ack.
 *  - Cross-agent gating: a message whose `from` is not a fleet agent is a no-op.
 *  - Ack content shape: `✅ <agent> processed your message` + humanized line.
 *  - Discriminator: the emitted ack carries kind "ack" so the loop closes.
 *  - Delivery degradation: delivered=false (Discord degraded) does not throw.
 *  - Fire-and-forget: a throwing delivery closure is caught, never rejects.
 *  - createMessage extension: explicit kind round-trips; absent kind → "message".
 *  - Single-hook bifurcation guard: ONE emitter instance records emissions
 *    driven from two distinct consumer call-sites.
 *
 * Fully DI — no fs, no Discord, no daemon.
 */

import { describe, it, expect, vi } from "vitest";
import type { InboxMessage } from "../types.js";
import { createMessage, resolveKind } from "../inbox.js";
import {
  createInboxAckEmitter,
  type InboxAckDeps,
} from "../inbox-ack.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const FIXED_NOW = 1_700_000_000_000; // deterministic clock

function makeMessage(overrides: Partial<InboxMessage> = {}): InboxMessage {
  return {
    id: "msg-001",
    from: "agent-a",
    to: "agent-b",
    content: "hello there",
    timestamp: FIXED_NOW - 60_000, // sent 60s before "now"
    priority: "normal",
    ...overrides,
  };
}

type DeliverAckSpy = ReturnType<
  typeof vi.fn<
    (req: {
      from: string;
      to: string;
      message: string;
      kind: "ack";
    }) => Promise<{ ok: boolean; delivered: boolean }>
  >
>;

function makeDeps(
  overrides: Partial<InboxAckDeps> = {},
): InboxAckDeps & { deliverAck: DeliverAckSpy } {
  const deliverAck: DeliverAckSpy = vi
    .fn()
    .mockResolvedValue({ ok: true, delivered: true });
  return {
    fleetAgentNames: new Set(["agent-a", "agent-b", "agent-c"]),
    now: () => FIXED_NOW,
    deliverAck,
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    ...overrides,
  } as InboxAckDeps & { deliverAck: DeliverAckSpy };
}

// ---------------------------------------------------------------------------
// Loop prevention
// ---------------------------------------------------------------------------

describe("createInboxAckEmitter — loop prevention", () => {
  it("does NOT ack a consumed message whose kind === 'ack'", async () => {
    const deps = makeDeps();
    const emit = createInboxAckEmitter(deps);

    await emit(makeMessage({ kind: "ack" }), "agent-b");

    expect(deps.deliverAck).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Cross-agent gating
// ---------------------------------------------------------------------------

describe("createInboxAckEmitter — cross-agent gating", () => {
  it("does NOT ack a message whose `from` is not a fleet agent", async () => {
    const deps = makeDeps();
    const emit = createInboxAckEmitter(deps);

    // Simulates Phase 999.43 attachment-ingest / system/trigger messages.
    await emit(makeMessage({ from: "attachment-ingest" }), "agent-b");

    expect(deps.deliverAck).not.toHaveBeenCalled();
  });

  it("acks when `from` is a fleet agent and kind is ABSENT (legacy file)", async () => {
    const deps = makeDeps();
    const emit = createInboxAckEmitter(deps);

    const legacy = makeMessage();
    // legacy on-disk file: no `kind` at all
    expect(legacy.kind).toBeUndefined();
    await emit(legacy, "agent-b");

    expect(deps.deliverAck).toHaveBeenCalledTimes(1);
  });

  it("acks when `from` is a fleet agent and kind === 'message'", async () => {
    const deps = makeDeps();
    const emit = createInboxAckEmitter(deps);

    await emit(makeMessage({ kind: "message" }), "agent-b");

    expect(deps.deliverAck).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Ack content shape
// ---------------------------------------------------------------------------

describe("createInboxAckEmitter — ack content shape", () => {
  it("emits content with checkmark, agent name, 'processed' and a humanized time line", async () => {
    const deps = makeDeps();
    const emit = createInboxAckEmitter(deps);

    await emit(makeMessage(), "agent-b");

    expect(deps.deliverAck).toHaveBeenCalledTimes(1);
    const req = deps.deliverAck.mock.calls[0][0];
    expect(req.message).toContain("✅");
    expect(req.message).toContain("agent-b");
    expect(req.message).toContain("processed");
    // humanized "sent <hh:mm> · processed <hh:mm>" line
    expect(req.message).toMatch(/sent \d{2}:\d{2} · processed \d{2}:\d{2}/);
  });

  it("routes the ack from the consumer agent TO the original sender", async () => {
    const deps = makeDeps();
    const emit = createInboxAckEmitter(deps);

    await emit(makeMessage({ from: "agent-a" }), "agent-b");

    const req = deps.deliverAck.mock.calls[0][0];
    expect(req.from).toBe("agent-b"); // the consumer
    expect(req.to).toBe("agent-a"); // the original sender
  });
});

// ---------------------------------------------------------------------------
// Discriminator / loop closure
// ---------------------------------------------------------------------------

describe("createInboxAckEmitter — discriminator", () => {
  it("delivers the ack with kind === 'ack' so a future consume is a no-op", async () => {
    const deps = makeDeps();
    const emit = createInboxAckEmitter(deps);

    await emit(makeMessage(), "agent-b");

    const req = deps.deliverAck.mock.calls[0][0];
    expect(req.kind).toBe("ack");

    // End-to-end closure: feeding that emitted ack back through the emitter
    // (as if the original sender consumed it) produces ZERO further acks.
    deps.deliverAck.mockClear();
    const emittedAck = makeMessage({
      from: req.from,
      to: req.to,
      content: req.message,
      kind: req.kind,
    });
    await emit(emittedAck, "agent-a");
    expect(deps.deliverAck).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Delivery degradation + fire-and-forget
// ---------------------------------------------------------------------------

describe("createInboxAckEmitter — delivery degradation", () => {
  it("resolves successfully when Discord post degraded (delivered: false, ok: true)", async () => {
    const deps = makeDeps();
    deps.deliverAck.mockResolvedValue({ ok: true, delivered: false });
    const emit = createInboxAckEmitter(deps);

    await expect(emit(makeMessage(), "agent-b")).resolves.toBeUndefined();
  });
});

describe("createInboxAckEmitter — fire-and-forget", () => {
  it("catches a throwing delivery closure, logs, and never rejects", async () => {
    const deps = makeDeps();
    deps.deliverAck.mockRejectedValue(new Error("delivery boom"));
    const emit = createInboxAckEmitter(deps);

    await expect(emit(makeMessage(), "agent-b")).resolves.toBeUndefined();
    expect(deps.log.warn).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// createMessage extension
// ---------------------------------------------------------------------------

describe("createMessage — kind extension", () => {
  it("returns kind 'ack' when explicitly passed", () => {
    const msg = createMessage("a", "b", "hi", "normal", "ack");
    expect(msg.kind).toBe("ack");
    expect(resolveKind(msg)).toBe("ack");
  });

  it("returns kind 'message' when no kind arg is supplied", () => {
    const msg = createMessage("a", "b", "hi");
    expect(msg.kind).toBe("message");
    expect(resolveKind(msg)).toBe("message");
  });

  it("resolveKind treats an absent kind as 'message'", () => {
    expect(resolveKind({})).toBe("message");
    expect(resolveKind({ kind: undefined })).toBe("message");
  });
});

// ---------------------------------------------------------------------------
// Single-hook bifurcation guard
// ---------------------------------------------------------------------------

describe("createInboxAckEmitter — single-hook bifurcation guard", () => {
  it("one emitter instance records emissions from two distinct consumer call-sites", async () => {
    const deps = makeDeps();
    // ONE emitter instance — both inbox consumers (InboxSource + heartbeat
    // reconciler) must share this exact instance. No bifurcation.
    const emit = createInboxAckEmitter(deps);

    // Call-site 1 — InboxSource-style consume.
    await emit(makeMessage({ id: "from-inbox-source", from: "agent-a" }), "agent-b");
    // Call-site 2 — heartbeat-reconciler-style consume.
    await emit(makeMessage({ id: "from-heartbeat", from: "agent-c" }), "agent-b");

    // The SAME injected deliverAck spy recorded both — single hook proven.
    expect(deps.deliverAck).toHaveBeenCalledTimes(2);
    expect(deps.deliverAck.mock.calls[0][0].to).toBe("agent-a");
    expect(deps.deliverAck.mock.calls[1][0].to).toBe("agent-c");
  });
});
