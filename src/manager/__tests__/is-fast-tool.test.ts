/**
 * INC-2026-06-05 — guards the load-bearing seam of the split fast/slow pause
 * ceiling: the tracker math is unit-tested separately, but the fix only engages
 * on the real culprit if `isFastTool()` classifies it correctly. A typo'd
 * prefix would pass every tracker test yet silently leave fin-client on
 * the 15-min path. This pins the exact classifications.
 */
import { describe, it, expect } from "vitest";
import { isFastTool } from "../persistent-session-handle.js";

describe("isFastTool — fast-tool allowlist", () => {
  it("classifies the triggering culprit (acme-db mysql_query) as fast", () => {
    expect(isFastTool("mcp__acme-db__mysql_query")).toBe(true);
  });

  it("classifies seconds-scale allowlisted tools as fast", () => {
    for (const n of [
      "Read",
      "Grep",
      "Glob",
      "ToolSearch",
      "mcp__acme-content__log_client_interaction",
      "mcp__finnhub__stock_quote",
    ]) {
      expect(isFastTool(n), n).toBe(true);
    }
  });

  it("classifies local-filesystem WRITE tools as fast (fleet-audit-2026-06-16 H2)", () => {
    // Local-disk write tools return in ms — same "never legitimately minutes"
    // property as Read. Before H2 these were SLOW → a lone hung Edit waited the
    // full 15-min ceiling instead of the 2-min fast ceiling (the residual
    // Read/Edit tool-wedge tail the audit measured).
    for (const n of ["Edit", "Write", "MultiEdit", "NotebookEdit"]) {
      expect(isFastTool(n), n).toBe(true);
    }
  });

  it("keeps heavy/unknown tools SLOW (no regression, no false-abort)", () => {
    for (const n of [
      // Bash stays SLOW BY DESIGN — heavy fin Bash legitimately runs 5–12 min.
      "Bash",
      "WebFetch",
      "WebSearch",
      "mcp__playwright__browser_navigate",
      "mcp__firecrawl__scrape",
      "mcp__exa__search",
      "some_future_unknown_tool",
      "",
    ]) {
      expect(isFastTool(n), n).toBe(false);
    }
    expect(isFastTool(undefined)).toBe(false);
    expect(isFastTool(null)).toBe(false);
  });
});
