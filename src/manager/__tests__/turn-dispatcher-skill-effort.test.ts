/**
 * Phase 83 Plan 03 Task 2 (RED→GREEN) — per-skill effort override in TurnDispatcher.
 *
 * EFFORT-05: when a skill's SKILL.md carries an `effort:` frontmatter and
 * that skill is invoked, the dispatcher must:
 *   1. Capture the current effort via handle.getEffort().
 *   2. Call handle.setEffort(skillEffort) BEFORE the send.
 *   3. Proceed with the normal send/stream.
 *   4. In a finally block, call handle.setEffort(priorEffort) — this runs
 *      even on errors, so one runaway turn cannot leave an agent stuck at
 *      an elevated level.
 *
 * Skills without `effort:` (skillEffort undefined) must NOT trigger any
 * setEffort call — zero side effects on the normal path.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import pino from "pino";
import { TurnDispatcher } from "../turn-dispatcher.js";
import { makeRootOrigin } from "../turn-origin.js";

const silentLog = pino({ level: "silent" });

/**
 * Make a mock SessionManager shaped like the real one, but with spy surfaces
 * for setEffort/getEffort on the per-agent handle. The dispatcher must reach
 * into the handle to apply + restore effort; to make that observable we expose
 * the effort surface on the SessionManager directly (mirroring the
 * setEffortForAgent / getEffortForAgent pair that already exists).
 */
function makeMockSessionManager(initialEffort: string = "low") {
  let currentEffort = initialEffort;
  const setEffortForAgent = vi.fn((_name: string, level: string) => {
    currentEffort = level;
  });
  const getEffortForAgent = vi.fn((_name: string) => currentEffort);

  const dispatchTurn = vi.fn(async () => "mock-response");
  const streamFromAgent = vi.fn(async () => "mock-stream");
  const getTraceCollector = vi.fn(() => undefined);

  const sm = {
    dispatchTurn,
    streamFromAgent,
    getTraceCollector,
    setEffortForAgent,
    getEffortForAgent,
  };
  return { sm, setEffortForAgent, getEffortForAgent, dispatchTurn, streamFromAgent };
}

describe("TurnDispatcher — per-skill effort override (EFFORT-05)", () => {
  let mock: ReturnType<typeof makeMockSessionManager>;
  let dispatcher: TurnDispatcher;

  beforeEach(() => {
    mock = makeMockSessionManager("low");
    dispatcher = new TurnDispatcher({
      sessionManager: mock.sm as never,
      log: silentLog,
    });
  });

  it("applies skillEffort before send + restores priorEffort after (happy path)", async () => {
    const origin = makeRootOrigin("discord", "msg-1");
    await dispatcher.dispatch(origin, "alice", "do a hard thing", {
      skillEffort: "max",
    } as never);

    // setEffort called twice: pre-turn override + post-turn revert.
    expect(mock.setEffortForAgent).toHaveBeenCalledTimes(2);
    expect(mock.setEffortForAgent.mock.calls[0]).toEqual(["alice", "max"]);
    expect(mock.setEffortForAgent.mock.calls[1]).toEqual(["alice", "low"]);
    // Ordering: pre-turn override BEFORE dispatchTurn, revert AFTER.
    const preOrder = mock.setEffortForAgent.mock.invocationCallOrder[0];
    const sendOrder = mock.dispatchTurn.mock.invocationCallOrder[0];
    const postOrder = mock.setEffortForAgent.mock.invocationCallOrder[1];
    expect(preOrder).toBeLessThan(sendOrder);
    expect(sendOrder).toBeLessThan(postOrder);
  });

  it("restores priorEffort even when send throws (try/finally contract)", async () => {
    const error = new Error("upstream-boom");
    mock.sm.dispatchTurn = vi.fn(async () => { throw error; });
    dispatcher = new TurnDispatcher({ sessionManager: mock.sm as never, log: silentLog });

    const origin = makeRootOrigin("discord", "msg-2");
    await expect(
      dispatcher.dispatch(origin, "alice", "hi", { skillEffort: "max" } as never),
    ).rejects.toBe(error);

    // setEffort still called twice (pre + finally-revert).
    expect(mock.setEffortForAgent).toHaveBeenCalledTimes(2);
    expect(mock.setEffortForAgent.mock.calls[0]).toEqual(["alice", "max"]);
    expect(mock.setEffortForAgent.mock.calls[1]).toEqual(["alice", "low"]);
  });

  it("does NOT call setEffort when skillEffort is omitted (zero side effects)", async () => {
    const origin = makeRootOrigin("discord", "msg-3");
    await dispatcher.dispatch(origin, "alice", "no skill in sight");

    expect(mock.setEffortForAgent).not.toHaveBeenCalled();
    expect(mock.dispatchTurn).toHaveBeenCalledTimes(1);
  });

  it("does NOT call setEffort when skillEffort is explicitly undefined", async () => {
    const origin = makeRootOrigin("discord", "msg-4");
    await dispatcher.dispatch(origin, "alice", "normal message", {
      skillEffort: undefined,
    } as never);

    expect(mock.setEffortForAgent).not.toHaveBeenCalled();
  });

  // Quick 260715-j1j (D9, layer 2) — defensive clamp: even if the scanner's
  // frontmatter rejection (layer 1) is bypassed, the dispatcher must never
  // pass "ultracode" through to setEffortForAgent — it clamps to "xhigh".
  it("clamps skillEffort 'ultracode' → 'xhigh' before setEffortForAgent (defense layer 2)", async () => {
    const origin = makeRootOrigin("discord", "msg-uc");
    await dispatcher.dispatch(origin, "alice", "sneaky skill", {
      skillEffort: "ultracode",
    } as never);

    // Pre-turn apply used the CLAMPED level; revert restores the prior.
    expect(mock.setEffortForAgent).toHaveBeenCalledTimes(2);
    expect(mock.setEffortForAgent.mock.calls[0]).toEqual(["alice", "xhigh"]);
    expect(mock.setEffortForAgent.mock.calls[1]).toEqual(["alice", "low"]);
    // The literal "ultracode" never crossed the SessionManager boundary.
    for (const call of mock.setEffortForAgent.mock.calls) {
      expect(call[1]).not.toBe("ultracode");
    }
  });

  it("dispatchStream also honors skillEffort pre/post wrap", async () => {
    const origin = makeRootOrigin("discord", "msg-5");
    await dispatcher.dispatchStream(
      origin,
      "alice",
      "stream test",
      () => {},
      { skillEffort: "high" } as never,
    );

    expect(mock.setEffortForAgent).toHaveBeenCalledTimes(2);
    expect(mock.setEffortForAgent.mock.calls[0]).toEqual(["alice", "high"]);
    expect(mock.setEffortForAgent.mock.calls[1]).toEqual(["alice", "low"]);
    const sendOrder = mock.streamFromAgent.mock.invocationCallOrder[0];
    const preOrder = mock.setEffortForAgent.mock.invocationCallOrder[0];
    const postOrder = mock.setEffortForAgent.mock.invocationCallOrder[1];
    expect(preOrder).toBeLessThan(sendOrder);
    expect(sendOrder).toBeLessThan(postOrder);
  });

  it("dispatchStream restores priorEffort even when stream throws", async () => {
    const error = new Error("stream-boom");
    mock.sm.streamFromAgent = vi.fn(async () => { throw error; });
    dispatcher = new TurnDispatcher({ sessionManager: mock.sm as never, log: silentLog });

    const origin = makeRootOrigin("discord", "msg-6");
    await expect(
      dispatcher.dispatchStream(
        origin,
        "alice",
        "stream-fail",
        () => {},
        { skillEffort: "xhigh" } as never,
      ),
    ).rejects.toBe(error);

    expect(mock.setEffortForAgent).toHaveBeenCalledTimes(2);
    expect(mock.setEffortForAgent.mock.calls[1]).toEqual(["alice", "low"]);
  });

  it("captures the prior effort AT the moment of dispatch (not at dispatcher construction)", async () => {
    // Simulate the agent already being at "medium" from a previous /clawcode-effort call.
    mock = makeMockSessionManager("medium");
    dispatcher = new TurnDispatcher({ sessionManager: mock.sm as never, log: silentLog });

    const origin = makeRootOrigin("discord", "msg-7");
    await dispatcher.dispatch(origin, "alice", "hi", {
      skillEffort: "max",
    } as never);

    // Revert target must be the LIVE "medium", not the constructor-time "low".
    expect(mock.setEffortForAgent.mock.calls[1]).toEqual(["alice", "medium"]);
  });

  it("getEffortForAgent called exactly once (to snapshot prior), before the first setEffort", async () => {
    const origin = makeRootOrigin("discord", "msg-8");
    await dispatcher.dispatch(origin, "alice", "hi", {
      skillEffort: "high",
    } as never);

    expect(mock.getEffortForAgent).toHaveBeenCalledTimes(1);
    expect(mock.getEffortForAgent).toHaveBeenCalledWith("alice");
    const getOrder = mock.getEffortForAgent.mock.invocationCallOrder[0];
    const setOrder = mock.setEffortForAgent.mock.invocationCallOrder[0];
    expect(getOrder).toBeLessThan(setOrder);
  });
});
