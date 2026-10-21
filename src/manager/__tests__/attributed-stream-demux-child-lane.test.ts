/**
 * 999.173 — AttributedStreamDemux child lane + task tap.
 *
 * Subagent frames carry a non-null `parent_tool_use_id`. A BACKGROUND
 * researcher's frames arrive while the parent is idle; before this fix they
 * opened a phantom orphan turn that swallowed the user's next reply (the
 * daemon turn opened orphan-tentative: no streaming, stall tracker paused).
 * Pinned here:
 *   - a child frame never opens, feeds or closes a parent turn;
 *   - it reaches the daemon queue only while a DAEMON turn is open (legacy
 *     parity for a foreground subagent) and never for a detached background
 *     task's lane;
 *   - `system/task_*` + `background_tasks_changed` frames are reported to
 *     `onTaskFrame` and keep their routing (task_notification still signals).
 *
 * Frame factories + raw harness are local copies (private to each suite).
 */
import { describe, it, expect } from "vitest";
import {
  AttributedStreamDemux,
  type OrphanTurnOutput,
} from "../attributed-stream-demux.js";
import type { SdkStreamMessage } from "../sdk-types.js";

const asFrame = (o: Record<string, unknown>) => o as unknown as SdkStreamMessage;
const notification = (taskId = "t1") =>
  asFrame({ type: "system", subtype: "task_notification", task_id: taskId, status: "completed", summary: "done" });
const taskStarted = (taskId: string, toolUseId: string) =>
  asFrame({ type: "system", subtype: "task_started", task_id: taskId, tool_use_id: toolUseId, description: "d", subagent_type: "researcher" });
const taskProgress = (taskId: string) =>
  asFrame({ type: "system", subtype: "task_progress", task_id: taskId, description: "d", usage: { total_tokens: 1, tool_uses: 1, duration_ms: 1 }, summary: "Reading" });
const taskUpdated = (taskId: string) =>
  asFrame({ type: "system", subtype: "task_updated", task_id: taskId, patch: { status: "running" } });
const bgChanged = (ids: string[]) =>
  asFrame({ type: "system", subtype: "background_tasks_changed", tasks: ids.map((id) => ({ task_id: id, task_type: "local_agent", description: "d" })) });
const assistant = (text: string, parent: string | null = null) =>
  asFrame({ type: "assistant", parent_tool_use_id: parent, message: { content: [{ type: "text", text }] } });
const userToolResult = (parent: string | null) =>
  asFrame({ type: "user", parent_tool_use_id: parent, message: { content: [{ type: "tool_result", tool_use_id: "x", content: "r" }] } });
const streamEvent = (parent: string | null = null) =>
  asFrame({ type: "stream_event", parent_tool_use_id: parent, event: {} });
const result = (text: string, opts: { origin?: string } = {}) =>
  asFrame({
    type: "result",
    subtype: "success",
    result: text,
    is_error: false,
    ...(opts.origin ? { origin: { kind: opts.origin } } : {}),
  });

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

function harness(opts: { detached?: (id: string) => boolean } = {}) {
  const raw = makeRawStream();
  const orphans: OrphanTurnOutput[] = [];
  const children: { parentToolUseId: string; openKind: string | null }[] = [];
  const tasks: SdkStreamMessage[] = [];
  let orphanActivity = 0;
  let orphanStarts = 0;
  const noop = () => undefined;
  const demux = new AttributedStreamDemux({
    raw: raw.iter,
    onOrphanOutput: (o) => orphans.push(o),
    onOrphanTurnStart: () => {
      orphanStarts++;
    },
    onOrphanActivity: () => {
      orphanActivity++;
    },
    onChildFrame: (ev) => children.push({ parentToolUseId: ev.parentToolUseId, openKind: ev.openKind }),
    onTaskFrame: (f) => tasks.push(f),
    ...(opts.detached ? { isDetachedChild: opts.detached } : {}),
    mergeGraceMs: 5,
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
  return {
    raw,
    demux,
    orphans,
    children,
    tasks,
    take,
    get orphanActivity() {
      return orphanActivity;
    },
    get orphanStarts() {
      return orphanStarts;
    },
  };
}

const typeOf = (f: SdkStreamMessage) => (f as { type?: string }).type;
const subtypeOf = (f: SdkStreamMessage) => (f as { subtype?: string }).subtype;

describe("AttributedStreamDemux — child lane (999.173)", () => {
  it("child frames while idle never open a turn — the user's next message still streams as a daemon turn", async () => {
    const h = harness();
    // A background researcher streams while the parent is idle.
    h.raw.feed(streamEvent("toolu_R1"), assistant("researcher notes", "toolu_R1"), userToolResult("toolu_R1"));
    await settle();
    expect(h.demux.isOrphanTurnOpen()).toBe(false);
    expect(h.orphanStarts).toBe(0);
    expect(h.children.map((c) => c.openKind)).toEqual([null, null, null]);

    // The user sends; the reply streams to the daemon consumer, not an orphan buffer.
    h.demux.registerDaemonSend();
    h.raw.feed(streamEvent(), assistant("reply"), result("reply"));
    await settle();
    expect(h.demux.isOrphanTurnOpen()).toBe(false);
    const frames = await h.take(3);
    expect(frames.map(typeOf)).toEqual(["stream_event", "assistant", "result"]);
    expect((frames[2] as { result?: string }).result).toBe("reply");
    expect(h.orphans).toEqual([]);
  });

  it("idle child frames are dropped, not queued for the next daemon turn", async () => {
    const h = harness();
    h.raw.feed(assistant("stale researcher text", "toolu_R1"));
    await settle();
    h.demux.registerDaemonSend();
    h.raw.feed(assistant("real"), result("real"));
    await settle();
    const frames = await h.take(2);
    expect(frames.map(typeOf)).toEqual(["assistant", "result"]);
    expect(frames[0]).not.toHaveProperty("parent_tool_use_id", "toolu_R1");
  });

  it("a foreground subagent's frames during a daemon turn still reach the daemon queue (parity)", async () => {
    const h = harness();
    h.demux.registerDaemonSend();
    const child = assistant("sub text", "toolu_F1");
    h.raw.feed(streamEvent(), child, assistant("parent"), result("parent"));
    await settle();
    const frames = await h.take(4);
    expect(frames[1]).toBe(child);
    expect(h.children).toEqual([{ parentToolUseId: "toolu_F1", openKind: "daemon" }]);
  });

  it("a detached background task's lane never reaches a later daemon turn", async () => {
    const h = harness({ detached: (id) => id === "toolu_R1" });
    h.demux.registerDaemonSend();
    h.raw.feed(streamEvent(), assistant("researcher", "toolu_R1"), assistant("parent"), result("parent"));
    await settle();
    const frames = await h.take(3);
    expect(frames.map(typeOf)).toEqual(["stream_event", "assistant", "result"]);
    expect((frames[1] as { parent_tool_use_id?: unknown }).parent_tool_use_id).toBeNull();
    expect(h.children).toEqual([{ parentToolUseId: "toolu_R1", openKind: "daemon" }]);
  });

  it("child frames during a self-fired turn never leak into its delivered text, but prove liveness", async () => {
    const h = harness();
    h.raw.feed(notification(), assistant("interim", null));
    await settle();
    expect(h.demux.isOrphanTurnOpen()).toBe(true);
    const before = h.orphanActivity;
    h.raw.feed(assistant("RAW RESEARCHER TEXT", "toolu_R2"));
    await settle();
    expect(h.orphanActivity).toBe(before + 1);
    h.raw.feed(result("", { origin: "task-notification" }));
    await settle();
    expect(h.orphans).toHaveLength(1);
    expect(h.orphans[0]!.text).toBe("interim");
  });

  it("frames with parent_tool_use_id null behave exactly as before", async () => {
    const h = harness();
    h.demux.registerDaemonSend();
    h.raw.feed(assistant("hi", null), result("hi"));
    await settle();
    const frames = await h.take(2);
    expect(frames.map(typeOf)).toEqual(["assistant", "result"]);
    expect(h.children).toEqual([]);
  });
});

describe("AttributedStreamDemux — task tap (999.173)", () => {
  it("reports every task frame and keeps ambient routing unchanged", async () => {
    const h = harness();
    const frames = [taskStarted("a1", "toolu_R1"), taskProgress("a1"), taskUpdated("a1"), bgChanged(["a1"])];
    h.raw.feed(...frames);
    await settle();
    expect(h.tasks).toEqual(frames);
    const forwarded = await h.take(frames.length);
    forwarded.forEach((f, i) => expect(f).toBe(frames[i]));
  });

  it("task_notification is reported AND still signals the self-fired turn that follows", async () => {
    const h = harness();
    const note = notification("a1");
    h.raw.feed(note, assistant("synthesis"), result("synthesis", { origin: "task-notification" }));
    await settle();
    expect(h.tasks).toEqual([note]);
    expect(h.orphans.map((o) => o.classification)).toEqual(["orphan-signaled"]);
    const forwarded = await h.take(1);
    expect(subtypeOf(forwarded[0]!)).toBe("task_notification");
  });

  it("reports every result frame before the turn closes — including an empty self-fired wake", async () => {
    const raw = makeRawStream();
    const noop = () => undefined;
    const results: SdkStreamMessage[] = [];
    const orphans: OrphanTurnOutput[] = [];
    const demux = new AttributedStreamDemux({
      raw: raw.iter,
      onOrphanOutput: (o) => orphans.push(o),
      onResultFrame: (f) => results.push(f),
      log: { info: noop, warn: noop, error: noop },
    });
    const empty = result("", { origin: "task-notification" });
    raw.feed(notification("a1"), asFrame({ type: "system", subtype: "init" }), empty);
    demux.registerDaemonSend();
    const daemonResult = result("reply");
    raw.feed(assistant("reply"), daemonResult);
    await settle();
    expect(results).toEqual([empty, daemonResult]);
    // The empty wake delivered nothing — the tap is the only way to count it.
    expect(orphans).toEqual([]);
  });

  it("a held self-fired close is delivered BEFORE the next result is reported (attribution order)", async () => {
    const raw = makeRawStream();
    const noop = () => undefined;
    const events: string[] = [];
    const demux = new AttributedStreamDemux({
      raw: raw.iter,
      onOrphanOutput: (o) => events.push(`orphan:${o.text}`),
      onResultFrame: (f) => events.push(`result:${String((f as { result?: unknown }).result)}`),
      mergeGraceMs: 60_000,
      log: { info: noop, warn: noop, error: noop },
    });
    raw.feed(notification("a1"), asFrame({ type: "system", subtype: "init" }), assistant("wake A"));
    await settle();
    // A user send is registered while the wake turn is open → its close is held.
    demux.registerDaemonSend();
    raw.feed(result("wake A", { origin: "task-notification" }));
    await settle();
    expect(events).toEqual(["result:wake A"]);
    // The next frame is a result straight away (zero-content turn).
    raw.feed(result("B"));
    await settle();
    expect(events).toEqual(["result:wake A", "orphan:wake A", "result:B"]);
  });

  it("a throwing task or child consumer never stops the pump", async () => {
    const raw = makeRawStream();
    const noop = () => undefined;
    const demux = new AttributedStreamDemux({
      raw: raw.iter,
      onOrphanOutput: noop,
      onTaskFrame: () => {
        throw new Error("tracker exploded");
      },
      onChildFrame: () => {
        throw new Error("card exploded");
      },
      log: { info: noop, warn: noop, error: noop },
    });
    raw.feed(taskStarted("a1", "toolu_R1"), assistant("child", "toolu_R1"));
    demux.registerDaemonSend();
    raw.feed(assistant("ok"), result("ok"));
    await settle();
    const it2 = demux.turnIterator();
    const out: SdkStreamMessage[] = [];
    for (let i = 0; i < 3; i++) {
      const s = await it2.next();
      out.push(s.value);
    }
    expect(out.map(typeOf)).toEqual(["system", "assistant", "result"]);
  });
});
