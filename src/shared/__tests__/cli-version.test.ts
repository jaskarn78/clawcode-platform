/**
 * Phase 999.159 — CLI version parsing + comparison.
 *
 * The assertions here are the two production outages written as tests: the
 * 2.1.257-vs-2.1.280 comparison that nothing performed, and the two-digit trap
 * (`2.1.9` vs `2.1.280`) that a naive string compare gets backwards.
 */
import { describe, expect, it } from "vitest";
import {
  compareCliVersions,
  cliVersionSatisfies,
  formatCliVersion,
  parseCliVersion,
} from "../cli-version.js";

describe("parseCliVersion", () => {
  it("parses the real `claude --version` output shape", () => {
    // Verified on both the prod pin and the dev box, 2026-09-22.
    expect(parseCliVersion("2.1.280 (Claude Code)")).toEqual([2, 1, 280]);
  });

  it("caps at MAJOR.MINOR.PATCH so a build suffix cannot promote a version", () => {
    // The wire cc_version carries a per-build suffix (2.1.158.7ab) that is NOT
    // derivable and NOT an ordering component. A greedy numeric parse reads it
    // as [2,1,158,7], which compares GREATER than the floor 2.1.158 — a build
    // suffix silently passing a check it should only tie.
    expect(parseCliVersion("2.1.158.7ab")).toEqual([2, 1, 158]);
    expect(compareCliVersions("2.1.158.7ab", "2.1.158")).toBe(0);
    expect(cliVersionSatisfies("2.1.158.7ab", "2.1.280")).toBe(false);
  });

  it("ignores a 4th numeric segment entirely", () => {
    expect(parseCliVersion("2.1.280.42")).toEqual([2, 1, 280]);
  });

  it("tolerates surrounding whitespace and trailing text", () => {
    expect(parseCliVersion("  2.1.257  \n")).toEqual([2, 1, 257]);
  });

  it("returns null for a string with no version in it", () => {
    expect(parseCliVersion("unprobeable")).toBeNull();
    expect(parseCliVersion("")).toBeNull();
  });
});

describe("compareCliVersions", () => {
  it("orders the two outage pairs correctly", () => {
    // 2026-09-01: binary 2.1.158, Fable 5.1 needed 2.1.257.
    expect(compareCliVersions("2.1.158", "2.1.257")).toBeLessThan(0);
    // 2026-09-22: binary 2.1.257, Opus 5.5 needed 2.1.280.
    expect(compareCliVersions("2.1.257", "2.1.280")).toBeLessThan(0);
  });

  it("🚨 does not fall into the two-digit trap", () => {
    // A string compare puts "2.1.9" ABOVE "2.1.280" because "9" > "2".
    expect(compareCliVersions("2.1.9", "2.1.280")).toBeLessThan(0);
    expect(compareCliVersions("2.1.280", "2.1.9")).toBeGreaterThan(0);
    // Sanity: the lexical order really is the wrong one.
    expect("2.1.9" > "2.1.280").toBe(true);
  });

  it("treats a missing segment as zero", () => {
    expect(compareCliVersions("2.1", "2.1.0")).toBe(0);
    expect(compareCliVersions("2.1", "2.1.1")).toBeLessThan(0);
  });

  it("compares across major and minor, not just patch", () => {
    expect(compareCliVersions("3.0.0", "2.9.999")).toBeGreaterThan(0);
    expect(compareCliVersions("2.2.0", "2.1.999")).toBeGreaterThan(0);
  });

  it("is null — not 0 — when either side is unparseable", () => {
    // A silent 0 would read as "equal", i.e. compatible. That is the whole bug.
    expect(compareCliVersions("unprobeable", "2.1.280")).toBeNull();
    expect(compareCliVersions("2.1.280", "")).toBeNull();
  });
});

describe("cliVersionSatisfies", () => {
  it("passes on equal and newer, fails on older", () => {
    expect(cliVersionSatisfies("2.1.280", "2.1.280")).toBe(true);
    expect(cliVersionSatisfies("2.1.281", "2.1.280")).toBe(true);
    expect(cliVersionSatisfies("2.2.0", "2.1.280")).toBe(true);
    expect(cliVersionSatisfies("2.1.257", "2.1.280")).toBe(false);
  });

  it("accepts the raw --version output on the installed side", () => {
    expect(cliVersionSatisfies("2.1.280 (Claude Code)", "2.1.280")).toBe(true);
    expect(cliVersionSatisfies("2.1.257 (Claude Code)", "2.1.280")).toBe(false);
  });

  it("returns null (NOT true) when the version cannot be read", () => {
    expect(cliVersionSatisfies("unprobeable", "2.1.280")).toBeNull();
  });
});

describe("formatCliVersion", () => {
  it("normalizes to the numeric run for logs", () => {
    expect(formatCliVersion("2.1.280 (Claude Code)")).toBe("2.1.280");
  });

  it("passes an unparseable string through unchanged", () => {
    expect(formatCliVersion("unprobeable")).toBe("unprobeable");
  });
});
