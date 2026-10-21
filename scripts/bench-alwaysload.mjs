#!/usr/bin/env node
/**
 * Synthetic benchmark for Phase 999.54 `mcpServers[].alwaysLoad: true`.
 *
 * Spawns two SDK queries with an identical prompt instructing the model to
 * call a specific MCP tool. The only difference: one query marks the MCP
 * server `alwaysLoad: true` (preloaded), the other leaves it default
 * (deferred behind tool search).
 *
 * Measures: wall-clock to first assistant message, wall-clock to first
 * tool_use of the target tool, total turns, total tokens.
 *
 * Run: node scripts/bench-alwaysload.mjs [--runs N] [--tools M]
 */

import { createSdkMcpServer, query, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

const args = process.argv.slice(2);
function getFlag(name, def) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : def;
}
const RUNS = parseInt(getFlag("--runs", "3"));
const TOOL_COUNT = parseInt(getFlag("--tools", "30"));
const MODEL = getFlag("--model", "claude-sonnet-4-5");
const VERBOSE = args.includes("--verbose");

console.log(`# bench-alwaysload — runs=${RUNS} tools=${TOOL_COUNT} model=${MODEL}\n`);

// Build N representative tools. One is the target the prompt will instruct
// the model to call. Schemas mirror typical clawcode tool shape (3-5 fields).
function buildTools() {
  const tools = [];
  for (let i = 0; i < TOOL_COUNT - 1; i++) {
    tools.push(
      tool(
        `noise_tool_${i.toString().padStart(2, "0")}`,
        `Filler tool ${i} — performs a placeholder operation on an input string and returns metadata. Used to bulk up the server's tool surface so the benchmark mirrors a realistic ClawCode MCP server with ~30 tools.`,
        {
          input: z.string().describe("Input string to process"),
          mode: z.enum(["a", "b", "c"]).optional().describe("Processing mode"),
          retries: z.number().optional().describe("Number of retries"),
        },
        async ({ input }) => ({
          content: [{ type: "text", text: `processed: ${input}` }],
        }),
      ),
    );
  }
  // The target tool — distinctive name + description so the model picks it
  tools.push(
    tool(
      "bench_target_emit_token",
      "BENCHMARK TARGET: emit a single ack token for the alwaysLoad preload benchmark. Call this tool with `phrase` set to the value the user requested.",
      { phrase: z.string().describe("Phrase to echo back") },
      async ({ phrase }) => ({
        content: [{ type: "text", text: `BENCH_ACK:${phrase}` }],
      }),
    ),
  );
  return tools;
}

const PROMPT =
  "Use the `bench_target_emit_token` tool with phrase set to 'pingpong'. Do not output anything else first — call the tool immediately.";

async function runOnce(alwaysLoad, label) {
  const server = createSdkMcpServer({
    name: "bench-server",
    version: "1.0.0",
    tools: buildTools(),
    alwaysLoad,
  });

  const t0 = performance.now();
  let tFirstMessage = null;
  let tFirstToolUse = null;
  let turns = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let resultMessage = null;
  let toolNameUsed = null;

  const q = query({
    prompt: PROMPT,
    options: {
      model: MODEL,
      mcpServers: { "bench-server": server },
      permissionMode: "bypassPermissions",
      settingSources: [],
      maxTurns: 6,
    },
  });

  for await (const m of q) {
    if (VERBOSE) console.log(`  [${label}] msg.type=${m.type}${m.subtype ? "/" + m.subtype : ""}`);
    if (tFirstMessage === null) tFirstMessage = performance.now();
    if (m.type === "assistant") {
      turns++;
      const blocks = m.message?.content ?? [];
      for (const b of blocks) {
        if (b.type === "tool_use" && tFirstToolUse === null) {
          tFirstToolUse = performance.now();
          toolNameUsed = b.name;
        }
      }
      const u = m.message?.usage;
      if (u) {
        inputTokens += u.input_tokens ?? 0;
        outputTokens += u.output_tokens ?? 0;
        cacheReadTokens += u.cache_read_input_tokens ?? 0;
        cacheWriteTokens += u.cache_creation_input_tokens ?? 0;
      }
    } else if (m.type === "result") {
      resultMessage = m;
      break;
    }
  }
  const tEnd = performance.now();

  return {
    label,
    alwaysLoad,
    ms_total: Math.round(tEnd - t0),
    ms_first_message: tFirstMessage ? Math.round(tFirstMessage - t0) : null,
    ms_first_tool_use: tFirstToolUse ? Math.round(tFirstToolUse - t0) : null,
    turns,
    tool_name_used: toolNameUsed,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    cache_read_tokens: cacheReadTokens,
    cache_write_tokens: cacheWriteTokens,
    result_subtype: resultMessage?.subtype,
    success: toolNameUsed?.endsWith("bench_target_emit_token") ?? false,
  };
}

async function main() {
  const results = { preload: [], deferred: [] };
  for (let i = 0; i < RUNS; i++) {
    console.log(`run ${i + 1}/${RUNS}: preload (alwaysLoad: true) ...`);
    results.preload.push(await runOnce(true, "preload"));
    console.log(`run ${i + 1}/${RUNS}: deferred (default tool search) ...`);
    results.deferred.push(await runOnce(false, "deferred"));
  }

  console.log("\n## Raw results\n");
  console.log(JSON.stringify(results, null, 2));

  // Summary
  const avg = (arr, k) => {
    const vals = arr.map((r) => r[k]).filter((v) => v !== null && !isNaN(v));
    return vals.length ? Math.round(vals.reduce((a, b) => a + b, 0) / vals.length) : null;
  };

  console.log("\n## Summary (averaged)\n");
  console.log("| metric | preload (alwaysLoad:true) | deferred (default) | delta |");
  console.log("|---|---|---|---|");
  const metrics = [
    "ms_total",
    "ms_first_message",
    "ms_first_tool_use",
    "turns",
    "input_tokens",
    "output_tokens",
    "cache_read_tokens",
    "cache_write_tokens",
  ];
  for (const k of metrics) {
    const p = avg(results.preload, k);
    const d = avg(results.deferred, k);
    const delta = p !== null && d !== null ? d - p : null;
    const sign = delta > 0 ? "+" : "";
    console.log(`| ${k} | ${p} | ${d} | ${sign}${delta} |`);
  }

  const successP = results.preload.filter((r) => r.success).length;
  const successD = results.deferred.filter((r) => r.success).length;
  console.log(`\nsuccess rate (correct tool called): preload=${successP}/${RUNS}, deferred=${successD}/${RUNS}`);
}

main().catch((e) => {
  console.error("BENCHMARK FAILED:", e);
  process.exit(1);
});
