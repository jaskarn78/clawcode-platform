import { describe, it, expect, afterEach } from "vitest";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import type { Server } from "node:net";
import { createIpcServer } from "../server.js";
import { sendIpcRequest } from "../client.js";
import { ManagerNotRunningError } from "../../shared/errors.js";

describe("IPC client-server", () => {
  let tmpDir: string;
  let socketPath: string;
  let server: Server | null = null;

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve) => {
        server!.close(() => resolve());
      });
      server = null;
    }
    if (tmpDir) {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  async function setupServer(): Promise<void> {
    tmpDir = await mkdtemp(join(tmpdir(), "ipc-test-"));
    socketPath = join(tmpDir, "test.sock");
  }

  it("handles round-trip status request", async () => {
    await setupServer();

    const mockEntries = [
      { name: "agent-1", status: "running" },
      { name: "agent-2", status: "stopped" },
    ];

    server = createIpcServer(socketPath, async (method, _params) => {
      if (method === "status") {
        return { entries: mockEntries };
      }
      throw new Error(`Unknown method: ${method}`);
    });

    // Wait for server to be ready
    await new Promise<void>((resolve) => {
      server!.on("listening", () => resolve());
    });

    const result = await sendIpcRequest(socketPath, "status", {});
    expect(result).toEqual({ entries: mockEntries });
  });

  it("returns JSON-RPC error for unknown method", async () => {
    await setupServer();

    server = createIpcServer(socketPath, async (method, _params) => {
      throw new Error(`Unknown method: ${method}`);
    });

    await new Promise<void>((resolve) => {
      server!.on("listening", () => resolve());
    });

    await expect(
      sendIpcRequest(socketPath, "unknown-method" as string, {}),
    ).rejects.toThrow();
  });

  it("returns JSON-RPC error when handler throws", async () => {
    await setupServer();

    server = createIpcServer(socketPath, async () => {
      throw new Error("Handler exploded");
    });

    await new Promise<void>((resolve) => {
      server!.on("listening", () => resolve());
    });

    await expect(
      sendIpcRequest(socketPath, "status", {}),
    ).rejects.toThrow(/handler exploded/i);
  });

  it("throws ManagerNotRunningError when no server is running", async () => {
    await setupServer();
    const noServerPath = join(tmpDir, "nonexistent.sock");

    await expect(
      sendIpcRequest(noServerPath, "status", {}),
    ).rejects.toThrow(ManagerNotRunningError);
  });
});
