/**
 * Phase 999.162 WS-1 — per-agent `toolSearch` reaches the spawned CLI as
 * ENABLE_TOOL_SEARCH, and only when set. The knob is deliberately narrow: no
 * generic env passthrough, so the credential strip cannot be bypassed.
 */
import { describe, expect, it } from "vitest";
import { buildCleanEnv } from "../session-adapter.js";
import { agentSchema } from "../../config/schema.js";

describe("buildCleanEnv — toolSearch", () => {
  it("omits ENABLE_TOOL_SEARCH when the agent has no toolSearch", () => {
    expect(buildCleanEnv().ENABLE_TOOL_SEARCH).toBeUndefined();
  });

  it("forwards the exact value when set", () => {
    expect(buildCleanEnv("true").ENABLE_TOOL_SEARCH).toBe("true");
    expect(buildCleanEnv("auto:5").ENABLE_TOOL_SEARCH).toBe("auto:5");
  });

  it("never lets toolSearch smuggle a credential", () => {
    expect(buildCleanEnv("true").ANTHROPIC_API_KEY).toBeUndefined();
  });
});

describe("agentSchema.toolSearch", () => {
  const base = { name: "a", workspace: "/tmp/a" };
  it("accepts true / false / auto / auto:N", () => {
    for (const v of ["true", "false", "auto", "auto:5", "auto:100"]) {
      expect(agentSchema.safeParse({ ...base, toolSearch: v }).success).toBe(true);
    }
  });
  it("rejects anything else — this is not an env passthrough", () => {
    for (const v of ["yes", "auto:", "auto:101", "ANTHROPIC_API_KEY=x", 1]) {
      expect(agentSchema.safeParse({ ...base, toolSearch: v }).success).toBe(false);
    }
  });
});
