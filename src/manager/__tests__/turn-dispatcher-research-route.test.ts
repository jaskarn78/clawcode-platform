/**
 * Research auto-routing — the message trigger in TurnDispatcher.
 *
 * A Discord message that asks for a deep dive / research / a workflow gets the
 * `<research-routing>` block in front of it, only when the agent opts in
 * (`research.autoRoute`) AND research subagents are live in its session (a
 * research tracker is registered). Scheduled turns, other agents and ordinary
 * messages pass through untouched.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import pino from "pino";
import { TurnDispatcher } from "../turn-dispatcher.js";
import { makeRootOrigin } from "../turn-origin.js";
import { RESEARCH_ROUTE_BLOCK } from "../research-route.js";
import { registerResearchTracker, resetResearchRegistryForTests, type ResearchTrackerPort } from "../research-registry.js";

const silentLog = pino({ level: "silent" });

function makeSm(autoRoute: boolean | undefined) {
  const dispatchTurn = vi.fn(async (_agent: string, _message: string) => "ok");
  const streamFromAgent = vi.fn(async (_agent: string, _message: string) => "ok");
  const sm = {
    dispatchTurn,
    streamFromAgent,
    getTraceCollector: vi.fn(() => undefined),
    getAgentConfig: vi.fn(() => (autoRoute === undefined ? {} : { research: { autoRoute } })),
  };
  return { sm, dispatchTurn, streamFromAgent };
}

const tracker: ResearchTrackerPort = {
  occupiedSlots: () => 0,
  occupiedSlotsFor: () => 0,
  noteApprovedLaunch: () => undefined,
  sessionForKey: () => undefined,
};

afterEach(() => resetResearchRegistryForTests());

describe("TurnDispatcher research routing", () => {
  it("prepends the block to a Discord deep-dive request when opted in and research is live", async () => {
    registerResearchTracker("fin-client", tracker);
    const m = makeSm(true);
    const d = new TurnDispatcher({ sessionManager: m.sm as never, log: silentLog });
    await d.dispatch(makeRootOrigin("discord", "111"), "fin-client", "Can you do a deep dive on this fund?");
    const sent = m.dispatchTurn.mock.calls[0]![1];
    expect(sent.startsWith(RESEARCH_ROUTE_BLOCK)).toBe(true);
    expect(sent.endsWith("Can you do a deep dive on this fund?")).toBe(true);
  });

  it("applies on the streaming seam too", async () => {
    registerResearchTracker("fin-client", tracker);
    const m = makeSm(true);
    const d = new TurnDispatcher({ sessionManager: m.sm as never, log: silentLog });
    await d.dispatchStream(makeRootOrigin("discord", "112"), "fin-client", "run a workflow on these tickers", () => undefined);
    expect(m.streamFromAgent.mock.calls[0]![1].startsWith(RESEARCH_ROUTE_BLOCK)).toBe(true);
  });

  it("does nothing for ordinary messages, scheduled turns, opt-out agents or when research isn't live", async () => {
    const cases: Array<[boolean | undefined, boolean, "discord" | "scheduler", string]> = [
      [true, true, "discord", "thanks, send it tomorrow"],
      [true, true, "scheduler", "deep dive the morning numbers"],
      [false, true, "discord", "deep dive this"],
      [undefined, true, "discord", "deep dive this"],
      [true, false, "discord", "deep dive this"],
    ];
    for (const [autoRoute, live, kind, msg] of cases) {
      resetResearchRegistryForTests();
      if (live) registerResearchTracker("fin-client", tracker);
      const m = makeSm(autoRoute);
      const d = new TurnDispatcher({ sessionManager: m.sm as never, log: silentLog });
      await d.dispatch(makeRootOrigin(kind, "113"), "fin-client", msg);
      expect(m.dispatchTurn.mock.calls[0]![1]).toBe(msg);
    }
  });

  it("fails open when the config lookup throws", async () => {
    registerResearchTracker("fin-client", tracker);
    const m = makeSm(true);
    m.sm.getAgentConfig = vi.fn(() => {
      throw new Error("boom");
    });
    const d = new TurnDispatcher({ sessionManager: m.sm as never, log: silentLog });
    await d.dispatch(makeRootOrigin("discord", "114"), "fin-client", "deep dive this");
    expect(m.dispatchTurn.mock.calls[0]![1]).toBe("deep dive this");
  });
});
