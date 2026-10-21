/**
 * Phase 138 Plan 03 T-01 — behavioral tests for the alert-message
 * helpers (`interpolate`, `formatAgentsList`, `messageForThreshold`).
 *
 * Wire-format pinning of the constants themselves lives in the sibling
 * `alert-messages-static-grep.test.ts`; this file exercises the
 * substitution + truncation LOGIC.
 */

import { describe, it, expect } from "vitest";
import {
  ALERT_MSG_75,
  ALERT_MSG_90,
  ALERT_MSG_95,
  ALERT_MSG_99,
  THRESHOLDS,
  FAILOVER_SUMMARY_PLACEHOLDER,
  interpolate,
  formatAgentsList,
  messageForThreshold,
} from "../alert-messages.js";

describe("interpolate", () => {
  it("(a) replaces a recognised placeholder", () => {
    expect(interpolate("hello {name}", { name: "world" })).toBe("hello world");
  });

  it("(b) leaves an unrecognised placeholder verbatim", () => {
    expect(interpolate("a {x} b {y}", { x: "1" })).toBe("a 1 b {y}");
  });

  it("does not throw on missing keys", () => {
    expect(() => interpolate("{missing}", {})).not.toThrow();
    expect(interpolate("{missing}", {})).toBe("{missing}");
  });

  it("treats a literal $ before a placeholder as plain text", () => {
    // `${cost_usd}` → `$` stays, `{cost_usd}` is substituted.
    expect(interpolate("cost ${cost_usd}", { cost_usd: "6.34" })).toBe(
      "cost $6.34",
    );
  });

  it("replaces every occurrence of a repeated placeholder", () => {
    expect(interpolate("{x}-{x}", { x: "z" })).toBe("z-z");
  });

  it("(e) interpolates ALERT_MSG_95 with all runtime vars", () => {
    const out = interpolate(ALERT_MSG_95, {
      provider: "openai",
      cost_usd: "6.34",
      cap_usd: "6.67",
      timestamp: "2026-05-19T18:00:00Z",
      agents: "research",
      failover_summary: "triggered",
    });
    expect(out).toContain("🚨");
    expect(out).toContain("openai");
    expect(out).toContain("$6.34/$6.67");
    expect(out).toContain("2026-05-19T18:00:00Z");
    expect(out).toContain("research");
    expect(out).toContain("Action: failover triggered");
    // No unfilled placeholders remain.
    expect(out).not.toMatch(/\{[a-z_]+\}/);
  });
});

describe("formatAgentsList", () => {
  it("(c) joins three agents with comma-space", () => {
    expect(formatAgentsList(["a", "b", "c"])).toBe("a, b, c");
  });

  it("(d) truncates to first 5 with a (+N more) suffix", () => {
    expect(formatAgentsList(["a", "b", "c", "d", "e", "f", "g"])).toBe(
      "a, b, c, d, e (+2 more)",
    );
  });

  it("renders exactly 5 without a suffix", () => {
    expect(formatAgentsList(["a", "b", "c", "d", "e"])).toBe(
      "a, b, c, d, e",
    );
  });

  it("renders 6 with a (+1 more) suffix", () => {
    expect(formatAgentsList(["a", "b", "c", "d", "e", "f"])).toBe(
      "a, b, c, d, e (+1 more)",
    );
  });

  it("renders an empty list as 'none'", () => {
    expect(formatAgentsList([])).toBe("none");
  });
});

describe("THRESHOLDS + messageForThreshold", () => {
  it("exports the four thresholds in ascending order", () => {
    expect(THRESHOLDS).toEqual([75, 90, 95, 99]);
  });

  it("maps each threshold to its verbatim message", () => {
    expect(messageForThreshold(75)).toBe(ALERT_MSG_75);
    expect(messageForThreshold(90)).toBe(ALERT_MSG_90);
    expect(messageForThreshold(95)).toBe(ALERT_MSG_95);
    expect(messageForThreshold(99)).toBe(ALERT_MSG_99);
  });

  it("exposes the Plan-04 failover-summary placeholder literal", () => {
    expect(FAILOVER_SUMMARY_PLACEHOLDER).toBe(
      "triggered (see plan 04 deployment)",
    );
  });
});
