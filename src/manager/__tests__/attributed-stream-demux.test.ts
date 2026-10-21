/**
 * WS-1 (999.99 structural delivery plan) — AttributedStreamDemux unit suite.
 *
 * Synthetic frame sequences modeled on the probe-verified stream layout
 * (claude 2.1.210/211, probe-stream.mjs 2026-07-16):
 *   - turn: [system:init] → assistant* → (user tool_result)* → result
 *   - self-fired turn preceded by system:task_notification; its result
 *     carries origin {kind: "task-notification"}; daemon results carry NO origin
 *   - pushed inputs are NOT echoed as user frames
 *
 * The suite covers the incident scenario (2026-07-16 Admin Clawdy off-by-N),
 * the heal paths (both misclassification directions), interrupts, epoch
 * teardown, and legacy-parity edges.
 */
import { describe, it, expect, vi } from "vitest";
import {
  AttributedStreamDemux,
  type OrphanTurnOutput,
} from "../attributed-stream-demux.js";
import type { SdkStreamMessage } from "../sdk-types.js";

// ---------------------------------------------------------------------------
// Frame factories (structural — the demux inspects shape, not the local type)
// ---------------------------------------------------------------------------

const init = () => ({ type: "system", subtype: "init" }) as unknown as SdkStreamMessage;
const notification = () =>
  ({ type: "system", subtype: "task_notification", task_id: "t1" }) as unknown as SdkStreamMessage;
const ambient = (subtype = "background_tasks_changed") =>
  ({ type: "system", subtype }) as unknown as SdkStreamMessage;
const rateLimit = () => ({ type: "rate_limit_event" }) as unknown as SdkStreamMessage;
const assistant = (text: string) =>
  ({
    type: "assistant",
    message: { content: [{ type: "text", text }] },
  }) as unknown as SdkStreamMessage;
const toolResult = () =>
  ({
    type: "user",
    message: { content: [{ type: "tool_result", tool_use_id: "toolu_x" }] },
  }) as unknown as SdkStreamMessage;
const streamEvent = () => ({ type: "stream_event", event: {} }) as unknown as SdkStreamMessage;
const result = (text: string, opts: { origin?: string; isError?: boolean } = {}) =>
  ({
    type: "result",
    subtype: "success",
    result: text,
    is_error: opts.isError ?? false,
    ...(opts.origin ? { origin: { kind: opts.origin } } : {}),
  }) as unknown as SdkStreamMessage;

/**
 * Controllable raw iterator: frames are released one-by-one via feed();
 * end()/fail() terminate. Mirrors the SDK generator contract the pump reads.
 */
function makeRawStream() {
  const queue: SdkStreamMessage[] = [];
  let waiter: ((r: IteratorResult<SdkStreamMessage>) => void) | null = null;
  let failWaiter: ((e: unknown) => void) | null = null;
  let done = false;
  let failure: unknown = null;
  const iter: AsyncIterator<SdkStreamMessage> = {
    next: () =>
      new Promise((resolve, reject) => {
        const item = queue.shift();
        if (item !== undefined) return resolve({ value: item, done: false });
        if (failure !== null) return reject(failure);
        if (done) return resolve({ value: undefined as never, done: true });
        waiter = resolve;
        failWaiter = reject;
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
          failWaiter = null;
          w({ value: f, done: false });
        } else {
          queue.push(f);
        }
      }
    },
    end() {
      done = true;
      if (waiter) {
        const w = waiter;
        waiter = null;
        w({ value: undefined as never, done: true });
      }
    },
    fail(err: unknown) {
      failure = err;
      if (failWaiter) {
        const fw = failWaiter;
        waiter = null;
        failWaiter = null;
        fw(err);
      }
    },
  };
}

/** Drain the microtask queue so pump routing settles deterministically. */
const settle = () => new Promise<void>((r) => setTimeout(r, 0));

function makeDemux(overrides: Partial<Parameters<typeof harnessOptions>[0]> = {}) {
  return harness(overrides);
}

function harnessOptions(opts: {
  onOrphanTurnStart?: () => void;
  onOrphanTurnEnd?: () => void;
  onActivity?: () => void;
}) {
  return opts;
}

function harness(opts: {
  onOrphanTurnStart?: () => void;
  onOrphanTurnEnd?: () => void;
  onActivity?: () => void;
  onOrphanActivity?: () => void;
  mergeGraceMs?: number;
} = {}) {
  const raw = makeRawStream();
  const orphans: OrphanTurnOutput[] = [];
  const logCalls: Array<{ level: string; msg: string }> = [];
  const log = {
    info: (_o: unknown, m?: unknown) => logCalls.push({ level: "info", msg: String(m ?? _o) }),
    warn: (_o: unknown, m?: unknown) => logCalls.push({ level: "warn", msg: String(m ?? _o) }),
    error: (_o: unknown, m?: unknown) => logCalls.push({ level: "error", msg: String(m ?? _o) }),
  };
  const demux = new AttributedStreamDemux({
    raw: raw.iter,
    onOrphanOutput: (o) => orphans.push(o),
    log,
    ...opts,
  });
  const turnIter = demux.turnIterator();
  /** Collect exactly n frames from the turn iterator. */
  async function take(n: number): Promise<SdkStreamMessage[]> {
    const out: SdkStreamMessage[] = [];
    for (let i = 0; i < n; i++) {
      const step = await turnIter.next();
      if (step.done) break;
      out.push(step.value);
    }
    return out;
  }
  return { raw, demux, turnIter, orphans, logCalls, take };
}

// ---------------------------------------------------------------------------
// Core routing
// ---------------------------------------------------------------------------

describe("AttributedStreamDemux — daemon turn passthrough", () => {
  it("a registered daemon turn's frames flow through the turn iterator in order, ending with its result", async () => {
    const h = harness();
    h.demux.registerDaemonSend();
    h.raw.feed(init(), assistant("hello"), streamEvent(), toolResult(), result("hello"));
    await settle();

    const frames = await h.take(5);
    expect(frames.map((f) => (f as { type?: string }).type)).toEqual([
      "system",
      "assistant",
      "stream_event",
      "user",
      "result",
    ]);
    expect((frames[4] as { result?: string }).result).toBe("hello");
    expect(h.orphans).toHaveLength(0);
  });

  it("ambient frames between turns are forwarded (legacy parity: rate_limit_event reaches the loop)", async () => {
    const h = harness();
    h.raw.feed(rateLimit(), ambient());
    await settle();
    h.demux.registerDaemonSend();
    h.raw.feed(init(), assistant("hi"), result("hi"));
    await settle();

    const frames = await h.take(5);
    expect((frames[0] as { type?: string }).type).toBe("rate_limit_event");
    expect((frames[1] as { subtype?: string }).subtype).toBe("background_tasks_changed");
    expect((frames[4] as { result?: string }).result).toBe("hi");
  });
});

describe("AttributedStreamDemux — THE incident scenario (off-by-N)", () => {
  it("self-fired turn output is delivered as orphan output, NOT returned to the next daemon turn", async () => {
    const h = harness();

    // Idle: Monitor fires — task-notification, wake turn generates output.
    h.raw.feed(
      notification(),
      init(),
      assistant("Click delivered (worker run ended clean)"),
      result("Click delivered (worker run ended clean)", { origin: "task-notification" }),
    );
    await settle();

    // The orphan output was delivered immediately — no daemon read needed.
    expect(h.orphans).toHaveLength(1);
    expect(h.orphans[0].text).toBe("Click delivered (worker run ended clean)");
    expect(h.orphans[0].classification).toBe("orphan-signaled");
    expect(h.orphans[0].originKind).toBe("task-notification");

    // NOW the user sends "Run the ingest" — the daemon turn's iterator must
    // yield THAT turn's result, not the stale orphan one.
    h.demux.registerDaemonSend();
    h.raw.feed(init(), assistant("Ingest started"), result("Ingest started"));
    await settle();

    const frames = await h.take(4);
    const resultFrame = frames.find((f) => (f as { type?: string }).type === "result");
    expect((resultFrame as { result?: string }).result).toBe("Ingest started");
    // The notification frame itself is forwarded as ambient (legacy parity).
    expect(
      frames.some((f) => (f as { subtype?: string }).subtype === "task_notification"),
    ).toBe(true);
  });

  it("multiple buffered self-fired turns each deliver standalone, in order", async () => {
    const h = harness();
    h.raw.feed(
      notification(),
      init(),
      assistant("first"),
      result("first", { origin: "task-notification" }),
      notification(),
      init(),
      assistant("second"),
      result("second", { origin: "task-notification" }),
      notification(),
      init(),
      assistant("third"),
      result("third", { origin: "task-notification" }),
    );
    await settle();

    expect(h.orphans.map((o) => o.text)).toEqual(["first", "second", "third"]);
  });

  it("orphan turn with empty result text falls back to accumulated assistant text", async () => {
    const h = harness();
    h.raw.feed(
      notification(),
      init(),
      assistant("accumulated line"),
      result("", { origin: "task-notification" }),
    );
    await settle();
    expect(h.orphans).toHaveLength(1);
    expect(h.orphans[0].text).toBe("accumulated line");
  });

  it("orphan turn with NO text at all delivers nothing (no empty channel posts)", async () => {
    const h = harness();
    h.raw.feed(notification(), init(), result("", { origin: "task-notification" }));
    await settle();
    expect(h.orphans).toHaveLength(0);
  });

  it("unsignaled self-fired turn (no task_notification) still becomes orphan output — never pairs with an unmade send", async () => {
    const h = harness();
    h.raw.feed(init(), assistant("mystery"), result("mystery", { origin: "task-notification" }));
    await settle();
    expect(h.orphans).toHaveLength(1);
    expect(h.orphans[0].classification).toBe("orphan-unsignaled");
  });
});

// ---------------------------------------------------------------------------
// Heal paths (origin cross-check)
// ---------------------------------------------------------------------------

describe("AttributedStreamDemux — misclassification healing", () => {
  it("daemon-tentative turn whose result says task-notification is rerouted to orphan; daemon expectation restored", async () => {
    const h = harness();
    // Race: daemon send registered, but the CLI ran a (signal-less) wake turn first.
    h.demux.registerDaemonSend();
    h.raw.feed(
      init(),
      assistant("stale background output"),
      result("stale background output", { origin: "task-notification" }),
    );
    await settle();

    // 999.155 — held until the merge decision (a daemon send is pending).
    expect(h.orphans).toHaveLength(0);

    // The REAL daemon turn arrives next — that decides "separate": the held
    // wake output is delivered as orphan and the real turn pairs correctly.
    h.raw.feed(init(), assistant("real reply"), result("real reply"));
    await settle();
    expect(h.orphans).toHaveLength(1);
    expect(h.orphans[0].classification).toBe("reclassified-from-daemon");

    // The daemon consumer sees: leaked tentative frames (init+assistant,
    // already forwarded before the heal — documented pollution), then the
    // real turn (init+assistant+result) ending in the CORRECT result.
    const frames = await h.take(5);
    const results = frames.filter((f) => (f as { type?: string }).type === "result");
    expect(results).toHaveLength(1);
    expect((results[0] as { result?: string }).result).toBe("real reply");
  });

  it("orphan-tentative turn whose result has NO origin while a daemon send is pending flushes to the daemon consumer (correct pairing)", async () => {
    const h = harness();
    // A task-notification arrives, then the daemon sends. FIFO tentatively
    // classifies the next turn as orphan — but it is actually the daemon's
    // (the CLI processed the stdin message first).
    h.raw.feed(notification());
    await settle();
    h.demux.registerDaemonSend();
    h.raw.feed(init(), assistant("daemon reply"), result("daemon reply"));
    await settle();

    // Healed: nothing delivered as orphan; the daemon consumer receives the
    // ambient notification + the full buffered sequence ending in the
    // correct result (4 frames total).
    expect(h.orphans).toHaveLength(0);
    const frames = await h.take(4);
    const types = frames.map((f) => (f as { type?: string }).type);
    expect(types).toContain("assistant");
    const resultFrame = frames.find((f) => (f as { type?: string }).type === "result");
    expect((resultFrame as { result?: string }).result).toBe("daemon reply");

    // The orphan expectation was restored — the actual wake turn that
    // follows classifies as orphan.
    h.raw.feed(init(), assistant("wake output"), result("wake output", { origin: "task-notification" }));
    await settle();
    expect(h.orphans).toHaveLength(1);
    expect(h.orphans[0].text).toBe("wake output");
  });
});

// ---------------------------------------------------------------------------
// Signals to the handle (stall pause / activity)
// ---------------------------------------------------------------------------

describe("AttributedStreamDemux — orphan-turn hooks", () => {
  it("fires onOrphanTurnStart/End around a signaled orphan turn", async () => {
    const onOrphanTurnStart = vi.fn();
    const onOrphanTurnEnd = vi.fn();
    const h = harness({ onOrphanTurnStart, onOrphanTurnEnd });
    h.raw.feed(notification(), init(), assistant("x"), result("x", { origin: "task-notification" }));
    await settle();
    expect(onOrphanTurnStart).toHaveBeenCalledTimes(1);
    expect(onOrphanTurnEnd).toHaveBeenCalledTimes(1);
  });

  it("fires onActivity for every raw frame (999.64 watchdog feed)", async () => {
    const onActivity = vi.fn();
    const h = harness({ onActivity });
    h.raw.feed(notification(), init(), assistant("x"), result("x", { origin: "task-notification" }));
    await settle();
    expect(onActivity).toHaveBeenCalledTimes(4);
  });

  it("balances onOrphanTurnEnd when the stream dies mid-orphan-turn", async () => {
    const onOrphanTurnStart = vi.fn();
    const onOrphanTurnEnd = vi.fn();
    const h = harness({ onOrphanTurnStart, onOrphanTurnEnd });
    h.raw.feed(notification(), init(), assistant("half"));
    await settle();
    expect(onOrphanTurnStart).toHaveBeenCalledTimes(1);
    h.raw.end();
    await settle();
    expect(onOrphanTurnEnd).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Stream termination / errors / teardown
// ---------------------------------------------------------------------------

describe("AttributedStreamDemux — termination semantics (legacy parity)", () => {
  it("raw stream end → turn iterator yields done (legacy loop throws generator-dead)", async () => {
    const h = harness();
    h.raw.end();
    await settle();
    const step = await h.turnIter.next();
    expect(step.done).toBe(true);
  });

  it("raw stream error → pending turn iterator next() REJECTS with that error", async () => {
    const h = harness();
    h.demux.registerDaemonSend();
    const pending = h.turnIter.next();
    const boom = new Error("spawn EPIPE");
    h.raw.fail(boom);
    await expect(pending).rejects.toBe(boom);
  });

  it("abandoned next() from an interrupted turn does not break the following turn (waiter FIFO)", async () => {
    const h = harness();
    h.demux.registerDaemonSend();
    // Turn 1 is interrupted: its raced next() is abandoned (never settled by a frame).
    const abandoned = h.turnIter.next();
    // Turn 2 issues its own next() — must NOT reject.
    const t2first = h.turnIter.next();
    h.raw.feed(init(), assistant("late"), result("late"));
    await settle();
    // The abandoned waiter consumed the first frame (generator semantics);
    // turn 2's next() got the second.
    const a = await abandoned;
    expect((a.value as { subtype?: string }).subtype).toBe("init");
    const b = await t2first;
    expect((b.value as { type?: string }).type).toBe("assistant");
  });

  it("stop() ends the turn iterator and the pump", async () => {
    const h = harness();
    h.demux.stop();
    const step = await h.turnIter.next();
    expect(step.done).toBe(true);
    await h.demux.whenDone();
  });

  it("a throwing onOrphanOutput sink never wedges the pump (fire-and-forget delivery)", async () => {
    const raw = makeRawStream();
    const demux = new AttributedStreamDemux({
      raw: raw.iter,
      onOrphanOutput: () => {
        throw new Error("delivery boom");
      },
    });
    raw.feed(notification(), init(), assistant("x"), result("x", { origin: "task-notification" }));
    await settle();
    // Pump alive: a daemon turn still flows.
    demux.registerDaemonSend();
    raw.feed(init(), result("ok"));
    await settle();
    const it = demux.turnIterator();
    // notification (ambient) + init + result
    const f1 = await it.next();
    const f2 = await it.next();
    const f3 = await it.next();
    expect(
      [f1, f2, f3].some(
        (s) => (s.value as { result?: string } | undefined)?.result === "ok",
      ),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Edges
// ---------------------------------------------------------------------------

describe("AttributedStreamDemux — edges", () => {
  it("bare result while idle with a pending daemon send is forwarded (stale zero-content daemon completion)", async () => {
    const h = harness();
    h.demux.registerDaemonSend();
    h.raw.feed(result("bare"));
    await settle();
    const frames = await h.take(1);
    expect((frames[0] as { result?: string }).result).toBe("bare");
  });

  it("bare result while idle with NO expectations goes to the orphan sink (never invents a pairing)", async () => {
    const h = harness();
    h.raw.feed(result("stale orphan", { origin: "task-notification" }));
    await settle();
    expect(h.orphans).toHaveLength(1);
    expect(h.orphans[0].text).toBe("stale orphan");
  });

  it("zero-content orphan result consumes its pending signal (no misclassification of the NEXT turn)", async () => {
    const h = harness();
    h.raw.feed(notification(), result("", { origin: "task-notification" }));
    await settle();
    // Signal consumed: the next daemon turn classifies correctly.
    h.demux.registerDaemonSend();
    h.raw.feed(init(), assistant("mine"), result("mine"));
    await settle();
    const frames = await h.take(4);
    const resultFrame = frames.find((f) => (f as { type?: string }).type === "result");
    expect((resultFrame as { result?: string }).result).toBe("mine");
    expect(h.orphans).toHaveLength(0);
  });

  it("is_error orphan results surface isError", async () => {
    const h = harness();
    h.raw.feed(
      notification(),
      init(),
      result("failed badly", { origin: "task-notification", isError: true }),
    );
    await settle();
    expect(h.orphans[0].isError).toBe(true);
  });

  it("interleaved: orphan completes BETWEEN two daemon turns — both daemon turns pair correctly", async () => {
    const h = harness();

    // Daemon turn 1.
    h.demux.registerDaemonSend();
    h.raw.feed(init(), assistant("one"), result("one"));
    await settle();
    let frames = await h.take(3);
    expect((frames[2] as { result?: string }).result).toBe("one");

    // Orphan fires while idle.
    h.raw.feed(notification(), init(), assistant("bg"), result("bg", { origin: "task-notification" }));
    await settle();
    expect(h.orphans.map((o) => o.text)).toEqual(["bg"]);

    // Daemon turn 2 — must get "two", not "bg".
    h.demux.registerDaemonSend();
    h.raw.feed(init(), assistant("two"), result("two"));
    await settle();
    frames = await h.take(4); // includes forwarded ambient notification frame
    const resultFrame = frames.find((f) => (f as { type?: string }).type === "result");
    expect((resultFrame as { result?: string }).result).toBe("two");
  });
});

// ---------------------------------------------------------------------------
// 999.155 — folded inputs (CLI queue-operation enqueue→remove)
// ---------------------------------------------------------------------------

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe("AttributedStreamDemux — 999.155 folded notifications and sends", () => {
  it("a notification folded into daemon turn 1 does NOT turn daemon turn 2 orphan (projects 09-22: silent 15-min turn)", async () => {
    const h = harness();
    h.demux.registerDaemonSend();
    h.raw.feed(init(), assistant("working"));
    await settle();
    // Background task finishes MID-TURN — the CLI folds it into this turn.
    h.raw.feed(notification(), toolResult(), assistant("done one"), result("done one"));
    await settle();
    await h.take(6); // turn 1: init, assistant, ambient signal, tool_result, assistant, result

    // Daemon turn 2: must stream live to the daemon consumer, not buffer.
    h.demux.registerDaemonSend();
    h.raw.feed(init(), assistant("streaming live"));
    await settle();
    expect(h.demux.isDaemonTurnOpen()).toBe(true);
    const live = await h.take(2);
    expect((live[1] as { type?: string }).type).toBe("assistant");
    h.raw.feed(result("two"));
    await settle();
    const [r] = await h.take(1);
    expect((r as { result?: string }).result).toBe("two");
    expect(h.orphans).toHaveLength(0);
    expect(h.logCalls.some((c) => c.msg.includes("yielded to a pending daemon send"))).toBe(true);
    expect(h.logCalls.some((c) => c.msg.includes("reclassified to daemon at result"))).toBe(false);
  });

  it("two mid-turn signals both yield to a send registered AFTER them", async () => {
    const h = harness();
    h.demux.registerDaemonSend();
    h.raw.feed(init(), assistant("turn one"));
    await settle();
    // Two background tasks finish mid-turn; both fold into the running turn.
    h.raw.feed(notification(), notification(), result("one"));
    await settle();
    await h.take(5);
    // The next send registers only now — after both signals were queued.
    h.demux.registerDaemonSend();
    h.raw.feed(init(), assistant("turn two"), result("two"));
    await settle();
    expect(h.orphans).toHaveLength(0);
    const frames = await h.take(3);
    expect((frames[2] as { result?: string }).result).toBe("two");
  });

  it("an IDLE notification still opens its own orphan turn ahead of a pending send", async () => {
    const h = harness({ mergeGraceMs: 30 });
    h.raw.feed(notification());
    await settle();
    h.demux.registerDaemonSend();
    h.raw.feed(init(), assistant("bg"));
    await settle();
    expect(h.demux.isOrphanTurnOpen()).toBe(true);
  });

  it("a daemon send folded into a running self-fired turn gets that turn's result (state-contract 09-22: queue jam)", async () => {
    const h = harness({ mergeGraceMs: 30 });
    h.raw.feed(notification(), init(), assistant("reading the transcript"));
    await settle();
    // Daemon pushes the summary request while the self-fired turn runs.
    h.demux.registerDaemonSend();
    h.raw.feed(assistant("summary for the owner"), result("summary for the owner", { origin: "task-notification" }));
    await settle();
    expect(h.orphans).toHaveLength(0); // held
    await sleep(60); // no separate turn opens → folded
    // ambient signal + held init/assistant/assistant + result
    const frames = await h.take(5);
    const res = frames.find((f) => (f as { type?: string }).type === "result");
    expect((res as { result?: string }).result).toBe("summary for the owner");
    expect(h.orphans).toHaveLength(0);
  });

  it("…but when a separate turn does open within the window, the held output is orphan and the send pairs with its own turn", async () => {
    const h = harness({ mergeGraceMs: 200 });
    h.raw.feed(notification(), init(), assistant("bg work"));
    await settle();
    h.demux.registerDaemonSend();
    h.raw.feed(result("bg done", { origin: "task-notification" }));
    await settle();
    h.raw.feed(init(), assistant("daemon answer"), result("daemon answer"));
    await settle();
    expect(h.orphans.map((o) => o.text)).toEqual(["bg done"]);
    // ambient signal + the daemon's own init/assistant/result
    const frames = await h.take(4);
    const res = frames.find((f) => (f as { type?: string }).type === "result");
    expect((res as { result?: string }).result).toBe("daemon answer");
  });

  it("daemon-tentative turn reclassified by origin, with no follow-up turn, keeps its result (folded)", async () => {
    const h = harness({ mergeGraceMs: 30 });
    h.demux.registerDaemonSend();
    h.raw.feed(init(), assistant("merged reply"), result("merged reply", { origin: "task-notification" }));
    await settle();
    await sleep(60);
    const frames = await h.take(3);
    expect((frames[2] as { result?: string }).result).toBe("merged reply");
    expect(h.orphans).toHaveLength(0);
  });

  it("orphan-turn frames feed onOrphanActivity (stall-tracker proof of life)", async () => {
    let n = 0;
    const h = harness({ onOrphanActivity: () => n++ });
    h.raw.feed(notification(), init(), assistant("a"), toolResult(), assistant("b"));
    await settle();
    expect(n).toBe(4);
  });

  it("stop() while a close is held delivers it as orphan (never lost)", async () => {
    const h = harness({ mergeGraceMs: 10_000 });
    h.raw.feed(notification(), init(), assistant("x"));
    await settle();
    h.demux.registerDaemonSend();
    h.raw.feed(result("x", { origin: "task-notification" }));
    await settle();
    h.demux.stop();
    expect(h.orphans.map((o) => o.text)).toEqual(["x"]);
  });

  it("a send abandoned during the hold falls back to orphan delivery", async () => {
    const h = harness({ mergeGraceMs: 30 });
    h.raw.feed(notification(), init(), assistant("y"));
    await settle();
    const token = h.demux.registerDaemonSend();
    h.raw.feed(result("y", { origin: "task-notification" }));
    await settle();
    h.demux.abandonDaemonTurn(token, "deadline");
    await sleep(60);
    expect(h.orphans.map((o) => o.text)).toEqual(["y"]);
  });
});
