/**
 * Phase 999.63 Plan 02 T-01 — Turn tool-name accumulator + TraceCollector
 * active-turn accessor tests.
 *
 * Pins the contract for the per-turn verification-tool-called signal that
 * Plan 03's financial-verification gate consumes:
 *   - Turn.recordToolCallName appends to a per-turn list (no-op after end()).
 *   - Turn.getToolCallNames returns a defensive copy; [] for a tool-free turn.
 *   - Duplicate tool names are preserved (multiplicity matches span-per-call).
 *   - TraceCollector.getActiveTurnToolCallNames reads the active Turn's names,
 *     returns [] for an unknown agent (failure-isolated — never throws), and
 *     returns [] once the Turn has ended (unregistered).
 *
 * Mirrors the fixture setup of trace-collector-lazy-recall.test.ts — a real
 * TraceStore on a temp dir + a silent pino logger.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import pino from "pino";
import { TraceStore } from "../trace-store.js";
import { TraceCollector } from "../trace-collector.js";

describe("Turn tool-name accumulator — Phase 999.63 Plan 02", () => {
  let store: TraceStore;
  let collector: TraceCollector;
  let tempDir: string;
  let dbPath: string;

  // 30s hook timeout — `new TraceStore` performs native better-sqlite3 +
  // sqlite-vec extension init, which can exceed the 10s default under
  // concurrent test-file load on a busy machine.
  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "trace-collector-tool-names-"));
    dbPath = join(tempDir, "traces.db");
    store = new TraceStore(dbPath);
    const log = pino({ level: "silent" });
    collector = new TraceCollector(store, log);
  }, 30000);

  afterEach(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }, 30000);

  it("(1) a fresh Turn → getToolCallNames() returns []", () => {
    const turn = collector.startTurn("msg-1", "atlas", null);
    expect(turn.getToolCallNames()).toEqual([]);
    turn.end("success");
  });

  it("(2) after two recordToolCallName calls → both names present in order", () => {
    const turn = collector.startTurn("msg-2", "atlas", null);
    turn.recordToolCallName("web_search");
    turn.recordToolCallName("clawcode_share_file");
    expect(turn.getToolCallNames()).toEqual(["web_search", "clawcode_share_file"]);
    turn.end("success");
  });

  it("(2b) duplicate tool names are preserved (multiplicity kept)", () => {
    const turn = collector.startTurn("msg-2b", "atlas", null);
    turn.recordToolCallName("web_search");
    turn.recordToolCallName("web_search");
    expect(turn.getToolCallNames()).toEqual(["web_search", "web_search"]);
    turn.end("success");
  });

  it("(3) recordToolCallName after end() is a no-op (list length unchanged)", () => {
    const turn = collector.startTurn("msg-3", "atlas", null);
    turn.recordToolCallName("web_search");
    turn.end("success");
    turn.recordToolCallName("clawcode_share_file");
    expect(turn.getToolCallNames()).toEqual(["web_search"]);
  });

  it("(4) getActiveTurnToolCallNames returns the active Turn's names", () => {
    const turn = collector.startTurn("msg-4", "atlas", null);
    turn.recordToolCallName("web_search");
    turn.recordToolCallName("web_fetch");
    expect(collector.getActiveTurnToolCallNames("atlas")).toEqual([
      "web_search",
      "web_fetch",
    ]);
    turn.end("success");
  });

  it("(5) getActiveTurnToolCallNames returns [] for an unknown agent (no throw)", () => {
    expect(() => collector.getActiveTurnToolCallNames("nobody")).not.toThrow();
    expect(collector.getActiveTurnToolCallNames("nobody")).toEqual([]);
  });

  it("(6) after Turn.end() unregisters the turn, accessor returns []", () => {
    const turn = collector.startTurn("msg-6", "atlas", null);
    turn.recordToolCallName("web_search");
    turn.end("success");
    expect(collector.getActiveTurnToolCallNames("atlas")).toEqual([]);
  });
});
