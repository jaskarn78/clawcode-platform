import { afterEach, describe, expect, it, vi } from "vitest";
import type { PreToolUseHookInput } from "@anthropic-ai/claude-agent-sdk";
import {
  RESEARCH_DENY_NOT_USER_TURN,
  decideResearchLaunch,
  makeResearchLaunchGateHook,
} from "../research-launch-gate.js";
import {
  discordMessageIdOf,
  registerResearchTracker,
  resetResearchRegistryForTests,
  setLiveDiscordTurn,
  type ResearchTrackerPort,
} from "../research-registry.js";

const AGENT = "personal";
const ORIGIN = { turnId: "discord:000000000000000118", messageId: "000000000000000118", channelId: "000000000000000106" };

const agentCall = (subagentType: string, extra: Record<string, unknown> = {}) =>
  ({
    hook_event_name: "PreToolUse",
    tool_name: "Agent",
    tool_input: { subagent_type: subagentType, description: "d", prompt: "p" },
    session_id: "s",
    transcript_path: "/t",
    cwd: "/",
    ...extra,
  }) as unknown as PreToolUseHookInput;

function fakeTracker(occupied: number): ResearchTrackerPort & { approved: string[] } {
  const approved: string[] = [];
  return {
    approved,
    occupiedSlots: () => occupied + approved.length,
    occupiedSlotsFor: () => approved.length,
    noteApprovedLaunch: (id) => {
      approved.push(id);
    },
    sessionForKey: () => undefined,
  };
}

afterEach(() => resetResearchRegistryForTests());

describe("research launch gate (999.173)", () => {
  it("allows a researcher launch on a live Discord-user turn and records the approval", () => {
    setLiveDiscordTurn(AGENT, ORIGIN);
    const t = fakeTracker(0);
    registerResearchTracker(AGENT, t);
    expect(decideResearchLaunch(AGENT, 4, agentCall("researcher"), "toolu_1")).toEqual({ kind: "allow", origin: ORIGIN });
    expect(t.approved).toEqual(["toolu_1"]);
  });

  it.each([
    ["EVENT INGEST (collector). slug=chicago-marathon-2026 — 3 new email(s) saved under events/…"],
    ["EVENT CURATOR SWEEP (event_tick, daily inside the event window). slug=chicago-marathon-2026 — audit, chase, search"],
    ["EVENT DROP DUE (event_tick). slug=chicago-marathon-2026 drop=race-day"],
  ])("denies on a dossier wake (no live Discord turn): %s", async (_wakeText) => {
    // Wakes arrive through `clawcode send` → sendAndCollect: no live Discord turn is set.
    const hook = makeResearchLaunchGateHook(AGENT, 4);
    const out = await hook(agentCall("researcher"), "toolu_2", { signal: new AbortController().signal });
    expect(out).toMatchObject({
      hookSpecificOutput: { permissionDecision: "deny", permissionDecisionReason: RESEARCH_DENY_NOT_USER_TURN },
    });
    expect(RESEARCH_DENY_NOT_USER_TURN).toMatch(/inline/);
  });

  it("denies the launch that would exceed the concurrency cap (running + approved)", () => {
    setLiveDiscordTurn(AGENT, ORIGIN);
    const t = fakeTracker(3);
    registerResearchTracker(AGENT, t);
    expect(decideResearchLaunch(AGENT, 4, agentCall("researcher"), "toolu_a").kind).toBe("allow");
    const fifth = decideResearchLaunch(AGENT, 4, agentCall("researcher"), "toolu_b");
    expect(fifth.kind).toBe("deny");
    expect(t.approved).toEqual(["toolu_a"]);
  });

  it("has no opinion on other subagent types, other tools, or calls from inside a subagent", async () => {
    const hook = makeResearchLaunchGateHook(AGENT, 4);
    const sig = { signal: new AbortController().signal };
    expect(await hook(agentCall("general-purpose"), "t", sig)).toEqual({});
    expect(
      await hook({ ...agentCall("researcher"), tool_name: "Read" } as unknown as PreToolUseHookInput, "t", sig),
    ).toEqual({});
    expect(await hook(agentCall("researcher", { agent_id: "sub-1" }), "t", sig)).toEqual({});
  });

  it("also recognizes the legacy Task tool name", () => {
    const denied = decideResearchLaunch(AGENT, 4, { ...agentCall("researcher"), tool_name: "Task" } as unknown as PreToolUseHookInput, "t");
    expect(denied.kind).toBe("deny");
  });

  it("a throwing tracker never blocks the agent (fails to no-opinion)", async () => {
    setLiveDiscordTurn(AGENT, ORIGIN);
    registerResearchTracker(AGENT, {
      occupiedSlots: () => {
        throw new Error("boom");
      },
      occupiedSlotsFor: () => 0,
      noteApprovedLaunch: vi.fn(),
      sessionForKey: () => undefined,
    });
    const hook = makeResearchLaunchGateHook(AGENT, 4);
    expect(await hook(agentCall("researcher"), "t", { signal: new AbortController().signal })).toEqual({});
  });
});

describe("discordMessageIdOf (999.173)", () => {
  it("extracts the snowflake from Discord turn ids, including reply-action clicks", () => {
    expect(discordMessageIdOf("discord:000000000000000118")).toBe("000000000000000118");
    expect(discordMessageIdOf("discord:000000000000000118:ra-custom")).toBe("000000000000000118");
  });

  it("returns null for voice, cron, IPC and malformed ids", () => {
    for (const id of ["discord:voice-abc-123", "scheduler:x", "ipc:1", "", "discord:", null, undefined]) {
      expect(discordMessageIdOf(id as string)).toBeNull();
    }
  });
});
