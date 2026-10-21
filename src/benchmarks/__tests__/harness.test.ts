import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  spawnIsolatedDaemon,
  awaitDaemonReady,
  writeBenchAgentConfig,
  type SpawnedChild,
} from "../harness.js";

describe("spawnIsolatedDaemon", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "harness-test-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("returns a handle with the tempdir-scoped socket path", async () => {
    const fakeChild: SpawnedChild = { pid: 9999, kill: vi.fn() };
    const spawner = vi.fn(() => fakeChild);
    const handle = await spawnIsolatedDaemon({
      tmpHome: tmp,
      configPath: join(tmp, "clawcode-bench.yaml"),
      spawner,
    });
    expect(handle.pid).toBe(9999);
    expect(handle.socketPath).toBe(
      join(tmp, ".clawcode", "manager", "clawcode.sock"),
    );
    expect(spawner).toHaveBeenCalledTimes(1);
    const call = spawner.mock.calls[0]! as unknown as [
      string,
      readonly string[],
      NodeJS.ProcessEnv,
    ];
    expect(call[0]).toBe("npx");
    // `args` includes `--config` + the configPath
    expect(call[1]).toContain("--config");
    expect(call[2].HOME).toBe(tmp);
  });

  it("stop() SIGTERMs the child and unlinks the socket", async () => {
    const killSpy = vi.fn();
    const fakeChild: SpawnedChild = { pid: 4242, kill: killSpy };
    const spawner = vi.fn(() => fakeChild);
    const handle = await spawnIsolatedDaemon({
      tmpHome: tmp,
      configPath: join(tmp, "clawcode-bench.yaml"),
      spawner,
    });

    // Create a placeholder socket file so stop() has something to unlink.
    writeFileSync(handle.socketPath, "", "utf-8");
    expect(existsSync(handle.socketPath)).toBe(true);

    await handle.stop();
    expect(killSpy).toHaveBeenCalledWith("SIGTERM");
    expect(existsSync(handle.socketPath)).toBe(false);
  });

  it("stop() is idempotent when the socket is already gone", async () => {
    const fakeChild: SpawnedChild = { pid: 4242, kill: vi.fn() };
    const handle = await spawnIsolatedDaemon({
      tmpHome: tmp,
      configPath: join(tmp, "clawcode-bench.yaml"),
      spawner: () => fakeChild,
    });
    // No socket created — stop() should still complete cleanly.
    await expect(handle.stop()).resolves.toBeUndefined();
  });

  it("throws when the spawner returns a child with no pid", async () => {
    const badChild = { pid: undefined, kill: vi.fn() } as unknown as SpawnedChild;
    await expect(
      spawnIsolatedDaemon({
        tmpHome: tmp,
        configPath: join(tmp, "clawcode-bench.yaml"),
        spawner: () => badChild,
      }),
    ).rejects.toThrow(/no pid/);
  });
});

describe("awaitDaemonReady", () => {
  it("resolves true when the stub IPC client returns on attempt 2", async () => {
    let attempts = 0;
    const ipcClient = vi.fn(async () => {
      attempts += 1;
      if (attempts < 2) throw new Error("not yet");
      return { ok: true };
    });
    const ready = await awaitDaemonReady("/tmp/fake.sock", {
      maxAttempts: 3,
      delayMs: 5,
      ipcClient,
    });
    expect(ready).toBe(true);
    expect(attempts).toBe(2);
  });

  it("resolves false when all attempts fail", async () => {
    const ipcClient = vi.fn(async () => {
      throw new Error("still down");
    });
    const ready = await awaitDaemonReady("/tmp/fake.sock", {
      maxAttempts: 3,
      delayMs: 5,
      ipcClient,
    });
    expect(ready).toBe(false);
    expect(ipcClient).toHaveBeenCalledTimes(3);
  });
});

describe("writeBenchAgentConfig", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "bench-cfg-test-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("writes a minimal clawcode.yaml that round-trips through loadConfig", async () => {
    const path = await writeBenchAgentConfig(tmp, {
      agentName: "bench-agent",
    });
    expect(path).toBe(join(tmp, "clawcode-bench.yaml"));
    expect(existsSync(path)).toBe(true);

    // Round-trip via the real config loader. This exercises the full Zod
    // validation path.
    const { loadConfig } = await import("../../config/loader.js");
    const cfg = await loadConfig(path);
    expect(cfg.agents).toHaveLength(1);
    expect(cfg.agents[0]!.name).toBe("bench-agent");
    expect(cfg.agents[0]!.model).toBe("haiku");
    expect(cfg.agents[0]!.channels).toEqual([]);
  });

  it("honors the optional model override", async () => {
    const path = await writeBenchAgentConfig(tmp, {
      agentName: "bench-agent",
      model: "sonnet",
    });
    const { loadConfig } = await import("../../config/loader.js");
    const cfg = await loadConfig(path);
    expect(cfg.agents[0]!.model).toBe("sonnet");
  });
});
