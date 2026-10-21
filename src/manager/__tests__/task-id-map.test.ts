import { describe, it, expect, vi } from "vitest";
import { TaskIdMap, TASK_ID_MAP_CAP } from "../task-id-map.js";

const started = (taskId: string, toolUseId: string) => ({
  type: "system",
  subtype: "task_started",
  task_id: taskId,
  tool_use_id: toolUseId,
  description: "d",
});

describe("TaskIdMap (999.173)", () => {
  it("stops by TASK id once task_started has been seen", () => {
    const stopTask = vi.fn(() => Promise.resolve());
    const m = new TaskIdMap({ stopTask });
    m.observe(started("b7", "toolu_1"));
    expect(m.stopForToolUse("toolu_1")).toBe("stopped");
    expect(stopTask).toHaveBeenCalledWith("b7");
    expect(stopTask).not.toHaveBeenCalledWith("toolu_1");
  });

  it("defers the stop until task_started arrives, then fires exactly once", () => {
    const stopTask = vi.fn(() => Promise.resolve());
    const m = new TaskIdMap({ stopTask });
    expect(m.stopForToolUse("toolu_2")).toBe("deferred");
    expect(stopTask).not.toHaveBeenCalled();
    m.observe(started("a9", "toolu_2"));
    m.observe(started("a9", "toolu_2"));
    expect(stopTask).toHaveBeenCalledTimes(1);
    expect(stopTask).toHaveBeenCalledWith("a9");
  });

  it("an expired deferred stop never fires", () => {
    let t = 0;
    const stopTask = vi.fn();
    const m = new TaskIdMap({ stopTask, now: () => t, pendingTtlMs: 1000 });
    m.stopForToolUse("toolu_3");
    t = 5000;
    m.observe(started("c1", "toolu_3"));
    expect(stopTask).not.toHaveBeenCalled();
  });

  it("ignores non-task frames and malformed ids", () => {
    const stopTask = vi.fn();
    const m = new TaskIdMap({ stopTask });
    m.observe({ type: "assistant" });
    m.observe({ type: "system", subtype: "task_started", task_id: 5, tool_use_id: "x" });
    m.observe(null);
    expect(m.taskIdFor("x")).toBeUndefined();
  });

  it("a rejecting or throwing stopTask never escapes", async () => {
    const m1 = new TaskIdMap({ stopTask: () => Promise.reject(new Error("v3")) });
    m1.observe(started("t", "u"));
    expect(() => m1.stopForToolUse("u")).not.toThrow();
    const m2 = new TaskIdMap({
      stopTask: () => {
        throw new Error("sync");
      },
    });
    m2.observe(started("t", "u"));
    expect(() => m2.stopForToolUse("u")).not.toThrow();
    await new Promise((r) => setTimeout(r, 0));
  });

  it("is size-capped", () => {
    const m = new TaskIdMap({ stopTask: vi.fn() });
    for (let i = 0; i < TASK_ID_MAP_CAP + 10; i++) m.observe(started(`t${i}`, `u${i}`));
    expect(m.taskIdFor("u0")).toBeUndefined();
    expect(m.taskIdFor(`u${TASK_ID_MAP_CAP + 9}`)).toBe(`t${TASK_ID_MAP_CAP + 9}`);
  });
});
