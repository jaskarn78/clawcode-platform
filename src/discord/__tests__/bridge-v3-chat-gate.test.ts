/**
 * Phase 140 Model B — v3 chat-routing gate (silent-path-bifurcation guard).
 *
 * `resolveV3ChatBridge` decides whether a Discord message routes over the v3
 * ClawCode channel (push + awaitReply) or the v2 SDK dispatch. Both branches are
 * pinned: a v3 agent with a live bridge → channel; a v3 agent WITHOUT a bridge
 * (cold / not wired) → v2 fallback; a v2 agent → v2 always.
 */
import { describe, it, expect, vi } from "vitest";
import { resolveV3ChatBridge, type ChatChannelBridge } from "../bridge.js";

const fakeBridge: ChatChannelBridge = {
  push: vi.fn(),
  awaitReply: vi.fn(async () => ({ result: "ok" })),
};

describe("resolveV3ChatBridge (Phase 140 Model B)", () => {
  it("v3 backend + live bridge → returns the bridge (channel path)", () => {
    const getBridge = vi.fn(() => fakeBridge);
    const b = resolveV3ChatBridge("claude-code-interactive", getBridge, "agent-x");
    expect(b).toBe(fakeBridge);
    expect(getBridge).toHaveBeenCalledWith("agent-x");
  });

  it("v3 backend but NO live bridge → undefined (v2 fallback)", () => {
    const getBridge = vi.fn(() => undefined);
    expect(resolveV3ChatBridge("claude-code-interactive", getBridge, "agent-x")).toBeUndefined();
  });

  it("v2 backend → undefined even if a bridge exists for some agent (v2 path)", () => {
    const getBridge = vi.fn(() => fakeBridge);
    expect(resolveV3ChatBridge("anthropic-agent-sdk", getBridge, "agent-x")).toBeUndefined();
    // Gated on backend BEFORE consulting getBridge — never misroutes a v2 agent.
    expect(getBridge).not.toHaveBeenCalled();
  });

  it("undefined backend / no getBridge → undefined", () => {
    expect(resolveV3ChatBridge(undefined, vi.fn(() => fakeBridge), "a")).toBeUndefined();
    expect(resolveV3ChatBridge("claude-code-interactive", undefined, "a")).toBeUndefined();
  });
});
