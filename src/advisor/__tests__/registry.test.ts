import { describe, it, expect } from "vitest";
import {
  resolveBackend,
  BackendRegistry,
  resolveAdvisorModel,
  ADVISOR_MODEL_ALIASES,
} from "../registry.js";
import { resolveModelId } from "../../manager/model-resolver.js";
import type { BackendId, AdvisorBackend } from "../index.js";

describe("resolveBackend", () => {
  it("defaults to 'native' when neither agent nor defaults specify", () => {
    expect(resolveBackend("x", undefined, undefined)).toBe("native");
  });

  it("agent-level setting wins over defaults", () => {
    expect(
      resolveBackend(
        "x",
        { advisor: { backend: "fork" } },
        { advisor: { backend: "native" } },
      ),
    ).toBe("fork");
  });

  it("falls back to defaults when agent is unset", () => {
    expect(
      resolveBackend("x", undefined, { advisor: { backend: "native" } }),
    ).toBe("native");
  });

  it("defensively coerces 'portable-fork' → 'native' (not selectable in Phase 117)", () => {
    expect(
      resolveBackend(
        "x",
        { advisor: { backend: "portable-fork" as BackendId } },
        undefined,
      ),
    ).toBe("native");
  });

  it("returns 'fork' when only the agent block sets it", () => {
    expect(
      resolveBackend("x", { advisor: { backend: "fork" } }, undefined),
    ).toBe("fork");
  });
});

describe("resolveAdvisorModel", () => {
  it("maps 'opus' → 'claude-opus-5-5'", () => {
    expect(resolveAdvisorModel("opus")).toBe("claude-opus-5-5");
  });

  it("passes a fully-qualified opus id through unchanged (5.5, 5 and the 4.8 pin)", () => {
    expect(resolveAdvisorModel("claude-opus-5-5")).toBe("claude-opus-5-5");
    expect(resolveAdvisorModel("claude-opus-5")).toBe("claude-opus-5");
    expect(resolveAdvisorModel("claude-opus-4-8")).toBe("claude-opus-4-8");
  });

  it("passes unknown values through unchanged (no silent alias fallback)", () => {
    expect(resolveAdvisorModel("claude-sonnet-4-5")).toBe("claude-sonnet-4-5");
    expect(resolveAdvisorModel("gpt-5")).toBe("gpt-5");
  });

  it("ADVISOR_MODEL_ALIASES exposes the opus mapping", () => {
    expect(ADVISOR_MODEL_ALIASES.opus).toBe("claude-opus-5-5");
  });

  // Opus 5.5 (2026-09) — executor AND advisor opus aliases move together. The
  // native advisor requires advisor >= executor, so an Opus-5.5 executor with an
  // Opus-5 advisor is rejected; keeping the two `opus` pins equal is the
  // invariant that prevents that. (Supersedes the Opus-5 / 999.92 lockstep.)
  // This assertion is the lockstep LOCK: bumping one pin without the other
  // fails HERE rather than in prod.
  it("executor and advisor opus aliases both resolve to opus-5-5 (pairing-safe)", () => {
    expect(resolveModelId("opus")).toBe("claude-opus-5-5");
    expect(ADVISOR_MODEL_ALIASES.opus).toBe("claude-opus-5-5");
  });
});

describe("BackendRegistry", () => {
  function makeBackend(id: BackendId): AdvisorBackend {
    return {
      id,
      consult: async () => ({ answer: "" }),
    };
  }

  it("get(id) throws for an unregistered backend", () => {
    const reg = new BackendRegistry();
    expect(() => reg.get("native")).toThrow(/not registered/);
  });

  it("get(id) returns the registered backend", () => {
    const reg = new BackendRegistry();
    const b = makeBackend("fork");
    reg.register(b);
    expect(reg.get("fork")).toBe(b);
  });

  it("register replaces an existing registration for the same id", () => {
    const reg = new BackendRegistry();
    const first = makeBackend("native");
    const second = makeBackend("native");
    reg.register(first);
    reg.register(second);
    expect(reg.get("native")).toBe(second);
  });

  it("has(id) reflects registration state", () => {
    const reg = new BackendRegistry();
    expect(reg.has("native")).toBe(false);
    reg.register(makeBackend("native"));
    expect(reg.has("native")).toBe(true);
    expect(reg.has("fork")).toBe(false);
  });
});
