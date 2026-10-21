import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { UsageTracker } from "./tracker.js";

describe("UsageTracker", () => {
  let tracker: UsageTracker;
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "usage-test-"));
    tracker = new UsageTracker(join(tempDir, "usage.db"));
  });

  afterEach(() => {
    tracker.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("record() inserts an event and getSessionUsage() returns correct totals", () => {
    tracker.record({
      agent: "test-agent",
      timestamp: "2026-04-09T10:00:00Z",
      tokens_in: 100,
      tokens_out: 200,
      cost_usd: 0.05,
      turns: 3,
      model: "sonnet",
      duration_ms: 5000,
      session_id: "sess-1",
    });

    tracker.record({
      agent: "test-agent",
      timestamp: "2026-04-09T10:05:00Z",
      tokens_in: 150,
      tokens_out: 300,
      cost_usd: 0.08,
      turns: 2,
      model: "sonnet",
      duration_ms: 3000,
      session_id: "sess-1",
    });

    const result = tracker.getSessionUsage("sess-1");
    expect(result.tokens_in).toBe(250);
    expect(result.tokens_out).toBe(500);
    expect(result.cost_usd).toBeCloseTo(0.13);
    expect(result.turns).toBe(5);
    expect(result.duration_ms).toBe(8000);
    expect(result.event_count).toBe(2);
  });

  it("getDailyUsage() aggregates all events for a given day", () => {
    tracker.record({
      agent: "agent-a",
      timestamp: "2026-04-09T08:00:00Z",
      tokens_in: 50,
      tokens_out: 100,
      cost_usd: 0.02,
      turns: 1,
      model: "haiku",
      duration_ms: 1000,
      session_id: "sess-1",
    });

    tracker.record({
      agent: "agent-b",
      timestamp: "2026-04-09T20:00:00Z",
      tokens_in: 75,
      tokens_out: 150,
      cost_usd: 0.03,
      turns: 2,
      model: "opus",
      duration_ms: 2000,
      session_id: "sess-2",
    });

    // Different day - should NOT be included
    tracker.record({
      agent: "agent-a",
      timestamp: "2026-04-10T08:00:00Z",
      tokens_in: 999,
      tokens_out: 999,
      cost_usd: 9.99,
      turns: 99,
      model: "sonnet",
      duration_ms: 99000,
      session_id: "sess-3",
    });

    const result = tracker.getDailyUsage("2026-04-09");
    expect(result.tokens_in).toBe(125);
    expect(result.tokens_out).toBe(250);
    expect(result.cost_usd).toBeCloseTo(0.05);
    expect(result.turns).toBe(3);
    expect(result.duration_ms).toBe(3000);
    expect(result.event_count).toBe(2);
  });

  it("getWeeklyUsage() aggregates events from weekStart to weekStart+7 days", () => {
    // Monday 2026-04-06
    tracker.record({
      agent: "agent-a",
      timestamp: "2026-04-06T10:00:00Z",
      tokens_in: 100,
      tokens_out: 200,
      cost_usd: 0.05,
      turns: 2,
      model: "sonnet",
      duration_ms: 3000,
      session_id: "sess-1",
    });

    // Wednesday 2026-04-08
    tracker.record({
      agent: "agent-a",
      timestamp: "2026-04-08T15:00:00Z",
      tokens_in: 200,
      tokens_out: 400,
      cost_usd: 0.10,
      turns: 3,
      model: "sonnet",
      duration_ms: 5000,
      session_id: "sess-2",
    });

    // Next Monday 2026-04-13 - should NOT be included
    tracker.record({
      agent: "agent-a",
      timestamp: "2026-04-13T10:00:00Z",
      tokens_in: 999,
      tokens_out: 999,
      cost_usd: 9.99,
      turns: 99,
      model: "sonnet",
      duration_ms: 99000,
      session_id: "sess-3",
    });

    const result = tracker.getWeeklyUsage("2026-04-06");
    expect(result.tokens_in).toBe(300);
    expect(result.tokens_out).toBe(600);
    expect(result.cost_usd).toBeCloseTo(0.15);
    expect(result.turns).toBe(5);
    expect(result.duration_ms).toBe(8000);
    expect(result.event_count).toBe(2);
  });

  it("getTotalUsage() returns lifetime totals", () => {
    tracker.record({
      agent: "agent-a",
      timestamp: "2026-04-01T10:00:00Z",
      tokens_in: 100,
      tokens_out: 200,
      cost_usd: 0.05,
      turns: 2,
      model: "sonnet",
      duration_ms: 3000,
      session_id: "sess-1",
    });

    tracker.record({
      agent: "agent-b",
      timestamp: "2026-04-09T10:00:00Z",
      tokens_in: 300,
      tokens_out: 600,
      cost_usd: 0.15,
      turns: 4,
      model: "opus",
      duration_ms: 7000,
      session_id: "sess-2",
    });

    const result = tracker.getTotalUsage();
    expect(result.tokens_in).toBe(400);
    expect(result.tokens_out).toBe(800);
    expect(result.cost_usd).toBeCloseTo(0.20);
    expect(result.turns).toBe(6);
    expect(result.duration_ms).toBe(10000);
    expect(result.event_count).toBe(2);
  });

  it("getTotalUsage() with agent filter returns only that agent's data", () => {
    tracker.record({
      agent: "agent-a",
      timestamp: "2026-04-09T10:00:00Z",
      tokens_in: 100,
      tokens_out: 200,
      cost_usd: 0.05,
      turns: 2,
      model: "sonnet",
      duration_ms: 3000,
      session_id: "sess-1",
    });

    tracker.record({
      agent: "agent-b",
      timestamp: "2026-04-09T10:00:00Z",
      tokens_in: 999,
      tokens_out: 999,
      cost_usd: 9.99,
      turns: 99,
      model: "opus",
      duration_ms: 99000,
      session_id: "sess-2",
    });

    const result = tracker.getTotalUsage("agent-a");
    expect(result.tokens_in).toBe(100);
    expect(result.tokens_out).toBe(200);
    expect(result.cost_usd).toBeCloseTo(0.05);
    expect(result.turns).toBe(2);
    expect(result.duration_ms).toBe(3000);
    expect(result.event_count).toBe(1);
  });

  it("empty database returns zero-value aggregates", () => {
    const session = tracker.getSessionUsage("nonexistent");
    expect(session.tokens_in).toBe(0);
    expect(session.tokens_out).toBe(0);
    expect(session.cost_usd).toBe(0);
    expect(session.turns).toBe(0);
    expect(session.duration_ms).toBe(0);
    expect(session.event_count).toBe(0);

    const daily = tracker.getDailyUsage("2026-04-09");
    expect(daily.event_count).toBe(0);

    const weekly = tracker.getWeeklyUsage("2026-04-06");
    expect(weekly.event_count).toBe(0);

    const total = tracker.getTotalUsage();
    expect(total.event_count).toBe(0);

    const filtered = tracker.getTotalUsage("nobody");
    expect(filtered.event_count).toBe(0);
  });
});
