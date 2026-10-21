import { describe, expect, it } from "vitest";
import {
  encodeResearchStatusId,
  encodeResearchStopId,
  encodeResearchStopSelectId,
  parseResearchButtonId,
  parseStopSelection,
  renderResearchStopPicker,
  renderResearchCardComponents,
  renderResearchCardContent,
  renderResearchStatus,
} from "../research-card.js";
import { IconRegistry } from "../icons.js";
import type { ResearchCardSnapshot } from "../../manager/research-card-sink.js";
import type { ResearchCardTaskView } from "../../manager/research-registry.js";

const KEY = "0a1b2c3d";
const T0 = 1_000_000;

function snap(over: Partial<ResearchCardSnapshot> = {}, tasks: readonly ResearchCardTaskView[] = defaultTasks()): ResearchCardSnapshot {
  return {
    session: {
      key: KEY,
      agentName: "personal",
      origin: { turnId: "discord:1", messageId: "1", channelId: "c" },
      startedAt: T0,
      tasks,
    },
    interim: null,
    settled: null,
    now: T0 + 102_000,
    ...over,
  };
}

function defaultTasks(): ResearchCardTaskView[] {
  return [
    { index: 0, taskId: "a1", description: "Chicago weather history", status: "completed" as const, lastLine: null, startedAt: T0, endedAt: T0 + 60_000 },
    { index: 1, taskId: "a2", description: "Course elevation profile", status: "running" as const, lastLine: "Reading the race PDF", startedAt: T0, endedAt: null },
    { index: 2, taskId: "a3", description: "Hotel walking distance", status: "running" as const, lastLine: null, startedAt: T0, endedAt: null },
  ];
}

describe("research card (999.173)", () => {
  it("renders the running card in the status-trail style", () => {
    const text = renderResearchCardContent(snap({ interim: "Mercury done,\nVenus still running" }));
    expect(text.split("\n")).toEqual([
      "**Researching · 2 running · 1m**",
      "-# ✓ Chicago weather history",
      "-# → Course elevation profile — Reading the race PDF",
      "-# → Hotel walking distance…",
      "-# “Mercury done, Venus still running”",
    ]);
  });

  it("settles to a done header with no interim line and no buttons", () => {
    const tasks = defaultTasks().map((t) => ({ ...t, status: "completed" as const, endedAt: T0 + 130_000 }));
    const s = snap({ settled: { at: T0 + 130_000, outcome: "done" }, interim: "x" }, tasks);
    expect(renderResearchCardContent(s).split("\n")[0]).toBe("**Researched · 3 researchers · 2m**");
    expect(renderResearchCardContent(s)).not.toContain("“x”");
    expect(renderResearchCardComponents(s)).toEqual([]);
  });

  it("timeout / interrupted headers count what finished; unfinished lines use ✗", () => {
    const t = snap({ settled: { at: T0 + 1_200_000, outcome: "timeout" } });
    expect(renderResearchCardContent(t).split("\n")[0]).toBe("**Research timed out · 1 of 3 · 20m**");
    const lost = defaultTasks().map((x) => (x.status === "running" ? { ...x, status: "lost" as const } : x));
    const i = snap({ settled: { at: T0 + 40_000, outcome: "interrupted" } }, lost);
    const lines = renderResearchCardContent(i).split("\n");
    expect(lines[0]).toMatch(/^\*\*Research interrupted · 1 of 3/);
    expect(lines[2]).toBe("-# ✗ Course elevation profile");
  });

  it("header carries the usage-guard note while running", () => {
    expect(renderResearchCardContent(snap({ notes: ["limited to 1 near usage limit"] })).split("\n")[0]).toBe(
      "**Researching · 2 running · limited to 1 near usage limit · 1m**",
    );
  });

  it("settles on any terminal mix: some failed → k of N, all failed → Research stopped, with the reason once", () => {
    const mixed = defaultTasks().map((x, i) => (i === 0 ? x : { ...x, status: "failed" as const, endedAt: T0 + 90_000 }));
    const m = renderResearchCardContent(
      snap({ settled: { at: T0 + 90_000, outcome: "done" }, reason: "usage limit reached, resets 5:30 PM PT" }, mixed),
    ).split("\n");
    expect(m[0]).toBe("**Researched · 1 of 3 · 1m**");
    expect(m).toContain("-# ✓ Chicago weather history");
    expect(m).toContain("-# ✗ Hotel walking distance");
    expect(m[m.length - 1]).toBe("-# usage limit reached, resets 5:30 PM PT");

    const allFailed = defaultTasks().map((x) => ({ ...x, status: "failed" as const, endedAt: T0 + 420_000 }));
    const a = renderResearchCardContent(
      snap({ settled: { at: T0 + 420_000, outcome: "done" }, reason: "usage limit reached, resets 5:30 PM PT" }, allFailed),
    );
    expect(a.split("\n")[0]).toBe("**Research stopped · 0 of 3 · 7m**");
    expect(a.match(/usage limit/g)).toHaveLength(1);
    expect(a).not.toMatch(/HTTP|429|rate_limit/);
    expect(renderResearchCardComponents(snap({ settled: { at: T0, outcome: "done" } }, allFailed))).toEqual([]);
  });
  it("text-only buttons when the icon set is missing (never a Unicode glyph)", () => {
    const b = renderResearchCardComponents(snap())[0]!.components;
    for (const x of b) expect(x.emoji).toBeUndefined();
  });

  it("stop picker lists each RUNNING researcher by description, then Stop all", () => {
    const tasks: ResearchCardTaskView[] = [
      ...defaultTasks(),
      { index: 3, taskId: "a4", description: "x".repeat(150), status: "running", lastLine: "y".repeat(150), startedAt: T0, endedAt: null },
    ];
    const rows = renderResearchStopPicker(snap({}, tasks).session);
    const menu = rows[0]!.components[0]!;
    expect(menu.type).toBe(3);
    expect(menu.custom_id).toBe(encodeResearchStopSelectId(KEY));
    expect(menu.options.map((o) => o.value)).toEqual(["1", "2", "3", "all"]);
    expect(menu.options[0]).toEqual({ label: "Course elevation profile", value: "1", description: "Reading the race PDF" });
    expect(menu.options[3]).toEqual({ label: "Stop all", value: "all" });
    for (const o of menu.options) {
      expect(o.label.length).toBeLessThanOrEqual(100);
      if (o.description) expect(o.description.length).toBeLessThanOrEqual(100);
    }
  });

  it("stop picker is empty when nothing runs", () => {
    const tasks = defaultTasks().map((t) => ({ ...t, status: "completed" as const }));
    expect(renderResearchStopPicker(snap({}, tasks).session)).toEqual([]);
  });

  it("custom ids round-trip, legacy per-researcher Stop ids open the picker, junk is rejected", () => {
    expect(parseResearchButtonId(encodeResearchStatusId(KEY))).toEqual({ action: "status", key: KEY });
    expect(parseResearchButtonId(encodeResearchStopId(KEY))).toEqual({ action: "stop-menu", key: KEY });
    expect(parseResearchButtonId(encodeResearchStopSelectId(KEY))).toEqual({ action: "stop-select", key: KEY });
    expect(parseResearchButtonId(`rsch:x:${KEY}:3`)).toEqual({ action: "stop-menu", key: KEY });
    for (const bad of ["rsch:s:zz", "rsch:x:0a1b2c3d:abc", "ra:1:2", "rsch:q:0a1b2c3d", "rsch:s:0a1b2c3d:9", "rsch:k:0a1b2c3d:1"]) {
      expect(parseResearchButtonId(bad)).toBeNull();
    }
    expect(parseStopSelection("2")).toBe(2);
    expect(parseStopSelection("all")).toBe("all");
    expect(parseStopSelection("drop table")).toBeNull();
    expect(parseStopSelection(undefined)).toBeNull();
  });

  it("status view lists every researcher with status and elapsed", () => {
    const text = renderResearchStatus(snap().session, T0 + 102_000);
    expect(text).toContain("1. Chicago weather history · completed · 1m");
    expect(text).toContain("2. Course elevation profile · running · 1m");
    expect(text).toContain("-# Reading the race PDF");
  });
});

describe("research card — writing up (fin-client 2026-09-26)", () => {
  it("every researcher done + synthesis running → 'Writing up', no stale filler, no buttons", () => {
    const tasks = defaultTasks().map((t) => ({ ...t, status: "completed" as const, endedAt: T0 + 90_000 }));
    const s = snap({ writingSince: T0 + 95_000, interim: "Only the hotel one is still running" }, tasks);
    const text = renderResearchCardContent(s);
    expect(text.split("\n")[0]).toBe("**Writing up the findings · 3 of 3 researched · 1m**");
    expect(text).not.toContain("still running");
    expect(renderResearchCardComponents(s)).toEqual([]);
  });
});
