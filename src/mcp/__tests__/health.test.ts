import { describe, it, expect } from "vitest";
import { checkMcpServerHealth } from "../health.js";

const isLinux = process.platform === "linux";

/**
 * Returns true if the given pid is still RUNNING (not zombie, not gone).
 *
 * `process.kill(pid, 0)` returns success even for zombies (a process that
 * received SIGKILL but hasn't been reaped by its parent yet) which would
 * make a kill-then-poll test flaky in CI containers where init reaping is
 * delayed. Read /proc/<pid>/stat directly: gone (ENOENT) or state == 'Z'
 * means our SIGKILL landed.
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

describe("checkMcpServerHealth", () => {
  it("returns healthy when server responds to initialize", async () => {
    // Mock server: reads stdin, responds with JSON-RPC initialize result
    const mockServerScript = `
      process.stdin.setEncoding("utf-8");
      let buf = "";
      process.stdin.on("data", (chunk) => {
        buf += chunk;
        if (buf.includes("\\n")) {
          const msg = JSON.parse(buf.trim());
          const response = JSON.stringify({
            jsonrpc: "2.0",
            id: msg.id,
            result: {
              protocolVersion: "2024-11-05",
              capabilities: {},
              serverInfo: { name: "test-server", version: "0.1.0" },
            },
          });
          process.stdout.write(response + "\\n");
        }
      });
    `;

    const result = await checkMcpServerHealth(
      { name: "test-server", command: "node", args: ["-e", mockServerScript], env: {} },
      5000,
    );

    expect(result.name).toBe("test-server");
    expect(result.healthy).toBe(true);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(result.error).toBeUndefined();
  });

  it("returns unhealthy when process fails to start", async () => {
    const result = await checkMcpServerHealth(
      { name: "bad-server", command: "nonexistent-command-xyz", args: [], env: {} },
      3000,
    );

    expect(result.name).toBe("bad-server");
    expect(result.healthy).toBe(false);
    expect(result.error).toBeDefined();
  });

  it("returns unhealthy when server times out", async () => {
    // Server that never responds
    const hangScript = `setInterval(() => {}, 10000);`;

    const result = await checkMcpServerHealth(
      { name: "slow-server", command: "node", args: ["-e", hangScript], env: {} },
      500, // Very short timeout
    );

    expect(result.name).toBe("slow-server");
    expect(result.healthy).toBe(false);
    expect(result.error).toContain("timed out");
    expect(result.latencyMs).toBeGreaterThanOrEqual(400);
  }, 10000);

  it("returns unhealthy when server exits immediately", async () => {
    const exitScript = `process.exit(1);`;

    const result = await checkMcpServerHealth(
      { name: "crash-server", command: "node", args: ["-e", exitScript], env: {} },
      3000,
    );

    expect(result.name).toBe("crash-server");
    expect(result.healthy).toBe(false);
    expect(result.error).toBeDefined();
  });

  // Regression: pre-fix, child.kill("SIGKILL") only signaled the wrapper PID;
  // a forked grandchild reparented to PID 1 and survived (e.g.
  // mcp-server-mysql holding a MariaDB connection). Now we spawn detached
  // (child becomes pgid leader) and group-kill via negative PID, which
  // reaches every member of the wrapper's process group.
  //
  // Fixture: wrapper writes its OWN pid + spawned grandchild's pid to a
  // temp file, then completes the JSON-RPC handshake. After
  // checkMcpServerHealth returns, both pids should reach Z/gone state
  // within ~1s as SIGKILL propagates through the wrapper's process group.
  it.skipIf(!isLinux)(
    "group-kills wrapper + grandchildren on cleanup (no PPID=1 leak)",
    async () => {
      const { mkdtemp, readFile } = await import("node:fs/promises");
      const { tmpdir } = await import("node:os");
      const path = await import("node:path");
      const dir = await mkdtemp(path.join(tmpdir(), "mcp-health-leak-"));
      const idsFile = path.join(dir, "ids.json");
      const fixture = `
        const fs = require("node:fs");
        const { spawn } = require("node:child_process");
        const gc = spawn("node", ["-e", "setInterval(() => {}, 60000);"], { stdio: "ignore" });
        gc.unref();
        fs.writeFileSync(${JSON.stringify(idsFile)}, JSON.stringify({ wrapper: process.pid, gc: gc.pid }));
        process.stdin.setEncoding("utf-8");
        let buf = "";
        process.stdin.on("data", (chunk) => {
          buf += chunk;
          if (buf.includes("\\n")) {
            const msg = JSON.parse(buf.trim());
            process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2024-11-05", capabilities: {}, serverInfo: { name: "leak", version: "0" } } }) + "\\n");
          }
        });
      `;

      const result = await checkMcpServerHealth(
        { name: "leak-fixture", command: "node", args: ["-e", fixture], env: {} },
        5000,
      );
      expect(result.healthy).toBe(true);

      const ids = JSON.parse(await readFile(idsFile, "utf-8")) as {
        wrapper: number;
        gc: number;
      };
      expect(ids.wrapper).toBeGreaterThan(1);
      expect(ids.gc).toBeGreaterThan(1);

      const wrapperGone = await waitFor(() => !pidRunning(ids.wrapper), 1500);
      const gcGone = await waitFor(() => !pidRunning(ids.gc), 1500);
      expect(wrapperGone).toBe(true);
      // The actual leak: pre-fix the grandchild survived as PPID=1.
      expect(gcGone).toBe(true);
    },
  );

  // Same regression on the timeout path: wrapper hangs past the health-check
  // budget; cleanup must still group-kill the grandchild.
  it.skipIf(!isLinux)(
    "group-kills grandchildren on timeout cleanup",
    async () => {
      const { mkdtemp, readFile } = await import("node:fs/promises");
      const { tmpdir } = await import("node:os");
      const path = await import("node:path");
      const dir = await mkdtemp(path.join(tmpdir(), "mcp-health-leak-timeout-"));
      const idsFile = path.join(dir, "ids.json");
      const hangScript = `
        const fs = require("node:fs");
        const { spawn } = require("node:child_process");
        const gc = spawn("node", ["-e", "setInterval(() => {}, 60000);"], { stdio: "ignore" });
        gc.unref();
        fs.writeFileSync(${JSON.stringify(idsFile)}, JSON.stringify({ wrapper: process.pid, gc: gc.pid }));
        setInterval(() => {}, 60000); // never respond
      `;

      const result = await checkMcpServerHealth(
        { name: "leak-timeout-fixture", command: "node", args: ["-e", hangScript], env: {} },
        500,
      );
      expect(result.healthy).toBe(false);
      expect(result.error).toContain("timed out");

      const ids = JSON.parse(await readFile(idsFile, "utf-8")) as {
        wrapper: number;
        gc: number;
      };

      const wrapperGone = await waitFor(() => !pidRunning(ids.wrapper), 1500);
      const gcGone = await waitFor(() => !pidRunning(ids.gc), 1500);
      expect(wrapperGone).toBe(true);
      expect(gcGone).toBe(true);
    },
    10000,
  );
});
