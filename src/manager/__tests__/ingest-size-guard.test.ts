import { describe, it, expect } from "vitest";
import {
  assertIngestSizeWithinLimit,
  resolveIngestMaxInputBytes,
  DEFAULT_INGEST_MAX_INPUT_BYTES,
} from "../ingest-size-guard.js";

const makeErr = (m: string): Error => new Error(m);

describe("assertIngestSizeWithinLimit", () => {
  it("passes a file at the ceiling", () => {
    expect(() =>
      assertIngestSizeWithinLimit(100, 100, "/x.pdf", makeErr),
    ).not.toThrow();
  });

  it("passes a file under the ceiling", () => {
    expect(() =>
      assertIngestSizeWithinLimit(1, 100, "/x.pdf", makeErr),
    ).not.toThrow();
  });

  it("throws via the injected factory when over the ceiling", () => {
    expect(() =>
      assertIngestSizeWithinLimit(101, 100, "/big.pdf", makeErr),
    ).toThrow(/big\.pdf.*101 bytes.*exceeding.*100 bytes.*refused/);
  });

  it("uses the supplied error factory (not a bare Error subclass)", () => {
    class CustomErr extends Error {}
    expect(() =>
      assertIngestSizeWithinLimit(2, 1, "/f", (m) => new CustomErr(m)),
    ).toThrow(CustomErr);
  });
});

describe("resolveIngestMaxInputBytes", () => {
  it("defaults when the env var is unset", () => {
    expect(resolveIngestMaxInputBytes({})).toBe(DEFAULT_INGEST_MAX_INPUT_BYTES);
  });

  it("honours a valid positive override", () => {
    expect(
      resolveIngestMaxInputBytes({ CLAWCODE_INGEST_MAX_INPUT_BYTES: "500" }),
    ).toBe(500);
  });

  it("floors a fractional override", () => {
    expect(
      resolveIngestMaxInputBytes({ CLAWCODE_INGEST_MAX_INPUT_BYTES: "500.9" }),
    ).toBe(500);
  });

  it.each(["0", "-1", "abc", "", "NaN"])(
    "falls back to default on invalid override %j",
    (val) => {
      expect(
        resolveIngestMaxInputBytes({ CLAWCODE_INGEST_MAX_INPUT_BYTES: val }),
      ).toBe(DEFAULT_INGEST_MAX_INPUT_BYTES);
    },
  );

  it("default is 100MB", () => {
    expect(DEFAULT_INGEST_MAX_INPUT_BYTES).toBe(100 * 1024 * 1024);
  });
});
