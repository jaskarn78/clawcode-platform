/**
 * Phase 96 Plan 04 Task 3 — TDD RED for D-10 post-turn DUAL detectors.
 *
 * Two sibling pure helpers extending TurnDispatcher post-turn hook:
 *   - detectMissedUpload(response, toolCallNames, deps) — D-10 auto-upload
 *     heuristic; soft warning to admin-clawdy when LLM response references
 *     a file artifact ("here's the PDF") but did NOT call clawcode_share_file.
 *   - detectOpenClawFallback(response, deps) — D-10 OpenClaw-fallback
 *     anti-pattern detector; HIGH-PRIORITY warning when bot recommends
 *     "spawn a subagent on the OpenClaw side" or similar fallback paths.
 *     Negative-match exception: archive/openclaw-sessions/ references are
 *     legitimate (reading historical sessions is fine).
 *
 * Both share the same Phase 91 alert dedup primitive but use DISTINCT
 * dedup keys ('missed-upload' vs 'openclaw-fallback') so they throttle
 * independently. Both non-blocking — sibling try/catch in turn-dispatcher
 * ensures one detector failure doesn't prevent the other from firing AND
 * neither blocks TurnDispatcher.dispatch return.
 *
 * 10 AUH- tests:
 *
 *   Missed-upload detector (6 tests):
 *     AUH-MATCH-PDF             — "here's the PDF you asked for" → fired
 *     AUH-MATCH-GENERATED       — "I generated the financial worksheet" → fired
 *     AUH-MATCH-ATTACHED        — "attached below" → fired
 *     AUH-NO-MATCH-QA           — "the PDF says X" → NOT fired (Q&A pattern)
 *     AUH-NO-WARN-WHEN-SHARED   — share-file in toolCalls → NOT fired
 *     AUH-THROTTLED             — 5 rapid fires → ≤1 alert (throttle key respected)
 *
 *   OpenClaw-fallback detector (4 tests):
 *     AUH-OPENCLAW-MATCH-SIDE      — "spawn a subagent on the OpenClaw side" → fired
 *     AUH-OPENCLAW-MATCH-SPAWN     — "the OpenClaw agent needs to do it" → fired
 *     AUH-OPENCLAW-NEGATIVE-ARCHIVE — "archive/openclaw-sessions/" → NOT fired
 *     AUH-OPENCLAW-THROTTLED       — 5 rapid fires → ≤1 alert (distinct dedup key)
 */

import { describe, it, expect, vi } from "vitest";
import {
  detectMissedUpload,
  detectOpenClawFallback,
  MISSED_UPLOAD_PATTERN,
  OPENCLAW_FALLBACK_PATTERN,
} from "../turn-dispatcher.js";

// Mock alert dedup primitive: tracks calls per dedup key for throttle assertions.
function makeAlertMock() {
  const calls: Array<{ message: string; dedupKey: string }> = [];
  const seenKeys = new Set<string>();
  const fn = vi.fn((message: string, dedupKey: string) => {
    if (seenKeys.has(dedupKey)) return; // dedup window — drop
    seenKeys.add(dedupKey);
    calls.push({ message, dedupKey });
  });
  return { fn, calls, reset: () => { calls.length = 0; seenKeys.clear(); fn.mockClear(); } };
}

describe("detectMissedUpload — D-10 auto-upload heuristic post-turn detector", () => {
  it("AUH-MATCH-PDF: response='here's the PDF you asked for'; no share-file → fire", () => {
    const alert = makeAlertMock();
    const fired = detectMissedUpload(
      "here's the PDF you asked for",
      [],
      { alert: alert.fn },
    );
    expect(fired).toBe(true);
    expect(alert.fn).toHaveBeenCalledTimes(1);
    expect(alert.calls[0]!.dedupKey).toBe("missed-upload");
  });

  it("AUH-MATCH-GENERATED: response='I generated the financial worksheet' → fire", () => {
    const alert = makeAlertMock();
    const fired = detectMissedUpload(
      "I generated the financial worksheet for Tara Maffeo",
      [],
      { alert: alert.fn },
    );
    expect(fired).toBe(true);
    expect(alert.fn).toHaveBeenCalledTimes(1);
  });

  it("AUH-MATCH-ATTACHED: response='attached below' → fire", () => {
    const alert = makeAlertMock();
    const fired = detectMissedUpload(
      "Sure — see the worksheet attached below.",
      [],
      { alert: alert.fn },
    );
    expect(fired).toBe(true);
  });

  it("AUH-NO-MATCH-QA: response='the PDF says X' (Q&A pattern) → NOT fire", () => {
    const alert = makeAlertMock();
    const fired = detectMissedUpload(
      "the PDF says the revenue grew 17% YoY",
      [],
      { alert: alert.fn },
    );
    expect(fired).toBe(false);
    expect(alert.fn).not.toHaveBeenCalled();
  });

  it("AUH-NO-WARN-WHEN-SHARED: artifact response + clawcode_share_file in toolCalls → NOT fire", () => {
    const alert = makeAlertMock();
    const fired = detectMissedUpload(
      "here's the PDF you asked for",
      ["clawcode_share_file", "Read"],
      { alert: alert.fn },
    );
    expect(fired).toBe(false);
    expect(alert.fn).not.toHaveBeenCalled();
  });

  it("AUH-THROTTLED: 5 rapid fires same response → alert called ≤1 time per dedup window", () => {
    const alert = makeAlertMock();
    for (let i = 0; i < 5; i++) {
      detectMissedUpload(
        "here's the PDF",
        [],
        { alert: alert.fn },
      );
    }
    // Mock dedup primitive throttles to one call per dedup-key window.
    expect(alert.calls.length).toBeLessThanOrEqual(1);
    expect(alert.calls[0]?.dedupKey).toBe("missed-upload");
  });
});

describe("detectOpenClawFallback — D-10 OpenClaw-fallback anti-pattern detector", () => {
  it("AUH-OPENCLAW-MATCH-SIDE: 'I'll spawn a subagent on the OpenClaw side to handle this' → fire", () => {
    const alert = makeAlertMock();
    const fired = detectOpenClawFallback(
      "I'll spawn a subagent on the OpenClaw side to handle this",
      { alert: alert.fn },
    );
    expect(fired).toBe(true);
    expect(alert.fn).toHaveBeenCalledTimes(1);
    expect(alert.calls[0]!.dedupKey).toBe("openclaw-fallback");
    // HIGH-PRIORITY warning text mentions OpenClaw
    expect(alert.calls[0]!.message).toMatch(/OpenClaw/i);
  });

  it("AUH-OPENCLAW-MATCH-SPAWN: 'the OpenClaw agent needs to do it' → fire", () => {
    const alert = makeAlertMock();
    const fired = detectOpenClawFallback(
      "Try the OpenClaw agent — it needs to do it for you",
      { alert: alert.fn },
    );
    expect(fired).toBe(true);
    expect(alert.fn).toHaveBeenCalledTimes(1);
  });

  it("AUH-OPENCLAW-NEGATIVE-ARCHIVE: 'archive/openclaw-sessions/' is legitimate → NOT fire", () => {
    const alert = makeAlertMock();
    const fired = detectOpenClawFallback(
      "see archive/openclaw-sessions/ for history of that conversation — the OpenClaw agent had context I don't",
      { alert: alert.fn },
    );
    expect(fired).toBe(false);
    expect(alert.fn).not.toHaveBeenCalled();
  });

  it("AUH-OPENCLAW-THROTTLED: 5 rapid fires same response → alert called ≤1 time per dedup window (distinct key)", () => {
    const alert = makeAlertMock();
    for (let i = 0; i < 5; i++) {
      detectOpenClawFallback(
        "I'll spawn a subagent on the OpenClaw side",
        { alert: alert.fn },
      );
    }
    expect(alert.calls.length).toBeLessThanOrEqual(1);
    expect(alert.calls[0]?.dedupKey).toBe("openclaw-fallback");
  });
});

describe("MISSED_UPLOAD_PATTERN + OPENCLAW_FALLBACK_PATTERN — exported regex constants", () => {
  it("MISSED_UPLOAD_PATTERN matches D-10 verbatim phrases", () => {
    expect(MISSED_UPLOAD_PATTERN.test("here's the PDF")).toBe(true);
    expect(MISSED_UPLOAD_PATTERN.test("attached below")).toBe(true);
    expect(MISSED_UPLOAD_PATTERN.test("I generated a report")).toBe(true);
    expect(MISSED_UPLOAD_PATTERN.test("saved to disk")).toBe(true);
    expect(MISSED_UPLOAD_PATTERN.test("I made a new file for you")).toBe(true);
  });

  it("OPENCLAW_FALLBACK_PATTERN matches D-10 anti-pattern phrases", () => {
    expect(OPENCLAW_FALLBACK_PATTERN.test("OpenClaw side")).toBe(true);
    expect(OPENCLAW_FALLBACK_PATTERN.test("openclaw agent")).toBe(true);
    expect(OPENCLAW_FALLBACK_PATTERN.test("OpenClaw host")).toBe(true);
    expect(OPENCLAW_FALLBACK_PATTERN.test("spawn a subagent on the OpenClaw side")).toBe(true);
  });
});
