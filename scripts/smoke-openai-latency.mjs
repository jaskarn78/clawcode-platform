#!/usr/bin/env node
/**
 * Phase 73 Plan 03 — zero-dep E2E TTFB smoke for /v1/chat/completions.
 *
 * Sends 2 sequential streaming requests against a warm agent, measures
 * client-side TTFB on each, and asserts turn 2 TTFB is below the configured
 * budget (default 2000ms per LAT-01's sub-2s goal).
 *
 * Exit codes:
 *   0 — turn 2 TTFB within budget (success).
 *   1 — turn 2 TTFB exceeded budget (regression) OR hard HTTP failure.
 *   2 — infra skip (daemon unreachable, 401/403, missing bearer key).
 *
 * Usage:
 *   CLAWCODE_OPENAI_KEY=sk-... node scripts/smoke-openai-latency.mjs \
 *     --agent test-agent --host http://127.0.0.1:3100 --ttfb-budget-ms 2000
 *
 * Meant for manual post-deploy validation on clawdy; NOT wired into CI
 * (CI runs the vitest suite; this needs a live daemon).
 *
 * Zero npm deps — Node 22 native fetch + ReadableStream reader only.
 */

import { parseArgs } from "node:util";

const { values: args } = parseArgs({
  options: {
    agent: { type: "string", default: "test-agent" },
    key: { type: "string", default: process.env.CLAWCODE_OPENAI_KEY ?? "" },
    host: { type: "string", default: "http://127.0.0.1:3100" },
    "ttfb-budget-ms": { type: "string", default: "2000" },
  },
});

const AGENT = args.agent;
const KEY = args.key;
const HOST = args.host.replace(/\/$/, "");
const TTFB_BUDGET_MS = Number.parseInt(args["ttfb-budget-ms"], 10);

function exit(code, msg) {
  process.stdout.write(msg + "\n");
  process.exit(code);
}

if (!KEY) {
  exit(
    2,
    "SKIP: No bearer key — set CLAWCODE_OPENAI_KEY env or --key <value>.",
  );
}

async function oneTurn(label) {
  const url = `${HOST}/v1/chat/completions`;
  const body = JSON.stringify({
    model: AGENT,
    stream: true,
    messages: [{ role: "user", content: "Reply with exactly: ok" }],
  });
  const start = Date.now();
  let firstDeltaAt = null;
  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${KEY}`,
      },
      body,
    });
  } catch (err) {
    const code = err?.cause?.code ?? err?.code;
    if (code === "ECONNREFUSED") {
      exit(
        2,
        `SKIP: daemon not reachable at ${HOST} (ECONNREFUSED). Is clawcoded running?`,
      );
    }
    if (code === "ENOTFOUND") {
      exit(2, `SKIP: host not resolvable (${HOST}): ${err.message}`);
    }
    exit(2, `SKIP: fetch failed — ${err.message}`);
  }
  if (res.status === 401 || res.status === 403) {
    exit(
      2,
      `SKIP: auth rejected (${res.status}) — verify CLAWCODE_OPENAI_KEY is valid for agent '${AGENT}'.`,
    );
  }
  if (!res.ok) {
    exit(1, `FAIL ${label}: HTTP ${res.status} ${res.statusText}`);
  }
  if (!res.body) {
    exit(1, `FAIL ${label}: response body missing (streaming expected).`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let fullText = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    // Split on SSE double-newline frame boundary.
    const frames = buffer.split("\n\n");
    buffer = frames.pop() ?? "";
    for (const frame of frames) {
      const line = frame.split("\n").find((l) => l.startsWith("data: "));
      if (!line) continue;
      const data = line.slice(6).trim();
      if (data === "[DONE]") continue;
      try {
        const obj = JSON.parse(data);
        const delta = obj.choices?.[0]?.delta?.content;
        if (typeof delta === "string" && delta.length > 0) {
          if (firstDeltaAt === null) firstDeltaAt = Date.now();
          fullText += delta;
        }
      } catch {
        // Ignore malformed frames (keepalive comments etc.)
      }
    }
  }
  const end = Date.now();
  const ttfb = firstDeltaAt !== null ? firstDeltaAt - start : null;
  return { label, ttfb, total: end - start, text: fullText };
}

// Run turns sequentially so turn 2 sees a warm persistent subprocess.
const t1 = await oneTurn("turn 1");
const t2 = await oneTurn("turn 2");

process.stdout.write(
  [
    `agent=${AGENT} host=${HOST} ttfb_budget_ms=${TTFB_BUDGET_MS}`,
    `turn 1: ttfb_ms=${t1.ttfb ?? "n/a"} total_ms=${t1.total} body=${JSON.stringify(t1.text.slice(0, 80))}`,
    `turn 2: ttfb_ms=${t2.ttfb ?? "n/a"} total_ms=${t2.total} body=${JSON.stringify(t2.text.slice(0, 80))}`,
  ].join("\n") + "\n",
);

if (t2.ttfb === null) {
  exit(1, `FAIL: turn 2 produced no content delta — cannot measure TTFB.`);
}
if (t2.ttfb >= TTFB_BUDGET_MS) {
  exit(
    1,
    `FAIL: turn 2 TTFB ${t2.ttfb}ms >= budget ${TTFB_BUDGET_MS}ms. Inspect the openai.chat_completion span via 'clawcode trace percentiles --span openai.chat_completion' to diagnose.`,
  );
}
exit(0, `OK: turn 2 TTFB ${t2.ttfb}ms < budget ${TTFB_BUDGET_MS}ms.`);
