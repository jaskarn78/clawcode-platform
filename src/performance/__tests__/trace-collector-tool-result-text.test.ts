/** 2026-08-27 — per-turn tool_result text accumulator (figures provenance). */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import pino from "pino";
import { TraceStore } from "../trace-store.js";
import {
  TraceCollector,
  TOOL_RESULT_TEXT_MAX_PER_RESULT,
  TOOL_RESULT_TEXT_MAX_PER_TURN,
} from "../trace-collector.js";

type Rec = { recordToolResultText: (s: string) => void };

describe("Turn.recordToolResultText", () => {
  let dir: string;
  let store: TraceStore;
  let collector: TraceCollector;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "clawcode-trt-"));
    store = new TraceStore(join(dir, "traces.db"));
    collector = new TraceCollector(store, pino({ level: "silent" }));
  });
  afterEach(() => {
    try { store.close?.(); } catch { /* ignore */ }
    rmSync(dir, { recursive: true, force: true });
  });

  it("accumulates and exposes joined text for the active turn", () => {
    const t = collector.startTurn("t1", "a", null) as unknown as Rec;
    t.recordToolResultText("Total $1,977,109");
    t.recordToolResultText("84% bonds");
    const text = collector.getActiveTurnToolResultText("a");
    expect(text).toContain("$1,977,109");
    expect(text).toContain("84% bonds");
  });

  it("caps each result and the whole turn — never unbounded", () => {
    const t = collector.startTurn("t1", "a", null) as unknown as Rec;
    t.recordToolResultText("x".repeat(TOOL_RESULT_TEXT_MAX_PER_RESULT * 3));
    expect(collector.getActiveTurnToolResultText("a").length).toBe(TOOL_RESULT_TEXT_MAX_PER_RESULT);
    for (let i = 0; i < 50; i++) t.recordToolResultText("y".repeat(TOOL_RESULT_TEXT_MAX_PER_RESULT));
    expect(collector.getActiveTurnToolResultText("a").length).toBeLessThanOrEqual(
      TOOL_RESULT_TEXT_MAX_PER_TURN + 60, // joins add a newline per entry
    );
  });

  it("ignores empty / non-string input and returns empty with no active turn", () => {
    const t = collector.startTurn("t1", "a", null) as unknown as Rec;
    t.recordToolResultText("");
    t.recordToolResultText(42 as unknown as string);
    expect(collector.getActiveTurnToolResultText("a")).toBe("");
    expect(collector.getActiveTurnToolResultText("nobody")).toBe("");
  });
});
