/**
 * 999.173 polish — research model: default opus, config override, runtime
 * override applied at launch through the gate's `updatedInput`, reset, and
 * the /clawcode-ux status text.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PreToolUseHookInput } from "@anthropic-ai/claude-agent-sdk";
import { makeResearchLaunchGateHook, researcherLaunchModel } from "../research-launch-gate.js";
import { resetResearchRegistryForTests, setLiveDiscordTurn } from "../research-registry.js";
import { modelFamilyOf } from "../research-subagents.js";
import {
  readAllUxFeatureState,
  resetUxFeatureOverridesForTests,
  resolveResearchModel,
  setUxFeatureOverride,
} from "../ux-feature-state-store.js";
import { handleSetUxFeature } from "../ux-feature-ipc.js";
import { handleUxSlash } from "../../discord/ux-slash.js";

const AGENT = "fin-client";
const ORIGIN = { turnId: "discord:000000000000000118", messageId: "000000000000000118", channelId: "c" };
const sig = { signal: new AbortController().signal };
const launch = (extra: Record<string, unknown> = {}) =>
  ({
    hook_event_name: "PreToolUse",
    tool_name: "Agent",
    tool_input: { subagent_type: "researcher", description: "d", prompt: "p", ...extra },
    tool_use_id: "tu",
    session_id: "s",
    transcript_path: "/t",
    cwd: "/",
  }) as unknown as PreToolUseHookInput;

afterEach(() => {
  resetUxFeatureOverridesForTests();
  resetResearchRegistryForTests();
});

function updatedModel(out: unknown): unknown {
  return (out as { hookSpecificOutput?: { updatedInput?: { model?: unknown } } }).hookSpecificOutput?.updatedInput?.model;
}

describe("research model resolution (999.173 polish)", () => {
  it("defaults to opus, then config, then the runtime override", () => {
    expect(resolveResearchModel(AGENT, undefined)).toEqual({ model: "opus", source: "default" });
    expect(resolveResearchModel(AGENT, "sonnet")).toEqual({ model: "sonnet", source: "config" });
    setUxFeatureOverride(AGENT, { researchModel: "haiku" });
    expect(resolveResearchModel(AGENT, "sonnet")).toEqual({ model: "haiku", source: "override" });
  });

  it("inherit maps to the agent's own model family (or leaves the input without a model)", () => {
    setUxFeatureOverride(AGENT, { researchModel: "inherit" });
    expect(researcherLaunchModel(AGENT, { parentModelFamily: "fable" })).toBe("fable");
    expect(researcherLaunchModel(AGENT, {})).toBeUndefined();
    expect(modelFamilyOf("opus-4-8")).toBe("opus");
    expect(modelFamilyOf("sonnet@latest")).toBe("sonnet");
    expect(modelFamilyOf("gpt-5")).toBeUndefined();
  });
});

describe("launch gate pins the researcher model at launch (999.173 polish)", () => {
  it("default: allow + updatedInput model opus, other input fields kept", async () => {
    setLiveDiscordTurn(AGENT, ORIGIN);
    const out = await makeResearchLaunchGateHook(AGENT, 4)(launch(), "tu", sig);
    expect(out).toMatchObject({
      hookSpecificOutput: {
        permissionDecision: "allow",
        updatedInput: { subagent_type: "researcher", description: "d", prompt: "p", model: "opus" },
      },
    });
  });

  it("config override (research.model)", async () => {
    setLiveDiscordTurn(AGENT, ORIGIN);
    const out = await makeResearchLaunchGateHook(AGENT, 4, { allowBash: false, configModel: "sonnet" })(launch(), "tu", sig);
    expect(updatedModel(out)).toBe("sonnet");
  });

  it("a runtime swap applies to the NEXT launch without rebuilding the hook; reset goes back", async () => {
    setLiveDiscordTurn(AGENT, ORIGIN);
    const hook = makeResearchLaunchGateHook(AGENT, 4, { allowBash: false, configModel: "sonnet" });
    expect(updatedModel(await hook(launch(), "t1", sig))).toBe("sonnet");
    setUxFeatureOverride(AGENT, { researchModel: "haiku" });
    expect(updatedModel(await hook(launch(), "t2", sig))).toBe("haiku");
    setUxFeatureOverride(AGENT, null);
    expect(updatedModel(await hook(launch(), "t3", sig))).toBe("sonnet");
  });

  it("the parent's own model choice never overrides the research model", async () => {
    setLiveDiscordTurn(AGENT, ORIGIN);
    const out = await makeResearchLaunchGateHook(AGENT, 4)(launch({ model: "haiku" }), "tu", sig);
    expect(updatedModel(out)).toBe("opus");
  });

  it("inherit with an unknown family strips the input model (the definition applies)", async () => {
    setLiveDiscordTurn(AGENT, ORIGIN);
    setUxFeatureOverride(AGENT, { researchModel: "inherit" });
    const out = await makeResearchLaunchGateHook(AGENT, 4)(launch({ model: "haiku" }), "tu", sig);
    const input = (out as { hookSpecificOutput: { updatedInput: Record<string, unknown> } }).hookSpecificOutput.updatedInput;
    expect("model" in input).toBe(false);
  });
});

describe("/clawcode-ux research model (999.173 polish)", () => {
  function deps(params: Record<string, unknown>, filePath: string, configModel?: "sonnet") {
    return {
      params: { agent: AGENT, feature: "research", ...params },
      getConfigFeatures: () => ({ researchSubagents: true }),
      isConfiguredAgent: () => true,
      getConfigResearchModel: () => configModel,
      filePath,
    };
  }

  it("set, status and reset: persisted, applied in memory, reported with its source", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "ux-rm-")), "state.json");
    const status0 = await handleSetUxFeature(deps({ state: "status" }, file));
    expect(status0.researchModel).toEqual({ model: "opus", source: "default", applies: "next-launch" });

    const set = await handleSetUxFeature(deps({ state: "status", model: "sonnet" }, file));
    expect(set.researchModel).toMatchObject({ model: "sonnet", source: "override" });
    expect((await readAllUxFeatureState(file))[AGENT]).toEqual({ researchModel: "sonnet" });
    expect(resolveResearchModel(AGENT, undefined).model).toBe("sonnet");

    const reset = await handleSetUxFeature(deps({ model: "reset" }, file, "sonnet"));
    expect(reset.researchModel).toMatchObject({ model: "sonnet", source: "config" });
    expect(JSON.parse(readFileSync(file, "utf8")).agents[AGENT]).toBeUndefined();
  });

  it("rejects an unknown model and model on a non-research feature, before any write", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "ux-rm-")), "state.json");
    await expect(handleSetUxFeature(deps({ model: "gpt-5" }, file))).rejects.toThrow(/invalid model/);
    await expect(
      handleSetUxFeature({ ...deps({ model: "sonnet" }, file), params: { agent: AGENT, feature: "thinking", model: "sonnet" } }),
    ).rejects.toThrow(/only to feature research/);
    expect(await readAllUxFeatureState(file)).toEqual({});
  });

  it("slash reply shows the effective research model and its source, plain text", async () => {
    const reply = await handleUxSlash({
      agent: AGENT,
      feature: "research",
      state: "status",
      model: "sonnet",
      sendIpc: async (_m, params) => ({
        agent: AGENT,
        feature: "researchSubagents",
        state: "status",
        enabled: true,
        source: "config",
        applies: "restart",
        researchModel: { model: params.model, source: "override", applies: "next-launch" },
      }),
    });
    expect(reply).toContain("Research model: sonnet (set with /clawcode-ux). Applies from the next research launch, no restart.");
    const status = await handleUxSlash({
      agent: AGENT,
      feature: "research",
      sendIpc: async () => ({
        agent: AGENT,
        feature: "researchSubagents",
        state: "status",
        enabled: true,
        source: "config",
        applies: "restart",
        researchModel: { model: "opus", source: "default", applies: "next-launch" },
      }),
    });
    expect(status).toContain("Research model: opus (default).");
  });
});
