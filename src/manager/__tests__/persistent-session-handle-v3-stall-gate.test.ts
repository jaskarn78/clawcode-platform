import { describe, it, expect } from "vitest";
import { isV3Session } from "../persistent-session-handle.js";

/**
 * v3 stall-tracker activity-trip gate — phase127 false-abort fix.
 *
 * Live finding (2026-06-14): the phase127 `no-useful-tokens` stall watchdog
 * false-aborted v3 (claude-code-interactive) sessions, whose in-process SDK
 * token stream is INERT by design — real tokens flow through the PTY. So it
 * tripped every v3 turn past the 180s threshold (60 observed
 * `phase127-stream-stall` aborts, all sessionId "v3-research", ~210s > 180s),
 * surfacing as "⚠️ stream stall — turn aborted, send the message again".
 *
 * The handle now passes `tokenActivityTripsEnabled: !isV3Session(sessionId)` —
 * for v3 it DISABLES the token-activity trips (no-useful-tokens /
 * max-pause-exceeded) while keeping the absolute `max-turn-duration`
 * wall-clock backstop armed (a hung v3 turn must still settle + release its
 * queue slot; the PtySupervisor owns process lifecycle, not a per-turn
 * settle). These cases pin the gate predicate so a regression that re-arms the
 * activity trips for v3 — or breaks the `v3-<agent>` sessionId convention from
 * session-adapter.ts — is caught. The trip behaviour itself is covered in
 * stream-stall-tracker-max-turn.test.ts ("tokenActivityTripsEnabled: false").
 */
describe("isV3Session — phase127 stall-tracker activity-trip gate", () => {
  it("returns true for v3 (claude-code-interactive) sessionIds → activity trips disabled", () => {
    expect(isV3Session("v3-research")).toBe(true);
    expect(isV3Session("v3-fin-client")).toBe(true);
    expect(isV3Session("v3-")).toBe(true);
  });

  it("returns false for SDK sessionIds → activity trips stay armed (dead-stream protection preserved)", () => {
    // Real API session ids are opaque UUIDs — never the v3- prefix.
    expect(isV3Session("018f8c1a-7b2e-7c3d-9a4b-1f2e3d4c5b6a")).toBe(false);
    expect(isV3Session("session-abc")).toBe(false);
    expect(isV3Session("")).toBe(false);
  });

  it("requires the prefix at the start — a mid-string 'v3-' does not match", () => {
    expect(isV3Session("agent-v3-research")).toBe(false);
    expect(isV3Session("v3")).toBe(false); // no dash → not the v3- convention
  });
});
