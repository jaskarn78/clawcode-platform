/**
 * Phase 999.42 Plan 05 T-02 — skill-patch-version.ts tests.
 *
 * Covers the D5 semver-bump locus:
 *  - bumpVersion bump matrix (patch / edit / breaking × several versions)
 *  - bumpVersion throws on non-semver input
 *  - validateBumpedVersion true/false cases
 *  - validateBumpedVersion returns false (never throws) on non-semver input
 */
import { describe, it, expect } from "vitest";
import {
  bumpVersion,
  validateBumpedVersion,
  type PatchClass,
} from "../skill-patch-version.js";

describe("skill-patch-version — bumpVersion", () => {
  it("BV-01: patch bump increments the patch segment", () => {
    expect(bumpVersion("1.2.3", "patch")).toBe("1.2.4");
    expect(bumpVersion("0.0.0", "patch")).toBe("0.0.1");
    expect(bumpVersion("9.9.9", "patch")).toBe("9.9.10");
  });

  it("BV-02: edit bump increments minor, resets patch", () => {
    expect(bumpVersion("1.2.3", "edit")).toBe("1.3.0");
    expect(bumpVersion("0.0.0", "edit")).toBe("0.1.0");
    expect(bumpVersion("9.9.9", "edit")).toBe("9.10.0");
  });

  it("BV-03: breaking bump increments major, resets minor + patch", () => {
    expect(bumpVersion("1.2.3", "breaking")).toBe("2.0.0");
    expect(bumpVersion("0.0.0", "breaking")).toBe("1.0.0");
    expect(bumpVersion("9.9.9", "breaking")).toBe("10.0.0");
  });

  it("BV-04: bumpVersion throws on non-semver input", () => {
    for (const bad of ["1.2", "v1.2.3", "1.2.3-beta", "", "1.2.3.4", "abc"]) {
      expect(() => bumpVersion(bad, "patch")).toThrow();
    }
  });

  it("BV-05: bumpVersion throws on an unknown patchClass at runtime", () => {
    // Defends the exhaustive switch against an out-of-type value.
    expect(() =>
      bumpVersion("1.2.3", "nonsense" as unknown as PatchClass),
    ).toThrow();
  });
});

describe("skill-patch-version — validateBumpedVersion", () => {
  it("VB-01: true when proposed === bumpVersion(current, class)", () => {
    expect(validateBumpedVersion("1.2.3", "1.2.4", "patch")).toBe(true);
    expect(validateBumpedVersion("1.2.3", "1.3.0", "edit")).toBe(true);
    expect(validateBumpedVersion("1.2.3", "2.0.0", "breaking")).toBe(true);
  });

  it("VB-02: false when proposed does not match the computed bump", () => {
    expect(validateBumpedVersion("1.2.3", "1.3.0", "patch")).toBe(false);
    expect(validateBumpedVersion("1.2.3", "1.2.4", "edit")).toBe(false);
    expect(validateBumpedVersion("1.2.3", "1.2.3", "patch")).toBe(false);
  });

  it("VB-03: false (never throws) when proposed is non-semver", () => {
    expect(validateBumpedVersion("1.2.3", "1.2", "patch")).toBe(false);
    expect(validateBumpedVersion("1.2.3", "v1.2.4", "patch")).toBe(false);
    expect(validateBumpedVersion("1.2.3", "", "patch")).toBe(false);
  });

  it("VB-04: false (never throws) when current is non-semver", () => {
    expect(validateBumpedVersion("1.2", "1.2.4", "patch")).toBe(false);
    expect(validateBumpedVersion("", "0.0.1", "patch")).toBe(false);
  });
});
