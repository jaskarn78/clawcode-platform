/**
 * Phase 135 Plan 01 — capture-state generation-counter dedup.
 *
 * Pure-data unit tests. Pattern: each speaking-start event mints a
 * monotonically-increasing generation per userId. The capture logic uses
 * `currentGeneration === capturedAtBegin` as the validity predicate; when
 * `finishVoiceCapture` increments past current, in-flight handlers see the
 * mismatch and drop their results (silent drop = correct dedup).
 *
 * Per-userId state is independent — one user's generation increment does
 * not affect another's. This isolates dedup boundaries to a single
 * speaker's stream.
 */
import { describe, it, expect } from "vitest";
import {
  beginVoiceCapture,
  createVoiceCaptureState,
  currentGeneration,
  finishVoiceCapture,
} from "../capture-state.js";

describe("capture-state — Phase 135 Plan 01", () => {
  it("beginVoiceCapture returns 1 on first call for a userId", () => {
    const state = createVoiceCaptureState();
    expect(beginVoiceCapture(state, "user-a")).toBe(1);
  });

  it("beginVoiceCapture increments monotonically for repeated begins", () => {
    const state = createVoiceCaptureState();
    expect(beginVoiceCapture(state, "user-a")).toBe(1);
    expect(beginVoiceCapture(state, "user-a")).toBe(2);
    expect(beginVoiceCapture(state, "user-a")).toBe(3);
  });

  it("currentGeneration reads back the latest generation", () => {
    const state = createVoiceCaptureState();
    beginVoiceCapture(state, "user-a");
    beginVoiceCapture(state, "user-a");
    expect(currentGeneration(state, "user-a")).toBe(2);
  });

  it("currentGeneration returns 0 for an unseen userId", () => {
    const state = createVoiceCaptureState();
    expect(currentGeneration(state, "ghost")).toBe(0);
  });

  it("finishVoiceCapture invalidates the current generation", () => {
    const state = createVoiceCaptureState();
    const gen = beginVoiceCapture(state, "user-a");
    // Pre-finish: the captured gen still matches.
    expect(currentGeneration(state, "user-a")).toBe(gen);
    finishVoiceCapture(state, "user-a");
    // Post-finish: current advanced past the captured gen — handlers see a mismatch.
    expect(currentGeneration(state, "user-a")).toBeGreaterThan(gen);
  });

  it("per-user generations are independent", () => {
    const state = createVoiceCaptureState();
    expect(beginVoiceCapture(state, "user-a")).toBe(1);
    expect(beginVoiceCapture(state, "user-b")).toBe(1); // independent counter
    expect(beginVoiceCapture(state, "user-a")).toBe(2);
    expect(currentGeneration(state, "user-a")).toBe(2);
    expect(currentGeneration(state, "user-b")).toBe(1);
  });

  it("typical dedup pattern: capture token survives concurrent begins from another user", () => {
    const state = createVoiceCaptureState();
    const capturedA = beginVoiceCapture(state, "user-a");
    // Another speaker starts mid-flight — must not invalidate A's token.
    beginVoiceCapture(state, "user-b");
    expect(currentGeneration(state, "user-a")).toBe(capturedA);
  });
});
