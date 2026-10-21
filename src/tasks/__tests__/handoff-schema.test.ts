/**
 * Phase 59 Plan 01 Task 2 — handoff-schema.ts JSON-Schema→Zod compiler tests.
 *
 * Covers primitives, constraints, object/.strict, enum, oneOf, nested,
 * unsupported constructs, and a realistic end-to-end research.brief shape.
 */

import { describe, it, expect } from "vitest";
import { ZodError } from "zod/v4";
import { compileJsonSchema, type JsonSchema } from "../handoff-schema.js";
import { ValidationError } from "../errors.js";

describe("compileJsonSchema — primitives", () => {
  it("Test 1: string primitive", () => {
    const s = compileJsonSchema({ type: "string" });
    expect(s.parse("hello")).toBe("hello");
    expect(() => s.parse(42)).toThrow();
  });

  it("Test 2: string with minLength/maxLength", () => {
    const s = compileJsonSchema({ type: "string", minLength: 3, maxLength: 10 });
    expect(() => s.parse("hi")).toThrow();
    expect(s.parse("okay")).toBe("okay");
    expect(() => s.parse("a very long string here")).toThrow();
  });

  it("Test 3: number vs integer", () => {
    const num = compileJsonSchema({ type: "number" });
    expect(num.parse(3.14)).toBe(3.14);
    const intS = compileJsonSchema({ type: "integer" });
    expect(() => intS.parse(3.14)).toThrow();
    expect(intS.parse(3)).toBe(3);
  });

  it("Test 4: integer with minimum/maximum", () => {
    const s = compileJsonSchema({ type: "integer", minimum: 1, maximum: 100 });
    expect(() => s.parse(0)).toThrow();
    expect(s.parse(50)).toBe(50);
    expect(() => s.parse(101)).toThrow();
  });

  it("Test 5: boolean", () => {
    const s = compileJsonSchema({ type: "boolean" });
    expect(s.parse(true)).toBe(true);
    expect(() => s.parse("true")).toThrow();
  });

  it("Test 6: null", () => {
    const s = compileJsonSchema({ type: "null" });
    expect(s.parse(null)).toBe(null);
    expect(() => s.parse(undefined)).toThrow();
  });
});

describe("compileJsonSchema — arrays", () => {
  it("Test 7: array with items", () => {
    const s = compileJsonSchema({ type: "array", items: { type: "string" } });
    expect(s.parse(["a", "b"])).toEqual(["a", "b"]);
    expect(() => s.parse([1, 2])).toThrow();
  });

  it("Test 8: array minItems/maxItems", () => {
    const s = compileJsonSchema({
      type: "array",
      items: { type: "string" },
      minItems: 1,
      maxItems: 3,
    });
    expect(() => s.parse([])).toThrow();
    expect(s.parse(["a"])).toEqual(["a"]);
    expect(() => s.parse(["a", "b", "c", "d"])).toThrow();
  });
});

describe("compileJsonSchema — objects + HAND-06 .strict()", () => {
  it("Test 9: object required[]", () => {
    const s = compileJsonSchema({
      type: "object",
      required: ["x"],
      properties: { x: { type: "string" }, y: { type: "number" } },
    });
    expect(s.parse({ x: "hi" })).toEqual({ x: "hi" });
    expect(() => s.parse({ y: 1 })).toThrow();
    expect(s.parse({ x: "hi", y: 2 })).toEqual({ x: "hi", y: 2 });
  });

  it("Test 10: object rejects unknown keys (HAND-06 flagship)", () => {
    const s = compileJsonSchema({
      type: "object",
      required: [],
      properties: { x: { type: "string" } },
    });
    let caught: unknown;
    try {
      s.parse({ x: "a", unknown_key: "b" });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ZodError);
    const issues = (caught as ZodError).issues;
    const hasUnrecognized = issues.some(
      (i) =>
        i.code === "unrecognized_keys" ||
        i.message.toLowerCase().includes("unrecognized") ||
        i.message.toLowerCase().includes("unknown"),
    );
    expect(hasUnrecognized).toBe(true);
  });
});

describe("compileJsonSchema — enum + oneOf", () => {
  it("Test 11: enum accepts listed values, rejects others", () => {
    const s = compileJsonSchema({ enum: ["a", "b", "c"] });
    expect(s.parse("a")).toBe("a");
    expect(() => s.parse("d")).toThrow();
  });

  it("Test 12: oneOf union", () => {
    const s = compileJsonSchema({ oneOf: [{ type: "string" }, { type: "number" }] });
    expect(s.parse("hi")).toBe("hi");
    expect(s.parse(42)).toBe(42);
    expect(() => s.parse(true)).toThrow();
  });
});

describe("compileJsonSchema — nested + edge cases", () => {
  it("Test 13: nested object (recursive .strict)", () => {
    const s = compileJsonSchema({
      type: "object",
      required: ["inner"],
      properties: {
        inner: {
          type: "object",
          required: ["field"],
          properties: { field: { type: "string" } },
        },
      },
    });
    expect(s.parse({ inner: { field: "ok" } })).toEqual({ inner: { field: "ok" } });
    expect(() => s.parse({ inner: { field: 1 } })).toThrow();
    expect(() => s.parse({ inner: { field: "ok", extra: "x" } })).toThrow();
  });

  it("Test 14: unsupported `type` throws ValidationError('unknown_schema', ...)", () => {
    expect(() =>
      compileJsonSchema({ type: "nonexistent" } as unknown as JsonSchema),
    ).toThrow(ValidationError);
    try {
      compileJsonSchema({ type: "nonexistent" } as unknown as JsonSchema);
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
      const ve = err as ValidationError;
      expect(ve.reason).toBe("unknown_schema");
      expect(ve.details["path"]).toBe("#");
    }
  });

  it("Test 15: array without items throws ValidationError", () => {
    expect(() => compileJsonSchema({ type: "array" } as JsonSchema)).toThrow(
      ValidationError,
    );
    try {
      compileJsonSchema({ type: "array" } as JsonSchema);
    } catch (err) {
      const ve = err as ValidationError;
      expect(ve.reason).toBe("unknown_schema");
      expect(ve.message).toContain("missing 'items'");
    }
  });

  it("Test 16: single-element enum does not crash z.union", () => {
    const s = compileJsonSchema({ enum: ["only-one"] });
    expect(s.parse("only-one")).toBe("only-one");
    expect(() => s.parse("other")).toThrow();
  });

  it("Test 17: single-element oneOf collapses to inner schema", () => {
    const s = compileJsonSchema({ oneOf: [{ type: "string" }] });
    expect(s.parse("hi")).toBe("hi");
    expect(() => s.parse(42)).toThrow();
  });

  it("Test 18: realistic research.brief shape (end-to-end)", () => {
    const input: JsonSchema = {
      type: "object",
      required: ["topic"],
      properties: {
        topic: { type: "string", minLength: 3 },
        depth: { type: "string", enum: ["shallow", "medium", "deep"] },
      },
    };
    const s = compileJsonSchema(input);
    expect(s.parse({ topic: "AI safety", depth: "deep" })).toEqual({
      topic: "AI safety",
      depth: "deep",
    });
    expect(() => s.parse({ topic: "hi" })).toThrow(); // minLength
    expect(() => s.parse({ topic: "ok", extra: "x" })).toThrow(); // strict
    // missing required
    expect(() => s.parse({ depth: "deep" })).toThrow();
  });
});
