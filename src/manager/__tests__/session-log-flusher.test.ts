import { describe, it, expect } from "vitest";

import {
  flushNewTurnsToSessionLog,
  type FlushableTurn,
} from "../session-log-flusher.js";

/** Build a turn with an ISO timestamp `n` seconds into 2026-06-18. */
function turn(
  n: number,
  role: "user" | "assistant" | "system" = "user",
  content = `c${n}`,
): FlushableTurn {
  const ms = Date.parse("2026-06-18T00:00:00.000Z") + n * 1000;
  return { role, content, createdAt: new Date(ms).toISOString() };
}

type Harness = {
  appended: Array<{ ts: string; role: string; content: string }>;
  cursor: { value: string | null };
  deps: Parameters<typeof flushNewTurnsToSessionLog>[0];
};

function harness(
  turns: readonly FlushableTurn[],
  sid: string | undefined = "sess-1",
  initialCursor: string | null = null,
): Harness {
  const appended: Harness["appended"] = [];
  const cursor = { value: initialCursor };
  return {
    appended,
    cursor,
    deps: {
      activeSessionId: sid,
      getTurns: () => turns,
      appendEntry: async (ts, role, content) => {
        appended.push({ ts, role, content });
      },
      memoryDir: "/tmp/unused",
      readCursor: () => cursor.value,
      writeCursor: (_dir, iso) => {
        cursor.value = iso;
      },
    },
  };
}

describe("flushNewTurnsToSessionLog", () => {
  it("no active session → no-op", async () => {
    // Build deps directly so the harness `sid` default doesn't mask `undefined`.
    let appendedCount = 0;
    const res = await flushNewTurnsToSessionLog({
      activeSessionId: undefined,
      getTurns: () => [turn(1)],
      appendEntry: async () => {
        appendedCount += 1;
      },
      memoryDir: "/tmp/unused",
      readCursor: () => null,
      writeCursor: () => undefined,
    });
    expect(res).toEqual({ flushed: 0, dates: [] });
    expect(appendedCount).toBe(0);
  });

  it("flushes all new turns and advances the cursor to the newest", async () => {
    const turns = [turn(1, "user"), turn(2, "assistant"), turn(3, "user")];
    const h = harness(turns);
    const res = await flushNewTurnsToSessionLog(h.deps);
    expect(res.flushed).toBe(3);
    expect(res.dates).toEqual(["2026-06-18"]);
    expect(h.appended.map((a) => a.content)).toEqual(["c1", "c2", "c3"]);
    expect(h.cursor.value).toBe(turns[2]!.createdAt);
  });

  it("is idempotent across ticks — already-flushed turns are not re-appended", async () => {
    const turns = [turn(1), turn(2)];
    const h = harness(turns);
    await flushNewTurnsToSessionLog(h.deps); // first tick
    const res2 = await flushNewTurnsToSessionLog(h.deps); // second tick, same turns
    expect(res2).toEqual({ flushed: 0, dates: [] });
    expect(h.appended).toHaveLength(2); // not 4
  });

  it("only flushes turns newer than the cursor", async () => {
    const turns = [turn(1), turn(2), turn(3)];
    const h = harness(turns, "sess-1", turns[1]!.createdAt); // cursor at turn 2
    const res = await flushNewTurnsToSessionLog(h.deps);
    expect(res.flushed).toBe(1);
    expect(h.appended.map((a) => a.content)).toEqual(["c3"]);
  });

  it("excludes system turns", async () => {
    const turns = [turn(1, "user"), turn(2, "system"), turn(3, "assistant")];
    const h = harness(turns);
    const res = await flushNewTurnsToSessionLog(h.deps);
    expect(res.flushed).toBe(2);
    expect(h.appended.map((a) => a.role)).toEqual(["user", "assistant"]);
  });

  it("sorts out-of-order turns chronologically and groups dates", async () => {
    const t1 = turn(1);
    const t2 = { ...turn(0), createdAt: "2026-06-19T00:00:30.000Z" };
    const h = harness([t2, t1]); // reversed + spans two days
    const res = await flushNewTurnsToSessionLog(h.deps);
    expect(res.flushed).toBe(2);
    expect(h.appended.map((a) => a.content)).toEqual(["c1", "c0"]);
    expect([...res.dates].sort()).toEqual(["2026-06-18", "2026-06-19"]);
  });
});
