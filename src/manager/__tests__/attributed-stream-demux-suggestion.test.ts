/**
 * 999.172 — AttributedStreamDemux `prompt_suggestion` tap.
 *
 * The CLI emits `{type:"prompt_suggestion", suggestion, uuid, session_id}`
 * AFTER a turn's result (probe: ~1 s on 2.1.280, ~11 s on 2.1.282). By then
 * the turn is closed, so the demux reports the suggestion with the
 * attribution of the LAST CLOSED turn and whether anything has superseded it.
 * Pinned here:
 *   - a genuine daemon close → attribution {daemon, <send token>};
 *   - an orphan (self-fired) close → attribution {orphan};
 *   - a later registerDaemonSend or a newly opened turn → superseded;
 *   - a suggestion during a 999.155 merge hold is decided by the hold:
 *     merged → daemon with the folded send's token; separate → orphan;
 *   - the frame is still forwarded to the daemon queue (stream parity);
 *   - a throwing consumer never stops the pump.
 */
import { describe, it, expect } from "vitest";
import { AttributedStreamDemux, SUGGESTION_AMBIGUITY_WINDOW_MS } from "../attributed-stream-demux.js";
import type { SdkStreamMessage } from "../sdk-types.js";

const notification = () =>
  ({ type: "system", subtype: "task_notification", task_id: "t1" }) as unknown as SdkStreamMessage;
const assistant = (text: string) =>
  ({ type: "assistant", message: { content: [{ type: "text", text }] } }) as unknown as SdkStreamMessage;
const result = (text: string, opts: { origin?: string } = {}) =>
  ({
    type: "result",
    subtype: "success",
    result: text,
    is_error: false,
    ...(opts.origin ? { origin: { kind: opts.origin } } : {}),
  }) as unknown as SdkStreamMessage;
/** Probe-verified shape (CLI 2.1.282). */
const suggestion = (text: unknown) =>
  ({ type: "prompt_suggestion", suggestion: text, uuid: "u-1", session_id: "s-1" }) as unknown as SdkStreamMessage;

function makeRawStream() {
  const queue: SdkStreamMessage[] = [];
  let waiter: ((r: IteratorResult<SdkStreamMessage>) => void) | null = null;
  let done = false;
  const iter: AsyncIterator<SdkStreamMessage> = {
    next: () =>
      new Promise((resolve) => {
        const item = queue.shift();
        if (item !== undefined) return resolve({ value: item, done: false });
        if (done) return resolve({ value: undefined as never, done: true });
        waiter = resolve;
      }),
    return: () => {
      done = true;
      if (waiter) {
        waiter({ value: undefined as never, done: true });
        waiter = null;
      }
      return Promise.resolve({ value: undefined as never, done: true });
    },
  };
  return {
    iter,
    feed(...frames: SdkStreamMessage[]) {
      for (const f of frames) {
        if (waiter) {
          const w = waiter;
          waiter = null;
          w({ value: f, done: false });
        } else {
          queue.push(f);
        }
      }
    },
  };
}

const settle = () => new Promise<void>((r) => setTimeout(r, 0));

type Call = {
  suggestion: string;
  attribution: { kind: "daemon" | "orphan"; token: number | null } | null;
  superseded: boolean;
};

function harness(opts: { mergeGraceMs?: number; throwing?: boolean; now?: () => number } = {}) {
  const raw = makeRawStream();
  const calls: Call[] = [];
  const ambiguous: boolean[] = [];
  const noop = () => undefined;
  const demux = new AttributedStreamDemux({
    raw: raw.iter,
    onOrphanOutput: () => undefined,
    ...(opts.now ? { now: opts.now } : {}),
    onPromptSuggestion: (ev) => {
      calls.push({ suggestion: ev.suggestion, attribution: ev.attribution, superseded: ev.superseded });
      ambiguous.push(ev.ambiguous);
      if (opts.throwing) throw new Error("renderer fault");
    },
    ...(opts.mergeGraceMs !== undefined ? { mergeGraceMs: opts.mergeGraceMs } : {}),
    log: { info: noop, warn: noop, error: noop },
  });
  const turnIter = demux.turnIterator();
  async function take(n: number): Promise<SdkStreamMessage[]> {
    const out: SdkStreamMessage[] = [];
    for (let i = 0; i < n; i++) {
      const step = await turnIter.next();
      if (step.done) break;
      out.push(step.value);
    }
    return out;
  }
  return { raw, demux, calls, ambiguous, take };
}

describe("999.172 — prompt_suggestion tap", () => {
  it("attributes a suggestion to the daemon turn that just closed, with its send token", async () => {
    const h = harness();
    const token = h.demux.registerDaemonSend();
    h.raw.feed(assistant("Lisbon, great."), result("Lisbon, great."));
    await h.take(2);
    h.raw.feed(suggestion("Which neighbourhood?"));
    await settle();
    expect(h.calls).toEqual([
      { suggestion: "Which neighbourhood?", attribution: { kind: "daemon", token }, superseded: false },
    ]);
    h.demux.stop();
  });

  it("still forwards the frame to the daemon queue (stream parity)", async () => {
    const h = harness();
    h.demux.registerDaemonSend();
    h.raw.feed(assistant("a"), result("a"), suggestion("next?"));
    const frames = await h.take(3);
    expect((frames[2] as { type?: string }).type).toBe("prompt_suggestion");
    h.demux.stop();
  });

  it("attributes a suggestion after a self-fired (orphan) turn to orphan", async () => {
    const h = harness();
    h.raw.feed(notification(), assistant("cron output"), result("cron output", { origin: "task-notification" }));
    await settle();
    h.raw.feed(suggestion("follow up?"));
    await settle();
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]!.attribution).toEqual({ kind: "orphan", token: null });
    h.demux.stop();
  });

  it("marks the suggestion superseded when a new daemon send registered after the close", async () => {
    const h = harness();
    h.demux.registerDaemonSend();
    h.raw.feed(assistant("a"), result("a"));
    await h.take(2);
    h.demux.registerDaemonSend(); // the user already sent the next message
    h.raw.feed(suggestion("stale"));
    await settle();
    expect(h.calls[0]!.superseded).toBe(true);
    h.demux.stop();
  });

  it("marks the suggestion superseded when another turn opened after the close", async () => {
    const h = harness();
    h.demux.registerDaemonSend();
    h.raw.feed(assistant("a"), result("a"));
    await h.take(2);
    h.raw.feed(notification(), assistant("self-fired turn starts"));
    await settle();
    h.raw.feed(suggestion("stale"));
    await settle();
    expect(h.calls[0]!.superseded).toBe(true);
    h.demux.stop();
  });

  it("reports null attribution when no turn has closed yet", async () => {
    const h = harness();
    h.raw.feed(suggestion("early"));
    await settle();
    expect(h.calls[0]!.attribution).toBeNull();
    h.demux.stop();
  });

  it("merge hold → merged: the folded daemon send owns the suggestion", async () => {
    const h = harness({ mergeGraceMs: 20 });
    // Orphan turn opens, a daemon send is pending, the orphan closes (held).
    h.raw.feed(notification(), assistant("self-fired"));
    await settle();
    const token = h.demux.registerDaemonSend();
    h.raw.feed(result("self-fired + folded answer", { origin: "task-notification" }));
    await settle();
    h.raw.feed(suggestion("merged next"));
    await settle();
    expect(h.calls).toHaveLength(0); // decided by the hold, not yet
    await new Promise((r) => setTimeout(r, 40)); // no new turn → merged
    expect(h.calls).toEqual([
      { suggestion: "merged next", attribution: { kind: "daemon", token }, superseded: false },
    ]);
    h.demux.stop();
  });

  it("merge hold → separate: a new turn opens, the held suggestion is orphan-attributed", async () => {
    const h = harness({ mergeGraceMs: 5_000 });
    h.raw.feed(notification(), assistant("self-fired"));
    await settle();
    h.demux.registerDaemonSend();
    h.raw.feed(result("self-fired", { origin: "task-notification" }));
    await settle();
    h.raw.feed(suggestion("held"));
    await settle();
    h.raw.feed(assistant("the daemon's own turn"));
    await settle();
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]!.attribution).toEqual({ kind: "orphan", token: null });
    h.demux.stop();
  });

  it("a suggestion arriving AFTER a merged hold resolved is daemon-attributed", async () => {
    const h = harness({ mergeGraceMs: 10 });
    h.raw.feed(notification(), assistant("self-fired"));
    await settle();
    const token = h.demux.registerDaemonSend();
    h.raw.feed(result("folded", { origin: "task-notification" }));
    await new Promise((r) => setTimeout(r, 30)); // hold resolves merged first
    h.raw.feed(suggestion("late"));
    await settle();
    expect(h.calls).toEqual([{ suggestion: "late", attribution: { kind: "daemon", token }, superseded: false }]);
    h.demux.stop();
  });

  it("a throwing consumer never stops the pump", async () => {
    const h = harness({ throwing: true });
    h.demux.registerDaemonSend();
    h.raw.feed(assistant("a"), result("a"));
    await h.take(2);
    h.raw.feed(suggestion("boom"));
    await settle();
    h.demux.registerDaemonSend();
    h.raw.feed(assistant("b"), result("b"));
    // prompt_suggestion (forwarded) + assistant + result
    const frames = await h.take(3);
    expect(frames.map((f) => (f as { type?: string }).type)).toEqual(["prompt_suggestion", "assistant", "result"]);
    h.demux.stop();
  });

  it("a non-string suggestion is still reported (the gate drops it downstream) and forwarded", async () => {
    const h = harness();
    h.demux.registerDaemonSend();
    h.raw.feed(assistant("a"), result("a"), suggestion(42));
    await h.take(3);
    expect(h.calls[0]!.suggestion).toBe("");
    h.demux.stop();
  });
});

describe("999.172 — abandoned daemon turn", () => {
  it("a suggestion for a turn the consumer abandoned is superseded", async () => {
    const h = harness();
    const token = h.demux.registerDaemonSend();
    h.raw.feed(assistant("a"), result("a"));
    await settle();
    // The consumer exits without taking its result (abort-deadline family).
    h.demux.abandonDaemonTurn(token, "abort");
    h.raw.feed(suggestion("next?"));
    await settle();
    expect(h.calls[0]!.superseded).toBe(true);
    h.demux.stop();
  });
});


describe("999.172 review — ambiguity rule (the frame has no turn correlation)", () => {
  /** One full daemon turn: register, stream, close, and consume its frames. */
  async function daemonTurn(h: ReturnType<typeof harness>, text: string): Promise<number> {
    const token = h.demux.registerDaemonSend();
    h.raw.feed(assistant(text), result(text));
    await h.take(2);
    return token;
  }

  it("reviewer's race: cron turn tC closes, Discord turn tB opens+closes, tC's late frame lands → ambiguous", async () => {
    let t = 1_000_000;
    const h = harness({ now: () => t });
    await daemonTurn(h, "cron / dossier wake (sendAndCollect)"); // tC
    t += 2_000;
    const tB = await daemonTurn(h, "the user's Discord reply"); // tB
    t += 3_000; // tC's suggestion was generating 1–11 s after its result
    h.raw.feed(suggestion("Chase the bib email?"));
    await settle();
    expect(h.calls[0]!.attribution).toEqual({ kind: "daemon", token: tB });
    expect(h.ambiguous).toEqual([true]);
    h.demux.stop();
  });

  it("two rapid Discord turns inside the window → ambiguous, and a straggler after it is ambiguous too", async () => {
    let t = 0;
    const h = harness({ now: () => t });
    await daemonTurn(h, "first");
    t += 10_000;
    await daemonTurn(h, "second");
    h.raw.feed(suggestion("one"));
    await settle();
    h.raw.feed(suggestion("two")); // the other turn's frame, if it ever comes
    await settle();
    expect(h.ambiguous).toEqual([true, true]);
    h.demux.stop();
  });

  it("control: a normal single turn is attributed (not ambiguous)", async () => {
    let t = 0;
    const h = harness({ now: () => t });
    const token = await daemonTurn(h, "only turn");
    t += 11_000;
    h.raw.feed(suggestion("next?"));
    await settle();
    expect(h.calls[0]).toEqual({ suggestion: "next?", attribution: { kind: "daemon", token }, superseded: false });
    expect(h.ambiguous).toEqual([false]);
    h.demux.stop();
  });

  it("an earlier close OUTSIDE the window does not make the last one ambiguous", async () => {
    let t = 0;
    const h = harness({ now: () => t });
    await daemonTurn(h, "long ago, never got a suggestion");
    t += SUGGESTION_AMBIGUITY_WINDOW_MS + 1;
    const token = await daemonTurn(h, "now");
    h.raw.feed(suggestion("next?"));
    await settle();
    expect(h.calls[0]!.attribution).toEqual({ kind: "daemon", token });
    expect(h.ambiguous).toEqual([false]);
    h.demux.stop();
  });

  it("an earlier close that already RESOLVED (got its suggestion) does not block the next turn's", async () => {
    let t = 0;
    const h = harness({ now: () => t });
    await daemonTurn(h, "first");
    h.raw.feed(suggestion("for first"));
    await settle();
    t += 5_000;
    const second = await daemonTurn(h, "second");
    h.raw.feed(suggestion("for second"));
    await settle();
    expect(h.ambiguous).toEqual([false, false]);
    expect(h.calls[1]!.attribution).toEqual({ kind: "daemon", token: second });
    h.demux.stop();
  });

  it("a second frame for an already-resolved close is ambiguous (at most one per turn)", async () => {
    const h = harness();
    await daemonTurn(h, "only");
    h.raw.feed(suggestion("a"));
    await settle();
    h.raw.feed(suggestion("b"));
    await settle();
    expect(h.ambiguous).toEqual([false, true]);
    h.demux.stop();
  });

  it("a self-fired close in the window blocks the Discord turn after it", async () => {
    let t = 0;
    const h = harness({ now: () => t });
    h.raw.feed(notification(), assistant("bg"), result("bg", { origin: "task-notification" }));
    await settle();
    t += 1_000;
    await daemonTurn(h, "user turn");
    h.raw.feed(suggestion("which?"));
    await settle();
    expect(h.ambiguous).toEqual([true]);
    h.demux.stop();
  });
});
