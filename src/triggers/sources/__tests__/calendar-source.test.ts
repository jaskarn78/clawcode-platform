/**
 * Phase 61 Plan 02 Task 2 -- CalendarSource tests.
 *
 * Tests MCP client polling for Google Calendar events with fired-event-ID
 * dedup, cursor_blob persistence, stale ID pruning, and transport cleanup.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { TriggerEvent } from "../../types.js";

// ---------------------------------------------------------------------------
// Mock MCP SDK
// ---------------------------------------------------------------------------

const mockConnect = vi.fn().mockResolvedValue(undefined);
const mockCallTool = vi.fn();
const mockTransportClose = vi.fn().mockResolvedValue(undefined);

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => {
  return {
    Client: class MockClient {
      connect = mockConnect;
      callTool = mockCallTool;
    },
  };
});

vi.mock("@modelcontextprotocol/sdk/client/stdio.js", () => {
  return {
    StdioClientTransport: class MockTransport {
      close = mockTransportClose;
    },
  };
});

// ---------------------------------------------------------------------------
// Import after mocks
// ---------------------------------------------------------------------------

import { CalendarSource, type CalendarSourceOptions } from "../calendar-source.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a mock TaskStore with getTriggerState and upsertTriggerState. */
function makeMockTaskStore(cursorBlob: string | null = null) {
  return {
    getTriggerState: vi.fn().mockReturnValue(
      cursorBlob !== null
        ? { source_id: "calendar:owner_a:primary", last_watermark: null, cursor_blob: cursorBlob, updated_at: 0 }
        : null,
    ),
    upsertTriggerState: vi.fn(),
  };
}

type MockTaskStore = ReturnType<typeof makeMockTaskStore>;

/** Build default CalendarSourceOptions. */
function makeOptions(overrides: Partial<Omit<CalendarSourceOptions, "taskStore">> & { taskStore?: MockTaskStore } = {}): CalendarSourceOptions {
  const { taskStore: tsOverride, ...rest } = overrides;
  const taskStore = tsOverride ?? makeMockTaskStore();
  return {
    user: "owner_a",
    targetAgent: "clawdy",
    calendarId: "primary",
    pollIntervalMs: 300_000,
    offsetMs: 900_000,
    maxResults: 50,
    eventRetentionDays: 7,
    mcpServer: {
      command: "npx",
      args: ["-y", "google-workspace-mcp"],
      env: {},
    },
    taskStore: taskStore as unknown as CalendarSourceOptions["taskStore"],
    ingest: vi.fn().mockResolvedValue(undefined),
    log: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    } as unknown as CalendarSourceOptions["log"],
    ...rest,
  };
}

/** Create a canned MCP calendar response. */
function makeCalendarResponse(events: Array<{ id: string; summary: string; start: string; end: string }>) {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(
          events.map((e) => ({
            id: e.id,
            summary: e.summary,
            start: { dateTime: e.start },
            end: { dateTime: e.end },
          })),
        ),
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("CalendarSource", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-17T12:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe("sourceId", () => {
    it("uses calendar:{user}:{calendarId} format", () => {
      const source = new CalendarSource(makeOptions());
      expect(source.sourceId).toBe("calendar:owner_a:primary");
    });
  });

  describe("Test 1: pollOnce calls MCP client callTool with correct params", () => {
    it("passes user, calendar_id, time_min, time_max, max_results", async () => {
      mockCallTool.mockResolvedValueOnce(makeCalendarResponse([]));

      const source = new CalendarSource(makeOptions());
      await source._startMcpClientForTest();
      await source._pollOnceForTest();

      expect(mockCallTool).toHaveBeenCalledWith({
        name: "calendar_list_events",
        arguments: {
          user: "owner_a",
          calendar_id: "primary",
          time_min: expect.stringContaining("2026-04-17T12:00:00"),
          time_max: expect.stringContaining("2026-04-17T12:15:00"),
          max_results: 50,
        },
      });
    });
  });

  describe("Test 2: pollOnce creates TriggerEvent for new events", () => {
    it("ingests events not in the fired set", async () => {
      const ingest = vi.fn().mockResolvedValue(undefined);
      const source = new CalendarSource(makeOptions({ ingest }));
      await source._startMcpClientForTest();

      mockCallTool.mockResolvedValueOnce(
        makeCalendarResponse([
          { id: "evt-1", summary: "Standup", start: "2026-04-17T12:10:00Z", end: "2026-04-17T12:30:00Z" },
        ]),
      );

      await source._pollOnceForTest();

      expect(ingest).toHaveBeenCalledWith(
        expect.objectContaining({
          sourceId: "calendar:owner_a:primary",
          idempotencyKey: "cal:evt-1",
          targetAgent: "clawdy",
        }),
      );
    });
  });

  describe("Test 3: pollOnce skips events already in fired set (dedup)", () => {
    it("does NOT ingest events already in the fired set", async () => {
      // Pre-load a fired event ID via cursor_blob
      const existingBlob = JSON.stringify([["evt-1", Date.now() + 86400000]]);
      const taskStore = makeMockTaskStore(existingBlob);
      const ingest = vi.fn().mockResolvedValue(undefined);
      const source = new CalendarSource(makeOptions({ taskStore, ingest }));
      await source._startMcpClientForTest();

      mockCallTool.mockResolvedValueOnce(
        makeCalendarResponse([
          { id: "evt-1", summary: "Already fired", start: "2026-04-17T12:10:00Z", end: "2026-04-17T12:30:00Z" },
          { id: "evt-2", summary: "New event", start: "2026-04-17T12:15:00Z", end: "2026-04-17T12:45:00Z" },
        ]),
      );

      await source._pollOnceForTest();

      // evt-1 should be skipped, evt-2 should be ingested
      expect(ingest).toHaveBeenCalledTimes(1);
      expect(ingest).toHaveBeenCalledWith(
        expect.objectContaining({ idempotencyKey: "cal:evt-2" }),
      );
    });
  });

  describe("Test 4: fired event IDs persisted via cursor_blob", () => {
    it("calls upsertTriggerState with Map entries as tuple array", async () => {
      const taskStore = makeMockTaskStore();
      const source = new CalendarSource(makeOptions({ taskStore }));
      await source._startMcpClientForTest();

      mockCallTool.mockResolvedValueOnce(
        makeCalendarResponse([
          { id: "evt-1", summary: "Meeting", start: "2026-04-17T12:10:00Z", end: "2026-04-17T12:30:00Z" },
        ]),
      );

      await source._pollOnceForTest();

      expect(taskStore.upsertTriggerState).toHaveBeenCalledWith(
        "calendar:owner_a:primary",
        expect.any(String), // watermark
        expect.stringContaining("evt-1"), // cursor_blob with event ID
      );

      // Verify the cursor_blob is a JSON array of [eventId, endTimeMs] tuples
      const blobArg = taskStore.upsertTriggerState.mock.calls[0]![2] as string;
      const parsed = JSON.parse(blobArg) as [string, number][];
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed[0]![0]).toBe("evt-1");
      expect(typeof parsed[0]![1]).toBe("number");
    });
  });

  describe("Test 5: loads existing fired IDs from cursor_blob on construction", () => {
    it("deserializes cursor_blob as Map of [eventId, endTimeMs] tuples", async () => {
      const futureEndTime = Date.now() + 86400000; // 1 day from now
      const existingBlob = JSON.stringify([["evt-existing", futureEndTime]]);
      const taskStore = makeMockTaskStore(existingBlob);
      const ingest = vi.fn().mockResolvedValue(undefined);
      const source = new CalendarSource(makeOptions({ taskStore, ingest }));
      await source._startMcpClientForTest();

      // Return the same existing event from MCP
      mockCallTool.mockResolvedValueOnce(
        makeCalendarResponse([
          { id: "evt-existing", summary: "Old event", start: "2026-04-17T12:10:00Z", end: "2026-04-17T12:30:00Z" },
        ]),
      );

      await source._pollOnceForTest();

      // Should NOT ingest because it was already in the fired set
      expect(ingest).not.toHaveBeenCalled();
    });
  });

  describe("Test 6: stale event IDs pruned on each poll", () => {
    it("removes entries older than eventRetentionDays", async () => {
      // Create an event ID that expired 8 days ago (retention = 7 days)
      const staleEndTime = Date.now() - 8 * 86400000;
      const freshEndTime = Date.now() + 86400000;
      const existingBlob = JSON.stringify([
        ["evt-stale", staleEndTime],
        ["evt-fresh", freshEndTime],
      ]);
      const taskStore = makeMockTaskStore(existingBlob);
      const source = new CalendarSource(makeOptions({ taskStore }));
      await source._startMcpClientForTest();

      mockCallTool.mockResolvedValueOnce(makeCalendarResponse([]));

      await source._pollOnceForTest();

      // cursor_blob should only have evt-fresh after pruning
      const blobArg = taskStore.upsertTriggerState.mock.calls[0]![2] as string;
      const parsed = JSON.parse(blobArg) as [string, number][];
      const ids = parsed.map(([id]) => id);
      expect(ids).not.toContain("evt-stale");
      expect(ids).toContain("evt-fresh");
    });
  });

  describe("Test 7: start() creates setInterval with pollIntervalMs and .unref()", () => {
    it("sets up interval and runs initial pollOnce", async () => {
      const source = new CalendarSource(makeOptions({ pollIntervalMs: 60_000 }));

      mockCallTool.mockResolvedValue(makeCalendarResponse([]));

      source.start();

      // Let the async _startAsync run
      await vi.advanceTimersByTimeAsync(0);

      // MCP connect should have been called
      expect(mockConnect).toHaveBeenCalled();

      // Initial pollOnce should have fired
      expect(mockCallTool).toHaveBeenCalledTimes(1);

      // Advance by one poll interval
      await vi.advanceTimersByTimeAsync(60_000);
      expect(mockCallTool).toHaveBeenCalledTimes(2);
    });
  });

  describe("Test 8: stop() clears interval and closes transport", () => {
    it("cleans up resources", async () => {
      const source = new CalendarSource(makeOptions());

      mockCallTool.mockResolvedValue(makeCalendarResponse([]));

      source.start();
      await vi.advanceTimersByTimeAsync(0);

      source.stop();

      expect(mockTransportClose).toHaveBeenCalled();
    });
  });

  describe("Test 9: MCP callTool error is logged, poll continues", () => {
    it("does not crash on MCP error", async () => {
      const log = {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      } as unknown as CalendarSourceOptions["log"];
      const ingest = vi.fn();
      const source = new CalendarSource(makeOptions({ log, ingest }));
      await source._startMcpClientForTest();

      mockCallTool.mockRejectedValueOnce(new Error("MCP connection failed"));

      await source._pollOnceForTest();

      expect(log.error).toHaveBeenCalled();
      expect(ingest).not.toHaveBeenCalled();
    });
  });

  describe("Test 10: poll(since) returns events not in fired set", () => {
    it("returns unfired events from the upcoming window", async () => {
      const source = new CalendarSource(makeOptions());

      mockCallTool.mockResolvedValueOnce(
        makeCalendarResponse([
          { id: "evt-poll", summary: "Replay event", start: "2026-04-17T12:10:00Z", end: "2026-04-17T12:30:00Z" },
        ]),
      );

      // Need to connect client first
      await source._startMcpClientForTest();

      const events = await source.poll("1713355200000");

      expect(events).toHaveLength(1);
      expect(events[0]!.idempotencyKey).toBe("cal:evt-poll");
    });

    it("returns empty array when client is not connected", async () => {
      const source = new CalendarSource(makeOptions());
      const events = await source.poll("1713355200000");
      expect(events).toHaveLength(0);
    });
  });

  describe("Test 11: round-trip cursor_blob serialization", () => {
    it("serialize with entries(), deserialize with new Map() produces identical Map", () => {
      const original = new Map<string, number>([
        ["evt-a", 1713400000000],
        ["evt-b", 1713500000000],
        ["evt-c", 1713600000000],
      ]);

      const serialized = JSON.stringify([...original.entries()]);
      const deserialized = new Map<string, number>(
        JSON.parse(serialized) as [string, number][],
      );

      expect(deserialized.size).toBe(original.size);
      for (const [key, value] of original) {
        expect(deserialized.get(key)).toBe(value);
      }
    });
  });
});
