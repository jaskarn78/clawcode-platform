/**
 * 999.143 — the state machine. The failures worth preventing are all here:
 * a second card for the same job, a transcript delivered twice, a job that
 * never completes, and a failure reported on every tick.
 */
import { describe, it, expect } from "vitest";
import { reconcile, withMessageId, type Observed, type TrackedJob } from "../reconcile.js";

const T0 = 1_700_000_000;
const NOW = (T0 + 60) * 1000;

const obs = (over: Partial<Observed> = {}): Observed => ({
  tree: "client-a-personal", job: "standup", done: false,
  progress: { job: "standup", phase: "transcribing", audio_seconds: 1800, job_started_at: T0, phase_started_at: T0 },
  ...over,
});
const empty = new Map<string, TrackedJob>();

describe("first sight", () => {
  it("posts one card", () => {
    const { actions } = reconcile(empty, [obs()], NOW);
    expect(actions).toHaveLength(1);
    expect(actions[0]!.kind).toBe("post");
  });

  it("does not post again while the post is still in flight", () => {
    // No messageId recorded yet — the next tick must wait, not post a duplicate.
    const { next } = reconcile(empty, [obs()], NOW);
    const { actions } = reconcile(next, [obs()], NOW + 30_000);
    expect(actions).toHaveLength(0);
  });

  it("edits once the message id is known and the bar has moved", () => {
    let { next } = reconcile(empty, [obs()], NOW);
    next = withMessageId(next, "client-a-personal", "standup", "msg-1");
    const r = reconcile(next, [obs()], NOW + 120_000);
    expect(r.actions[0]).toMatchObject({ kind: "edit", messageId: "msg-1" });
  });

  it("does not edit when nothing visible changed", () => {
    let { next } = reconcile(empty, [obs()], NOW);
    next = withMessageId(next, "client-a-personal", "standup", "msg-1");
    const r = reconcile(next, [obs()], NOW + 200);   // same rounded pct
    expect(r.actions).toHaveLength(0);
  });
});

describe("completion", () => {
  it("completes on the worker's sentinel, not on the percentage", () => {
    let { next } = reconcile(empty, [obs()], NOW);
    next = withMessageId(next, "client-a-personal", "standup", "msg-1");
    const r = reconcile(next, [obs({ done: true })], NOW + 300_000);
    expect(r.actions[0]).toMatchObject({ kind: "complete", messageId: "msg-1" });
    expect(r.actions[0]).toHaveProperty("state.pct", 100);
  });

  it("delivers the transcript exactly once", () => {
    let { next } = reconcile(empty, [obs()], NOW);
    next = withMessageId(next, "client-a-personal", "standup", "msg-1");
    const first = reconcile(next, [obs({ done: true })], NOW + 300_000);
    const second = reconcile(first.next, [obs({ done: true })], NOW + 360_000);
    expect(first.actions).toHaveLength(1);
    expect(second.actions).toHaveLength(0);
  });

  it("completes even if we never saw it running", () => {
    // A short job can finish between two polls; it must still be delivered.
    const r = reconcile(empty, [obs({ done: true })], NOW);
    expect(r.actions[0]!.kind).toBe("complete");
  });
});

describe("failure", () => {
  it("reports a failure once, not on every tick", () => {
    const first = reconcile(empty, [obs({ failed: "CUDA OOM" })], NOW);
    const second = reconcile(first.next, [obs({ failed: "CUDA OOM" })], NOW + 60_000);
    expect(first.actions[0]).toMatchObject({ kind: "fail", reason: "CUDA OOM" });
    expect(second.actions).toHaveLength(0);
  });

  it("edits the existing card rather than orphaning it", () => {
    let { next } = reconcile(empty, [obs()], NOW);
    next = withMessageId(next, "client-a-personal", "standup", "msg-1");
    const r = reconcile(next, [obs({ failed: "bad audio" })], NOW + 10_000);
    expect(r.actions[0]).toMatchObject({ kind: "fail", messageId: "msg-1" });
  });
});

describe("routing and isolation", () => {
  it("keeps jobs in different trees separate even with the same name", () => {
    const r = reconcile(empty, [
      obs({ tree: "client-a-personal", job: "call" }),
      obs({ tree: "state-contract", job: "call" }),
    ], NOW);
    expect(r.actions).toHaveLength(2);
    expect(r.next.size).toBe(2);
    expect([...r.next.keys()].sort()).toEqual(["client-a-personal/call", "state-contract/call"]);
  });

  it("carries the queue position through so the card can explain the wait", () => {
    const r = reconcile(empty, [obs({ progress: { job: "standup", phase: "queued" }, queuePosition: 2 })], NOW);
    expect(r.actions[0]).toMatchObject({ kind: "post", queuePosition: 2 });
  });

  it("forgets jobs that vanish from the trees", () => {
    const { next } = reconcile(empty, [obs()], NOW);
    const r = reconcile(next, [], NOW + 60_000);
    expect(r.next.size).toBe(0);
    expect(r.actions).toHaveLength(0);
  });
});

describe("monotonic progress across ticks", () => {
  it("never rewinds the bar the user already saw", () => {
    let { next } = reconcile(empty, [obs({ progress: { job: "standup", phase: "diarizing", audio_seconds: 1800, job_started_at: T0, phase_started_at: T0 } })], NOW);
    next = withMessageId(next, "client-a-personal", "standup", "msg-1");
    const seen = next.get("client-a-personal/standup")!.last!.pct;
    const r = reconcile(next, [obs()], NOW + 1000);   // a LATE 'transcribing' arrives
    const shown = r.next.get("client-a-personal/standup")!.last!.pct;
    expect(shown).toBeGreaterThanOrEqual(seen);
  });
});

describe("duplicate observations (regression 2026-09-16)", () => {
  // The worker leaves the source in inbox/ until the job FINISHES, so for the
  // whole run a job is observed twice in one poll: queued (inbox) and running
  // (output). Each was compared against the previous state, so both looked new
  // and TWO cards were posted for one recording — seen in production.
  const queued: Observed = { tree: "client-a-personal", job: "standup", done: false };
  const running: Observed = {
    tree: "client-a-personal", job: "standup", done: false,
    progress: { job: "standup", phase: "transcribing", audio_seconds: 600, job_started_at: T0, phase_started_at: T0 },
  };

  it("posts ONE card when a job is seen as both queued and running", () => {
    const { actions } = reconcile(empty, [queued, running], NOW);
    expect(actions).toHaveLength(1);
  });

  it("keeps the more advanced view — running, not queued", () => {
    const { actions } = reconcile(empty, [queued, running], NOW);
    expect((actions[0] as { state: { phase: string } }).state.phase).toBe("transcribing");
  });

  it("done beats a lingering inbox entry", () => {
    const { actions } = reconcile(empty, [queued, { ...running, done: true }], NOW);
    expect(actions).toHaveLength(1);
    expect(actions[0]!.kind).toBe("complete");
  });

  it("priming also collapses, so history is adopted once", () => {
    const { next } = reconcile(empty, [queued, { ...running, done: true }], NOW);
    expect(next.size).toBe(1);
  });
});
