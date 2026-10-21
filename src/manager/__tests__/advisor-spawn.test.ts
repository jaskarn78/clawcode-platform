import { describe, expect, it } from "vitest";
import { ADVISOR_TOOL_ENV, advisorSdkSettings, withAdvisorToolEnv } from "../advisor-spawn.js";

describe("advisor-spawn — native advisor SDK fields (2026-08-28)", () => {
  it("emits settings.advisorModel only when a validated model is present", () => {
    expect(advisorSdkSettings("claude-fable-5")).toEqual({ settings: { advisorModel: "claude-fable-5" } });
    expect(advisorSdkSettings(undefined)).toEqual({});
    expect(advisorSdkSettings("")).toEqual({});
    // Never the inert top-level field.
    expect("advisorModel" in advisorSdkSettings("claude-fable-5")).toBe(false);
  });
  it("sets the experimental flag for native agents and STRIPS an inherited one otherwise", () => {
    const inherited = { PATH: "/bin", [ADVISOR_TOOL_ENV]: "1" };
    expect(withAdvisorToolEnv(inherited, undefined)).toEqual({ PATH: "/bin" });
    expect(withAdvisorToolEnv({ PATH: "/bin" }, "claude-fable-5")).toEqual({ PATH: "/bin", [ADVISOR_TOOL_ENV]: "1" });
    // Pure: the input is untouched.
    expect(inherited[ADVISOR_TOOL_ENV]).toBe("1");
  });
});
