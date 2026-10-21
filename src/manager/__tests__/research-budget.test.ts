/**
 * 999.173 polish — researcher tool-call budgets (per researcher, per request),
 * the 80 % nudge, the hard stop, and the wall-clock cap (journal kept).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PreToolUseHookInput } from "@anthropic-ai/claude-agent-sdk";
import {
  BUDGET_NUDGE_TEXT,
  BUDGET_STOP_TEXT,
  decideResearcherBudget,
  makeResearchLaunchGateHook,
} from "../research-launch-gate.js";
import { registerResearchTracker, resetResearchRegistryForTests, setLiveDiscordTurn } from "../research-registry.js";
import { ResearchTracker } from "../research-tracker.js";
import { journalDirName } from "../research-journal.js";
import { researchBudgetStatusLine } from "../research-subagents.js";

const AGENT = "fin-client";
const MSG = "000000000000000118";
const ORIGIN = { turnId: `discord:${MSG}`, messageId: MSG, channelId: "chan" };
const started = (taskId: string, toolUseId: string) => ({
  type: "system",
  subtype: "task_started",
  task_id: taskId,
  tool_use_id: toolUseId,
  description: `Screen ${taskId}`,
  subagent_type: "researcher",
});
const sig = { signal: new AbortController().signal };
const call = (taskId: string, tool = "mcp__finnhub__quote") =>
  ({
    hook_event_name: "PreToolUse",
    tool_name: tool,
    tool_input: { symbol: "NVDA" },
    tool_use_id: "tu",
    session_id: "s",
    transcript_path: "/t",
    cwd: "/",
    agent_id: taskId,
    agent_type: "researcher",
  }) as unknown as PreToolUseHookInput;

function setup(extra: Partial<ConstructorParameters<typeof ResearchTracker>[0]> = {}) {
  setLiveDiscordTurn(AGENT, ORIGIN);
  const stopTask = vi.fn(() => Promise.resolve());
  const t = new ResearchTracker({
    agentName: AGENT,
    maxConcurrent: 4,
    holdTimeoutMs: 60 * 60_000,
    stopTask,
    deliver: () => undefined,
    log: { info: () => undefined, warn: () => undefined },
    ...extra,
  });
  registerResearchTracker(AGENT, t);
  return { t, stopTask };
}

afterEach(() => {
  resetResearchRegistryForTests();
  vi.useRealTimers();
});

describe("researcher tool-call budgets (999.173 polish)", () => {
  it("per researcher: allow → nudge exactly at 80 % → allow → deny at 100 %", () => {
    const { t } = setup();
    t.observe(started("a1", "t1"));
    const budgets = { maxToolCalls: 10, maxSessionToolCalls: 100 };
    const kinds = Array.from({ length: 12 }, () => decideResearcherBudget(AGENT, "a1", "mcp__finnhub__quote", budgets).kind);
    expect(kinds).toEqual(["allow", "allow", "allow", "allow", "allow", "allow", "allow", "nudge", "allow", "allow", "deny", "deny"]);
    expect(t.toolCallsFor("a1")).toEqual({ task: 10, session: 10, known: true });
  });

  it("per request: the session total across researchers is budgeted too", () => {
    const { t } = setup();
    t.observe(started("a1", "t1"));
    t.observe(started("a2", "t2"));
    const budgets = { maxToolCalls: 100, maxSessionToolCalls: 5 };
    const seq = ["a1", "a2", "a1", "a2", "a1", "a2"].map((id) => decideResearcherBudget(AGENT, id, "WebFetch", budgets).kind);
    expect(seq).toEqual(["allow", "allow", "allow", "nudge", "allow", "deny"]);
    expect(t.toolCallsFor("a1").session).toBe(5);
  });

  it("ToolSearch and unknown tasks are not budgeted", () => {
    const { t } = setup();
    t.observe(started("a1", "t1"));
    const budgets = { maxToolCalls: 1, maxSessionToolCalls: 1 };
    expect(decideResearcherBudget(AGENT, "a1", "ToolSearch", budgets).kind).toBe("allow");
    expect(decideResearcherBudget(AGENT, "not-a-researcher", "Read", budgets).kind).toBe("allow");
    expect(t.toolCallsFor("a1").task).toBe(0);
  });

  it("through the hook: the nudge is additionalContext, the stop a deny with reason; the card says 'budget reached'", async () => {
    const snaps: { notes?: readonly string[] }[] = [];
    const { t } = setup({
      cardPort: () => ({ post: async (_c, s) => (snaps.push(s), "card"), edit: async (_c, _m, s) => void snaps.push(s) }),
      repaintMs: 5,
    });
    t.observe(started("a1", "t1"));
    const hook = makeResearchLaunchGateHook(AGENT, 4, { allowBash: false, budgets: { maxToolCalls: 5, maxSessionToolCalls: 50 } });
    const outs = [];
    for (let i = 0; i < 6; i++) outs.push(await hook(call("a1"), "tu", sig));
    expect(outs[3]).toEqual({ hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: BUDGET_NUDGE_TEXT } });
    expect(outs[5]).toEqual({
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: BUDGET_STOP_TEXT },
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(snaps[snaps.length - 1]!.notes).toContain("budget reached");
  });

  it("the side-effect policy still denies first (a denied call is not counted)", async () => {
    const { t } = setup();
    t.observe(started("a1", "t1"));
    const hook = makeResearchLaunchGateHook(AGENT, 4, { allowBash: false, budgets: { maxToolCalls: 5, maxSessionToolCalls: 50 } });
    const out = await hook(call("a1", "mcp__google-workspace__send_gmail_message"), "tu", sig);
    expect(out).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } });
    expect(t.toolCallsFor("a1").task).toBe(0);
  });

  it("status line shows the budgets", () => {
    expect(researchBudgetStatusLine(undefined)).toBe(
      "Budgets: 60 tool calls per researcher, 180 per request, 15 min per researcher (nudge at 80%).",
    );
    expect(researchBudgetStatusLine({ maxToolCalls: 30, maxMinutes: 5 })).toContain("30 tool calls per researcher, 180 per request, 5 min");
  });
});

describe("researcher wall-clock cap (999.173 polish)", () => {
  it("stops a researcher past maxMinutes through the stop path; the journal keeps its work", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const root = mkdtempSync(join(tmpdir(), "rb-"));
    const { t, stopTask } = setup({ maxResearcherMs: 15 * 60_000, journalRoot: root });
    t.observe(started("a1", "toolu_A"));
    t.observeChild("toolu_A", {
      type: "assistant",
      parent_tool_use_id: "toolu_A",
      message: { content: [{ type: "text", text: "FINDING: CRWD margin 78% — 10-Q" }] },
    });
    await vi.advanceTimersByTimeAsync(15 * 60_000 + 10);
    expect(stopTask).toHaveBeenCalledWith("a1");
    expect(t.occupiedSlots()).toBe(0);
    const session = [...(t as unknown as { active: Map<string, { journal: { flushed(): Promise<void> } }> }).active.values()][0]!;
    await session.journal.flushed();
    const dir = join(root, journalDirName(Date.now(), MSG));
    const file = readFileSync(join(dir, readdirSync(dir).find((f) => f.startsWith("a1-"))!), "utf8");
    expect(file).toContain("- CRWD margin 78% — 10-Q");
    expect(file).toContain("Ended: stopped (timed out)");
  });

  it("a researcher that finishes in time is never stopped", async () => {
    vi.useFakeTimers();
    const { t, stopTask } = setup({ maxResearcherMs: 60_000 });
    t.observe(started("a1", "t1"));
    t.observe({ type: "system", subtype: "task_notification", task_id: "a1", status: "completed", summary: "s", output_file: "/o" });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(stopTask).not.toHaveBeenCalled();
  });
});
