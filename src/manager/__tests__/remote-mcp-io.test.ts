import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import { createServer, type AddressInfo } from "node:net";
import { listChildArgv, tcpReachable } from "../remote-mcp-io.js";

const onLinux = process.platform === "linux";

describe.runIf(onLinux)("listChildArgv (/proc)", () => {
  it("returns the exact argv of a live direct child", async () => {
    const child = spawn("sleep", ["30"], { stdio: "ignore" });
    try {
      await new Promise((r) => setTimeout(r, 100));
      const argvs = await listChildArgv(process.pid);
      expect(argvs).not.toBeNull();
      expect(argvs!.some((a) => a.length === 2 && a[0] === "sleep" && a[1] === "30")).toBe(true);
    } finally {
      child.kill("SIGKILL");
    }
  });

  it("sees grandchildren too (bwrap-sandboxed CLI → MCP servers are grandchildren)", async () => {
    const child = spawn("sh", ["-c", "sleep 33; true"], { stdio: "ignore" });
    try {
      await new Promise((r) => setTimeout(r, 150));
      const argvs = await listChildArgv(process.pid);
      expect(argvs!.some((a) => a[0] === "sleep" && a[1] === "33")).toBe(true);
    } finally {
      child.kill("SIGKILL");
      spawn("pkill", ["-P", String(child.pid)]);
    }
  });

  it("drops the child once it has exited", async () => {
    const child = spawn("sleep", ["31"], { stdio: "ignore" });
    await new Promise((r) => setTimeout(r, 100));
    child.kill("SIGKILL");
    await new Promise((r) => child.once("exit", r));
    const argvs = await listChildArgv(process.pid);
    expect(argvs!.some((a) => a[0] === "sleep" && a[1] === "31")).toBe(false);
  });
});

describe("tcpReachable", () => {
  it("true for a listening port, false for a closed one", async () => {
    const srv = createServer((s) => s.destroy());
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    const port = (srv.address() as AddressInfo).port;
    expect(await tcpReachable("127.0.0.1", port, 1_000)).toBe(true);
    await new Promise<void>((r) => srv.close(() => r()));
    expect(await tcpReachable("127.0.0.1", port, 1_000)).toBe(false);
  });
});
