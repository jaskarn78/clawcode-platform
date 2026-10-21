#!/usr/bin/env node
/**
 * Phase 72 Plan 02 — Image generation E2E smoke.
 *
 * Drives a live daemon's `image-tool-call` IPC end-to-end:
 *   1. image_generate — assert ok=true, images[].length > 0, first image
 *      carries a valid workspace path; verify the file exists on disk
 *      with bytes > 0 (the atomic .tmp + rename(2) pattern from Plan 01
 *      guarantees the file is fully written when this call returns).
 *
 * Usage:
 *   # daemon must be running with OPENAI_API_KEY set
 *   # (or MINIMAX_API_KEY / FAL_API_KEY if defaults.image.backend is
 *   #  "minimax" or "fal")
 *   node scripts/image-smoke.mjs [agent] [prompt]
 *
 *   # defaults (matches 72-CONTEXT headline smoke):
 *   node scripts/image-smoke.mjs clawdy "a cat in a tophat"
 *
 * Expected output (successful run, live daemon + OPENAI_API_KEY):
 *   Phase 72 image smoke — agent=clawdy prompt="a cat in a tophat" socket=/home/user/.clawcode/manager/clawcode.sock
 *   [1/1] image_generate — backend=openai, model=gpt-image-1 (8341ms)
 *          path: /home/user/.clawcode/agents/clawdy/generated-images/1734...-abc.png
 *   SMOKE PASS — image written to <path> (284521 bytes, cost 4¢)
 *
 * Exit codes:
 *   0 — image generated and file exists on disk with bytes > 0
 *   1 — any assertion failed (loud error message)
 *   2 — daemon not running (bring up via `clawcode start-all`)
 */

import { connect } from "node:net";
import { performance } from "node:perf_hooks";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { statSync } from "node:fs";

// Matches SOCKET_PATH / MANAGER_DIR derivation in src/manager/daemon.ts.
const MANAGER_DIR =
  process.env.CLAWCODE_MANAGER_DIR ?? join(homedir(), ".clawcode", "manager");
const SOCKET_PATH =
  process.env.CLAWCODE_SOCKET_PATH ?? join(MANAGER_DIR, "clawcode.sock");

const AGENT = process.argv[2] ?? "clawdy";
const PROMPT = process.argv[3] ?? "a cat in a tophat";
// Image generation can take 30-60s depending on backend + size.
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

async function imageCall(toolName, args) {
  return sendIpcRequest("image-tool-call", {
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
    `Phase 72 image smoke — agent=${AGENT} prompt="${PROMPT}" socket=${SOCKET_PATH}`,
  );

  // --- Step 1: image_generate -------------------------------------------
  const t0 = performance.now();
  let genResp;
  try {
    genResp = await imageCall("image_generate", {
      prompt: PROMPT,
      n: 1,
    });
  } catch (err) {
    if (err.isDaemonDown) {
      console.error(err.message);
      process.exit(2);
    }
    fail(`image_generate threw: ${err.message}`);
  }
  if (!genResp?.ok) {
    fail(`image_generate returned error: ${JSON.stringify(genResp?.error)}`);
  }
  const images = genResp.data?.images ?? [];
  if (!Array.isArray(images) || images.length === 0) {
    fail(`image_generate returned no images`);
  }
  const first = images[0];
  if (typeof first.path !== "string" || first.path.length === 0) {
    fail(`image_generate first image missing path`);
  }
  if (typeof first.backend !== "string" || first.backend.length === 0) {
    fail(`image_generate first image missing backend`);
  }
  if (typeof first.model !== "string" || first.model.length === 0) {
    fail(`image_generate first image missing model`);
  }

  // Verify the file exists on disk with bytes > 0. The atomic .tmp +
  // rename(2) pattern from Plan 01's writeImageToWorkspace guarantees
  // the file is complete when the tool call returns.
  let stat;
  try {
    stat = statSync(first.path);
  } catch (err) {
    fail(`image_generate returned path does not exist on disk: ${first.path} (${err.message})`);
  }
  if (!stat.isFile()) {
    fail(`image_generate returned path is not a file: ${first.path}`);
  }
  if (stat.size === 0) {
    fail(`image_generate returned an empty file (0 bytes): ${first.path}`);
  }

  const genMs = performance.now() - t0;
  const costCents = first.cost_cents ?? 0;
  console.log(
    `[1/1] image_generate — backend=${first.backend}, model=${first.model} (${genMs.toFixed(0)}ms)`,
  );
  console.log(`       path: ${first.path}`);

  console.log(
    `SMOKE PASS — image written to ${first.path} (${stat.size} bytes, cost ${costCents}¢)`,
  );
  process.exit(0);
}

main().catch((err) => {
  console.error(`SMOKE FAIL — unexpected error: ${err.stack ?? err.message}`);
  process.exit(1);
});
