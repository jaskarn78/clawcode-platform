/**
 * Phase 999.173 polish — live probe: is a PreToolUse `updatedInput` honoured
 * for the Agent tool, and does the Agent tool's `model` input override the
 * AgentDefinition's model? Researcher definition = haiku. The hook leaves the
 * 1st researcher launch alone and sets model "sonnet" on the 2nd. Each
 * researcher's real model is read from its child assistant frames
 * (message.model), not from self-report.
 *
 *   node_modules/.bin/tsx scripts/ops/research-model-probe.ts
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { createRequire } from "node:module";
import { query, type HookCallback } from "@anthropic-ai/claude-agent-sdk";

const require = createRequire(import.meta.url);
const BIN = join(dirname(require.resolve(`@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/package.json`)), "claude");
const CWD = mkdtempSync(join(tmpdir(), "research-model-probe-"));
const ENV: Record<string, string> = { ...(process.env as Record<string, string>), ENABLE_CLAUDEAI_MCP_SERVERS: "false" };
delete ENV.ANTHROPIC_API_KEY;

let launches = 0;
const seenInputs: unknown[] = [];
const hook: HookCallback = async (input) => {
  const i = input as { hook_event_name?: string; tool_name?: string; tool_input?: Record<string, unknown>; agent_id?: string };
  if (i.hook_event_name !== "PreToolUse" || i.agent_id || (i.tool_name !== "Agent" && i.tool_name !== "Task")) return {};
  if (i.tool_input?.subagent_type !== "researcher") return {};
  launches++;
  seenInputs.push(i.tool_input);
  if (launches === 2) {
    return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", updatedInput: { ...i.tool_input, model: "sonnet" } } };
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
const push = (text: string) => {
  items.push({ type: "user", message: { role: "user", content: text }, parent_tool_use_id: null, session_id: "" });
  wake?.();
};

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
    agents: {
      researcher: {
        description: "Background researcher.",
        prompt: "Answer the question in one short sentence. No tools.",
        tools: ["Read"],
        model: "haiku",
        maxTurns: 2,
        background: true,
      },
    },
    perTaskStopAffordance: true,
    hooks: { PreToolUse: [{ hooks: [hook] }] },
  } as never,
});

const modelByLane = new Map<string, Set<string>>();
const laneOrder: string[] = [];
const t0 = Date.now();
push(
  "Launch TWO researcher subagents one after the other (Agent tool, subagent_type \"researcher\", do not set a model): " +
    "first with the task 'What is 2+2?', then with the task 'What is the capital of France?'. Do nothing else.",
);
let notifications = 0;
const timer = setTimeout(() => q.close(), 180_000);
for await (const m of q as AsyncIterable<Record<string, any>>) {
  const parent = m.parent_tool_use_id ?? null;
  if (m.type === "assistant" && !parent) {
    for (const b of m.message?.content ?? []) {
      if (b.type === "tool_use" && (b.name === "Agent" || b.name === "Task")) laneOrder.push(b.id);
    }
  }
  if (m.type === "assistant" && parent && m.message?.model) {
    if (!modelByLane.has(parent)) modelByLane.set(parent, new Set());
    modelByLane.get(parent)!.add(m.message.model);
  }
  if (m.type === "system" && m.subtype === "task_notification") notifications++;
  if (notifications >= 2 && m.type === "result" && m.origin?.kind === "task-notification") break;
}
clearTimeout(timer);
console.log(`elapsed ${((Date.now() - t0) / 1000).toFixed(1)}s, hook saw ${launches} researcher launches`);
console.log("tool_input seen by hook:", JSON.stringify(seenInputs));
laneOrder.forEach((id, i) => console.log(`launch #${i + 1} (${id.slice(-6)}): model(s) = ${[...(modelByLane.get(id) ?? [])].join(", ") || "none seen"}`));
q.close();
process.exit(0);
