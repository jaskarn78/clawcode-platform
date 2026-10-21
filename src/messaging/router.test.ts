import { describe, it, expect } from "vitest";
import { buildPlatformRoutingTable, getAgentForChannel } from "./router.js";

describe("buildPlatformRoutingTable", () => {
  it("maps channels to agents and back", () => {
    const table = buildPlatformRoutingTable([
      { name: "alice", channels: ["C1", "C2"] },
      { name: "bob", channels: ["C3"] },
    ]);
    expect(table.channelToAgent.get("C1")).toBe("alice");
    expect(table.channelToAgent.get("C2")).toBe("alice");
    expect(table.channelToAgent.get("C3")).toBe("bob");
    expect(table.agentToChannels.get("alice")).toEqual(["C1", "C2"]);
  });

  it("skips agents with no channels", () => {
    const table = buildPlatformRoutingTable([
      { name: "alice", channels: [] },
      { name: "bob", channels: ["C3"] },
    ]);
    expect(table.agentToChannels.has("alice")).toBe(false);
    expect(table.channelToAgent.size).toBe(1);
  });

  it("throws when a channel is claimed by two agents", () => {
    expect(() =>
      buildPlatformRoutingTable([
        { name: "alice", channels: ["C1"] },
        { name: "bob", channels: ["C1"] },
      ]),
    ).toThrow(/Duplicate channel binding/);
  });

  it("tolerates the same agent listing a channel twice (idempotent)", () => {
    const table = buildPlatformRoutingTable([{ name: "alice", channels: ["C1", "C1"] }]);
    expect(table.channelToAgent.get("C1")).toBe("alice");
  });

  it("getAgentForChannel returns undefined for unbound channels", () => {
    const table = buildPlatformRoutingTable([{ name: "alice", channels: ["C1"] }]);
    expect(getAgentForChannel(table, "C9")).toBeUndefined();
  });
});
