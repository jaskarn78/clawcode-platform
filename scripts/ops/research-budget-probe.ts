/**
 * Phase 999.173 polish — live probe for the researcher tool-call budget:
 *  (a) does a researcher's PreToolUse hook input carry an agent_id equal to
 *      the task_id from task_started (so the hook can count per task)?
 *  (b) does PreToolUse `additionalContext` reach a SUBAGENT's model (the 80 %
 *      nudge), and does a deny reason (the 100 % stop)?
 *
 *   node_modules/.bin/tsx scripts/ops/research-budget-probe.ts
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { createRequire } from "node:module";
import { query, createSdkMcpServer, tool, type HookCallback } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

const require = createRequire(import.meta.url);
const BIN = join(dirname(require.resolve(`@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/package.json`)), "claude");
const CWD = mkdtempSync(join(tmpdir(), "research-budget-probe-"));
const ENV: Record<string, string> = { ...(process.env as Record<string, string>), ENABLE_CLAUDEAI_MCP_SERVERS: "false" };
delete ENV.ANTHROPIC_API_KEY;

let n = 0;
const probe = createSdkMcpServer({
  name: "probe",
  version: "1.0.0",
  tools: [tool("ping", "Returns pong and a counter.", { i: z.number() }, async ({ i }) => ({ content: [{ type: "text", text: `pong ${i}` }] }))],
});

const hookAgentIds: string[] = [];
let researcherCalls = 0;
const hook: HookCallback = async (input) => {
  const i = input as { hook_event_name?: string; tool_name?: string; agent_id?: string; agent_type?: string };
  if (i.hook_event_name !== "PreToolUse" || i.agent_type !== "researcher") return {};
  if (!i.tool_name?.startsWith("mcp__probe__")) return {};
  researcherCalls++;
  if (i.agent_id) hookAgentIds.push(i.agent_id);
  if (researcherCalls === 2) {
    return { hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: "BUDGET NUDGE 7731: budget nearly used — write up findings now." } };
  }
  if (researcherCalls >= 3) {
    return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "BUDGET STOP 4402: budget reached — write your final summary from what you have." } };
  }
  return {};
};

const items: unknown[] = [];
let wake: (() => void) | null = null;
const input = {
  async *[Symbol.asyncIterator]() {
    for (;;) {
      while (items.length > 0) yield items.shift();
      await new Promise<void>((r) => (wake = r));
      wake = null;
    }
  },
};
items.push({
  type: "user",
  message: {
    role: "user",
    content:
      "Launch ONE researcher subagent (Agent tool, subagent_type \"researcher\") with this task: " +
      "'Call the probe ping tool with i=1, then i=2, then i=3, then i=4, one at a time. Then report every tool result verbatim " +
      "AND quote verbatim any extra context or system note you received alongside a tool result, including any code numbers.' Do nothing else.",
  },
  parent_tool_use_id: null,
  session_id: "",
});

const q = query({
  prompt: input as never,
  options: {
    model: "claude-sonnet-4-5",
    cwd: CWD,
    pathToClaudeCodeExecutable: BIN,
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    settingSources: [],
    env: ENV,
    mcpServers: { probe },
    agents: {
      researcher: {
        description: "Background researcher.",
        prompt: "Follow the task exactly. Report everything you observe verbatim.",
        model: "haiku",
        maxTurns: 12,
        background: true,
      },
    },
    perTaskStopAffordance: true,
    hooks: { PreToolUse: [{ hooks: [hook] }] },
  } as never,
});

let taskId = "";
let finalSummary = "";
const childResults: string[] = [];
const timer = setTimeout(() => q.close(), 200_000);
for await (const m of q as AsyncIterable<Record<string, any>>) {
  if (m.type === "system" && m.subtype === "task_started") taskId = m.task_id;
  if (m.type === "user" && m.parent_tool_use_id) {
    for (const b of m.message?.content ?? []) {
      if (b.type === "tool_result") {
        const text = Array.isArray(b.content) ? b.content.map((c: any) => c.text ?? "").join(" ") : String(b.content);
        childResults.push(`${b.is_error ? "ERROR " : ""}${text.slice(0, 160)}`);
      }
    }
  }
  if (m.type === "assistant" && m.parent_tool_use_id) {
    for (const b of m.message?.content ?? []) if (b.type === "text") finalSummary = String(b.text);
  }
  if (m.type === "system" && m.subtype === "task_notification") {
    finalSummary = `${finalSummary}\n[notification summary] ${m.summary ?? ""}`;
    break;
  }
}
clearTimeout(timer);
console.log("task_started task_id:", taskId);
console.log("hook agent_id(s):", [...new Set(hookAgentIds)].join(", "), "| equal:", hookAgentIds.every((a) => a === taskId));
console.log("researcher tool results:", JSON.stringify(childResults));
console.log("nudge 7731 visible to the researcher's model:", /7731/.test(finalSummary));
console.log("stop 4402 visible:", /4402/.test(finalSummary) || childResults.some((r) => r.includes("4402")));
console.log("researcher final text:", JSON.stringify(finalSummary.slice(0, 600)));
q.close();
process.exit(0);
