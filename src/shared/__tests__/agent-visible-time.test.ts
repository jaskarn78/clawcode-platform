/**
 * Phase 999.13 Wave 0 RED tests — agent-visible TZ rendering helper.
 *
 * Pins TZ-01 / TZ-03 invariants:
 *   - canonical-format: `YYYY-MM-DD HH:mm:ss ZZZ` byte-exact
 *   - dst-round-trip: 7 fixtures covering 2026 US DST transitions
 *     (spring-forward Mar 8, fall-back Nov 1 — RESEARCH.md Pitfall 1)
 *   - bad-iana-fallback: invalid IANA TZ does NOT throw; falls back to UTC
 *   - input-types: Date and ISO string produce identical output
 *   - invalid-date: "not-a-date" returns "invalid date" literally
 *   - timezone-resolution-chain: configTz → process.env.TZ → host
 *
 * Module under test exists as a 2-function THROW-stub on main (Plan 02
 * replaces with the real implementation). Tests fail today because every
 * call throws "not implemented".
 */

import { describe, it, expect } from "vitest";
import {
  renderAgentVisibleTimestamp,
  resolveAgentTimezone,
} from "../agent-visible-time.js";

describe("Phase 999.13 — TZ: renderAgentVisibleTimestamp", () => {
  it("canonical-format: 2026-04-30T18:32:51Z + America/Los_Angeles → '2026-04-30 11:32:51 PDT' byte-exact", () => {
    const out = renderAgentVisibleTimestamp(
      "2026-04-30T18:32:51.000Z",
      "America/Los_Angeles",
    );
    expect(out).toBe("2026-04-30 11:32:51 PDT");
  });

  // DST round-trip table per <dst_fixtures_corrected> in PLAN.md.
  // RESEARCH.md Pitfall 1: 2026 US DST = spring-forward Mar 8, fall-back Nov 1.
  const FIXTURES: ReadonlyArray<{ utc: string; expected: string }> = [
    {
      utc: "2026-01-15T08:32:51.000Z",
      expected: "2026-01-15 00:32:51 PST",
    },
    {
      utc: "2026-04-30T18:32:51.000Z",
      expected: "2026-04-30 11:32:51 PDT",
    },
    {
      utc: "2026-03-08T09:30:00.000Z",
      // 1h before spring-forward — still PST
      expected: "2026-03-08 01:30:00 PST",
    },
    {
      utc: "2026-03-08T10:30:00.000Z",
      // post-spring-forward — PDT
      expected: "2026-03-08 03:30:00 PDT",
    },
    {
      utc: "2026-11-01T08:30:00.000Z",
      // fall-back ambiguous local 01:30 — first occurrence (still PDT)
      expected: "2026-11-01 01:30:00 PDT",
    },
    {
      utc: "2026-11-01T09:30:00.000Z",
      // fall-back ambiguous local 01:30 — second occurrence (now PST)
      expected: "2026-11-01 01:30:00 PST",
    },
    {
      utc: "2026-11-02T08:30:00.000Z",
      // firmly PST by Nov 2
      expected: "2026-11-02 00:30:00 PST",
    },
  ];

  it.each(FIXTURES)(
    "dst-round-trip: $utc → $expected (America/Los_Angeles)",
    ({ utc, expected }) => {
      const out = renderAgentVisibleTimestamp(utc, "America/Los_Angeles");
      expect(out).toBe(expected);
    },
  );

  it("bad-iana-fallback: typo 'Pacific/LosAngeles' does NOT throw; falls back to UTC rendering", () => {
    // Pitfall 6 — runtime layer must wrap Intl.DateTimeFormat in try/catch.
    expect(() =>
      renderAgentVisibleTimestamp(
        "2026-04-30T18:32:51.000Z",
        "Pacific/LosAngeles", // typo: should be America/Los_Angeles
      ),
    ).not.toThrow();
    const out = renderAgentVisibleTimestamp(
      "2026-04-30T18:32:51.000Z",
      "Pacific/LosAngeles",
    );
    // Falls back to UTC — assert the canonical format pattern with a UTC zone
    expect(out).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} [A-Z]{2,5}$/);
    expect(out).toBe("2026-04-30 18:32:51 UTC");
  });

  it("input-types: Date and ISO string produce byte-identical output for same instant", () => {
    const iso = "2026-04-30T18:32:51.000Z";
    const date = new Date(iso);
    const fromIso = renderAgentVisibleTimestamp(iso, "America/Los_Angeles");
    const fromDate = renderAgentVisibleTimestamp(date, "America/Los_Angeles");
    expect(fromIso).toBe(fromDate);
    expect(fromIso).toBe("2026-04-30 11:32:51 PDT");
  });

  it("invalid-date: 'not-a-date' returns the literal string 'invalid date'", () => {
    const out = renderAgentVisibleTimestamp("not-a-date", "UTC");
    expect(out).toBe("invalid date");
  });

  it("host-tz-default: when tz arg omitted, output's TZ-abbrev token matches /[A-Z]{2,5}/ (no UTC literal hardcoding)", () => {
    // Pitfall 7 — process.env.TZ mutation in tests is fragile. Just assert
    // the format is canonical and the abbrev is non-empty alpha; the host
    // TZ is implementation-defined per CI environment.
    const out = renderAgentVisibleTimestamp("2026-04-30T18:32:51.000Z");
    expect(out).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} [A-Z]{2,5}$/);
  });
});

describe("Phase 999.13 — TZ: resolveAgentTimezone", () => {
  it("timezone-resolution-chain: explicit configTz wins → returns it verbatim", () => {
    expect(resolveAgentTimezone("America/New_York")).toBe("America/New_York");
    expect(resolveAgentTimezone("UTC")).toBe("UTC");
    expect(resolveAgentTimezone("Europe/London")).toBe("Europe/London");
  });

  it("timezone-resolution-chain: undefined configTz → falls through to process.env.TZ or host TZ (non-empty IANA-shaped string)", () => {
    const resolved = resolveAgentTimezone(undefined);
    // Either an IANA name (e.g. "America/Los_Angeles") or a fallback like
    // "UTC". Just assert non-empty string with no whitespace.
    expect(typeof resolved).toBe("string");
    expect(resolved.length).toBeGreaterThan(0);
    expect(resolved).not.toMatch(/\s/);
  });
});
