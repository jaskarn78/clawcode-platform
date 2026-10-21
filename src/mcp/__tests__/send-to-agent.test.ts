import { describe, it, expect } from "vitest";
import { TOOL_DEFINITIONS } from "../server.js";

describe("send_to_agent tool definition", () => {
  it("is defined in TOOL_DEFINITIONS", () => {
    expect(TOOL_DEFINITIONS).toHaveProperty("send_to_agent");
  });

  it("has correct ipcMethod", () => {
    expect(TOOL_DEFINITIONS.send_to_agent.ipcMethod).toBe("send-to-agent");
  });

  it("has a description", () => {
    expect(TOOL_DEFINITIONS.send_to_agent.description).toBeTruthy();
  });
});
