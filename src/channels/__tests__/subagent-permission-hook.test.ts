import { describe, it, expect } from "vitest";

import {
  decideSubagentTool,
  subagentPermissionHook,
} from "../subagent-permission-hook.js";
import type {
  PreToolUseHookInput,
  HookInput,
} from "@anthropic-ai/claude-agent-sdk";

// ---------------------------------------------------------------------------
// Synthetic PreToolUse input builder. No live model call — every test feeds the
// hook hand-built inputs (the production gate that the pinned binary actually
// propagates `agent_id` for in-process subagents is the operator-run probe at
// scripts/145-subagent-hook-fires-probe.ts, NOT a vitest test).
// ---------------------------------------------------------------------------
function preToolUse(
  toolName: string,
  agentId: string | undefined,
): PreToolUseHookInput {
  return {
    hook_event_name: "PreToolUse",
    tool_name: toolName,
    tool_input: {},
    tool_use_id: "toolu_test",
    session_id: "sess_test",
    transcript_path: "/tmp/transcript.jsonl",
    cwd: "/tmp",
    ...(agentId !== undefined ? { agent_id: agentId } : {}),
  } satisfies PreToolUseHookInput;
}

describe("decideSubagentTool (Phase 145 WS1 — pure decision table)", () => {
  it("DENIES WebFetch (interactive prompt would hang → use MCP search)", () => {
    const d = decideSubagentTool("WebFetch");
    expect(d.deny).toBe(true);
    expect(d.reason).toMatch(/MCP search/i);
  });

  it("DENIES AskUserQuestion (non-rendering interactive tool; subagents have no operator)", () => {
    const d = decideSubagentTool("AskUserQuestion");
    expect(d.deny).toBe(true);
    expect(d.reason).toMatch(/subagent|operator|prompt/i);
  });

  it("ALLOWS the normal working set (Read/Grep/Glob/Bash/Edit/Write)", () => {
    for (const tool of ["Read", "Grep", "Glob", "Bash", "Edit", "Write"]) {
      expect(decideSubagentTool(tool)).toEqual({ deny: false });
    }
  });

  it("ALLOWS an MCP search tool (mcp__* namespace — legitimate subagent work)", () => {
    expect(decideSubagentTool("mcp__search__web_search")).toEqual({ deny: false });
    expect(decideSubagentTool("mcp__clawcode__memory")).toEqual({ deny: false });
  });

  it("ALLOWS an unknown/unrecognized tool by default (a new working tool must not silently break subagents)", () => {
    // Posture: default-ALLOW unknown tools (inverse of bash-allowlist's
    // deny-by-default) — the goal is "let the subagent work, only block the
    // tools we KNOW hang headless".
    expect(decideSubagentTool("SomeBrandNewTool")).toEqual({ deny: false });
  });

  it("DENIES an empty/undefined tool_name (fail-closed for the ambiguous-prompt hazard)", () => {
    // Empty tool_name is unparseable → we cannot confirm it is a safe
    // non-interactive tool, so deny to avoid an ambiguous headless prompt.
    expect(decideSubagentTool("").deny).toBe(true);
    // @ts-expect-error — exercising the runtime undefined guard
    expect(decideSubagentTool(undefined).deny).toBe(true);
  });
});

describe("subagentPermissionHook (Phase 145 WS1 — agent_id gating + output shape)", () => {
  const opts = { signal: new AbortController().signal };

  it("returns {} (no change) when agent_id is ABSENT — a top-level turn is unaffected", async () => {
    const out = await subagentPermissionHook(
      preToolUse("WebFetch", undefined),
      "toolu_test",
      opts,
    );
    expect(out).toEqual({});
  });

  it("returns {} when agent_id is an empty string (treated as not-a-subagent)", async () => {
    const out = await subagentPermissionHook(
      preToolUse("WebFetch", ""),
      "toolu_test",
      opts,
    );
    expect(out).toEqual({});
  });

  it("DENIES WebFetch when agent_id is PRESENT (subagent call)", async () => {
    const out = await subagentPermissionHook(
      preToolUse("WebFetch", "agent_abc123"),
      "toolu_test",
      opts,
    );
    expect(out).toMatchObject({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
      },
    });
  });

  it("ALLOWS Read when agent_id is PRESENT (subagent call)", async () => {
    const out = await subagentPermissionHook(
      preToolUse("Read", "agent_abc123"),
      "toolu_test",
      opts,
    );
    expect(out).toMatchObject({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
      },
    });
  });

  it("DENIES AskUserQuestion when agent_id is PRESENT (subagent call)", async () => {
    const out = await subagentPermissionHook(
      preToolUse("AskUserQuestion", "agent_abc123"),
      "toolu_test",
      opts,
    );
    expect(out).toMatchObject({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
      },
    });
  });

  it("returns {} for a NON-PreToolUse event even with agent_id (defense-in-depth narrowing)", async () => {
    // The hook is only registered for PreToolUse, but the HookCallback param is
    // the HookInput union; a non-PreToolUse event must early-return so we never
    // read tool_name off a member that lacks it.
    const notPreToolUse = {
      hook_event_name: "PostToolUse",
      session_id: "sess_test",
      transcript_path: "/tmp/transcript.jsonl",
      cwd: "/tmp",
      agent_id: "agent_abc123",
    } as unknown as HookInput;
    const out = await subagentPermissionHook(notPreToolUse, "toolu_test", opts);
    expect(out).toEqual({});
  });
});
