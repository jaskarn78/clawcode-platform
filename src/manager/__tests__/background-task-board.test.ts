/**
 * 999.178 — BackgroundTaskBoard. Replays fin-client 2026-09-26 08:51:
 * a background "wait for price download" task outlived the turn; the
 * channel got no card, no typing when the agent woke on its result, and
 * "eta" said "Nothing running".
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BackgroundTaskBoard, type BackgroundCardPort, type BackgroundCardSnapshot } from "../background-task-board.js";
import { resetResearchRegistryForTests, setLiveDiscordTurn } from "../research-registry.js";

const AGENT = "fin-client";
const ORIGIN = { turnId: "discord:000000000000000121", messageId: "000000000000000121", channelId: "000000000000000110" };

const started = (id: string, description = "Wait for price download", subagentType?: string) => ({
  type: "system",
  subtype: "task_started",
  task_id: id,
  tool_use_id: `toolu_${id}`,
  description,
  ...(subagentType ? { subagent_type: subagentType } : {}),
});
const notified = (id: string, status = "completed") => ({ type: "system", subtype: "task_notification", task_id: id, status });
const daemonResult = () => ({ type: "result", subtype: "success", result: "Part 2 is still downloading prices." });

function fakePort() {
  const posts: BackgroundCardSnapshot[] = [];
  const edits: BackgroundCardSnapshot[] = [];
  const typing: string[] = [];
  const port: BackgroundCardPort = {
    post: vi.fn(async (_c: string, _r: string | null, s: BackgroundCardSnapshot) => {
      posts.push(s);
      return "card-1";
    }),
    edit: vi.fn(async (_c: string, _m: string, s: BackgroundCardSnapshot) => {
      edits.push(s);
    }),
    typing: vi.fn(async (c: string) => {
      typing.push(c);
    }),
  };
  return { port, posts, edits, typing, last: () => edits[edits.length - 1] ?? posts[posts.length - 1] };
}

function make(port: BackgroundCardPort) {
  return new BackgroundTaskBoard({ agentName: AGENT, cardPort: () => port, cardDelayMs: 1_000, repaintMs: 5_000, typingMs: 100, typingMaxMs: 5_000 });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(Date.parse("2026-09-26T15:51:00Z"));
  setLiveDiscordTurn(AGENT, ORIGIN);
});
afterEach(() => {
  resetResearchRegistryForTests();
  vi.useRealTimers();
});

describe("BackgroundTaskBoard", () => {
  it("a task that outlives its turn gets a card after the delay; it settles when the task ends", async () => {
    const p = fakePort();
    const b = make(p.port);
    b.observe(started("bp93"));
    b.observe(daemonResult()); // the turn ends; the task is still running
    expect(b.running().map((t) => t.description)).toEqual(["Wait for price download"]);
    expect(p.posts).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1_100);
    expect(p.posts).toHaveLength(1);
    expect(p.last()?.settledAt).toBeNull();

    b.observe(notified("bp93"));
    await vi.advanceTimersByTimeAsync(10);
    expect(p.last()?.settledAt).not.toBeNull();
    expect(p.last()?.tasks[0]?.status).toBe("completed");
    expect(b.running()).toEqual([]);
    b.dispose();
  });

  it("a quick job that finishes before the delay never posts a card", async () => {
    const p = fakePort();
    const b = make(p.port);
    b.observe(started("quick"));
    b.observe(daemonResult());
    await vi.advanceTimersByTimeAsync(500);
    b.observe(notified("quick"));
    await vi.advanceTimersByTimeAsync(2_000);
    expect(p.posts).toHaveLength(0);
    b.dispose();
  });

  it("a task that ends inside its own turn never gets a card", async () => {
    const p = fakePort();
    const b = make(p.port);
    b.observe(started("inturn"));
    b.observe(notified("inturn"));
    b.observe(daemonResult());
    await vi.advanceTimersByTimeAsync(2_000);
    expect(p.posts).toHaveLength(0);
    b.dispose();
  });

  it("the self-fired turn woken by a task's result types in its channel until it closes (capped)", async () => {
    const p = fakePort();
    const b = make(p.port);
    b.observe(started("bp93"));
    b.observe(daemonResult());
    b.observe(notified("bp93"));
    b.setSelfFiredTurnOpen(true);
    expect(p.typing).toEqual([ORIGIN.channelId]);
    await vi.advanceTimersByTimeAsync(350);
    expect(p.typing.length).toBeGreaterThanOrEqual(3);
    b.setSelfFiredTurnOpen(false);
    const n = p.typing.length;
    await vi.advanceTimersByTimeAsync(500);
    expect(p.typing.length).toBe(n);

    // A later self-fired turn with no fresh wake does not type.
    b.setSelfFiredTurnOpen(true);
    expect(p.typing.length).toBe(n);
    b.setSelfFiredTurnOpen(false);
    b.dispose();
  });

  it("typing is capped for a wedged wake turn", async () => {
    const p = fakePort();
    const b = make(p.port);
    b.observe(started("t1"));
    b.observe(notified("t1"));
    b.setSelfFiredTurnOpen(true);
    await vi.advanceTimersByTimeAsync(5_200);
    const n = p.typing.length;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(p.typing.length).toBe(n);
    b.dispose();
  });

  it("researchers are the research tracker's: never on the board", () => {
    const p = fakePort();
    const b = make(p.port);
    b.observe(started("r1", "Free fundamentals", "researcher"));
    expect(b.running()).toEqual([]);
    b.dispose();
  });

  it("background_tasks_changed ends a task missing from the live set", () => {
    const p = fakePort();
    const b = make(p.port);
    b.observe(started("a"));
    b.observe(started("c", "Wait for retry"));
    b.observe({ type: "system", subtype: "background_tasks_changed", tasks: [{ task_id: "c" }] });
    expect(b.running().map((t) => t.taskId)).toEqual(["c"]);
    b.dispose();
  });

  it("progress summaries become the task's last line", () => {
    const p = fakePort();
    const b = make(p.port);
    b.observe(started("a"));
    b.observe({ type: "system", subtype: "task_progress", task_id: "a", summary: "812 of 1124 tickers" });
    expect(b.running()[0]?.lastLine).toBe("812 of 1124 tickers");
    b.dispose();
  });
});
