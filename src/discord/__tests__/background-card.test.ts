import { describe, expect, it } from "vitest";
import { renderBackgroundCardContent } from "../background-card.js";

const T0 = 1_000_000;
const task = (over: Record<string, unknown> = {}) => ({
  taskId: "a",
  description: "Wait for price download",
  status: "running" as const,
  startedAt: T0,
  endedAt: null,
  lastLine: null,
  ...over,
});

describe("background card", () => {
  it("running: header, one line per task, no Unicode glyphs without an icon registry", () => {
    const text = renderBackgroundCardContent({ tasks: [task()], startedAt: T0, settledAt: null, now: T0 + 130_000 });
    expect(text.split("\n")).toEqual([
      "**Working in the background · 1 running · 2m**",
      "-# Wait for price download · 2m",
      '-# Ask "eta" any time for a status check.',
    ]);
  });

  it("uses cc_* icons when given", () => {
    const text = renderBackgroundCardContent(
      { tasks: [task({ status: "completed", endedAt: T0 + 60_000 })], startedAt: T0, settledAt: T0 + 60_000, now: T0 + 60_000 },
      (name) => `<:cc_${name}:1>`,
    );
    expect(text).toContain("**Background work finished · 1m**");
    expect(text).toContain("<:cc_circle_check:1> Wait for price download · 1m");
    expect(text).not.toContain("eta");
  });
});
