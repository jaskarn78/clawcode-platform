import { describe, it, expect, vi, afterEach } from "vitest";

/**
 * quick task 260714-mkq — Task 1 Part A predicate + tracker integration.
 *
 * `streamEventHasUsefulDelta` is the LANE-AGNOSTIC useful-token predicate
 * extracted into `stream-stall-tracker.ts` and shared with the production
 * chokepoint in `persistent-session-handle.ts`. These tests are the
 * load-bearing proof that a native in-session Workflow/Task CHILD-lane delta
 * (message-level `parent_tool_use_id` set — the SDK shape
 * `SDKPartialAssistantMessage = { type:'stream_event', event, parent_tool_use_id:
 * string | null }`) is counted as a useful token, so an active Workflow lane
 * keeps the parent turn's stall countdown alive. The genuine-wedge case
 * (no deltas at all) is preserved by construction.
 */

import {
  streamEventHasUsefulDelta,
  createStreamStallTracker,
  type StreamStallPayload,
} from "../stream-stall-tracker.js";

// ---------------------------------------------------------------------------
// Fixtures — built from the REAL SDK stream_event shape (sdk.d.ts:
//   SDKPartialAssistantMessage { type:'stream_event'; event:
//   BetaRawMessageStreamEvent; parent_tool_use_id: string | null }
// with event = content_block_delta { type, index, delta }).
// The ONLY difference between the top-level and child-lane fixtures is the
// message-level `parent_tool_use_id` — child-lane deltas carry a NON-null id.
// ---------------------------------------------------------------------------

function streamEvent(
  parentToolUseId: string | null,
  delta: Record<string, unknown>,
): unknown {
  return {
    type: "stream_event",
    parent_tool_use_id: parentToolUseId,
    event: { type: "content_block_delta", index: 0, delta },
  };
}

const topLevelTextDeltaMsg = streamEvent(null, {
  type: "text_delta",
  text: "hello from the parent turn",
});

// LOAD-BEARING: same content_block_delta nesting, parent_tool_use_id SET.
const childLaneTextDeltaMsg = streamEvent("toolu_01ChildLane", {
  type: "text_delta",
  text: "subagent making progress",
});

const childLaneInputJsonDeltaMsg = streamEvent("toolu_01ChildLane", {
  type: "input_json_delta",
  partial_json: '{"query":"a',
});

const childLaneThinkingDeltaMsg = streamEvent("toolu_01ChildLane", {
  type: "thinking_delta",
  thinking: "the child lane is reasoning",
});

const emptyDeltaMsg = streamEvent(null, { type: "text_delta", text: "" });

const nonStreamEventMsg = {
  type: "assistant",
  message: { role: "assistant", content: [] },
  parent_tool_use_id: null,
};

describe("streamEventHasUsefulDelta — lane-agnostic predicate", () => {
  it("returns true for a TOP-LEVEL text_delta", () => {
    expect(streamEventHasUsefulDelta(topLevelTextDeltaMsg)).toBe(true);
  });

  it("returns true for a CHILD-LANE text_delta (parent_tool_use_id set)", () => {
    // The exact shape the native Workflow/Task lane streams — the fix.
    expect(streamEventHasUsefulDelta(childLaneTextDeltaMsg)).toBe(true);
  });

  it("returns true for a CHILD-LANE input_json_delta and thinking_delta", () => {
    expect(streamEventHasUsefulDelta(childLaneInputJsonDeltaMsg)).toBe(true);
    expect(streamEventHasUsefulDelta(childLaneThinkingDeltaMsg)).toBe(true);
  });

  it("returns false for an EMPTY delta (present but text is '')", () => {
    expect(streamEventHasUsefulDelta(emptyDeltaMsg)).toBe(false);
  });

  it("returns false for a non-stream_event message", () => {
    expect(streamEventHasUsefulDelta(nonStreamEventMsg)).toBe(false);
  });

  it("returns false for junk inputs (null / non-object / missing event)", () => {
    expect(streamEventHasUsefulDelta(null)).toBe(false);
    expect(streamEventHasUsefulDelta(undefined)).toBe(false);
    expect(streamEventHasUsefulDelta(42)).toBe(false);
    expect(streamEventHasUsefulDelta({ type: "stream_event" })).toBe(false);
    expect(
      streamEventHasUsefulDelta({
        type: "stream_event",
        parent_tool_use_id: null,
        event: { type: "content_block_start" },
      }),
    ).toBe(false);
  });
});

describe("tracker integration — child-lane deltas keep the tracker alive; no deltas still trips", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("feeding ONLY child-lane deltas via the predicate does NOT trip across 3× threshold", () => {
    vi.useFakeTimers();
    const clock = { now: 0 };
    const onStall = vi.fn<(p: StreamStallPayload) => void>();
    const tracker = createStreamStallTracker({
      thresholdMs: 1000,
      checkIntervalMs: 100,
      getNow: () => clock.now,
      onStall,
    });

    // Advance in 100ms steps for 3000ms (3× threshold). On EVERY step a
    // child-lane delta arrives and is marked via the SAME predicate the
    // production chokepoint uses — the countdown restarts each step.
    for (let step = 0; step < 30; step++) {
      clock.now += 100;
      vi.advanceTimersByTime(100);
      if (streamEventHasUsefulDelta(childLaneTextDeltaMsg)) {
        tracker.markUsefulToken();
      }
    }

    expect(onStall).not.toHaveBeenCalled();
    tracker.stop();
  });

  it("feeding NO deltas at all STILL trips at thresholdMs (genuine-wedge preserved)", () => {
    vi.useFakeTimers();
    const clock = { now: 0 };
    const onStall = vi.fn<(p: StreamStallPayload) => void>();
    const tracker = createStreamStallTracker({
      thresholdMs: 1000,
      checkIntervalMs: 100,
      getNow: () => clock.now,
      onStall,
    });

    // No markUsefulToken() ever — advance past threshold and let the interval
    // observe the silent stream.
    for (let step = 0; step < 15; step++) {
      clock.now += 100;
      vi.advanceTimersByTime(100);
    }

    expect(onStall).toHaveBeenCalledTimes(1);
    expect(onStall.mock.calls[0]![0].reason).toBe("no-useful-tokens");
    tracker.stop();
  });
});
