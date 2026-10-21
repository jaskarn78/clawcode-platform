import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseSinceDuration, sinceToIso } from "../percentiles.js";
import { TraceStore } from "../trace-store.js";
import type { TurnRecord } from "../types.js";

function buildTurn(overrides: Partial<TurnRecord>): TurnRecord {
  const base: TurnRecord = {
    id: overrides.id ?? "msg-1",
    agent: overrides.agent ?? "agent-x",
    channelId: overrides.channelId ?? "chan-1",
    startedAt: overrides.startedAt ?? "2026-04-13T12:00:00.000Z",
    endedAt: overrides.endedAt ?? "2026-04-13T12:00:01.000Z",
    totalMs: overrides.totalMs ?? 1000,
    status: overrides.status ?? "success",
    spans: overrides.spans ?? [],
  };
  return Object.freeze({ ...base, spans: Object.freeze([...base.spans]) });
}

describe("parseSinceDuration", () => {
  it("since parser accepts 1h / 6h / 24h / 7d", () => {
    expect(parseSinceDuration("1h")).toBe(3_600_000);
    expect(parseSinceDuration("6h")).toBe(21_600_000);
    expect(parseSinceDuration("24h")).toBe(86_400_000);
    expect(parseSinceDuration("7d")).toBe(604_800_000);
  });

  it("since parser also accepts minutes and seconds (30m, 90s)", () => {
    expect(parseSinceDuration("30m")).toBe(30 * 60_000);
    expect(parseSinceDuration("90s")).toBe(90 * 1_000);
  });

  it("since parser throws on invalid input", () => {
    expect(() => parseSinceDuration("bogus")).toThrow();
    expect(() => parseSinceDuration("")).toThrow();
    expect(() => parseSinceDuration("h24")).toThrow();
  });
});

describe("sinceToIso", () => {
  it("produces ISO string relative to provided now", () => {
    const now = new Date("2026-04-13T12:00:00.000Z");
    const iso = sinceToIso("1h", now);
    const result = new Date(iso);
    expect(result.toISOString()).toBe("2026-04-13T11:00:00.000Z");
  });

  it("handles 7d offset", () => {
    const now = new Date("2026-04-13T00:00:00.000Z");
    const iso = sinceToIso("7d", now);
    const result = new Date(iso);
    expect(result.toISOString()).toBe("2026-04-06T00:00:00.000Z");
  });
});

describe("percentile SQL math (via TraceStore.getPercentiles)", () => {
  let store: TraceStore;
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "percentiles-test-"));
    store = new TraceStore(join(tempDir, "traces.db"));
  });

  afterEach(() => {
    try {
      store.close();
    } catch {
      // ignore
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("returns correct p50/p95/p99 for 100 synthetic spans", () => {
    const baseTime = new Date("2026-04-13T00:00:00.000Z").getTime();
    for (let i = 1; i <= 100; i++) {
      const turn = buildTurn({
        id: `p-${i}`,
        agent: "agent-p",
        startedAt: new Date(baseTime + i).toISOString(),
        endedAt: new Date(baseTime + i + 1).toISOString(),
        totalMs: i,
        spans: [
          Object.freeze({
            name: "end_to_end",
            startedAt: new Date(baseTime + i).toISOString(),
            durationMs: i,
            metadata: Object.freeze({}),
          }),
        ],
      });
      store.writeTurn(turn);
    }

    const rows = store.getPercentiles("agent-p", new Date(baseTime - 1000).toISOString());
    const endToEnd = rows.find((r) => r.segment === "end_to_end");
    expect(endToEnd).toBeDefined();
    expect(endToEnd!.count).toBe(100);
    // p50 ~ 50, p95 ~ 95, p99 ~ 99 — tolerate off-by-one from rank-based math
    expect(endToEnd!.p50).toBeGreaterThanOrEqual(49);
    expect(endToEnd!.p50).toBeLessThanOrEqual(51);
    expect(endToEnd!.p95).toBeGreaterThanOrEqual(94);
    expect(endToEnd!.p95).toBeLessThanOrEqual(96);
    expect(endToEnd!.p99).toBeGreaterThanOrEqual(98);
    expect(endToEnd!.p99).toBeLessThanOrEqual(100);
  });

  it("aggregates tool_call.* into a single tool_call segment row", () => {
    const baseTime = new Date("2026-04-13T00:00:00.000Z").getTime();
    const turn = buildTurn({
      id: "tool-aggregate-1",
      agent: "agent-t",
      startedAt: new Date(baseTime).toISOString(),
      endedAt: new Date(baseTime + 100).toISOString(),
      spans: [
        Object.freeze({
          name: "tool_call.memory_lookup",
          startedAt: new Date(baseTime).toISOString(),
          durationMs: 10,
          metadata: Object.freeze({}),
        }),
        Object.freeze({
          name: "tool_call.search_documents",
          startedAt: new Date(baseTime + 20).toISOString(),
          durationMs: 20,
          metadata: Object.freeze({}),
        }),
        Object.freeze({
          name: "tool_call.memory_lookup",
          startedAt: new Date(baseTime + 50).toISOString(),
          durationMs: 30,
          metadata: Object.freeze({}),
        }),
      ],
    });
    store.writeTurn(turn);

    const rows = store.getPercentiles("agent-t", new Date(baseTime - 1000).toISOString());
    const toolCallRows = rows.filter((r) => r.segment === "tool_call");
    expect(toolCallRows.length).toBe(1);
    expect(toolCallRows[0]!.count).toBe(3);
  });
});
