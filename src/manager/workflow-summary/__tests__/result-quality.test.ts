import { describe, it, expect } from "vitest";
import {
  looksLikeMetaSummary,
  pickBetterResult,
  STEP_DELIVERY_CONTRACT,
  CORRECTIVE_PROMPT,
  THIN_RESULT_CHARS,
} from "../result-quality.js";

/**
 * INC-2026-08-14 — fixtures are the VERBATIM final messages from wf_X2SbTV
 * steps 0 and 2, the two that lost their findings in production. If these two
 * ever stop qualifying for the corrective retry, the regression is back.
 */
const PROD_STATUS_NARRATION =
  "All four research agents are running in parallel:\n\n" +
  "1. **Water/action cluster** — WaterWorks Park (with the critical mid-August schedule check), " +
  "Rare Air Trampoline, Oasis Fun Center go-kart age minimums\n" +
  "2. **Escape/combat cluster** — Extreme Escape rooms, Break Out Redding (identifying what it " +
  "actually is), axe throwing, VR, nerf/paintball\n" +
  "3. **Classic indoor cluster** — bowling, climbing gyms, roller/ice skating, batting cages, " +
  "mini golf, plus Cinemark as a heat backup\n" +
  "4. **Outlying areas** — Joystick Junction in Anderson, Shasta Lake City, Shasta Caverns " +
  "(58°F cave, boat is transport not swimming), and city aquatic centers with the " +
  "post-school-start schedule risk\n\n" +
  "Each is verifying open status for this specific weekend, exact Sat/Sun hours, prices, " +
  "age/height minimums, booking requirements, and drive times from the Sheraton. When they " +
  "all report back I'll rank everything by 13-year-old appeal and deliver the structured list.";

const PROD_DELIVERED_ABOVE =
  "Report delivered above — WaterWorks Park (with per-slide fit for both kids, weekend " +
  "pricing, twilight hack, cabana costs, no-outside-food policy), Sheraton's confirmed " +
  "outdoor pool, the $6–8 Aquatic Center backup, the free Fantasy Fountain splash pad, and " +
  "a note that Redding has no real indoor-water option. Two facts still need a phone call " +
  "to lock down: Aquatic Center 2026 admission/hours and Sheraton pool hours.";

describe("looksLikeMetaSummary — the wf_X2SbTV regressions", () => {
  it("catches the prod status narration (step 0, 949 bytes)", () => {
    expect(looksLikeMetaSummary(PROD_STATUS_NARRATION)).toBe(true);
  });

  it("catches the prod 'delivered above' pointer (step 2, 421 bytes)", () => {
    expect(looksLikeMetaSummary(PROD_DELIVERED_ABOVE)).toBe(true);
  });

  it("catches empty and sub-threshold results regardless of wording", () => {
    expect(looksLikeMetaSummary("")).toBe(true);
    expect(looksLikeMetaSummary("Done!")).toBe(true);
    expect(looksLikeMetaSummary("x".repeat(THIN_RESULT_CHARS - 1))).toBe(true);
  });

  it("does NOT flag a real report that happens to be long", () => {
    // The good sibling from the same workflow starts with a preamble and runs
    // 6.5k chars — must never retry.
    const real =
      "Research complete. Here's the full indoor-heat-escape guide for Redding. " +
      "## Movies — Cinemark Redding 14 & XD\n980 Old Alturas Rd — ~2.5 mi. " +
      "Detailed listing paragraph. ".repeat(60);
    expect(looksLikeMetaSummary(real)).toBe(false);
  });

  it("does NOT flag a large report containing 'as shown above' mid-text", () => {
    const real = `${"Substantive finding paragraph with numbers 42%. ".repeat(40)}As shown above, the trend holds.${" More detail. ".repeat(30)}`;
    expect(real.length).toBeGreaterThan(900);
    expect(looksLikeMetaSummary(real)).toBe(false);
  });

  it("does NOT flag a legitimately medium answer with real content", () => {
    const real =
      "WaterWorks Park: open Sat 10-6, Sun 10-5, $28 adult / $22 under-48in, " +
      "twilight rate $15 after 3pm. Slides: Avalanche (48in min), Riptide (42in). " +
      "Cabanas $75/day, book online. No outside food; parking free. " +
      "Sheraton outdoor pool confirmed open 7am-10pm for guests. " +
      "Aquatic Center backup: $6-8, hours unconfirmed for late August - call " +
      "(530) 555-0100. Fantasy Fountain splash pad: free, dawn to dusk.";
    expect(real.length).toBeGreaterThan(THIN_RESULT_CHARS);
    expect(looksLikeMetaSummary(real)).toBe(false);
  });
});

describe("pickBetterResult", () => {
  const real = "Full findings: ".padEnd(800, "detail ");
  it("takes the retry when it is real and the original was meta", () => {
    expect(pickBetterResult(PROD_DELIVERED_ABOVE, real)).toBe(real);
  });
  it("keeps the original when the retry doubled down on meta", () => {
    expect(pickBetterResult(real, "As delivered above.")).toBe(real);
  });
  it("prefers the longer when both are real", () => {
    const longer = real + " Plus an appendix of verified numbers and hours.";
    expect(pickBetterResult(real, longer)).toBe(longer);
  });
});

describe("the prompts", () => {
  it("the delivery contract states the collection mechanism explicitly", () => {
    expect(STEP_DELIVERY_CONTRACT).toContain("FINAL message IS the deliverable");
    expect(STEP_DELIVERY_CONTRACT).toContain("NOT captured");
  });
  it("the corrective prompt bans the two observed failure shapes", () => {
    expect(CORRECTIVE_PROMPT).toMatch(/as shown above/);
    expect(CORRECTIVE_PROMPT).toMatch(/still running/);
  });
});
