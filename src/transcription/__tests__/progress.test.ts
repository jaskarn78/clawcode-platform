/**
 * 999.143 — the percentage is shown to a person, so its honesty properties are
 * the thing worth testing: monotonic, never 100% before done, never past the
 * phase actually in progress.
 */
import { describe, it, expect } from "vitest";
import { deriveState, humanDuration, bar, expectedTotalSeconds, isPhase } from "../progress.js";

const T0 = 1_700_000_000;           // epoch seconds
const now = (plusSeconds: number) => (T0 + plusSeconds) * 1000;

const raw = (phase: string, over: Partial<Record<string, number>> = {}) => ({
  job: "meeting", phase,
  audio_seconds: 1800,              // 30 min of audio -> ~300 s of GPU work
  job_started_at: T0,
  phase_started_at: T0,
  ...over,
});

describe("expectedTotalSeconds", () => {
  it("is real-time over six", () => {
    expect(expectedTotalSeconds(1800)).toBe(300);
  });
  it("is unknown without a duration", () => {
    expect(expectedTotalSeconds(undefined)).toBeUndefined();
    expect(expectedTotalSeconds(0)).toBeUndefined();
  });
});

describe("deriveState", () => {
  it("starts low rather than at zero-forever", () => {
    const s = deriveState(raw("extracting"), now(0));
    expect(s.pct).toBeGreaterThanOrEqual(2);
    expect(s.pct).toBeLessThan(10);
  });

  it("never reports 100% before the job is done", () => {
    // A phase that massively overruns its budget still cannot claim completion.
    const s = deriveState(raw("writing", { phase_started_at: T0 }), now(100_000));
    expect(s.pct).toBeLessThan(100);
  });

  it("reports exactly 100% and zero ETA when done", () => {
    const s = deriveState(raw("done"), now(400));
    expect(s.pct).toBe(100);
    expect(s.etaSeconds).toBe(0);
  });

  it("cannot overtake the phase actually running", () => {
    // transcribing tops out at 62 no matter how long it has been running.
    const s = deriveState(raw("transcribing", { phase_started_at: T0 }), now(99_999));
    expect(s.pct).toBeLessThanOrEqual(62);
  });

  it("never runs backwards across polls", () => {
    // A late phase transition must not rewind a bar the user already saw.
    const seen = deriveState(raw("diarizing", { phase_started_at: T0 }), now(200)).pct;
    const later = deriveState(raw("transcribing", { phase_started_at: T0 }), now(201), seen);
    expect(later.pct).toBeGreaterThanOrEqual(seen);
  });

  it("advances as a phase progresses", () => {
    const a = deriveState(raw("transcribing"), now(10)).pct;
    const b = deriveState(raw("transcribing"), now(120)).pct;
    expect(b).toBeGreaterThan(a);
  });

  it("falls back to queued for a phase it does not recognise", () => {
    expect(deriveState(raw("marinating"), now(0)).phase).toBe("queued");
  });

  it("still produces a state when the duration is unknown", () => {
    const s = deriveState({ job: "x", phase: "transcribing" }, now(0));
    expect(s.pct).toBeGreaterThanOrEqual(0);
    expect(s.etaSeconds).toBeUndefined();   // honest: no basis for an estimate
  });

  it("shrinks the ETA as the job proceeds", () => {
    const early = deriveState(raw("transcribing"), now(10)).etaSeconds!;
    const late = deriveState(raw("diarizing", { phase_started_at: T0 + 200 }), now(260)).etaSeconds!;
    expect(late).toBeLessThan(early);
  });
});

describe("isPhase", () => {
  it("accepts the worker's phases and rejects noise", () => {
    expect(isPhase("diarizing")).toBe(true);
    expect(isPhase("nonsense")).toBe(false);
  });
});

describe("humanDuration", () => {
  it("reads naturally at each scale", () => {
    expect(humanDuration(45)).toBe("45s");
    expect(humanDuration(240)).toBe("4 min");
    expect(humanDuration(4200)).toBe("1h 10m");
    expect(humanDuration(undefined)).toBe("—");
  });
});

describe("bar", () => {
  it("is empty at 0 and full at 100", () => {
    expect(bar(0)).toBe("░".repeat(12));
    expect(bar(100)).toBe("█".repeat(12));
  });
  it("is proportional in between", () => {
    expect(bar(50).startsWith("██████")).toBe(true);
  });
  it("clamps nonsense rather than throwing", () => {
    expect(bar(-10).length).toBe(12);
    expect(bar(999).length).toBe(12);
  });
});
