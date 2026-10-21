import { describe, it, expect, vi } from "vitest";
import { TranscriptionWatcher, type WatcherDeps } from "../watcher.js";
import type { Observed } from "../reconcile.js";

const T0 = 1_700_000_000;
const run = (over: Partial<Observed> = {}): Observed => ({
  tree: "client-a-personal", job: "standup", done: false,
  progress: { job: "standup", phase: "transcribing", audio_seconds: 1800, job_started_at: T0, phase_started_at: T0 },
  ...over,
});

function harness(jobs: Observed[][] | Observed[]) {
  const frames = Array.isArray(jobs[0]) ? (jobs as Observed[][]) : [jobs as Observed[]];
  let i = 0;
  const calls = { post: [] as unknown[], edit: [] as unknown[], deliver: [] as unknown[] };
  const deps: WatcherDeps = {
    poll: async () => frames[Math.min(i++, frames.length - 1)]!,
    agentFor: (t) => (t === "client-a-personal" ? "client-a-personal" : undefined),
    postCard: async (a, s) => { calls.post.push({ a, s }); return `msg-${calls.post.length}`; },
    editCard: async (a, m, s) => { calls.edit.push({ a, m, s }); },
    deliver: async (a, t, j) => { calls.deliver.push({ a, t, j }); },
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };
  return { deps, calls, w: new TranscriptionWatcher(deps, 10_000, true) };
}

describe("TranscriptionWatcher", () => {
  it("posts one card for a new job", async () => {
    const { w, calls } = harness([run()]);
    await w.tick((T0 + 60) * 1000);
    expect(calls.post).toHaveLength(1);
  });

  it("edits the SAME message rather than posting again", async () => {
    const { w, calls } = harness([[run()], [run()]]);
    await w.tick((T0 + 60) * 1000);
    await w.tick((T0 + 200) * 1000);
    expect(calls.post).toHaveLength(1);
    expect(calls.edit).toHaveLength(1);
    expect((calls.edit[0] as { m: string }).m).toBe("msg-1");
  });

  it("delivers the transcript exactly once when the job completes", async () => {
    const { w, calls } = harness([[run()], [run({ done: true })], [run({ done: true })]]);
    await w.tick((T0 + 60) * 1000);
    await w.tick((T0 + 300) * 1000);
    await w.tick((T0 + 360) * 1000);
    expect(calls.deliver).toHaveLength(1);
  });

  it("shows the finished card BEFORE fetching, so it never sits mid-bar", async () => {
    const order: string[] = [];
    const { deps } = harness([run({ done: true })]);
    const w = new TranscriptionWatcher({
      ...deps,
      editCard: async () => { order.push("card"); },
      postCard: async () => { order.push("card"); return "m1"; },
      deliver: async () => { order.push("deliver"); },
    }, 10_000, true);
    await w.tick((T0 + 60) * 1000);
    expect(order).toEqual(["card", "deliver"]);
  });

  it("ignores trees with no agent, and warns only once", async () => {
    const { deps, calls } = harness([[run({ tree: "orphan" })], [run({ tree: "orphan" })]]);
    const w = new TranscriptionWatcher(deps, 10_000, true);
    await w.tick(); await w.tick();
    expect(calls.post).toHaveLength(0);
    expect((deps.log.warn as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
  });

  it("routes a job to the agent that owns its tree", async () => {
    const { w, calls } = harness([run()]);
    await w.tick((T0 + 60) * 1000);
    expect((calls.post[0] as { a: string }).a).toBe("client-a-personal");
  });

  it("survives a poll that throws and keeps ticking", async () => {
    const { deps, calls } = harness([run()]);
    let first = true;
    const w = new TranscriptionWatcher({
      ...deps,
      poll: async () => { if (first) { first = false; throw new Error("ssh down"); } return [run()]; },
    }, 10_000, true);
    await w.tick();                       // throws internally, must not propagate
    await w.tick((T0 + 60) * 1000);
    expect(calls.post).toHaveLength(1);
    expect(deps.log.error).toHaveBeenCalled();
  });

  it("survives a Discord post failure without losing the job", async () => {
    const { deps, calls } = harness([[run()], [run()]]);
    let fail = true;
    const w = new TranscriptionWatcher({
      ...deps,
      postCard: async (a, s) => { if (fail) { fail = false; throw new Error("429"); } calls.post.push({ a, s }); return "m1"; },
    }, 10_000, true);
    await w.tick((T0 + 60) * 1000);       // post throws
    await w.tick((T0 + 200) * 1000);      // no messageId yet -> no duplicate post
    expect(calls.edit).toHaveLength(0);
  });

  it("does not let a slow poll overlap the next tick", async () => {
    let inFlight = 0, maxConcurrent = 0;
    const { deps } = harness([run()]);
    const w = new TranscriptionWatcher({
      ...deps,
      poll: async () => {
        inFlight += 1; maxConcurrent = Math.max(maxConcurrent, inFlight);
        await new Promise((r) => setTimeout(r, 20));
        inFlight -= 1; return [run()];
      },
    }, 10_000, true);
    await Promise.all([w.tick(), w.tick(), w.tick()]);
    expect(maxConcurrent).toBe(1);
  });

  it("reports a failure on the existing card", async () => {
    const { w, calls } = harness([[run()], [run({ failed: "CUDA OOM" })]]);
    await w.tick((T0 + 60) * 1000);
    await w.tick((T0 + 120) * 1000);
    const last = calls.edit.at(-1) as { s: { blocks: { type: string; content?: string }[] } };
    expect(JSON.stringify(last.s)).toContain("CUDA OOM");
    expect(calls.deliver).toHaveLength(0);   // nothing to deliver
  });
});

describe("cold start — the archive must not be replayed", () => {
  // REGRESSION (2026-09-16, caught in production): the first tick treated every
  // historical job as new. 46 finished jobs sat in the output trees; it posted
  // cards and re-delivered old transcripts into a live channel before it was
  // stopped. The output tree is an archive, not a queue.
  const history: Observed[] = [
    { tree: "client-a-personal", job: "old-1", done: true },
    { tree: "client-a-personal", job: "old-2", done: true },
    { tree: "client-a-personal", job: "old-fail", done: false, failed: "CUDA OOM" },
  ];

  const coldHarness = (frames: Observed[][]) => {
    const h = harness(frames);
    return { ...h, w: new TranscriptionWatcher(h.deps, 10_000) };   // NOT primed
  };

  it("posts nothing and delivers nothing for jobs already finished at startup", async () => {
    const { w, calls } = coldHarness([history, history]);
    await w.tick();            // primes
    await w.tick();            // steady state
    expect(calls.post).toHaveLength(0);
    expect(calls.deliver).toHaveLength(0);
    expect(calls.edit).toHaveLength(0);
  });

  it("still picks up a job that finishes AFTER it started", async () => {
    const later: Observed[] = [...history, { tree: "client-a-personal", job: "new", done: true }];
    const { w, calls } = coldHarness([history, later]);
    await w.tick();
    await w.tick();
    expect(calls.deliver).toHaveLength(1);
    expect((calls.deliver[0] as { j: string }).j).toBe("new");
  });

  it("picks up work that was mid-flight when the daemon restarted", async () => {
    // A recording being transcribed right now still deserves a card.
    const inflight: Observed[] = [{ tree: "client-a-personal", job: "live", done: false }];
    const { w, calls } = coldHarness([inflight, inflight]);
    await w.tick();            // primes; running jobs are NOT adopted
    await w.tick();
    expect(calls.post).toHaveLength(1);
  });

  it("does not re-report a failure that was already on disk at startup", async () => {
    const { w, calls } = coldHarness([history, history]);
    await w.tick();
    await w.tick();
    expect(calls.post).toHaveLength(0);
  });
});
