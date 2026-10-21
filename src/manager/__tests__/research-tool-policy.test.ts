import { describe, expect, it } from "vitest";
import type { PreToolUseHookInput } from "@anthropic-ai/claude-agent-sdk";
import { decideResearcherTool, isReadOnlySql, researcherDisallowedTools } from "../research-tool-policy.js";
import { makeResearchLaunchGateHook } from "../research-launch-gate.js";

const OFF = { allowBash: false };

describe("researcher tool policy (999.173) — allow table", () => {
  it.each([
    ["Read", {}],
    ["Grep", {}],
    ["Glob", {}],
    ["WebSearch", {}],
    ["WebFetch", {}],
    ["mcp__search__web_search", {}],
    ["mcp__search__web_fetch_url", {}],
    ["mcp__finnhub__quote", { symbol: "AAPL" }],
    ["mcp__finnhub__company_news", {}],
    ["mcp__google-workspace__search_gmail_messages", {}],
    ["mcp__google-workspace__get_gmail_message_content", {}],
    ["mcp__google-workspace__list_drive_items", {}],
    ["mcp__google-workspace__get_events", {}],
    ["mcp__playwright__browser_navigate", {}],
    ["mcp__playwright__browser_snapshot", {}],
    ["mcp__playwright__browser_click", {}],
    ["mcp__brave-search__brave_web_search", {}],
    ["mcp__clawcode__memory_lookup", {}],
    ["mcp__clawcode__clawcode_memory_search", {}],
    ["mcp__clawcode__read_thread", {}],
    ["mcp__clawcode__search_documents", {}],
    ["mcp__acme-db__query", { sql: "SELECT * FROM clients WHERE id = 1" }],
    ["mcp__acme-db__execute_sql", { query: "WITH x AS (SELECT 1) SELECT * FROM x" }],
    ["mcp__acme-db__query", { sql: "-- latest\n  SHOW TABLES;" }],
  ])("allows %s", (tool, input) => {
    expect(decideResearcherTool(tool, input, OFF)).toEqual({ deny: false });
  });
});

describe("researcher tool policy (999.173) — deny table", () => {
  it.each([
    ["Agent"],
    ["Task"],
    ["Write"],
    ["Edit"],
    ["NotebookEdit"],
    ["Bash"],
    ["mcp__1password__read_secret"],
    ["mcp__1password__item_get"],
    ["mcp__clawcode__start_workflow"],
    ["mcp__clawcode__spawn_subagent_thread"],
    ["mcp__clawcode__post_to_agent"],
    ["mcp__clawcode__send_message"],
    ["mcp__clawcode__ask_agent"],
    ["mcp__clawcode__schedule_recurring"],
    ["mcp__clawcode__cancel_schedule"],
    ["mcp__clawcode__clawcode_share_file"],
    ["mcp__clawcode__send_attachment"],
    ["mcp__clawcode__post_cv2_embed"],
    ["mcp__clawcode__memory_save"],
    ["mcp__clawcode__some_future_tool"],
    ["mcp__google-workspace__send_gmail_message"],
    ["mcp__google-workspace__draft_gmail_message"],
    ["mcp__google-workspace__modify_gmail_message_labels"],
    ["mcp__google-workspace__create_drive_file"],
    ["mcp__google-workspace__update_drive_file"],
    ["mcp__google-workspace__delete_event"],
    ["mcp__google-workspace__trashFile"],
    ["mcp__google-workspace__moveFile"],
    ["mcp__google-workspace__share_drive_file"],
    ["mcp__google-workspace__manage_event"],
    ["mcp__playwright__browser_file_upload"],
    ["mcp__shop__checkout_cart"],
    ["mcp__smarthome__set_thermostat"],
  ])("denies %s", (tool) => {
    const d = decideResearcherTool(tool, {}, OFF);
    expect(d.deny).toBe(true);
    expect(d.reason).toBeTruthy();
  });

  it.each([
    ["DELETE FROM clients"],
    ["UPDATE clients SET x = 1"],
    ["SELECT 1; DROP TABLE clients"],
    ["WITH d AS (DELETE FROM t RETURNING *) SELECT * FROM d"],
    ["SELECT * INTO OUTFILE '/tmp/x' FROM t"],
    ["insert into t values (1)"],
  ])("denies write SQL: %s", (sql) => {
    expect(decideResearcherTool("mcp__acme-db__execute_sql", { sql }, OFF).deny).toBe(true);
    expect(isReadOnlySql(sql)).toBe(false);
  });

  it("denies a SQL tool call with no readable statement", () => {
    expect(decideResearcherTool("mcp__acme-db__query", {}, OFF).deny).toBe(true);
  });
});

describe("researcher tool policy (999.173) — knobs", () => {
  it("allowBash lets Bash through", () => {
    expect(decideResearcherTool("Bash", { command: "curl -s example.com" }, { allowBash: true })).toEqual({ deny: false });
  });

  it("deniedTools adds exact names and whole servers", () => {
    const opts = { allowBash: false, extraDenied: ["mcp__finnhub__quote", "mcp__brave-search"] };
    expect(decideResearcherTool("mcp__finnhub__quote", {}, opts).deny).toBe(true);
    expect(decideResearcherTool("mcp__brave-search__brave_web_search", {}, opts).deny).toBe(true);
    expect(decideResearcherTool("mcp__finnhub__company_news", {}, opts).deny).toBe(false);
  });

  it("disallowedTools (layer 1) lists exact names and the 1password server", () => {
    const list = researcherDisallowedTools({ allowBash: false, deniedTools: ["mcp__x__y"] });
    expect(list).toContain("mcp__1password");
    expect(list).toContain("Bash");
    expect(list).toContain("mcp__x__y");
    expect(researcherDisallowedTools({ allowBash: true, deniedTools: [] })).not.toContain("Bash");
  });
});

describe("research hook — researcher tool enforcement (999.173)", () => {
  const sig = { signal: new AbortController().signal };
  const call = (tool: string, extra: Record<string, unknown>) =>
    ({
      hook_event_name: "PreToolUse",
      tool_name: tool,
      tool_input: {},
      tool_use_id: "tu",
      session_id: "s",
      transcript_path: "/t",
      cwd: "/",
      ...extra,
    }) as unknown as PreToolUseHookInput;

  it("denies a mutating tool called BY a researcher", async () => {
    const hook = makeResearchLaunchGateHook("personal", 4, { allowBash: false });
    const out = await hook(call("mcp__google-workspace__send_gmail_message", { agent_id: "sub-1", agent_type: "researcher" }), "tu", sig);
    expect(out).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } });
  });

  it("has no opinion on a read tool called by a researcher", async () => {
    const hook = makeResearchLaunchGateHook("personal", 4, { allowBash: false });
    expect(await hook(call("mcp__finnhub__quote", { agent_id: "sub-1", agent_type: "researcher" }), "tu", sig)).toEqual({});
  });

  it("never touches other subagents or the main thread's tools", async () => {
    const hook = makeResearchLaunchGateHook("personal", 4, { allowBash: false });
    expect(await hook(call("mcp__google-workspace__send_gmail_message", { agent_id: "sub-2", agent_type: "general-purpose" }), "tu", sig)).toEqual({});
    expect(await hook(call("mcp__google-workspace__send_gmail_message", {}), "tu", sig)).toEqual({});
    expect(await hook(call("Write", {}), "tu", sig)).toEqual({});
  });

  it("passes the agent's knobs to the policy", async () => {
    const withBash = makeResearchLaunchGateHook("personal", 4, { allowBash: true });
    expect(await withBash(call("Bash", { agent_id: "sub-1", agent_type: "researcher" }), "tu", sig)).toEqual({});
    const extra = makeResearchLaunchGateHook("personal", 4, { allowBash: false, deniedTools: ["mcp__finnhub__quote"] });
    expect(await extra(call("mcp__finnhub__quote", { agent_id: "sub-1", agent_type: "researcher" }), "tu", sig)).toMatchObject({
      hookSpecificOutput: { permissionDecision: "deny" },
    });
  });
});
