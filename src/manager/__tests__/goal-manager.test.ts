/**
 * GoalManager wiring tests — mock all injected deps (bridge, model, channel
 * sink). Proves the daemon-side glue without a live daemon:
 *   - drives turns via the bridge (push + awaitReply) with the ack instruction
 *   - judges via the injected model, posts progress + a final outcome
 *   - v2 fallback uses dispatchTurn when there's no bridge
 *   - clear() aborts + cancelPendingReplies (which rejects the hung awaitReply,
 *     exactly as the real bridge does on /clawcode-interrupt)
 *   - status() reflects running state; replacing a goal cancels the old loop
 */
import { describe, it, expect, vi } from "vitest";
import {
  GoalManager,
  formatOutcome,
  type GoalManagerDeps,
  type GoalBridgeLike,
} from "../goal-manager.js";

const CONFIG = { backstopMaxTurns: 50, backstopDeadlineMs: 3_600_000, turnTimeoutMs: 60_000 };

/**
 * Controllable fake bridge. `replies` is consumed per turn; the sentinel "hang"
 * makes that turn's awaitReply never resolve on its own — only a later
 * cancelPendingReplies rejects it (with a ChannelReplyInterruptedError, exactly
 * like the production bridge). That faithfully models mid-turn cancel.
 */
function controllableBridge(replies: ReadonlyArray<string | "hang">) {
  const pendingRejects: Array<(e: Error) => void> = [];
  let i = 0;
  return {
    pushed: [] as Array<{ message_id: string; content: string }>,
    cancelled: 0,
    push(msg: { message_id: string; content: string }) {
      this.pushed.push({ message_id: msg.message_id, content: msg.content });
    },
    awaitReply(_corr: string): Promise<{ result?: string }> {
      const r = replies[i++];
      if (r === "hang") {
        return new Promise((_resolve, reject) => pendingRejects.push(reject));
      }
      return Promise.resolve({ result: r ?? "no more replies" });
    },
    cancelPendingReplies(reason: string): number {
      this.cancelled++;
      const err = new Error(`aborted: ${reason}`);
      err.name = "ChannelReplyInterruptedError";
      const n = pendingRejects.length;
      pendingRejects.splice(0).forEach((rej) => rej(err));
      return n;
    },
  } satisfies GoalBridgeLike & {
    pushed: Array<{ message_id: string; content: string }>;
    cancelled: number;
  };
}

function makeDeps(over: Partial<GoalManagerDeps> = {}): GoalManagerDeps {
  let n = 0;
  return {
    getBridge: () => undefined,
    dispatchTurn: vi.fn(async () => "v2 reply"),
    callModel: vi.fn(async () => '{"met": true, "reason": "ok"}'),
    sendToChannel: vi.fn(async () => {}),
    newCorrelationId: () => `corr-${++n}`,
    now: () => Date.now(),
    log: { info: vi.fn(), warn: vi.fn() },
    config: CONFIG,
    ...over,
  };
}

/** Wait for the background loop + final post to settle. */
async function settle(): Promise<void> {
  await new Promise((r) => setTimeout(r, 20));
}

describe("GoalManager", () => {
  it("drives turns via the bridge with an ack instruction, then posts outcome", async () => {
    const bridge = controllableBridge(["did the work, all 3 tests pass"]);
    const sent: string[] = [];
    const callModel = vi
      .fn<GoalManagerDeps["callModel"]>()
      .mockResolvedValue('{"met": true, "reason": "all green shown"}');
    const mgr = new GoalManager(
      makeDeps({
        getBridge: () => bridge,
        callModel,
        sendToChannel: async (_a, t) => void sent.push(t),
      }),
    );

    const { replaced } = mgr.start("personal", "tests pass");
    expect(replaced).toBe(false);
    await settle();

    expect(bridge.pushed).toHaveLength(1);
    expect(bridge.pushed[0].content).toContain("tests pass");
    expect(bridge.pushed[0].content).toContain("clawcode_ack");
    expect(bridge.pushed[0].message_id).toBe("corr-1");
    expect(callModel.mock.calls[0][1]).toContain("all 3 tests pass");
    expect(sent.some((s) => s.includes("turn 1"))).toBe(true);
    expect(sent.some((s) => s.includes("Goal accomplished"))).toBe(true);
    expect(mgr.status("personal")).toEqual({ running: false });
  });

  it("falls back to dispatchTurn for v2 agents (no bridge)", async () => {
    const dispatchTurn = vi.fn(async () => "v2 did it");
    const callModel = vi
      .fn<GoalManagerDeps["callModel"]>()
      .mockResolvedValue('{"met": true, "reason": "done"}');
    const mgr = new GoalManager(makeDeps({ getBridge: () => undefined, dispatchTurn, callModel }));
    mgr.start("legacy", "do X");
    await settle();
    expect(dispatchTurn).toHaveBeenCalledTimes(1);
    expect(callModel.mock.calls[0][1]).toContain("v2 did it");
  });

  it("reports running status with turns + last reason mid-flight", async () => {
    const bridge = controllableBridge(["turn 1 work", "hang"]); // turn 2 parks
    const mgr = new GoalManager(
      makeDeps({
        getBridge: () => bridge,
        callModel: vi.fn(async () => '{"met": false, "reason": "still 1 failing"}'),
      }),
    );
    mgr.start("personal", "tests pass");
    await settle();
    const st = mgr.status("personal");
    expect(st.running).toBe(true);
    if (st.running) {
      expect(st.turns).toBe(1);
      expect(st.lastReason).toContain("still 1 failing");
    }
    mgr.clear("personal"); // cleanup the parked loop
    await settle();
    expect(mgr.status("personal")).toEqual({ running: false });
  });

  it("clear() aborts the loop and cancels pending replies", async () => {
    const bridge = controllableBridge(["hang"]); // parks on turn 1
    const sent: string[] = [];
    const mgr = new GoalManager(
      makeDeps({ getBridge: () => bridge, sendToChannel: async (_a, t) => void sent.push(t) }),
    );
    mgr.start("personal", "long goal");
    await settle();
    const res = mgr.clear("personal");
    expect(res.wasRunning).toBe(true);
    await settle();
    expect(bridge.cancelled).toBeGreaterThan(0);
    expect(mgr.status("personal")).toEqual({ running: false });
    expect(sent.some((s) => s.includes("Goal cleared"))).toBe(true);
  });

  it("clear() on no active goal is a no-op", () => {
    const mgr = new GoalManager(makeDeps());
    expect(mgr.clear("nobody")).toEqual({ wasRunning: false });
  });

  it("replacing a running goal cancels the old loop without nuking the new record", async () => {
    const bridge = controllableBridge(["hang", "hang"]); // both goals park
    const mgr = new GoalManager(makeDeps({ getBridge: () => bridge }));
    mgr.start("personal", "first goal");
    await settle();
    const { replaced } = mgr.start("personal", "second goal");
    expect(replaced).toBe(true);
    await settle();
    const st = mgr.status("personal");
    expect(st.running).toBe(true);
    if (st.running) expect(st.condition).toBe("second goal");
    mgr.clear("personal");
    await settle();
  });
});

describe("formatOutcome", () => {
  it("renders each terminal status distinctly", () => {
    expect(formatOutcome("c", { status: "met", turns: 2, reason: "r", history: [] })).toContain(
      "accomplished",
    );
    expect(formatOutcome("c", { status: "cancelled", turns: 1, history: [] })).toContain("cleared");
    expect(
      formatOutcome("c", { status: "backstop", turns: 9, reason: "runaway", history: [] }),
    ).toContain("stopped");
    expect(formatOutcome("c", { status: "error", turns: 0, error: "boom", history: [] })).toContain(
      "boom",
    );
  });
});
