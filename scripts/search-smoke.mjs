#!/usr/bin/env node
/**
 * Phase 71 Plan 02 — Web Search E2E smoke.
 *
 * Drives a live daemon's `search-tool-call` IPC end-to-end:
 *   1. web_search  — assert ok=true, results[].length > 0, first result
 *      carries both `title` and `url`
 *   2. web_fetch_url  — fetch the first search hit, assert ok=true,
 *      `text.length > 100`, `wordCount > 10`
 *   3. web_search again — verifies the IPC path is repeatable (the
 *      actual Turn-scoped cache verification lives inside the agent
 *      session, not this subprocess-level smoke; a duplicate call here
 *      just re-exercises the transport).
 *
 * Usage:
 *   # daemon must be running with BRAVE_API_KEY set
 *   node scripts/search-smoke.mjs [agent] [query]
 *
 *   # defaults:
 *   node scripts/search-smoke.mjs clawdy "anthropic claude api"
 *
 * Exit codes:
 *   0 — all 3 steps succeeded
 *   1 — any assertion failed (loud error message)
 *   2 — daemon not running (bring up via `clawcode start-all`)
 */

import { connect } from "node:net";
import { performance } from "node:perf_hooks";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

// Matches SOCKET_PATH / MANAGER_DIR derivation in src/manager/daemon.ts.
const MANAGER_DIR =
  process.env.CLAWCODE_MANAGER_DIR ?? join(homedir(), ".clawcode", "manager");
const SOCKET_PATH =
  process.env.CLAWCODE_SOCKET_PATH ?? join(MANAGER_DIR, "clawcode.sock");

const AGENT = process.argv[2] ?? "clawdy";
const QUERY = process.argv[3] ?? "anthropic claude api";
const STEP_TIMEOUT_MS = 30_000;

/**
 * Thin JSON-RPC 2.0 client over the daemon's Unix socket. Mirrors
 * src/ipc/client.ts sendIpcRequest without pulling the TS module.
 */
function sendIpcRequest(method, params) {
  return new Promise((resolve, reject) => {
    const socket = connect(SOCKET_PATH);
    const request = {
      jsonrpc: "2.0",
      id: randomBytes(8).toString("hex"),
      method,
      params,
    };
    let data = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(new Error(`timeout after ${STEP_TIMEOUT_MS}ms`));
    }, STEP_TIMEOUT_MS);

    socket.on("connect", () => {
      socket.write(JSON.stringify(request) + "\n");
    });
    socket.on("data", (chunk) => {
      data += chunk.toString();
      const newline = data.indexOf("\n");
      if (newline === -1) return;
      const message = data.slice(0, newline);
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      try {
        const parsed = JSON.parse(message);
        if (parsed.error) {
          reject(new Error(`IPC error ${parsed.error.code}: ${parsed.error.message}`));
        } else {
          resolve(parsed.result);
        }
      } catch (err) {
        reject(new Error(`failed to parse daemon response: ${err.message}`));
      }
    });
    socket.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err.code === "ECONNREFUSED" || err.code === "ENOENT") {
        const hint = new Error(
          "daemon not running — start with `clawcode start-all` first",
        );
        hint.isDaemonDown = true;
        reject(hint);
      } else {
        reject(err);
      }
    });
    socket.on("end", () => {
      if (settled) return;
      if (data.length > 0 && !data.includes("\n")) {
        settled = true;
        clearTimeout(timer);
        try {
          const parsed = JSON.parse(data);
          if (parsed.error) {
            reject(new Error(`IPC error ${parsed.error.code}: ${parsed.error.message}`));
          } else {
            resolve(parsed.result);
          }
        } catch (err) {
          reject(new Error(`failed to parse daemon response: ${err.message}`));
        }
      }
    });
  });
}

async function searchCall(toolName, args) {
  return sendIpcRequest("search-tool-call", {
    agent: AGENT,
    toolName,
    args,
  });
}

function fail(msg) {
  console.error(`SMOKE FAIL — ${msg}`);
  process.exit(1);
}

async function main() {
  console.log(
    `Phase 71 search smoke — agent=${AGENT} query="${QUERY}" socket=${SOCKET_PATH}`,
  );

  // --- Step 1: web_search -----------------------------------------------
  const t0 = performance.now();
  let searchResp;
  try {
    searchResp = await searchCall("web_search", {
      query: QUERY,
      numResults: 3,
    });
  } catch (err) {
    if (err.isDaemonDown) {
      console.error(err.message);
      process.exit(2);
    }
    fail(`web_search threw: ${err.message}`);
  }
  if (!searchResp?.ok) {
    fail(`web_search returned error: ${JSON.stringify(searchResp?.error)}`);
  }
  const results = searchResp.data?.results ?? [];
  if (!Array.isArray(results) || results.length === 0) {
    fail(`web_search returned no results (query=${QUERY})`);
  }
  const first = results[0];
  if (typeof first.title !== "string" || first.title.length === 0) {
    fail(`web_search first result missing title`);
  }
  if (typeof first.url !== "string" || first.url.length === 0) {
    fail(`web_search first result missing url`);
  }
  const searchMs = performance.now() - t0;
  console.log(
    `[1/3] web_search — ${results.length} results, provider=${searchResp.data.provider} (${searchMs.toFixed(0)}ms)`,
  );
  console.log(`       first: "${first.title}" — ${first.url}`);

  // --- Step 2: web_fetch_url --------------------------------------------
  const t1 = performance.now();
  let fetchResp;
  try {
    fetchResp = await searchCall("web_fetch_url", { url: first.url });
  } catch (err) {
    fail(`web_fetch_url threw: ${err.message}`);
  }
  if (!fetchResp?.ok) {
    fail(`web_fetch_url returned error: ${JSON.stringify(fetchResp?.error)}`);
  }
  const text = fetchResp.data?.text ?? "";
  const wordCount = fetchResp.data?.wordCount ?? 0;
  if (typeof text !== "string" || text.length <= 100) {
    fail(
      `web_fetch_url text too short (length=${text?.length ?? 0}, expected > 100)`,
    );
  }
  if (typeof wordCount !== "number" || wordCount <= 10) {
    fail(`web_fetch_url wordCount too low (${wordCount}, expected > 10)`);
  }
  const fetchMs = performance.now() - t1;
  const preview = text.slice(0, 160).replace(/\s+/g, " ");
  console.log(
    `[2/3] web_fetch_url — ${text.length} chars, ${wordCount} words (${fetchMs.toFixed(0)}ms)`,
  );
  console.log(`       preview: "${preview}${text.length > 160 ? "..." : ""}"`);

  // --- Step 3: web_search repeat ----------------------------------------
  // Note: the v1.7 intra-turn idempotent cache lives inside a Turn, not
  // inside the daemon IPC layer — this repeat only re-exercises the
  // transport end-to-end. `cached:true` is only observable from an
  // agent's trace, not from this subprocess smoke.
  const t2 = performance.now();
  let searchResp2;
  try {
    searchResp2 = await searchCall("web_search", {
      query: QUERY,
      numResults: 3,
    });
  } catch (err) {
    fail(`web_search (repeat) threw: ${err.message}`);
  }
  if (!searchResp2?.ok) {
    fail(
      `web_search (repeat) returned error: ${JSON.stringify(searchResp2?.error)}`,
    );
  }
  const search2Ms = performance.now() - t2;
  console.log(
    `[3/3] web_search (repeat) — ${searchResp2.data.results.length} results (${search2Ms.toFixed(0)}ms)`,
  );

  console.log(
    `SMOKE PASS — search: ${searchMs.toFixed(0)}ms, ` +
      `fetch: ${fetchMs.toFixed(0)}ms (${text.length} chars, ${wordCount} words), ` +
      `search2: ${search2Ms.toFixed(0)}ms.`,
  );
  process.exit(0);
}

main().catch((err) => {
  console.error(`SMOKE FAIL — unexpected error: ${err.stack ?? err.message}`);
  process.exit(1);
});
