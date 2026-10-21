/**
 * 2026-07-31 — Turn heaviness accessors (adaptive verify budget inputs).
 * Mirrors the trace-collector-tool-names fixture (real TraceStore on tmp).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import pino from "pino";
import { TraceStore } from "../trace-store.js";
import { TraceCollector } from "../trace-collector.js";

describe("Turn heaviness accessors — 2026-07-31", () => {
  let store: TraceStore;
  let collector: TraceCollector;
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "turn-accessors-"));
    store = new TraceStore(join(tempDir, "traces.db"));
    collector = new TraceCollector(store, pino({ level: "silent" }));
  }, 30000);

  afterEach(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }, 30000);

  it("getElapsedMs is non-negative and monotonic", async () => {
    const turn = collector.startTurn("t1", "fin-research", null);
    const first = turn.getElapsedMs();
    expect(first).toBeGreaterThanOrEqual(0);
    await new Promise((r) => setTimeout(r, 15));
    expect(turn.getElapsedMs()).toBeGreaterThanOrEqual(first);
    turn.end("success");
  });

  it("getToolExecutionMsSoFar reflects addToolExecutionMs folds", () => {
    const turn = collector.startTurn("t2", "fin-research", null);
    expect(turn.getToolExecutionMsSoFar()).toBe(0);
    turn.addToolExecutionMs(120);
    turn.addToolExecutionMs(30);
    expect(turn.getToolExecutionMsSoFar()).toBe(150);
    turn.end("success");
  });
});
