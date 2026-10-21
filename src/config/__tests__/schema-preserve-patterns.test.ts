import { describe, it, expect } from "vitest";
import {
  resolvePreserveLastTurns,
  resolvePreserveVerbatimPatterns,
} from "../loader.js";
import { configSchema } from "../schema.js";

describe("preserveLastTurns / preserveVerbatimPatterns resolution", () => {
  it("resolvePreserveLastTurns defaults to 10 when both sides omit", () => {
    expect(resolvePreserveLastTurns(undefined, undefined)).toBe(10);
    expect(resolvePreserveLastTurns({}, {})).toBe(10);
  });

  it("resolvePreserveLastTurns cascades agent over defaults", () => {
    expect(
      resolvePreserveLastTurns({ preserveLastTurns: 25 }, { preserveLastTurns: 5 }),
    ).toBe(25);
    expect(
      resolvePreserveLastTurns(undefined, { preserveLastTurns: 7 }),
    ).toBe(7);
  });

  it("zod schema rejects out-of-range preserveLastTurns at parse time", () => {
    const bad = {
      version: 1,
      discord: { enabled: false },
      agents: [
        {
          name: "a",
          workspace: "/tmp/a",
          channels: [],
          preserveLastTurns: 0,
        },
      ],
    };
    const r = configSchema.safeParse(bad);
    expect(r.success).toBe(false);
  });

  it("resolvePreserveVerbatimPatterns compiles valid patterns and throws on invalid", () => {
    const compiled = resolvePreserveVerbatimPatterns(
      { preserveVerbatimPatterns: ["\\bAUM\\b", "\\$[0-9]"] },
      undefined,
    );
    expect(compiled).toBeDefined();
    expect(compiled?.length).toBe(2);
    expect(compiled?.[0].test("the AUM line")).toBe(true);

    expect(() =>
      resolvePreserveVerbatimPatterns(
        { preserveVerbatimPatterns: ["[unterminated"] },
        undefined,
      ),
    ).toThrow(/invalid regex/);
  });

  it("resolvePreserveVerbatimPatterns returns undefined for empty/absent", () => {
    expect(resolvePreserveVerbatimPatterns(undefined, undefined)).toBeUndefined();
    expect(
      resolvePreserveVerbatimPatterns(
        { preserveVerbatimPatterns: [] },
        { preserveVerbatimPatterns: [] },
      ),
    ).toBeUndefined();
  });
});
