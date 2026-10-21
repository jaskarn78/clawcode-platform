import { afterEach, describe, expect, it } from "vitest";
import type { PreToolUseHookInput } from "@anthropic-ai/claude-agent-sdk";
import {
  RESEARCH_ROUTE_BLOCK,
  RESEARCH_WORKFLOW_DENY,
  START_WORKFLOW_TOOL,
  isResearchIntent,
  isResearchOnlyWorkflow,
  userTextOf,
  withResearchRoute,
} from "../research-route.js";
import { WORKFLOW_TOOL_DISALLOW } from "../workflow-orchestrator.js";
import { decideResearchWorkflow, makeResearchLaunchGateHook } from "../research-launch-gate.js";
import { resetResearchRegistryForTests, setLiveDiscordTurn } from "../research-registry.js";

afterEach(() => resetResearchRegistryForTests());

describe("isResearchIntent", () => {
  // Shapes from Client A's real requests (08-26 → 09-26), names removed.
  it.each([
    "Is $260 for two keys a good price? Can you do a deep dive and tell me?",
    "220 seems way too low, are you sure? deep dive that",
    "Is there a case with a small profile that holds 2 cards? Deep dive and find the best",
    "Can you do a deep-dive on how I claim the warranty",
    "Can you run a workflow on this?",
    "can you look into the entity questions",
    "I want an in-depth answer on the tranche schedule",
    "can you find the best prices for me online from reputable websites?",
    "start another workflow — look for the best 5 stocks to buy as of today",
    "what are people saying about their pre-IPO investments?",
    "research the licensing market for these patents",
    "check reddit for complaints about this seller",
  ])("routes: %s", (msg) => {
    expect(isResearchIntent(msg)).toBe(true);
  });

  it.each([
    "thanks",
    "Is this fixed?",
    "send the pdf to him tomorrow morning",
    "What was my ftp before and after?",
    "ok let's switch gears",
    "the researcher said it was fine", // "researcher" is not "research"
    // False positives measured on Client A's real turns with the first draft:
    "Is there a workflow running. Right now?",
    "Let's move forward in this as soon as the workflow is complete",
    "I want to write something that I'm researching his existing investments and I'll send him an update",
    "Yeah text message seems the best way to go",
    "is not promising research for longevity",
  ])("does not route: %s", (msg) => {
    expect(isResearchIntent(msg)).toBe(false);
  });
});

describe("userTextOf", () => {
  const bridged = [
    "Quick-lane recap: you asked whether the workflow finished; I said yes.",
    "",
    '<channel source="discord" chat_id="1" message_id="2" user="clientAhin" ts="Sat 26 Sep 12:00">',
    "thanks, send it tomorrow",
    "</channel>",
    "",
    "[Replying to: \"I can run a deep dive on this if you want\"]",
  ].join("\n");

  it("reads only what the user typed inside the channel tags", () => {
    expect(userTextOf(bridged).trim()).toBe("thanks, send it tomorrow");
    expect(isResearchIntent(bridged)).toBe(false);
  });

  it("routes when the typed text asks, whatever surrounds it", () => {
    expect(isResearchIntent(bridged.replace("thanks, send it tomorrow", "ok do a deep dive on the fund fees"))).toBe(true);
  });

  it("joins several channel blocks (combined messages) and falls back to the whole message without tags", () => {
    expect(userTextOf('<channel user="a">one</channel>\n<channel user="a">two</channel>')).toBe("one\ntwo");
    expect(userTextOf("plain text")).toBe("plain text");
  });
});

describe("withResearchRoute", () => {
  it("prepends the block when enabled and the raw message asks for research", () => {
    expect(withResearchRoute("deep dive this", "<memory-context/>deep dive this", true)).toBe(
      RESEARCH_ROUTE_BLOCK + "<memory-context/>deep dive this",
    );
  });
  it("detects on the RAW message, not on the augmented one", () => {
    expect(withResearchRoute("thanks", "<memory-context>deep dive notes</memory-context>thanks", true)).toBe(
      "<memory-context>deep dive notes</memory-context>thanks",
    );
  });
  it("is a no-op when disabled", () => {
    expect(withResearchRoute("deep dive this", "deep dive this", false)).toBe("deep dive this");
  });
  it("names researchers and never a model", () => {
    expect(RESEARCH_ROUTE_BLOCK).toContain('subagent_type "researcher"');
    expect(RESEARCH_ROUTE_BLOCK).not.toMatch(/\b(opus|sonnet|haiku|fable)\b/i);
  });
});

const steps = (ids: string[], prompt = "Research this and report findings with sources.") =>
  ({ steps: ids.map((stepId) => ({ stepId, prompt })) });

describe("isResearchOnlyWorkflow", () => {
  // Step ids from real Client A-agent workflow records.
  it.each([
    [["federal-tax-law", "california-tax", "solo401k-and-payroll", "arithmetic-audit", "consistency-and-compliance", "final-report"]],
    [["overreaction-screen", "hidden-catalyst-screen", "sentiment-screen", "quality-value-screen", "verify-and-rank"]],
    [["hightower-adv-fees", "commissions-conflicts", "fee-benchmarks", "final-report"]],
    [["remote-flatfee-routes", "ct-ma-boutiques", "rates-benchmarks", "ct-scope-and-screening", "final-report"]],
  ])("research-only: %j", (ids) => {
    expect(isResearchOnlyWorkflow(steps(ids))).toBe(true);
  });

  it.each([
    [["fowler-clovis", "sanpablo-fresno", "boyd-fresno", "build-pdf", "final-report"]],
    [["weekly-planner", "dashboard", "ramp-test-hook", "final-report"]],
    [["morning-post", "eod-cv2", "verify-figures", "final-report"]],
  ])("mixed (makes something): %j", (ids) => {
    expect(isResearchOnlyWorkflow(steps(ids))).toBe(false);
  });

  it("reads waves too", () => {
    expect(isResearchOnlyWorkflow({ waves: [[{ stepId: "a-prices", prompt: "find prices" }], [{ stepId: "rank", prompt: "rank them" }]] })).toBe(true);
    expect(isResearchOnlyWorkflow({ waves: [[{ stepId: "a", prompt: "find" }], [{ stepId: "b", prompt: "Then build a PDF of it" }]] })).toBe(false);
  });

  it("research prompts that merely mention pages, charts or fee schedules stay research-only", () => {
    expect(
      isResearchOnlyWorkflow(steps(["fees"], "Read each fund's product page, the fee schedule and the performance chart; cite sources.")),
    ).toBe(true);
  });

  it("templates, empty and malformed specs are never research-only", () => {
    expect(isResearchOnlyWorkflow({ template: "stock-screen", params: {} })).toBe(false);
    expect(isResearchOnlyWorkflow({ steps: [] })).toBe(false);
    expect(isResearchOnlyWorkflow(null)).toBe(false);
    expect(isResearchOnlyWorkflow("steps")).toBe(false);
  });
});

const AGENT = "fin-client";
const ORIGIN = { turnId: "discord:000000000000000118", messageId: "000000000000000118", channelId: "000000000000000106" };
const workflowCall = (tool_input: unknown, extra: Record<string, unknown> = {}) =>
  ({
    hook_event_name: "PreToolUse",
    tool_name: START_WORKFLOW_TOOL,
    tool_input,
    session_id: "s",
    transcript_path: "/t",
    cwd: "/",
    ...extra,
  }) as unknown as PreToolUseHookInput;
const RESEARCH_SPEC = steps(["fee-benchmarks", "commissions-conflicts"]);

describe("research-only workflow guard", () => {
  it("the tool name matches the orchestrator's", () => {
    expect(START_WORKFLOW_TOOL).toBe(WORKFLOW_TOOL_DISALLOW);
  });

  it("denies a research-only workflow from a live Discord turn when autoRoute is on", () => {
    setLiveDiscordTurn(AGENT, ORIGIN);
    expect(decideResearchWorkflow(AGENT, workflowCall(RESEARCH_SPEC), true)).toEqual({ kind: "deny", reason: RESEARCH_WORKFLOW_DENY });
  });

  it("leaves it alone when autoRoute is off, off-turn, mixed, a template, or called by a subagent", () => {
    setLiveDiscordTurn(AGENT, ORIGIN);
    expect(decideResearchWorkflow(AGENT, workflowCall(RESEARCH_SPEC), false).kind).toBe("not-applicable");
    expect(decideResearchWorkflow(AGENT, workflowCall(steps(["research", "build-pdf"])), true).kind).toBe("not-applicable");
    expect(decideResearchWorkflow(AGENT, workflowCall({ template: "screen" }), true).kind).toBe("not-applicable");
    expect(decideResearchWorkflow(AGENT, workflowCall(RESEARCH_SPEC, { agent_id: "t1", agent_type: "researcher" }), true).kind).toBe("not-applicable");
    resetResearchRegistryForTests();
    expect(decideResearchWorkflow(AGENT, workflowCall(RESEARCH_SPEC), true).kind).toBe("not-applicable");
  });

  it("the hook returns a PreToolUse deny with the pointer text", async () => {
    setLiveDiscordTurn(AGENT, ORIGIN);
    const hook = makeResearchLaunchGateHook(AGENT, 4, { allowBash: false, autoRoute: true });
    const out = await hook(workflowCall(RESEARCH_SPEC), "tu1", { signal: new AbortController().signal });
    expect(out).toEqual({
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: RESEARCH_WORKFLOW_DENY },
    });
  });

  it("the hook has no opinion on start_workflow when autoRoute is off", async () => {
    setLiveDiscordTurn(AGENT, ORIGIN);
    const hook = makeResearchLaunchGateHook(AGENT, 4, { allowBash: false });
    expect(await hook(workflowCall(RESEARCH_SPEC), "tu1", { signal: new AbortController().signal })).toEqual({});
  });
});
