import { describe, it, expect } from "vitest";
import { makeImageError, toImageToolError } from "../errors.js";

describe("makeImageError", () => {
  it("E1: returns a frozen ImageError with all fields populated", () => {
    const err = makeImageError("rate_limit", "msg", {
      backend: "openai",
      status: 429,
      details: { retryAfter: 30 },
    });
    expect(err.type).toBe("rate_limit");
    expect(err.message).toBe("msg");
    expect(err.backend).toBe("openai");
    expect(err.status).toBe(429);
    expect(err.details).toEqual({ retryAfter: 30 });
    expect(Object.isFrozen(err)).toBe(true);
  });

  it("makeImageError without extras returns a minimal frozen error", () => {
    const err = makeImageError("internal", "boom");
    expect(err).toEqual({ type: "internal", message: "boom" });
    expect(Object.isFrozen(err)).toBe(true);
  });
});

describe("toImageToolError", () => {
  it("E2: TypeError matching /fetch/i → network error with message preserved", () => {
    const err = toImageToolError(new TypeError("fetch failed"), "internal");
    expect(err.type).toBe("network");
    expect(err.message).toBe("fetch failed");
  });

  it("E3: AbortError → fallback type with timeout message", () => {
    const abort = new Error("aborted");
    abort.name = "AbortError";
    const err = toImageToolError(abort, "network", "openai");
    expect(err.type).toBe("network");
    expect(err.message).toMatch(/timeout|aborted/i);
    expect(err.backend).toBe("openai");
  });

  it("non-Error value → fallback type with stringified message", () => {
    const err = toImageToolError("plain string err", "internal");
    expect(err.type).toBe("internal");
    expect(err.message).toBe("plain string err");
  });

  it("unknown thrown value → fallback type with 'unknown error'", () => {
    const err = toImageToolError(42, "internal");
    expect(err.type).toBe("internal");
    expect(err.message).toBe("unknown error");
  });

  it("regular Error with non-fetch message → fallback type with message preserved", () => {
    const err = toImageToolError(new Error("boom"), "backend_unavailable", "fal");
    expect(err.type).toBe("backend_unavailable");
    expect(err.message).toBe("boom");
    expect(err.backend).toBe("fal");
  });
});
