import { describe, it, expect } from "vitest";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { makeRealCallTool, makeRealListTools } from "../json-rpc-call.js";

const isLinux = process.platform === "linux";

/**
 * Returns true if the given pid is RUNNING (not zombie, not gone). See the
 * twin helper in health.test.ts for why we read /proc directly instead of
 * using `process.kill(pid, 0)`: zombies (post-SIGKILL pre-reap) report
 * alive via signal 0 and would make this test flake under containers
 * where init reaping is delayed.
 */
function pidRunning(pid: number): boolean {
  try {
    const fs = require("node:fs");
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf-8") as string;
    const close = stat.lastIndexOf(")");
    const state = stat.slice(close + 2, close + 3);
    return state !== "Z" && state !== "X";
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ESRCH") return false;
    return true;
  }
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs: number,
  pollMs: number = 25,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, pollMs));
  }
  return predicate();
}

/**
 * Build a node -e fixture that:
 *   1. forks a long-running grandchild that inherits the wrapper's pgid
 *      (wrapper is spawned detached by rpcCall → wrapper.pid == pgid leader)
 *   2. records {wrapper, gc} pids to `idsFile` for the test to read post-cleanup
 *   3. responds to JSON-RPC `initialize` with `result`, then to one follow-up
 *      method (`tools/list` or `tools/call`) with the configured `result`
 *
 * Pre-fix: cleanup SIGKILLs the wrapper PID only; grandchild reparents to
 * PID 1 and survives. Post-fix: detached-spawn + negative-PID kill takes
 * down the whole pgid → both pids reach Z/gone state within ~1s.
 */
function buildLeakFixture(idsFile: string, followUpResult: unknown): string {
  return `
    const fs = require("node:fs");
    const { spawn } = require("node:child_process");
    const gc = spawn("node", ["-e", "setInterval(() => {}, 60000);"], { stdio: "ignore" });
    gc.unref();
    fs.writeFileSync(${JSON.stringify(idsFile)}, JSON.stringify({ wrapper: process.pid, gc: gc.pid }));

    process.stdin.setEncoding("utf-8");
    let buf = "";
    process.stdin.on("data", (chunk) => {
      buf += chunk;
      let nl = buf.indexOf("\\n");
      while (nl !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        nl = buf.indexOf("\\n");
        if (line.length === 0) continue;
        const msg = JSON.parse(line);
        if (msg.id === "init") {
          process.stdout.write(JSON.stringify({
            jsonrpc: "2.0",
            id: "init",
            result: { protocolVersion: "2024-11-05", capabilities: {}, serverInfo: { name: "leak", version: "0" } },
          }) + "\\n");
        } else if (msg.id === "call") {
          process.stdout.write(JSON.stringify({
            jsonrpc: "2.0",
            id: "call",
            result: ${JSON.stringify(followUpResult)},
          }) + "\\n");
        }
      }
    });
  `;
}

describe("json-rpc-call: makeRealListTools / makeRealCallTool", () => {
  it.skipIf(!isLinux)(
    "tools/list group-kills wrapper + grandchildren on cleanup",
    async () => {
      const dir = await mkdtemp(path.join(tmpdir(), "mcp-rpc-list-leak-"));
      const idsFile = path.join(dir, "ids.json");
      const fixture = buildLeakFixture(idsFile, {
        tools: [{ name: "echo" }, { name: "ping" }],
      });

      const serversByName = new Map([
        [
          "leak-list",
          { name: "leak-list", command: "node", args: ["-e", fixture], env: {} },
        ],
      ]);
      const listTools = makeRealListTools(serversByName);
      const tools = await listTools("leak-list");
      expect(tools.map((t) => t.name).sort()).toEqual(["echo", "ping"]);

      const ids = JSON.parse(await readFile(idsFile, "utf-8")) as { wrapper: number; gc: number };
      expect(ids.wrapper).toBeGreaterThan(1);
      expect(ids.gc).toBeGreaterThan(1);

      const wrapperGone = await waitFor(() => !pidRunning(ids.wrapper), 1500);
      const gcGone = await waitFor(() => !pidRunning(ids.gc), 1500);
      expect(wrapperGone).toBe(true);
      expect(gcGone).toBe(true);
    },
    10000,
  );

  it.skipIf(!isLinux)(
    "tools/call group-kills wrapper + grandchildren on cleanup",
    async () => {
      const dir = await mkdtemp(path.join(tmpdir(), "mcp-rpc-call-leak-"));
      const idsFile = path.join(dir, "ids.json");
      const fixture = buildLeakFixture(idsFile, {
        content: [{ type: "text", text: "ok" }],
      });

      const serversByName = new Map([
        [
          "leak-call",
          { name: "leak-call", command: "node", args: ["-e", fixture], env: {} },
        ],
      ]);
      const callTool = makeRealCallTool(serversByName);
      const result = await callTool("leak-call", "echo", { msg: "hi" });
      expect(result).toEqual({ content: [{ type: "text", text: "ok" }] });

      const ids = JSON.parse(await readFile(idsFile, "utf-8")) as { wrapper: number; gc: number };

      const wrapperGone = await waitFor(() => !pidRunning(ids.wrapper), 1500);
      const gcGone = await waitFor(() => !pidRunning(ids.gc), 1500);
      expect(wrapperGone).toBe(true);
      expect(gcGone).toBe(true);
    },
    10000,
  );

  it.skipIf(!isLinux)(
    "timeout cleanup also group-kills grandchildren (no PPID=1 leak on hang)",
    async () => {
      const dir = await mkdtemp(path.join(tmpdir(), "mcp-rpc-timeout-leak-"));
      const idsFile = path.join(dir, "ids.json");
      // Wrapper records ids + spawns grandchild, then never responds.
      const hangScript = `
        const fs = require("node:fs");
        const { spawn } = require("node:child_process");
        const gc = spawn("node", ["-e", "setInterval(() => {}, 60000);"], { stdio: "ignore" });
        gc.unref();
        fs.writeFileSync(${JSON.stringify(idsFile)}, JSON.stringify({ wrapper: process.pid, gc: gc.pid }));
        setInterval(() => {}, 60000);
      `;

      const serversByName = new Map([
        [
          "leak-hang",
          { name: "leak-hang", command: "node", args: ["-e", hangScript], env: {} },
        ],
      ]);
      const listTools = makeRealListTools(serversByName);
      // rpcCall's internal RPC_TIMEOUT_MS is 8s; production exercises that.
      await expect(listTools("leak-hang")).rejects.toThrow(/timed out/);

      const ids = JSON.parse(await readFile(idsFile, "utf-8")) as { wrapper: number; gc: number };

      const wrapperGone = await waitFor(() => !pidRunning(ids.wrapper), 1500);
      const gcGone = await waitFor(() => !pidRunning(ids.gc), 1500);
      expect(wrapperGone).toBe(true);
      expect(gcGone).toBe(true);
    },
    15000,
  );
});
