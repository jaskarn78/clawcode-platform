/**
 * 999.178 — the research synthesis is visible, and a synthesis delivered in
 * the user's own turn settles the research.
 *
 * Replays fin-client 2026-09-26 14:49–14:59 PT: four researchers; the
 * last one ended and the CLI's synthesis turn ran for 3.5 min with no card
 * change, no typing, and "eta" answered "Nothing running". A user message the
 * CLI folded into that turn took its output, the tracker never saw it, and
 * 2.5 min later the fallback re-posted stale filler ("Only the
 * free-fundamentals one is still running").
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ResearchTracker } from "../research-tracker.js";
import type { ResearchCardPort, ResearchCardSnapshot } from "../research-card-sink.js";
import { resetResearchRegistryForTests, setLiveDiscordTurn } from "../research-registry.js";
import { AttributedStreamDemux } from "../attributed-stream-demux.js";
import type { SdkStreamMessage } from "../sdk-types.js";

const AGENT = "fin-client";
const ORIGIN = { turnId: "discord:000000000000000120", messageId: "000000000000000120", channelId: "000000000000000110" };

const started = (taskId: string, toolUseId: string) => ({
  type: "system",
  subtype: "task_started",
  task_id: taskId,
  tool_use_id: toolUseId,
  description: `look into ${taskId}`,
  subagent_type: "researcher",
  is_backgrounded: true,
});
const notified = (taskId: string) => ({ type: "system", subtype: "task_notification", task_id: taskId, status: "completed", summary: "s", output_file: "/o" });
const wakeResult = () => ({ type: "result", subtype: "success", result: "", origin: { kind: "task-notification" } });

function fakePort() {
  const snaps: ResearchCardSnapshot[] = [];
  const typing: string[] = [];
  const port: ResearchCardPort = {
    post: vi.fn(async (_c: string, s: ResearchCardSnapshot) => {
      snaps.push(s);
      return "card-1";
    }),
    edit: vi.fn(async (_c: string, _m: string, s: ResearchCardSnapshot) => {
      snaps.push(s);
    }),
    typing: vi.fn(async (c: string) => {
      typing.push(c);
    }),
  };
  return { port, snaps, typing, last: () => snaps[snaps.length - 1] };
}

function make(port: ResearchCardPort) {
  const delivered: { text: string; replyTo: unknown }[] = [];
  const tracker = new ResearchTracker({
    agentName: AGENT,
    maxConcurrent: 4,
    holdTimeoutMs: 20 * 60_000,
    stopTask: () => Promise.resolve(),
    deliver: (text, replyTo) => delivered.push({ text, replyTo }),
    cardPort: () => port,
    repaintMs: 10,
    synthesisWaitMs: 1000,
    stragglerQuietMs: 500,
    typingMs: 100,
    typingMaxMs: 10_000,
    log: { info: () => undefined, warn: () => undefined },
  });
  return { tracker, delivered };
}

/** Two researchers; the first completes with interim filler; the second completes. */
function runResearch(tracker: ResearchTracker) {
  tracker.noteApprovedLaunch("toolu_A", ORIGIN);
  tracker.noteApprovedLaunch("toolu_B", ORIGIN);
  tracker.observe(started("a1", "toolu_A"));
  tracker.observe(started("a2", "toolu_B"));
  tracker.observe(notified("a1"));
  tracker.setSelfFiredTurnOpen(true);
  tracker.observe(wakeResult());
  expect(tracker.routeOrphanOutput("Only a2 is still running.")).toEqual({ kind: "fold" });
  tracker.setSelfFiredTurnOpen(false);
  vi.advanceTimersByTime(50);
  tracker.observe(notified("a2"));
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(Date.parse("2026-09-26T21:49:00Z"));
  setLiveDiscordTurn(AGENT, ORIGIN);
});
afterEach(() => {
  resetResearchRegistryForTests();
  vi.useRealTimers();
});

describe("synthesis is visible", () => {
  it("no typing between researchers; typing + 'writing up' card once the synthesis turn opens", async () => {
    const p = fakePort();
    const { tracker } = make(p.port);
    runResearch(tracker);
    expect(p.typing).toEqual([]); // parent idle: nothing owed yet
    expect(tracker.statusView()).toMatchObject({ total: 2, done: 2, running: 0, writingSince: null });

    tracker.setSelfFiredTurnOpen(true); // the synthesis wake turn starts
    expect(p.typing).toEqual([ORIGIN.channelId]);
    await vi.advanceTimersByTimeAsync(250);
    expect(p.typing.length).toBeGreaterThanOrEqual(3); // refreshed while it writes
    expect(p.last()?.writingSince).toBeDefined();
    expect(p.last()?.settled).toBeNull();
    expect(tracker.statusView()?.writingSince).not.toBeNull();

    // The synthesis arrives as a reply: typing stops, the card settles.
    tracker.observe(wakeResult());
    expect(tracker.routeOrphanOutput("Here is the synthesis").kind).toBe("reply");
    tracker.setSelfFiredTurnOpen(false);
    const n = p.typing.length;
    await vi.advanceTimersByTimeAsync(500);
    expect(p.typing.length).toBe(n);
    expect(tracker.statusView()).toBeNull();
    tracker.dispose();
  });

  it("typing is capped for a wedged synthesis turn", async () => {
    const p = fakePort();
    const { tracker } = make(p.port);
    runResearch(tracker);
    tracker.setSelfFiredTurnOpen(true);
    await vi.advanceTimersByTimeAsync(10_500);
    const n = p.typing.length;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(p.typing.length).toBe(n);
    tracker.dispose();
  });
});

describe("synthesis delivered in the user's turn", () => {
  it("absorbing the wake's output ends the research: no filler re-posted later", async () => {
    const p = fakePort();
    const { tracker, delivered } = make(p.port);
    runResearch(tracker);
    tracker.setSelfFiredTurnOpen(true);
    tracker.observe(wakeResult()); // the wake turn's result…
    tracker.absorbSelfFiredOutput(); // …went to the folded user send (demux merge)
    tracker.setSelfFiredTurnOpen(false);
    await vi.advanceTimersByTimeAsync(5_000); // well past synthesisWaitMs
    expect(delivered).toEqual([]);
    expect(tracker.statusView()).toBeNull();
    const n = p.typing.length;
    await vi.advanceTimersByTimeAsync(500);
    expect(p.typing.length).toBe(n);
    tracker.dispose();
  });

  it("an absorbed INTERIM wake (researchers still running) leaves the research alone", () => {
    const p = fakePort();
    const { tracker } = make(p.port);
    tracker.noteApprovedLaunch("toolu_A", ORIGIN);
    tracker.noteApprovedLaunch("toolu_B", ORIGIN);
    tracker.observe(started("a1", "toolu_A"));
    tracker.observe(started("a2", "toolu_B"));
    tracker.observe(notified("a1"));
    tracker.observe(wakeResult());
    tracker.absorbSelfFiredOutput();
    expect(tracker.statusView()).toMatchObject({ done: 1, running: 1 });
    tracker.dispose();
  });
});

describe("fallback never re-posts stale filler", () => {
  it("synthesis never arrives: filler written before the last researcher ended is replaced by a plain line", async () => {
    const p = fakePort();
    const { tracker, delivered } = make(p.port);
    runResearch(tracker);
    await vi.advanceTimersByTimeAsync(1_500); // synthesisWaitMs, parent idle
    expect(delivered).toHaveLength(1);
    expect(delivered[0]!.text).not.toContain("still running");
    expect(delivered[0]!.text).toMatch(/^Research finished \(2 of 2\)/);
    tracker.dispose();
  });
});

// ---------------------------------------------------------------------------
// Demux: the merge path reports itself
// ---------------------------------------------------------------------------

function makeRawStream() {
  const queue: SdkStreamMessage[] = [];
  let waiter: ((r: IteratorResult<SdkStreamMessage>) => void) | null = null;
  const iter: AsyncIterator<SdkStreamMessage> = {
    next: () =>
      new Promise((resolve) => {
        const item = queue.shift();
        if (item !== undefined) return resolve({ value: item, done: false });
        waiter = resolve;
      }),
    return: () => Promise.resolve({ value: undefined as never, done: true }),
  };
  return {
    iter,
    feed(...frames: SdkStreamMessage[]) {
      for (const f of frames) {
        if (waiter) {
          const w = waiter;
          waiter = null;
          w({ value: f, done: false });
        } else queue.push(f);
      }
    },
  };
}

const frame = (f: unknown) => f as SdkStreamMessage;

describe("AttributedStreamDemux.onOrphanMergedIntoDaemon", () => {
  it("fires when a pending send is folded into the orphan turn, not when it gets its own turn", async () => {
    vi.useRealTimers();
    const settle = () => new Promise<void>((r) => setTimeout(r, 0));
    const noop = () => undefined;
    for (const [separate, expected] of [[false, 1], [true, 0]] as const) {
      const raw = makeRawStream();
      let merged = 0;
      const outputs: string[] = [];
      const demux = new AttributedStreamDemux({
        raw: raw.iter,
        onOrphanOutput: (o) => outputs.push(o.text),
        onOrphanMergedIntoDaemon: () => {
          merged += 1;
        },
        mergeGraceMs: 20,
        log: { info: noop, warn: noop, error: noop },
      });
      demux.turnIterator();
      raw.feed(frame({ type: "system", subtype: "task_notification", task_id: "t1" }), frame({ type: "assistant", message: { content: [{ type: "text", text: "writing up" }] } }));
      await settle();
      demux.registerDaemonSend();
      raw.feed(frame({ type: "result", subtype: "success", result: "synthesis", is_error: false, origin: { kind: "task-notification" } }));
      await settle();
      if (separate) raw.feed(frame({ type: "assistant", message: { content: [{ type: "text", text: "own turn" }] } }));
      await new Promise((r) => setTimeout(r, 40));
      expect(merged).toBe(expected);
      if (separate) expect(outputs).toEqual(["synthesis"]);
      demux.stop();
    }
  });
});
