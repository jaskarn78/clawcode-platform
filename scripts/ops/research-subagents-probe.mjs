#!/usr/bin/env node
/**
 * Phase 999.173 — live probe: does the model auto-select the `researcher`
 * AgentDefinition for a "deep dive" request, and what frames arrive?
 * Uses the REAL research options (buildResearchSdkOptions semantics, copied
 * here as plain objects) against the installed SDK + bundled CLI. Cheap: the
 * researcher only reads two local files; the parent is sonnet, researchers
 * haiku with maxTurns 4. Prints a compact frame timeline.
 *
 *   node scripts/ops/research-subagents-probe.mjs
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { createRequire } from "node:module";
import { query } from "@anthropic-ai/claude-agent-sdk";

const require = createRequire(import.meta.url);
const BIN = join(dirname(require.resolve(`@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/package.json`)), "claude");
const CWD = mkdtempSync(join(tmpdir(), "research-probe-"));
writeFileSync(join(CWD, "mercury.md"), "Mercury: closest planet to the Sun. Orbital period 88 days. No moons. Surface temps -180C to 430C.\n");
writeFileSync(join(CWD, "venus.md"), "Venus: second planet. Orbital period 225 days. No moons. Thick CO2 atmosphere, surface ~465C (hottest planet).\n");
const ENV = { ...process.env };
delete ENV.ANTHROPIC_API_KEY;

const researcher = {
  description:
    "Background researcher for research, deep dives, investigations, comparisons and \"look into X\" requests. " +
    "Launch 2-4 in parallel with the Agent tool (subagent_type \"researcher\"), one per distinct sub-question, " +
    "each with a self-contained prompt. They run in the background while a live research card shows the user " +
    "their progress; you are woken as each one finishes. When all are done, write ONE synthesis for the user. " +
    "Not for quick lookups you can answer directly.",
  prompt: "You are a focused research worker answering ONE sub-question for a lead agent. Use Read/Grep/Glob on the working directory. Return a compact brief: the answer first, then key findings as bullets. No preamble.",
  tools: ["Read", "Grep", "Glob"],
  disallowedTools: ["Agent", "Task", "Write", "Edit", "Bash"],
  model: "haiku",
  effort: "low",
  maxTurns: 4,
  background: true,
};

const items = [];
let wake = null;
const input = {
  async *[Symbol.asyncIterator]() {
    for (;;) {
      while (items.length > 0) yield items.shift();
      await new Promise((r) => (wake = r));
      wake = null;
    }
  },
};
const push = (text) => {
  items.push({ type: "user", message: { role: "user", content: text }, parent_tool_use_id: null, session_id: "" });
  wake?.();
};

const q = query({
  prompt: input,
  options: {
    model: "claude-sonnet-4-5",
    cwd: CWD,
    pathToClaudeCodeExecutable: BIN,
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    settingSources: [],
    env: ENV,
    agents: { researcher },
    agentProgressSummaries: true,
    perTaskStopAffordance: true,
    systemPrompt: {
      type: "preset",
      preset: "claude_code",
      append:
        "For research, deep dives, investigations and comparisons, launch 2-4 `researcher` subagents in parallel with the Agent tool (subagent_type \"researcher\", one per sub-question): they run in the background, and when they have all finished you write ONE synthesis.",
    },
  },
});

const t0 = Date.now();
const line = (s) => console.log(`${String(((Date.now() - t0) / 1000).toFixed(1)).padStart(6)}s  ${s}`);
push("Deep dive: compare Mercury and Venus using the notes in this directory (mercury.md, venus.md).");
let results = 0;
let researcherLaunches = 0;
const timeout = setTimeout(() => {
  line("TIMEOUT — closing");
  q.close();
}, 240_000);
for await (const m of q) {
  const parent = m.parent_tool_use_id ?? null;
  if (m.type === "system") {
    const extra =
      m.subtype === "task_started"
        ? ` task=${m.task_id} tool_use=${m.tool_use_id} subagent_type=${m.subagent_type} bg=${m.is_backgrounded}`
        : m.subtype === "task_notification"
          ? ` task=${m.task_id} status=${m.status}`
          : m.subtype === "task_progress"
            ? ` task=${m.task_id} summary=${JSON.stringify(m.summary ?? null)} tool=${m.last_tool_name ?? ""}`
            : m.subtype === "background_tasks_changed"
              ? ` live=[${(m.tasks ?? []).map((t) => t.task_id).join(",")}]`
              : "";
    if (m.subtype !== "thinking_tokens") line(`system/${m.subtype}${extra}`);
  } else if (m.type === "assistant") {
    for (const b of m.message?.content ?? []) {
      if (b.type === "tool_use") {
        if ((b.name === "Agent" || b.name === "Task") && b.input?.subagent_type === "researcher") researcherLaunches++;
        line(`assistant${parent ? `[child ${parent.slice(-6)}]` : ""} tool_use ${b.name} ${b.input?.subagent_type ?? ""}`);
      } else if (b.type === "text" && !parent) line(`assistant text: ${JSON.stringify(b.text.slice(0, 100))}`);
    }
  } else if (m.type === "result") {
    results++;
    line(`result #${results} origin=${m.origin?.kind ?? "none"} text=${JSON.stringify(String(m.result ?? "").slice(0, 120))}`);
    if (results >= 4) break;
  } else if (m.type === "user" && parent) {
    // child tool results — skip
  }
}
clearTimeout(timeout);
line(`researcher launches: ${researcherLaunches}`);
q.close();
process.exit(0);
