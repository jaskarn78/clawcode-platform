/**
 * Quick 260520-r70 — heartbeat inbox reconciler ack-emitter wiring tests.
 *
 * Verifies the heartbeat inbox check fires `context.inboxAckEmitter` once
 * per delivered message, AFTER markProcessed succeeds — and never when
 * markProcessed throws. Legacy paths with no emitter are unaffected.
 *
 * Mocks collaboration/inbox so no fs is touched.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { InboxMessage } from "../../../collaboration/types.js";
import type { CheckContext } from "../../types.js";

// ---------------------------------------------------------------------------
// Mock collaboration/inbox
// ---------------------------------------------------------------------------

const mockReadMessages = vi.fn<(dir: string) => Promise<readonly InboxMessage[]>>();
const mockMarkProcessed = vi.fn<(dir: string, id: string) => Promise<void>>();

vi.mock("../../../collaboration/inbox.js", () => ({
  readMessages: (...args: unknown[]) => mockReadMessages(args[0] as string),
  markProcessed: (...args: unknown[]) =>
    mockMarkProcessed(args[0] as string, args[1] as string),
  // WS-0 (quick 260716-u5h) — pure default-resolution helper, mirrored
  // verbatim (same idiom as the inbox-source test mock).
  resolveKind: (msg: { kind?: "message" | "ack" }) =>
    msg.kind === "ack" ? "ack" : "message",
}));

// Import after mocks.
import inboxCheck, { setInboxSourceActive } from "../inbox.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMessage(overrides: Partial<InboxMessage> = {}): InboxMessage {
  return {
    id: "msg-001",
    from: "agent-a",
    to: "agent-b",
    content: "hello there",
    timestamp: 1000,
    priority: "normal",
    ...overrides,
  };
}

type AckEmitterSpy = ReturnType<
  typeof vi.fn<(consumed: InboxMessage, consumerAgent: string) => Promise<void>>
>;

function makeContext(opts: {
  ackEmitter?: AckEmitterSpy;
  dispatchTurn?: ReturnType<typeof vi.fn>;
}): CheckContext {
  const dispatchTurn =
    opts.dispatchTurn ?? vi.fn().mockResolvedValue(undefined);
  const context = {
    agentName: "agent-b",
    sessionManager: {
      hasActiveTurn: () => false,
      getAgentConfig: () => ({ memoryPath: "/mem/agent-b" }),
      dispatchTurn,
    },
    registry: { entries: [], updatedAt: 0 },
    config: {
      enabled: true,
      intervalSeconds: 60,
      checkTimeoutSeconds: 10,
      contextFill: { warningThreshold: 0.6, criticalThreshold: 0.75 },
    },
  } as unknown as CheckContext;
  if (opts.ackEmitter) {
    (context as { inboxAckEmitter?: AckEmitterSpy }).inboxAckEmitter =
      opts.ackEmitter;
  }
  return context;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("heartbeat inbox check — inboxAckEmitter wiring", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Primary mode — process ALL messages (no staleness filter).
    setInboxSourceActive(false);
    mockMarkProcessed.mockResolvedValue(undefined);
  });

  it("invokes inboxAckEmitter once per delivered message after markProcessed", async () => {
    const ackEmitter: AckEmitterSpy = vi.fn().mockResolvedValue(undefined);
    mockReadMessages.mockResolvedValueOnce([
      makeMessage({ id: "m1", from: "agent-a" }),
      makeMessage({ id: "m2", from: "agent-c" }),
    ]);

    const result = await inboxCheck.execute(makeContext({ ackEmitter }));

    expect(ackEmitter).toHaveBeenCalledTimes(2);
    expect(ackEmitter.mock.calls[0][0].id).toBe("m1");
    expect(ackEmitter.mock.calls[0][1]).toBe("agent-b");
    expect(ackEmitter.mock.calls[1][0].id).toBe("m2");
    expect(result.status).toBe("healthy");
  });

  it("does NOT invoke inboxAckEmitter when markProcessed throws", async () => {
    const ackEmitter: AckEmitterSpy = vi.fn().mockResolvedValue(undefined);
    mockReadMessages.mockResolvedValueOnce([makeMessage({ id: "m1" })]);
    mockMarkProcessed.mockRejectedValueOnce(new Error("rename boom"));

    const result = await inboxCheck.execute(makeContext({ ackEmitter }));

    expect(ackEmitter).not.toHaveBeenCalled();
    // Delivery counted as failed → warning status.
    expect(result.status).toBe("warning");
  });

  it("behaves exactly as before when inboxAckEmitter is undefined", async () => {
    mockReadMessages.mockResolvedValueOnce([makeMessage({ id: "m1" })]);

    const result = await inboxCheck.execute(makeContext({}));

    expect(mockMarkProcessed).toHaveBeenCalledWith("/mem/agent-b/inbox", "m1");
    expect(result.status).toBe("healthy");
  });

  it("a throwing inboxAckEmitter does not fail the check (fire-and-forget)", async () => {
    const ackEmitter: AckEmitterSpy = vi
      .fn()
      .mockRejectedValue(new Error("ack boom"));
    mockReadMessages.mockResolvedValueOnce([makeMessage({ id: "m1" })]);

    const result = await inboxCheck.execute(makeContext({ ackEmitter }));

    // Delivery itself succeeded; the ack failure is swallowed.
    expect(result.status).toBe("healthy");
  });
});

// ---------------------------------------------------------------------------
// WS-0 quick 260716-u5h — ack messages are an audit record, never a turn.
// The 2026-07-16 Admin Clawdy incident: acks dispatched as turns fed the
// agent its own machinery output, generating buffered garbage responses.
// ---------------------------------------------------------------------------
describe("WS-0 quick 260716-u5h — ack turn-suppression", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setInboxSourceActive(false);
    mockMarkProcessed.mockResolvedValue(undefined);
  });

  it("an ack is markProcessed WITHOUT dispatchTurn and WITHOUT ack-emitter", async () => {
    const ackEmitter: AckEmitterSpy = vi.fn().mockResolvedValue(undefined);
    const dispatchTurn = vi.fn().mockResolvedValue(undefined);
    mockReadMessages.mockResolvedValueOnce([
      makeMessage({ id: "ack-1", kind: "ack", content: "✅ agent-b processed your message" }),
    ]);

    const result = await inboxCheck.execute(makeContext({ ackEmitter, dispatchTurn }));

    expect(dispatchTurn).not.toHaveBeenCalled();
    expect(ackEmitter).not.toHaveBeenCalled();
    expect(mockMarkProcessed).toHaveBeenCalledWith("/mem/agent-b/inbox", "ack-1");
    expect(result.status).toBe("healthy");
    expect((result.metadata as { acksSuppressed?: number }).acksSuppressed).toBe(1);
  });

  it("mixed batch: the genuine message dispatches, the ack is suppressed", async () => {
    const dispatchTurn = vi.fn().mockResolvedValue(undefined);
    mockReadMessages.mockResolvedValueOnce([
      makeMessage({ id: "ack-1", kind: "ack" }),
      makeMessage({ id: "m1", from: "agent-a", content: "real work" }),
    ]);

    const result = await inboxCheck.execute(makeContext({ dispatchTurn }));

    expect(dispatchTurn).toHaveBeenCalledTimes(1);
    expect(dispatchTurn).toHaveBeenCalledWith(
      "agent-b",
      "[Message from agent-a]: real work",
    );
    expect(mockMarkProcessed).toHaveBeenCalledTimes(2);
    expect((result.metadata as { acksSuppressed?: number }).acksSuppressed).toBe(1);
    expect((result.metadata as { delivered?: number }).delivered).toBe(1);
  });

  it("absent kind (legacy on-disk JSON) still dispatches as a genuine message", async () => {
    const dispatchTurn = vi.fn().mockResolvedValue(undefined);
    mockReadMessages.mockResolvedValueOnce([
      makeMessage({ id: "m-legacy", kind: undefined }),
    ]);

    const result = await inboxCheck.execute(makeContext({ dispatchTurn }));

    expect(dispatchTurn).toHaveBeenCalledTimes(1);
    expect(result.status).toBe("healthy");
  });

  it("markProcessed failure on an ack counts as failed (warning) — the file retries next tick", async () => {
    mockReadMessages.mockResolvedValueOnce([
      makeMessage({ id: "ack-1", kind: "ack" }),
    ]);
    mockMarkProcessed.mockRejectedValueOnce(new Error("rename boom"));

    const result = await inboxCheck.execute(makeContext({}));

    expect(result.status).toBe("warning");
  });
});
