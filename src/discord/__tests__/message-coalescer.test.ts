import { describe, it, expect } from "vitest";
import { MessageCoalescer } from "../message-coalescer.js";

/**
 * Phase 100 follow-up — message-coalescer unit tests.
 *
 * Operator-reported bug 2026-04-28: rapid-fire messages while the agent is
 * busy hit `SerialTurnQueue.QUEUE_FULL` (depth-1) and get ❌-reacted instead
 * of being processed. The coalescer is the per-agent buffer at the bridge
 * layer (upstream of SerialTurnQueue) so the depth-1 queue never overflows.
 *
 * MC-1: addMessage + takePending returns added in order
 * MC-2: takePending clears the buffer (subsequent take returns empty)
 * MC-3: per-agent isolation — one agent's pending doesn't affect another
 * MC-4: perAgentCap enforced — addMessage returns false at cap, doesn't push
 * MC-5: empty agent has takePending return [] cleanly
 */
describe("MessageCoalescer", () => {
  it("MC-1: addMessage + takePending returns added in order", () => {
    const coalescer = new MessageCoalescer();
    expect(coalescer.addMessage("agent-x", "first", "msg-1")).toBe(true);
    expect(coalescer.addMessage("agent-x", "second", "msg-2")).toBe(true);
    expect(coalescer.addMessage("agent-x", "third", "msg-3")).toBe(true);

    const pending = coalescer.takePending("agent-x");
    expect(pending.length).toBe(3);
    expect(pending[0].content).toBe("first");
    expect(pending[0].messageId).toBe("msg-1");
    expect(pending[1].content).toBe("second");
    expect(pending[1].messageId).toBe("msg-2");
    expect(pending[2].content).toBe("third");
    expect(pending[2].messageId).toBe("msg-3");
    // receivedAt should be set
    expect(typeof pending[0].receivedAt).toBe("number");
  });

  it("MC-2: takePending clears the buffer (subsequent take returns empty)", () => {
    const coalescer = new MessageCoalescer();
    coalescer.addMessage("agent-x", "one", "msg-1");
    coalescer.addMessage("agent-x", "two", "msg-2");

    const first = coalescer.takePending("agent-x");
    expect(first.length).toBe(2);

    const second = coalescer.takePending("agent-x");
    expect(second.length).toBe(0);
    expect(coalescer.getPendingCount("agent-x")).toBe(0);
  });

  it("MC-3: per-agent isolation — one agent's pending doesn't affect another", () => {
    const coalescer = new MessageCoalescer();
    coalescer.addMessage("agent-x", "x-msg", "msg-x1");
    coalescer.addMessage("agent-y", "y-msg-1", "msg-y1");
    coalescer.addMessage("agent-y", "y-msg-2", "msg-y2");

    expect(coalescer.getPendingCount("agent-x")).toBe(1);
    expect(coalescer.getPendingCount("agent-y")).toBe(2);

    const xPending = coalescer.takePending("agent-x");
    expect(xPending.length).toBe(1);
    expect(xPending[0].content).toBe("x-msg");
    // taking agent-x must NOT affect agent-y
    expect(coalescer.getPendingCount("agent-y")).toBe(2);

    const yPending = coalescer.takePending("agent-y");
    expect(yPending.length).toBe(2);
    expect(yPending[0].content).toBe("y-msg-1");
    expect(yPending[1].content).toBe("y-msg-2");
  });

  it("MC-4: perAgentCap enforced — addMessage returns false at cap, doesn't push", () => {
    const coalescer = new MessageCoalescer({ perAgentCap: 3 });
    expect(coalescer.addMessage("agent-x", "1", "m1")).toBe(true);
    expect(coalescer.addMessage("agent-x", "2", "m2")).toBe(true);
    expect(coalescer.addMessage("agent-x", "3", "m3")).toBe(true);
    // 4th hits cap — must return false and NOT push
    expect(coalescer.addMessage("agent-x", "4", "m4")).toBe(false);
    expect(coalescer.getPendingCount("agent-x")).toBe(3);

    const pending = coalescer.takePending("agent-x");
    expect(pending.length).toBe(3);
    expect(pending.map((m) => m.content)).toEqual(["1", "2", "3"]);
  });

  it("MC-5: empty agent has takePending return [] cleanly", () => {
    const coalescer = new MessageCoalescer();
    const pending = coalescer.takePending("never-seen-agent");
    expect(pending.length).toBe(0);
    expect(coalescer.getPendingCount("never-seen-agent")).toBe(0);
  });

  it("MC-6: default perAgentCap is 50", () => {
    const coalescer = new MessageCoalescer();
    for (let i = 0; i < 50; i++) {
      expect(coalescer.addMessage("agent-x", `msg-${i}`, `id-${i}`)).toBe(true);
    }
    // 51st must be rejected
    expect(coalescer.addMessage("agent-x", "msg-51", "id-51")).toBe(false);
    expect(coalescer.getPendingCount("agent-x")).toBe(50);
  });

  // -------------------------------------------------------------------------
  // Phase 999.11 Plan 00 — MC-7 RED test for the new requeue API.
  //
  // Note: the plan numbered this MC-6 but that label was already taken by the
  // existing "default perAgentCap is 50" test above, so this is MC-7. Tracked
  // in 999.11-00-SUMMARY.md as a numbering deviation.
  //
  // RED reason: `requeue` does not exist on MessageCoalescer today. The cast
  // below will compile (any-cast through the indexed access) but the call
  // throws "requeue is not a function" at runtime. Plan 02 adds the method.
  // -------------------------------------------------------------------------
  it("MC-7: requeue bypasses perAgentCap (push-back of already-accepted messages)", () => {
    // Build with cap=2 so we can verify push-back overflows the cap.
    const coalescer = new MessageCoalescer({ perAgentCap: 2 });
    expect(coalescer.addMessage("agent-x", "first", "msg-1")).toBe(true);
    expect(coalescer.addMessage("agent-x", "second", "msg-2")).toBe(true);
    // Cap reached.
    expect(coalescer.addMessage("agent-x", "third", "msg-3")).toBe(false);
    expect(coalescer.getPendingCount("agent-x")).toBe(2);

    // requeue MUST bypass the cap: these messages were already accepted
    // once and we're returning them after a deferred drain. Total now 4.
    (coalescer as unknown as {
      requeue: (
        agent: string,
        msgs: ReadonlyArray<{ content: string; messageId: string; receivedAt: number }>,
      ) => void;
    }).requeue("agent-x", [
      { content: "requeued-A", messageId: "rq-A", receivedAt: 100 },
      { content: "requeued-B", messageId: "rq-B", receivedAt: 101 },
    ]);

    // Buffer holds 4 entries — cap was bypassed.
    expect(coalescer.getPendingCount("agent-x")).toBe(4);
    const pending = coalescer.takePending("agent-x");
    expect(pending.length).toBe(4);
  });
});
