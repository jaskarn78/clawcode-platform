/**
 * INC-2026-08-14c — silence contract for scheduled polls.
 *
 * Fixture discipline (same as workflow-summary/result-quality.ts tests): the
 * VERBATIM prod string that landed in #shopping is a test case. If a
 * threshold or pattern drifts and the observed failure would post again,
 * these tests catch it before prod does.
 */
import { describe, it, expect } from "vitest";
import {
  SILENCE_SENTINEL,
  SCHEDULED_SILENCE_CONTRACT,
  isScheduledSourceId,
  isSilentTickResponse,
} from "../silence-sentinel.js";

/** Verbatim from #shopping, 2026-08-14 09:30 (price-watch cron). */
const PROD_NARRATION =
  "Watchlist is empty - nothing to check. Ending silently per instructions.";

describe("isSilentTickResponse — sentinel layer", () => {
  it("suppresses the bare sentinel", () => {
    expect(isSilentTickResponse("NO_REPORT")).toBe(true);
    expect(isSilentTickResponse("  NO_REPORT  \n")).toBe(true);
  });

  it("suppresses the sentinel with a short annotation or markdown wrap", () => {
    expect(isSilentTickResponse("NO_REPORT — watchlist empty")).toBe(true);
    expect(isSilentTickResponse("**NO_REPORT**")).toBe(true);
    expect(isSilentTickResponse("`NO_REPORT`")).toBe(true);
  });

  it("does NOT suppress a long reply that merely leads with the token", () => {
    const longReport = "NO_REPORT was the old status, but this run found: " +
      "AirPods Pro $249 -> $189 at Amazon (beats 30-day low of $199), " +
      "link https://example.com/x. Also Anker 737 dropped 12%.";
    expect(isSilentTickResponse(longReport)).toBe(false);
  });
});

describe("isSilentTickResponse — narrated-silence backstop", () => {
  it("suppresses the verbatim prod narration", () => {
    expect(isSilentTickResponse(PROD_NARRATION)).toBe(true);
  });

  it("suppresses common short nothing-to-report shapes", () => {
    expect(isSilentTickResponse("No price changes since the last check.")).toBe(true);
    expect(isSilentTickResponse("No state changes - all orders still in transit.")).toBe(true);
    expect(isSilentTickResponse("Nothing new to report.")).toBe(true);
  });

  it("does NOT suppress a real short report", () => {
    expect(
      isSilentTickResponse(
        "Anker 737: $59.99 -> $47.99 at Amazon (20% drop, beats target $50) https://a.co/x",
      ),
    ).toBe(false);
  });

  it("does NOT suppress a long report containing a silence-ish phrase mid-text", () => {
    const report =
      "Order tracking update: package 1Z999 moved to out-for-delivery (ETA today). " +
      "The Sony order shows no changes at the carrier yet, still label-created. " +
      "Costco order delivered yesterday, photo confirmation on file. " +
      "Flagging the Sony one for tomorrow's run if it still has not moved by then.";
    expect(report.length).toBeGreaterThan(200);
    expect(isSilentTickResponse(report)).toBe(false);
  });

  it("suppresses empty/whitespace (belt-and-suspenders with the engine guard)", () => {
    expect(isSilentTickResponse("")).toBe(true);
    expect(isSilentTickResponse("   \n ")).toBe(true);
  });
});

describe("isSilentTickResponse — a short alert is never swallowed (999.174)", () => {
  // WISHLIST-SPEC §3.1: the backstop's "no changes" shape matched a real alert
  // that ended with a courtesy line, and the alert was dropped as silence.
  // Every tail below trips the backstop on its own, so each fixture is only
  // posted because of its alert shape.
  const TAILS = ["No changes elsewhere.", "No changes on others.", "Nothing to report on the rest."];
  it("each tail alone is suppressed (the fixtures below are load-bearing)", () => {
    for (const t of TAILS) expect(isSilentTickResponse(t)).toBe(true);
  });
  it("posts a price move that ends with a no-changes line", () => {
    for (const alert of [
      "AirPods $179→$149.",
      "AirPods $179 -> $149.",
      "Terra dropped to $239.99 (target $249.99).",
      "Chain dropped 17% to $149.",
      "Terra was $279.94, now $239.99.",
      "Price drop: AirPods $149.",
      "Terra at an all-time low today.",
    ]) {
      for (const t of TAILS) expect(isSilentTickResponse(`${alert} ${t}`), `${alert} ${t}`).toBe(false);
    }
  });
  it("posts a restock or a target hit that ends with a no-changes line", () => {
    for (const alert of ["Force XG-1270 back in stock at Competitive Cyclist.", "Chain hit your target at $52."]) {
      for (const t of TAILS) expect(isSilentTickResponse(`${alert} ${t}`), `${alert} ${t}`).toBe(false);
    }
  });
  it("still suppresses no-change narration, including negated alert words", () => {
    for (const m of [
      "No price drops — Terra holding at $279.94.",
      "No changes: Terra $279.94, Noctua $69.95.",
      "Nothing hit your target — ending silently.",
      "No price drops; nothing below your target.",
      "Noctua still not back in stock. No changes.",
    ]) {
      expect(isSilentTickResponse(m), m).toBe(true);
    }
  });
  it("posts any alert-shaped text over the backstop's length cap", () => {
    const long = `Price drop: Fractal Terra Jade fell from $279.94 to $239.99 at Fractal, under your $249.99 target and the lowest in 30 days. Noctua NH-L12Sx77 unchanged at $69.95. ${"No changes elsewhere. ".repeat(3)}`;
    expect(long.length).toBeGreaterThan(200);
    expect(isSilentTickResponse(long)).toBe(false);
  });
});

describe("isScheduledSourceId — contract scope", () => {
  it("covers the scheduler family only", () => {
    expect(isScheduledSourceId("scheduler")).toBe(true);
    expect(isScheduledSourceId("reminder:abc123")).toBe(true);
    expect(isScheduledSourceId("recurring:xyz789")).toBe(true);
    expect(isScheduledSourceId("mysql:orders")).toBe(false);
    expect(isScheduledSourceId("webhook:strava")).toBe(false);
    expect(isScheduledSourceId("inbox")).toBe(false);
  });
});

describe("SCHEDULED_SILENCE_CONTRACT", () => {
  it("names the sentinel and the auto-post behavior", () => {
    expect(SCHEDULED_SILENCE_CONTRACT).toContain(SILENCE_SENTINEL);
    expect(SCHEDULED_SILENCE_CONTRACT).toContain("auto-posted");
  });

  it("a contract-following reply round-trips through suppression", () => {
    expect(isSilentTickResponse(SILENCE_SENTINEL)).toBe(true);
  });
});
