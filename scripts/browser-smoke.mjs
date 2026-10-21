#!/usr/bin/env node
/**
 * Phase 70 Plan 03 — Browser automation E2E smoke.
 *
 * Drives a live daemon's `browser-tool-call` IPC against a real URL,
 * exercising the full chain: auto-injected `browser` MCP config →
 * BrowserManager singleton → per-agent BrowserContext → the 6 pure
 * tool handlers in src/browser/tools.ts.
 *
 * Three steps against the target URL (default https://example.com):
 *   1. browser_navigate    → assert status === 200
 *   2. browser_screenshot  → assert the PNG was written to disk
 *   3. browser_extract     → assert readability text is non-empty and
 *                            (for example.com) contains "Example Domain"
 *
 * Usage:
 *   # daemon must be running
 *   node scripts/browser-smoke.mjs [agent] [url]
 *
 *   # defaults
 *   node scripts/browser-smoke.mjs clawdy https://example.com
 *
 * Exit codes:
 *   0 — all 3 steps succeeded
 *   1 — any step failed (loud error message)
 *   2 — daemon not running (bring up via `clawcode start-all`)
 */

import { connect } from "node:net";
import { performance } from "node:perf_hooks";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

// Matches SOCKET_PATH / MANAGER_DIR derivation in src/manager/daemon.ts.
const MANAGER_DIR = process.env.CLAWCODE_MANAGER_DIR ?? join(homedir(), ".clawcode", "manager");
const SOCKET_PATH = process.env.CLAWCODE_SOCKET_PATH ?? join(MANAGER_DIR, "clawcode.sock");

const AGENT = process.argv[2] ?? "clawdy";
const URL_ARG = process.argv[3] ?? "https://example.com";
const STEP_TIMEOUT_MS = 60_000;

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

async function browserCall(toolName, args) {
  return sendIpcRequest("browser-tool-call", { agent: AGENT, toolName, args });
}

function fail(msg) {
  console.error(`SMOKE FAIL — ${msg}`);
  process.exit(1);
}

async function main() {
  console.log(`Phase 70 browser smoke — agent=${AGENT} url=${URL_ARG} socket=${SOCKET_PATH}`);

  // --- Step 1: navigate ------------------------------------------------
  const t0 = performance.now();
  let navResp;
  try {
    navResp = await browserCall("browser_navigate", { url: URL_ARG });
  } catch (err) {
    if (err.isDaemonDown) {
      console.error(err.message);
      process.exit(2);
    }
    fail(`browser_navigate threw: ${err.message}`);
  }
  if (!navResp?.ok) {
    fail(`browser_navigate returned error: ${JSON.stringify(navResp?.error)}`);
  }
  if (navResp.data?.status !== 200) {
    fail(`browser_navigate status=${navResp.data?.status} (expected 200)`);
  }
  const navMs = performance.now() - t0;
  console.log(`[1/3] navigated to ${navResp.data.url} (${navResp.data.title}) — status=${navResp.data.status} (${navMs.toFixed(0)}ms)`);

  // --- Step 2: screenshot ---------------------------------------------
  const t1 = performance.now();
  let shotResp;
  try {
    shotResp = await browserCall("browser_screenshot", { fullPage: true });
  } catch (err) {
    fail(`browser_screenshot threw: ${err.message}`);
  }
  if (!shotResp?.ok) {
    fail(`browser_screenshot returned error: ${JSON.stringify(shotResp?.error)}`);
  }
  if (typeof shotResp.data?.path !== "string" || shotResp.data.path.length === 0) {
    fail(`browser_screenshot path missing or empty`);
  }
  const shotMs = performance.now() - t1;
  const inlined = typeof shotResp.data.inlineBase64 === "string";
  console.log(`[2/3] screenshot saved to ${shotResp.data.path} (${shotResp.data.bytes} bytes, inlined=${inlined}) (${shotMs.toFixed(0)}ms)`);

  // --- Step 3: extract (readability) -----------------------------------
  const t2 = performance.now();
  let extractResp;
  try {
    extractResp = await browserCall("browser_extract", { mode: "readability" });
  } catch (err) {
    fail(`browser_extract threw: ${err.message}`);
  }
  if (!extractResp?.ok) {
    fail(`browser_extract returned error: ${JSON.stringify(extractResp?.error)}`);
  }
  const text = extractResp.data?.text ?? "";
  if (typeof text !== "string" || text.length === 0) {
    fail(`browser_extract returned no text`);
  }
  const extractMs = performance.now() - t2;
  const preview = text.slice(0, 200).replace(/\s+/g, " ");
  console.log(`[3/3] extracted ${text.length} chars — "${preview}${text.length > 200 ? "..." : ""}" (${extractMs.toFixed(0)}ms)`);

  // --- Step 4: example.com specific assertion --------------------------
  if (URL_ARG.includes("example.com") && !/example domain/i.test(text)) {
    fail(`example.com extract text did not contain "Example Domain"`);
  }

  console.log(
    `SMOKE PASS — navigate: ${navMs.toFixed(0)}ms, ` +
    `screenshot: ${shotMs.toFixed(0)}ms (${shotResp.data.bytes}B), ` +
    `extract: ${extractMs.toFixed(0)}ms (${text.length} chars).`
  );
  process.exit(0);
}

main().catch((err) => {
  console.error(`SMOKE FAIL — unexpected error: ${err.stack ?? err.message}`);
  process.exit(1);
});
