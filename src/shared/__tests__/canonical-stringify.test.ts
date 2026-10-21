import { describe, it, expect } from "vitest";
import { canonicalStringify } from "../canonical-stringify.js";

describe("canonicalStringify (Phase 55)", () => {
  it("produces identical output regardless of object key-insertion order", () => {
    // Object property iteration preserves insertion order in modern JS, so
    // {b:1,a:2} and {a:2,b:1} serialize differently under JSON.stringify —
    // canonicalStringify must normalize that.
    const a = canonicalStringify({ b: 1, a: 2 });
    const b = canonicalStringify({ a: 2, b: 1 });
    expect(a).toBe(b);
    expect(a).toBe('{"a":2,"b":1}');
  });

  it("sorts keys recursively in nested objects", () => {
    const a = canonicalStringify({ outer: { z: 1, a: 2 } });
    const b = canonicalStringify({ outer: { a: 2, z: 1 } });
    expect(a).toBe(b);
    expect(a).toBe('{"outer":{"a":2,"z":1}}');
  });

  it("preserves array order (arrays are order-significant)", () => {
    // Arrays must NOT be sorted — element order is part of the data.
    const ascending = canonicalStringify([1, 2, 3]);
    const descending = canonicalStringify([3, 2, 1]);
    expect(ascending).toBe("[1,2,3]");
    expect(descending).toBe("[3,2,1]");
    expect(ascending).not.toBe(descending);
  });

  it("treats undefined as null for deterministic hashing", () => {
    // undefined is not a valid JSON value — canonicalStringify must coerce
    // to null so cache keys are stable across arg-presence variations.
    expect(canonicalStringify(undefined)).toBe("null");
    expect(canonicalStringify(null)).toBe("null");
    expect(canonicalStringify(undefined)).toBe(canonicalStringify(null));
  });

  it("handles primitive values (string / number / boolean) as JSON scalars", () => {
    expect(canonicalStringify("x")).toBe('"x"');
    expect(canonicalStringify(42)).toBe("42");
    expect(canonicalStringify(true)).toBe("true");
    expect(canonicalStringify(false)).toBe("false");
    expect(canonicalStringify(0)).toBe("0");
    expect(canonicalStringify("")).toBe('""');
  });

  it("sorts keys inside objects nested in arrays", () => {
    // [{b:1,a:2}] and [{a:2,b:1}] must hash identically — the array position
    // is preserved, but inner object keys are recursively sorted.
    const a = canonicalStringify([{ b: 1, a: 2 }]);
    const b = canonicalStringify([{ a: 2, b: 1 }]);
    expect(a).toBe(b);
    expect(a).toBe('[{"a":2,"b":1}]');
  });

  it("serializes NaN as null (matches JSON.stringify behavior)", () => {
    // NaN is not a valid JSON value. JSON.stringify(NaN) returns "null" —
    // canonicalStringify must behave the same so callers never see "NaN"
    // in a cache key (which would be an invalid round-trip).
    expect(canonicalStringify(Number.NaN)).toBe("null");
    // Nested NaN too.
    expect(canonicalStringify({ x: Number.NaN })).toBe('{"x":null}');
    expect(canonicalStringify([Number.NaN, 1])).toBe("[null,1]");
  });

  it("handles deeply nested mixed structures deterministically", () => {
    // Real-world cache key scenario: memory_lookup args like
    // { query: "foo", filters: { tier: "hot", tags: ["a","b"] }, limit: 10 }.
    const a = canonicalStringify({
      query: "foo",
      filters: { tier: "hot", tags: ["a", "b"] },
      limit: 10,
    });
    const b = canonicalStringify({
      limit: 10,
      filters: { tags: ["a", "b"], tier: "hot" },
      query: "foo",
    });
    expect(a).toBe(b);
  });
});
