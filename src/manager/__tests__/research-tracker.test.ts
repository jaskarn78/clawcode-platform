import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ResearchTracker } from "../research-tracker.js";
import type { ResearchCardPort, ResearchCardSnapshot } from "../research-card-sink.js";
import { resetResearchRegistryForTests, setLiveDiscordTurn } from "../research-registry.js";

const AGENT = "personal";
const ORIGIN = { turnId: "discord:000000000000000118", messageId: "000000000000000118", channelId: "000000000000000106" };
const REPLY_TO = { channelId: ORIGIN.channelId, messageId: ORIGIN.messageId };

const started = (taskId: string, toolUseId: string, subagentType = "researcher", description = `look into ${taskId}`) => ({
  type: "system",
  subtype: "task_started",
  task_id: taskId,
  tool_use_id: toolUseId,
  description,
  subagent_type: subagentType,
  is_backgrounded: true,
});
const progress = (taskId: string, summary?: string, tool?: string) => ({
  type: "system",
  subtype: "task_progress",
  task_id: taskId,
  description: "d",
  usage: { total_tokens: 1, tool_uses: 1, duration_ms: 1 },
  ...(summary ? { summary } : {}),
  ...(tool ? { last_tool_name: tool } : {}),
});
const notified = (taskId: string, status = "completed") => ({
  type: "system",
  subtype: "task_notification",
  task_id: taskId,
  status,
  summary: "s",
  output_file: "/o",
});
/** A self-fired wake turn closing (the demux reports its result before it routes the output). */
const wakeResult = () => ({ type: "result", subtype: "success", result: "", origin: { kind: "task-notification" } });
function wake(tracker: ResearchTracker, text: string) {
  tracker.observe(wakeResult());
  return tracker.routeOrphanOutput(text);
}
const liveSet = (ids: string[]) => ({
  type: "system",
  subtype: "background_tasks_changed",
  tasks: ids.map((id) => ({ task_id: id, task_type: "local_agent", description: "d" })),
});

function fakePort() {
  const posts: ResearchCardSnapshot[] = [];
  const edits: ResearchCardSnapshot[] = [];
  const port: ResearchCardPort = {
    post: vi.fn(async (_c: string, snap: ResearchCardSnapshot) => {
      posts.push(snap);
      return "card-1";
    }),
    edit: vi.fn(async (_c: string, _m: string, snap: ResearchCardSnapshot) => {
      edits.push(snap);
    }),
  };
  return { port, posts, edits, last: () => edits[edits.length - 1] ?? posts[posts.length - 1] };
}

function make(opts: { port?: ResearchCardPort; max?: number; hold?: number } = {}) {
  const stopTask = vi.fn(() => Promise.resolve());
  const delivered: { text: string; replyTo: unknown }[] = [];
  const tracker = new ResearchTracker({
    agentName: AGENT,
    maxConcurrent: opts.max ?? 4,
    holdTimeoutMs: opts.hold ?? 20 * 60_000,
    stopTask,
    deliver: (text, replyTo) => delivered.push({ text, replyTo }),
    cardPort: () => opts.port,
    repaintMs: 10,
    synthesisWaitMs: 1000,
    stragglerQuietMs: 500,
    log: { info: () => undefined, warn: () => undefined },
  });
  return { tracker, stopTask, delivered };
}

beforeEach(() => {
  setLiveDiscordTurn(AGENT, ORIGIN);
});
afterEach(() => {
  resetResearchRegistryForTests();
  vi.useRealTimers();
});

describe("ResearchTracker (999.173)", () => {
  it("probe sequence: interim turn folds, the final self-fired turn replies to the origin", () => {
    const { tracker, delivered } = make();
    tracker.noteApprovedLaunch("toolu_A", ORIGIN);
    tracker.noteApprovedLaunch("toolu_B", ORIGIN);
    tracker.observe(liveSet([]));
    tracker.observe(started("a1", "toolu_A"));
    tracker.observe(started("a2", "toolu_B"));
    expect(tracker.occupiedSlots()).toBe(2);

    tracker.observe(notified("a1"));
    expect(wake(tracker, "Mercury done, Venus still running")).toEqual({ kind: "fold" });

    tracker.observe(notified("a2"));
    expect(wake(tracker, "Here is the synthesis")).toEqual({ kind: "reply", replyTo: REPLY_TO });
    // Session over: later self-fired output is ordinary.
    expect(tracker.routeOrphanOutput("unrelated monitor output")).toEqual({ kind: "pass" });
    expect(delivered).toEqual([]);
  });

  it("passes orphan output through when no research is running", () => {
    const { tracker } = make();
    expect(tracker.routeOrphanOutput("hello")).toEqual({ kind: "pass" });
  });

  it("ignores non-researcher tasks (a Bash task, another subagent type)", () => {
    const { tracker } = make();
    tracker.observe(started("b1", "toolu_X", "general-purpose"));
    tracker.observe({ type: "system", subtype: "task_started", task_id: "bash1", tool_use_id: "toolu_Y", description: "ls" });
    expect(tracker.occupiedSlots()).toBe(0);
    expect(tracker.routeOrphanOutput("x")).toEqual({ kind: "pass" });
  });

  it("background_tasks_changed has REPLACE semantics — a vanished researcher has ended", () => {
    const { tracker } = make();
    tracker.observe(started("a1", "toolu_A"));
    tracker.observe(started("a2", "toolu_B"));
    tracker.observe(liveSet(["a2"]));
    expect(tracker.occupiedSlots()).toBe(1);
    tracker.observe(liveSet([]));
    expect(tracker.routeOrphanOutput("synthesis")).toMatchObject({ kind: "reply" });
  });

  it("2026-09-25 probe order: completions mid-turn, an EMPTY wake, filler after all ended, then the synthesis", () => {
    const { tracker, delivered } = make();
    tracker.observe(started("a1", "t1"));
    tracker.observe(started("a2", "t2"));
    tracker.observe(started("a3", "t3"));
    // Two researchers finish while the parent's own (daemon) turn is still open.
    tracker.observe(liveSet(["a1", "a3"]));
    tracker.observe(notified("a2"));
    tracker.observe(liveSet(["a3"]));
    tracker.observe(notified("a1"));
    // The daemon turn closes (no origin): not a wake.
    tracker.observe({ type: "result", subtype: "success", result: "Three researchers launched" });
    // Wake #1 is empty: its result is observed, onOrphanOutput never fires.
    tracker.observe(wakeResult());
    // The last researcher ends while wake #2 runs.
    tracker.observe(liveSet([]));
    tracker.observe(notified("a3"));
    // Wake #2 is filler even though every researcher has ended.
    expect(wake(tracker, "Two agents finished. Waiting for the comparative analysis.")).toEqual({ kind: "fold" });
    // Wake #3 is the synthesis.
    expect(wake(tracker, "## Mercury vs Venus")).toEqual({ kind: "reply", replyTo: REPLY_TO });
    expect(delivered).toEqual([]);
  });

  it("the fallback never pre-empts a self-fired turn that is still running (long synthesis)", () => {
    vi.useFakeTimers();
    const { tracker, delivered } = make();
    tracker.observe(started("a1", "t1"));
    tracker.observe(started("a2", "t2"));
    tracker.observe(notified("a1"));
    tracker.observe(notified("a2"));
    expect(wake(tracker, "filler")).toEqual({ kind: "fold" });
    // The synthesis wake opens and thinks silently well past the quiet window.
    tracker.setSelfFiredTurnOpen(true);
    vi.advanceTimersByTime(5_000);
    expect(delivered).toEqual([]);
    tracker.setSelfFiredTurnOpen(false);
    expect(wake(tracker, "the synthesis")).toEqual({ kind: "reply", replyTo: REPLY_TO });
    vi.advanceTimersByTime(5_000);
    expect(delivered).toEqual([]);
  });

  it("wakes folded by the CLI (count never settles): after quiet, the LATEST output is delivered as the reply", () => {
    vi.useFakeTimers();
    const { tracker, delivered } = make();
    tracker.observe(started("a1", "t1"));
    tracker.observe(started("a2", "t2"));
    tracker.observe(notified("a1"));
    tracker.observe(notified("a2"));
    // Only ONE wake turn arrives for the two completions.
    expect(wake(tracker, "the synthesis")).toEqual({ kind: "fold" });
    vi.advanceTimersByTime(501);
    expect(delivered).toEqual([{ text: "the synthesis", replyTo: REPLY_TO }]);
    expect(tracker.routeOrphanOutput("later")).toEqual({ kind: "pass" });
  });

  it("researcher lanes are detached (their child frames never feed a daemon turn)", () => {
    const { tracker } = make();
    tracker.noteApprovedLaunch("toolu_A", ORIGIN);
    expect(tracker.isDetachedChild("toolu_A")).toBe(true);
    tracker.observe(started("a2", "toolu_B"));
    expect(tracker.isDetachedChild("toolu_B")).toBe(true);
    expect(tracker.isDetachedChild("toolu_foreground")).toBe(false);
  });

  it("stops a researcher that starts over the cap (backstop)", () => {
    const { tracker, stopTask } = make({ max: 2 });
    tracker.observe(started("a1", "t1"));
    tracker.observe(started("a2", "t2"));
    expect(stopTask).not.toHaveBeenCalled();
    tracker.observe(started("a3", "t3"));
    expect(stopTask).toHaveBeenCalledWith("a3");
  });

  it("approvals count toward the cap until task_started, and expire", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const { tracker } = make();
    tracker.noteApprovedLaunch("t1", ORIGIN);
    expect(tracker.occupiedSlots()).toBe(1);
    vi.setSystemTime(3 * 60_000);
    expect(tracker.occupiedSlots()).toBe(0);
  });

  it("fail-open on swap/close: running researchers are lost, folded text is delivered as a reply", () => {
    const { tracker, delivered } = make();
    tracker.observe(started("a1", "t1"));
    tracker.observe(started("a2", "t2"));
    tracker.observe(notified("a1"));
    wake(tracker, "first findings");
    tracker.failOpen("swap");
    expect(delivered).toEqual([{ text: "first findings", replyTo: REPLY_TO }]);
    expect(tracker.routeOrphanOutput("late")).toEqual({ kind: "pass" });
  });

  it("fail-open with nothing folded delivers nothing (never an empty post)", () => {
    const { tracker, delivered } = make();
    tracker.observe(started("a1", "t1"));
    tracker.dispose();
    expect(delivered).toEqual([]);
  });

  it("hold timeout: STOPS the still-running researchers, settles, delivers what is folded; later completions pass through", () => {
    vi.useFakeTimers();
    const { tracker, delivered, stopTask } = make({ hold: 60_000 });
    tracker.observe(started("a1", "t1"));
    tracker.observe(started("a2", "t2"));
    tracker.observe(notified("a1"));
    wake(tracker, "partial");
    vi.advanceTimersByTime(60_001);
    expect(stopTask).toHaveBeenCalledTimes(1);
    expect(stopTask).toHaveBeenCalledWith("a2");
    expect(delivered).toEqual([{ text: "partial", replyTo: REPLY_TO }]);
    // The stop frees the slot immediately (never untracked past the cap).
    expect(tracker.occupiedSlots()).toBe(0);
    tracker.observe(notified("a2", "stopped"));
    expect(wake(tracker, "synthesis after timeout")).toEqual({ kind: "pass" });
  });

  it("hold timeout also stops approved launches that never started (deferred, by tool_use id)", () => {
    vi.useFakeTimers();
    const stopForToolUse = vi.fn();
    const stopTask = vi.fn(() => Promise.resolve());
    const tracker = new ResearchTracker({
      agentName: AGENT,
      maxConcurrent: 4,
      holdTimeoutMs: 60_000,
      stopTask,
      stopForToolUse,
      deliver: () => undefined,
      log: { info: () => undefined, warn: () => undefined },
    });
    tracker.noteApprovedLaunch("toolu_A", ORIGIN);
    tracker.noteApprovedLaunch("toolu_B", ORIGIN);
    tracker.observe(started("a1", "toolu_A"));
    vi.advanceTimersByTime(60_001);
    expect(stopTask).toHaveBeenCalledWith("a1");
    expect(stopForToolUse).toHaveBeenCalledWith("toolu_B");
    expect(tracker.occupiedSlots()).toBe(0);
  });

  it("synthesis-wait timeout stops approved launches that never started", () => {
    vi.useFakeTimers();
    const stopForToolUse = vi.fn();
    const delivered: string[] = [];
    const tracker = new ResearchTracker({
      agentName: AGENT,
      maxConcurrent: 4,
      holdTimeoutMs: 60 * 60_000,
      stopTask: vi.fn(),
      stopForToolUse,
      deliver: (t) => delivered.push(t),
      synthesisWaitMs: 1000,
      log: { info: () => undefined, warn: () => undefined },
    });
    tracker.noteApprovedLaunch("t1", ORIGIN);
    tracker.observe(started("a1", "t1"));
    tracker.noteApprovedLaunch("t2", ORIGIN); // approved, never starts
    tracker.observe(notified("a1"));
    tracker.observe(wakeResult()); // empty wake: no synthesis text
    vi.advanceTimersByTime(1001);
    expect(stopForToolUse).toHaveBeenCalledWith("t2");
    expect(tracker.occupiedSlots()).toBe(0);
  });

  it("straggler timeout stops approved launches that never started", () => {
    vi.useFakeTimers();
    const stopForToolUse = vi.fn();
    const delivered: string[] = [];
    const tracker = new ResearchTracker({
      agentName: AGENT,
      maxConcurrent: 4,
      holdTimeoutMs: 60 * 60_000,
      stopTask: vi.fn(),
      stopForToolUse,
      deliver: (t) => delivered.push(t),
      synthesisWaitMs: 60 * 60_000,
      stragglerQuietMs: 500,
      log: { info: () => undefined, warn: () => undefined },
    });
    tracker.noteApprovedLaunch("t1", ORIGIN);
    tracker.noteApprovedLaunch("t2", ORIGIN);
    tracker.observe(started("a1", "t1"));
    tracker.observe(started("a2", "t2"));
    tracker.noteApprovedLaunch("t3", ORIGIN); // approved, never starts
    tracker.observe(notified("a1"));
    tracker.observe(notified("a2"));
    tracker.observe(wakeResult());
    expect(tracker.routeOrphanOutput("the synthesis")).toEqual({ kind: "fold" }); // one wake still owed
    vi.advanceTimersByTime(501);
    expect(stopForToolUse).toHaveBeenCalledWith("t3");
    expect(delivered).toEqual(["the synthesis"]);
  });
  it("no synthesis within the wait → folded text is delivered", () => {
    vi.useFakeTimers();
    const { tracker, delivered } = make();
    tracker.observe(started("a1", "t1"));
    tracker.observe(started("a2", "t2"));
    tracker.observe(notified("a1"));
    wake(tracker, "interim");
    tracker.observe(notified("a2"));
    // The last wake never produces output (empty synthesis turn).
    tracker.observe(wakeResult());
    vi.advanceTimersByTime(1001);
    expect(delivered).toEqual([{ text: "interim", replyTo: REPLY_TO }]);
  });

  it("a researcher with no originating Discord turn is not tracked (the gate should have denied it)", () => {
    resetResearchRegistryForTests();
    const { tracker } = make();
    tracker.observe(started("a1", "t1"));
    expect(tracker.occupiedSlots()).toBe(0);
  });

  it("paints the card: post once, then edits; progress summaries and the settle outcome", async () => {
    vi.useFakeTimers();
    const p = fakePort();
    const { tracker } = make({ port: p.port });
    tracker.observe(started("a1", "t1", "researcher", "Chicago weather history"));
    await vi.advanceTimersByTimeAsync(20);
    expect(p.port.post).toHaveBeenCalledTimes(1);
    expect(p.posts[0]!.session.tasks[0]).toMatchObject({ description: "Chicago weather history", status: "running" });

    tracker.observe(progress("a1", "Reading NOAA station records"));
    await vi.advanceTimersByTimeAsync(20);
    expect(p.last()!.session.tasks[0]!.lastLine).toBe("Reading NOAA station records");

    tracker.observe(progress("a1", undefined, "mcp__search__web_fetch_url"));
    await vi.advanceTimersByTimeAsync(20);
    expect(p.last()!.session.tasks[0]!.lastLine).toBe("using web_fetch_url");

    tracker.observe(notified("a1"));
    wake(tracker, "synthesis");
    await vi.advanceTimersByTimeAsync(50);
    expect(p.last()!.settled?.outcome).toBe("done");
    expect(p.last()!.session.tasks[0]!.status).toBe("completed");
    expect(p.port.post).toHaveBeenCalledTimes(1);
  });

  it("the card shows the latest folded interim line", async () => {
    vi.useFakeTimers();
    const p = fakePort();
    const { tracker } = make({ port: p.port });
    tracker.observe(started("a1", "t1"));
    tracker.observe(started("a2", "t2"));
    tracker.observe(notified("a1"));
    wake(tracker, "Mercury done,\n Venus still running");
    await vi.advanceTimersByTimeAsync(30);
    expect(p.last()!.interim).toBe("Mercury done, Venus still running");
  });

  it("a button key finds the session, live or recently ended", () => {
    const { tracker } = make();
    tracker.observe(started("a1", "t1"));
    const key = [...(tracker as unknown as { active: Map<string, { key: string }> }).active.values()][0]!.key;
    expect(tracker.sessionForKey(key)?.tasks).toHaveLength(1);
    tracker.observe(notified("a1"));
    wake(tracker, "done");
    expect(tracker.sessionForKey(key)?.tasks[0]?.status).toBe("completed");
    expect(tracker.sessionForKey("nope")).toBeUndefined();
  });

  it("two overlapping origins: each synthesis replies to ITS OWN message", () => {
    const { tracker, delivered } = make();
    const ORIGIN_B = { turnId: "discord:000000000000000119", messageId: "000000000000000119", channelId: ORIGIN.channelId };
    tracker.noteApprovedLaunch("tA1", ORIGIN);
    tracker.noteApprovedLaunch("tA2", ORIGIN);
    tracker.observe(started("a1", "tA1"));
    tracker.observe(started("a2", "tA2"));
    // A second message launches its own researcher while A's are running.
    setLiveDiscordTurn(AGENT, ORIGIN_B);
    tracker.noteApprovedLaunch("tB1", ORIGIN_B);
    tracker.observe(started("b1", "tB1"));

    tracker.observe(notified("a1"));
    expect(wake(tracker, "A interim")).toEqual({ kind: "fold" });
    tracker.observe(notified("b1"));
    expect(wake(tracker, "B synthesis")).toEqual({
      kind: "reply",
      replyTo: { channelId: ORIGIN_B.channelId, messageId: ORIGIN_B.messageId },
    });
    tracker.observe(notified("a2"));
    expect(wake(tracker, "A synthesis")).toEqual({ kind: "reply", replyTo: REPLY_TO });
    expect(delivered).toEqual([]);
  });

  it("a late notification after the OTHER session ended is still routed to its own session", () => {
    const { tracker } = make();
    const ORIGIN_B = { turnId: "discord:000000000000000119", messageId: "000000000000000119", channelId: ORIGIN.channelId };
    tracker.noteApprovedLaunch("tA1", ORIGIN);
    tracker.observe(started("a1", "tA1"));
    tracker.noteApprovedLaunch("tB1", ORIGIN_B);
    tracker.noteApprovedLaunch("tB2", ORIGIN_B);
    tracker.observe(started("b1", "tB1"));
    tracker.observe(started("b2", "tB2"));
    // A finishes and replies — session A ends.
    tracker.observe(notified("a1"));
    expect(wake(tracker, "A synthesis")).toMatchObject({ kind: "reply", replyTo: REPLY_TO });
    // B's completions arrive afterwards and must not be dropped.
    tracker.observe(notified("b1"));
    expect(wake(tracker, "B interim")).toEqual({ kind: "fold" });
    tracker.observe(progress("b2", "Reading"));
    tracker.observe(notified("b2"));
    expect(wake(tracker, "B synthesis")).toEqual({
      kind: "reply",
      replyTo: { channelId: ORIGIN_B.channelId, messageId: ORIGIN_B.messageId },
    });
  });

  it("the concurrency cap is global across sessions", () => {
    const { tracker, stopTask } = make({ max: 3 });
    const ORIGIN_B = { turnId: "discord:000000000000000119", messageId: "000000000000000119", channelId: ORIGIN.channelId };
    tracker.noteApprovedLaunch("tA1", ORIGIN);
    tracker.noteApprovedLaunch("tA2", ORIGIN);
    tracker.observe(started("a1", "tA1"));
    tracker.observe(started("a2", "tA2"));
    tracker.noteApprovedLaunch("tB1", ORIGIN_B);
    expect(tracker.occupiedSlots()).toBe(3);
    tracker.observe(started("b1", "tB1"));
    expect(stopTask).not.toHaveBeenCalled();
    // A fourth researcher (for either origin) is over the cap.
    tracker.observe(started("b2", "tB2-unapproved"));
    expect(stopTask).toHaveBeenCalledWith("b2");
  });

  it("with two live sessions, an unattributable self-fired output is delivered as-is (never folded into the wrong card)", () => {
    const { tracker } = make();
    const ORIGIN_B = { turnId: "discord:000000000000000119", messageId: "000000000000000119", channelId: ORIGIN.channelId };
    tracker.noteApprovedLaunch("tA1", ORIGIN);
    tracker.observe(started("a1", "tA1"));
    tracker.noteApprovedLaunch("tB1", ORIGIN_B);
    tracker.observe(started("b1", "tB1"));
    // No queued wake (an unsignaled self-fired turn): cannot be attributed.
    expect(tracker.routeOrphanOutput("who does this belong to?")).toEqual({ kind: "pass" });
  });

  it("a non-research wake (e.g. a Monitor task) passes through without consuming a research wake", () => {
    const { tracker } = make();
    tracker.observe(started("a1", "t1"));
    tracker.observe(started("a2", "t2"));
    tracker.observe({ type: "system", subtype: "task_started", task_id: "m1", tool_use_id: "tm", description: "monitor" });
    tracker.observe(notified("m1"));
    expect(wake(tracker, "monitor fired")).toEqual({ kind: "pass" });
    tracker.observe(notified("a1"));
    expect(wake(tracker, "interim")).toEqual({ kind: "fold" });
    tracker.observe(notified("a2"));
    expect(wake(tracker, "synthesis")).toMatchObject({ kind: "reply" });
  });

  it("prod 2026-09-25: all 3 fail on the usage limit → card settles at once, daemon posts ONE notice after the wakes close", async () => {
    vi.useFakeTimers();
    const p = fakePort();
    const { tracker, delivered } = make({ port: p.port });
    const LIMIT =
      "Agent terminated early due to an API error: You've hit your session limit · resets 5:30pm (America/Los_Angeles) (error type rate_limit, HTTP 429)";
    for (const id of ["a1", "a2", "a3"]) tracker.observe(started(id, `t${id}`));
    for (const id of ["a1", "a2", "a3"]) tracker.observe({ ...notified(id, "failed"), summary: LIMIT });
    await vi.advanceTimersByTimeAsync(30);
    // Card settled immediately: no running researchers, no buttons, one reason line.
    expect(p.last()!.settled).not.toBeNull();
    expect(p.last()!.reason).toBe("usage limit reached, resets 5:30 PM PT");
    // The parent's wakes all error out (rate-limited): the handle skips them.
    for (let i = 0; i < 3; i++) {
      tracker.observe(wakeResult());
      tracker.skipOrphanOutput();
    }
    expect(delivered).toEqual([]);
    await vi.advanceTimersByTimeAsync(5_001);
    expect(delivered).toEqual([
      { text: "Research couldn't run: the Claude usage limit is reached until 5:30 PM PT. Ask again after that.", replyTo: REPLY_TO },
    ]);
    // Session over: no second notice, later output passes.
    await vi.advanceTimersByTimeAsync(120_000);
    expect(delivered).toHaveLength(1);
  });

  it("all failed but the parent DOES answer → its answer is the reply, no daemon notice (no double post)", async () => {
    vi.useFakeTimers();
    const { tracker, delivered } = make();
    tracker.observe(started("a1", "t1"));
    tracker.observe(started("a2", "t2"));
    tracker.observe({ ...notified("a1", "failed"), summary: "You've hit your session limit · resets 5:30pm (America/Los_Angeles)" });
    tracker.observe({ ...notified("a2", "failed"), summary: "You've hit your session limit" });
    expect(wake(tracker, "Both researchers hit the usage limit; here is what I know already…")).toEqual({ kind: "fold" });
    expect(wake(tracker, "Final: the limit resets at 5:30 PM.")).toMatchObject({ kind: "reply", replyTo: REPLY_TO });
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(delivered).toEqual([]);
  });

  it("no wakes ever close (parent hung): the 60 s fallback still posts the notice once", async () => {
    vi.useFakeTimers();
    const { tracker, delivered } = make();
    tracker.observe(started("a1", "t1"));
    tracker.observe({ ...notified("a1", "failed"), summary: "You've hit your session limit · resets 5:30pm (America/Los_Angeles)" });
    await vi.advanceTimersByTimeAsync(60_001);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]!.text).toMatch(/until 5:30 PM PT/);
  });

  it("mixed (one finished, one failed): settles as k of N and waits for the synthesis — no notice", async () => {
    vi.useFakeTimers();
    const p = fakePort();
    const { tracker, delivered } = make({ port: p.port });
    tracker.observe(started("a1", "t1"));
    tracker.observe(started("a2", "t2"));
    tracker.observe(notified("a1"));
    tracker.observe({ ...notified("a2", "failed"), summary: "API error: overloaded" });
    await vi.advanceTimersByTimeAsync(30);
    expect(p.last()!.settled).not.toBeNull();
    expect(p.last()!.reason).toBe("API error");
    expect(wake(tracker, "interim")).toEqual({ kind: "fold" });
    expect(wake(tracker, "synthesis from one researcher")).toMatchObject({ kind: "reply" });
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(delivered).toEqual([]);
  });

  it("stopped by the user: no notice", async () => {
    vi.useFakeTimers();
    const { tracker, delivered } = make();
    tracker.observe(started("a1", "t1"));
    tracker.observe(notified("a1", "stopped"));
    await vi.advanceTimersByTimeAsync(120_000);
    expect(delivered).toEqual([]);
  });

  it("a malformed frame never throws", () => {
    const { tracker } = make();
    expect(() => tracker.observe(null)).not.toThrow();
    expect(() => tracker.observe({ type: "system", subtype: "task_started" })).not.toThrow();
    expect(() => tracker.observe({ type: "system", subtype: "background_tasks_changed", tasks: "x" })).not.toThrow();
  });
});
