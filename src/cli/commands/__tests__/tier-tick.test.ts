/**
 * Phase 999.8 follow-up — `clawcode tier-tick` CLI tests.
 *
 * Pure-formatter tests (no IPC). Verifies the table layout matches the
 * existing `clawcode health` aesthetic and renders the four states
 * cleanly: empty, single agent, multi agent, with skipped entries.
 */

import { describe, it, expect } from "vitest";
import { formatTierTickTable } from "../tier-tick.js";

describe("formatTierTickTable", () => {
  it("renders the empty state when no agents and no skipped names", () => {
    const out = formatTierTickTable({ results: {}, skipped: [] });
    expect(out).toBe("No agents with tier managers configured");
  });

  it("renders a single-agent result with promoted/demoted/cooled columns", () => {
    const out = formatTierTickTable({
      results: { "fin-client": { promoted: 12, demoted: 3, archived: 0 } },
      skipped: [],
    });
    expect(out).toContain("AGENT");
    expect(out).toContain("PROMOTED");
    expect(out).toContain("DEMOTED");
    expect(out).toContain("COOLED");
    expect(out).toContain("REWARMED");
    expect(out).toContain("ERRORS");
    expect(out).toContain("fin-client");
    expect(out).toContain("12");
    expect(out).toContain("3");
    expect(out).toContain("0");
  });

  it("renders multiple agents in stable insertion order", () => {
    const out = formatTierTickTable({
      results: {
        "Admin Clawdy": { promoted: 5, demoted: 1, archived: 0 },
        "fin-client": { promoted: 12, demoted: 3, archived: 4 },
      },
      skipped: [],
    });
    const adminIdx = out.indexOf("Admin Clawdy");
    const finIdx = out.indexOf("fin-client");
    expect(adminIdx).toBeGreaterThanOrEqual(0);
    expect(finIdx).toBeGreaterThan(adminIdx);
  });

  it("appends a skipped-list footer when names couldn't be ticked", () => {
    const out = formatTierTickTable({
      results: { "Admin Clawdy": { promoted: 0, demoted: 0, archived: 0 } },
      skipped: ["recol-demo", "test-agent"],
    });
    expect(out).toContain("Skipped (no tier manager): recol-demo, test-agent");
  });

  it("renders a header separator that's at least as wide as the header row", () => {
    const out = formatTierTickTable({
      results: { "x": { promoted: 0, demoted: 0, archived: 0 } },
      skipped: [],
    });
    const lines = out.split("\n");
    const headerLen = lines[0]?.length ?? 0;
    const sepLen = lines[1]?.length ?? 0;
    expect(sepLen).toBeGreaterThanOrEqual(Math.min(20, headerLen));
    expect(lines[1]).toMatch(/^-+$/);
  });
});

describe("formatTierTickTable — Phase 999.119 columns", () => {
  it("renders rewarmed/errors and prints the first error under the table", () => {
    const out = formatTierTickTable({
      results: {
        "fin-research": {
          promoted: 1,
          demoted: 0,
          archived: 2,
          rewarmed: 3,
          errors: 1,
          firstError: "Failed to delete memory X: FOREIGN KEY constraint failed",
        },
      },
      skipped: [],
    });
    expect(out).toContain("REWARMED");
    expect(out).toContain("ERRORS");
    expect(out).toContain("fin-research: first error — Failed to delete memory X: FOREIGN KEY constraint failed");
  });

  it("tolerates an older daemon response without the new fields", () => {
    const out = formatTierTickTable({
      results: { "personal": { promoted: 1, demoted: 1, archived: 1 } },
      skipped: [],
    });
    expect(out).toContain("personal");
    expect(out).not.toContain("first error");
  });
});
