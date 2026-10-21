#!/usr/bin/env node
/**
 * Phase 999.169 — Agent SDK + bundled CLI smoke, run against the REAL install in
 * this checkout after every lockstep bump. Cheap prompts on haiku; subscription
 * auth from ~/.claude (ANTHROPIC_API_KEY is stripped). settingSources: [] so the
 * operator's own hooks/plugins cannot interfere.
 *
 *   node scripts/ops/sdk-lockstep-smoke.mjs [--only name,name] [--json out.json]
 *
 * Each case prints PASS/FAIL with evidence; exit 1 if any case failed.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { createRequire } from "node:module";
import { writeFileSync } from "node:fs";
import { query, createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

const require = createRequire(import.meta.url);
const SDK_DIR = dirname(require.resolve("@anthropic-ai/claude-agent-sdk"));
const SDK_PKG = JSON.parse(await import("node:fs").then((fs) => fs.readFileSync(join(SDK_DIR, "package.json"), "utf8")));
const BIN = process.env.CLAWCODE_CLAUDE_BIN?.trim() || join(dirname(require.resolve(`@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/package.json`)), "claude");
const MODEL = process.env.SMOKE_MODEL ?? "claude-haiku-4-5";
const CWD = mkdtempSync(join(tmpdir(), "sdk-smoke-"));
// Mirrors the daemon's chokepoint: claude.ai connectors never load (FORCED_SESSION_ENV).
const ENV = { ...process.env, ENABLE_CLAUDEAI_MCP_SERVERS: "false" };
delete ENV.ANTHROPIC_API_KEY;

const args = process.argv.slice(2);
const only = args.includes("--only") ? args[args.indexOf("--only") + 1].split(",") : null;
const jsonOut = args.includes("--json") ? args[args.indexOf("--json") + 1] : null;

const base = (extra = {}) => ({
  model: MODEL,
  cwd: CWD,
  pathToClaudeCodeExecutable: BIN,
  permissionMode: "bypassPermissions",
  allowDangerouslySkipPermissions: true,
  settingSources: [],
  env: ENV,
  ...extra,
});

/** Streaming-input prompt the test drives turn by turn. */
function inputQueue() {
  const items = [];
  let wake = null;
  let closed = false;
  return {
    push(text) {
      items.push({ type: "user", message: { role: "user", content: text }, parent_tool_use_id: null, session_id: "" });
      wake?.();
    },
    close() {
      closed = true;
      wake?.();
    },
    async *[Symbol.asyncIterator]() {
      for (;;) {
        while (items.length > 0) yield items.shift();
        if (closed) return;
        await new Promise((r) => (wake = r));
        wake = null;
      }
    },
  };
}

const withTimeout = (p, ms, what) =>
  Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`timeout ${ms}ms: ${what}`)), ms))]);

/** Read messages until `pred` matches; returns [all, match]. */
async function readUntil(it, pred, ms, what) {
  const seen = [];
  const run = (async () => {
    for (;;) {
      const { value, done } = await it.next();
      if (done) return [seen, null];
      seen.push(value);
      if (pred(value)) return [seen, value];
    }
  })();
  return withTimeout(run, ms, what);
}

const cases = {
  async "handshake-streaming"() {
    const q = query({ prompt: "Reply with exactly: pong", options: base({ maxTurns: 1 }) });
    const msgs = [];
    for await (const m of q) msgs.push(m);
    const init = msgs.find((m) => m.type === "system" && m.subtype === "init");
    const result = msgs.find((m) => m.type === "result");
    if (!init || !result || result.is_error) throw new Error(`no init/result: ${JSON.stringify(result)?.slice(0, 200)}`);
    return `init claude_code_version=${init.claude_code_version ?? "?"} model=${init.model}; result="${String(result.result).slice(0, 40)}"`;
  },

  async "control-calls"() {
    const input = inputQueue();
    const q = query({ prompt: input, options: base() });
    const it = q[Symbol.asyncIterator]();
    input.push("Reply with exactly: one");
    await readUntil(it, (m) => m.type === "result", 60_000, "turn 1");
    await q.setModel(MODEL);
    const mcp = await q.mcpServerStatus();
    const ctx = await q.getContextUsage();
    input.push("Reply with exactly: two");
    const [, r2] = await readUntil(it, (m) => m.type === "result", 60_000, "turn 2");
    input.close();
    q.close?.();
    return `setModel ok; mcpServerStatus=${mcp.length} servers; getContextUsage totalTokens=${ctx?.totalTokens ?? JSON.stringify(ctx).slice(0, 60)}; turn2="${String(r2?.result).slice(0, 20)}"`;
  },

  async "mid-turn-interrupt"() {
    const input = inputQueue();
    const q = query({ prompt: input, options: base() });
    const it = q[Symbol.asyncIterator]();
    input.push("Count from 1 to 400, one number per line, no other text.");
    await readUntil(it, (m) => m.type === "assistant" || m.type === "stream_event", 60_000, "first output");
    await q.interrupt();
    const [, r] = await readUntil(it, (m) => m.type === "result", 60_000, "result after interrupt");
    input.push("Reply with exactly: alive");
    const [, r2] = await readUntil(it, (m) => m.type === "result", 60_000, "turn after interrupt");
    input.close();
    q.close?.();
    return `interrupted → result subtype=${r?.subtype}; next turn="${String(r2?.result).slice(0, 20)}"`;
  },

  async "multi-turn-tool"() {
    const input = inputQueue();
    const q = query({ prompt: input, options: base() });
    const it = q[Symbol.asyncIterator]();
    input.push("Use the Bash tool to run: echo smoke-$((6*7)). Then reply with only the command output.");
    const [m1, r1] = await readUntil(it, (m) => m.type === "result", 90_000, "tool turn");
    const usedBash = m1.some((m) => m.type === "assistant" && m.message.content.some((b) => b.type === "tool_use" && b.name === "Bash"));
    input.push("What number did the command print? Reply with only the number.");
    const [, r2] = await readUntil(it, (m) => m.type === "result", 60_000, "follow-up");
    input.close();
    q.close?.();
    if (!usedBash || !String(r1?.result).includes("smoke-42")) throw new Error(`bash not used or wrong output: ${r1?.result}`);
    return `Bash used; turn1="${String(r1.result).trim()}"; turn2="${String(r2?.result).trim()}"`;
  },

  async "prod-shaped-init"() {
    let hookFired = 0;
    const server = createSdkMcpServer({
      name: "smoke",
      version: "1.0.0",
      tools: [tool("ping", "Returns pong", {}, async () => ({ content: [{ type: "text", text: "pong-from-mcp" }] }))],
    });
    const q = query({
      prompt: "Call the mcp__smoke__ping tool once, then reply with its output only.",
      options: base({
        maxTurns: 3,
        mcpServers: { smoke: server },
        hooks: {
          PreToolUse: [{ hooks: [async () => { hookFired++; return { continue: true }; }] }],
        },
        systemPrompt: { type: "preset", preset: "claude_code", append: "You are a smoke test." },
      }),
    });
    let result;
    let mcpStatus = "?";
    for await (const m of q) {
      if (m.type === "system" && m.subtype === "init") mcpStatus = JSON.stringify(m.mcp_servers);
      if (m.type === "result") result = m;
    }
    if (hookFired === 0 || !String(result?.result).includes("pong-from-mcp")) {
      throw new Error(`hook=${hookFired} result=${result?.result}`);
    }
    if (mcpStatus.includes('"claudeai"')) throw new Error(`claude.ai connectors loaded: ${mcpStatus}`);
    return `mcp_servers=${mcpStatus}; PreToolUse fired ${hookFired}x; result="${String(result.result).trim()}"`;
  },

  async "background-agent-per-task-stop"() {
    const agents = {
      sleeper: {
        description: "Waits using Bash when asked to wait.",
        prompt: "Run exactly the Bash command you are given, then reply 'slept'.",
        tools: ["Bash"],
        model: "haiku",
        background: true,
        maxTurns: 4,
      },
    };
    const input = inputQueue();
    const q = query({ prompt: input, options: base({ agents, perTaskStopAffordance: true, agentProgressSummaries: true }) });
    const it = q[Symbol.asyncIterator]();
    input.push(
      "Launch TWO sleeper subagents in parallel using the Agent tool (subagent_type 'sleeper'): " +
        "the first runs `sleep 25 && echo A`, the second runs `sleep 45 && echo B`. Do not wait for them; reply 'launched'.",
    );
    const tasks = new Map();
    const seen = [];
    const track = (m) => {
      seen.push(`${m.type}/${m.subtype ?? ""}`);
      if (m.type === "system" && m.subtype === "task_started") tasks.set(m.task_id, { desc: m.description, status: "running", toolUseId: m.tool_use_id });
      if (m.type === "system" && m.subtype === "task_notification") {
        const t = tasks.get(m.task_id) ?? {};
        tasks.set(m.task_id, { ...t, status: m.status });
      }
    };
    await readUntil(it, (m) => (track(m), m.type === "result"), 120_000, "launch turn");
    await readUntil(it, (m) => (track(m), tasks.size >= 2), 60_000, "both task_started");
    // Interrupt a DAEMON turn while researchers run (the path that used to kill them).
    input.push("Count from 1 to 300, one number per line.");
    await readUntil(it, (m) => (track(m), m.type === "assistant" || m.type === "stream_event"), 60_000, "second turn output");
    await q.interrupt();
    await readUntil(it, (m) => (track(m), m.type === "result"), 60_000, "interrupted result");
    const afterInterrupt = [...tasks.values()].map((t) => t.status);
    // Stop the second (longer) task individually.
    const [longId] = [...tasks.entries()].find(([, t]) => /B/.test(t.desc ?? "")) ?? [...tasks.entries()][1];
    await q.stopTask(longId);
    await readUntil(it, (m) => (track(m), [...tasks.values()].every((t) => t.status !== "running")), 150_000, "tasks settle");
    input.close();
    q.close?.();
    const final = [...tasks.entries()].map(([id, t]) => `${id.slice(0, 8)}:${t.status}`);
    const survivedInterrupt = afterInterrupt.every((s) => s === "running" || s === "completed");
    const stoppedOne = tasks.get(longId)?.status === "stopped";
    if (!survivedInterrupt || !stoppedOne) throw new Error(`afterInterrupt=${afterInterrupt} final=${final} kinds=${[...new Set(seen)].join(",")}`);
    return `after interrupt: [${afterInterrupt}] (survived); stopTask(${longId.slice(0, 8)}) → final [${final}]; saw ${[...new Set(seen)].filter((s) => s.startsWith("system/task") || s.includes("background")).join(",")}`;
  },

  async "subagent-mcp-under-toolsearch"() {
    const server = createSdkMcpServer({
      name: "smoke",
      version: "1.0.0",
      tools: [tool("ping", "Returns pong", {}, async () => ({ content: [{ type: "text", text: "pong-from-mcp" }] }))],
    });
    const run = async (tools) => {
      const q = query({
        prompt: "Use the Agent tool with subagent_type 'pinger' and wait for its answer. Reply with the subagent's answer only.",
        options: base({
          maxTurns: 4,
          env: { ...ENV, ENABLE_TOOL_SEARCH: "true" },
          mcpServers: { smoke: server },
          agents: {
            pinger: { description: "Calls the ping tool.", prompt: "Call mcp__smoke__ping and reply with its output only.", tools, model: "haiku", maxTurns: 4 },
          },
        }),
      });
      let result;
      for await (const m of q) if (m.type === "result") result = m;
      return String(result?.result ?? "");
    };
    const without = await run(["mcp__smoke__ping"]);
    const withTs = await run(["mcp__smoke__ping", "ToolSearch"]);
    return `tools=[ping] → ${without.includes("pong-from-mcp") ? "WORKS" : `NO (${without.slice(0, 60)})`}; tools=[ping,ToolSearch] → ${withTs.includes("pong-from-mcp") ? "WORKS" : `NO (${withTs.slice(0, 60)})`}`;
  },
};

const results = [];
console.log(`SDK ${SDK_PKG.version} (claudeCodeVersion ${SDK_PKG.claudeCodeVersion}) · binary ${BIN} · model ${MODEL}\n`);
for (const [name, fn] of Object.entries(cases)) {
  if (only && !only.includes(name)) continue;
  const t0 = Date.now();
  try {
    const evidence = await fn();
    results.push({ name, ok: true, ms: Date.now() - t0, evidence });
    console.log(`PASS ${name} (${Date.now() - t0} ms) — ${evidence}`);
  } catch (err) {
    results.push({ name, ok: false, ms: Date.now() - t0, evidence: String(err?.message ?? err) });
    console.log(`FAIL ${name} (${Date.now() - t0} ms) — ${err?.message ?? err}`);
  }
}
if (jsonOut) writeFileSync(jsonOut, JSON.stringify({ sdk: SDK_PKG.version, cli: SDK_PKG.claudeCodeVersion, bin: BIN, model: MODEL, results }, null, 2));
process.exit(results.every((r) => r.ok) ? 0 : 1);
