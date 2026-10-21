import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { HeartbeatRunner } from "../runner.js";
import type { HeartbeatConfig } from "../types.js";

function createMockSessionManager(agents: string[] = ["agent-a"]) {
  return {
    getRunningAgents: vi.fn().mockReturnValue(agents),
    getContextFillProvider: vi.fn().mockReturnValue(undefined),
    getCompactionManager: vi.fn().mockReturnValue(undefined),
    getMemoryStore: vi.fn().mockReturnValue(undefined),
  } as any;
}

function createMockLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn().mockReturnThis(),
  } as any;
}

function defaultConfig(): HeartbeatConfig {
  return {
    enabled: true,
    intervalSeconds: 60,
    checkTimeoutSeconds: 10,
    contextFill: { warningThreshold: 0.6, criticalThreshold: 0.75 },
  };
}

describe("HeartbeatRunner active-state provider (125-01-T03)", () => {
  let tempDir: string;
  let checksDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "hb-active-state-"));
    checksDir = join(tempDir, "checks");
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("when provider returns a string, lastProbeText contains it with ACTIVE STATE wrapper", async () => {
    const runner = new HeartbeatRunner({
      sessionManager: createMockSessionManager(["agent-a"]),
      registryPath: join(tempDir, "registry.json"),
      config: defaultConfig(),
      checksDir,
      log: createMockLogger(),
    });
    runner.setActiveStateProvider(async () => "primary client: Acme");
    await runner.tick();
    const text = runner.getLastProbeText("agent-a");
    expect(text).toBeDefined();
    expect(text).toContain("--- ACTIVE STATE ---");
    expect(text).toContain("primary client: Acme");
    expect(text).toContain("--- end ---");
  });

  it("when provider returns null, lastProbeText is unchanged (undefined)", async () => {
    const runner = new HeartbeatRunner({
      sessionManager: createMockSessionManager(["agent-a"]),
      registryPath: join(tempDir, "registry.json"),
      config: defaultConfig(),
      checksDir,
      log: createMockLogger(),
    });
    runner.setActiveStateProvider(async () => null);
    await runner.tick();
    expect(runner.getLastProbeText("agent-a")).toBeUndefined();
  });

  it("when provider throws, the tick continues + warn is logged", async () => {
    const log = createMockLogger();
    const runner = new HeartbeatRunner({
      sessionManager: createMockSessionManager(["agent-a"]),
      registryPath: join(tempDir, "registry.json"),
      config: defaultConfig(),
      checksDir,
      log,
    });
    runner.setActiveStateProvider(async () => {
      throw new Error("boom");
    });
    await runner.tick();
    expect(runner.getLastProbeText("agent-a")).toBeUndefined();
    expect(log.warn).toHaveBeenCalled();
    const warnCalls = (log.warn as any).mock.calls as readonly any[][];
    const matched = warnCalls.some(
      (call) =>
        typeof call[1] === "string" && call[1].includes("active-state provider"),
    );
    expect(matched).toBe(true);
  });

  it("with provider unset (back-compat), tick runs without touching lastProbeText", async () => {
    const runner = new HeartbeatRunner({
      sessionManager: createMockSessionManager(["agent-a"]),
      registryPath: join(tempDir, "registry.json"),
      config: defaultConfig(),
      checksDir,
      log: createMockLogger(),
    });
    await runner.tick();
    expect(runner.getLastProbeText("agent-a")).toBeUndefined();
  });

  it("provider is invoked exactly once per agent per tick (even with two agents)", async () => {
    const calls: string[] = [];
    const runner = new HeartbeatRunner({
      sessionManager: createMockSessionManager(["agent-a", "agent-b"]),
      registryPath: join(tempDir, "registry.json"),
      config: defaultConfig(),
      checksDir,
      log: createMockLogger(),
    });
    runner.setActiveStateProvider(async (agent) => {
      calls.push(agent);
      return `state-for-${agent}`;
    });
    await runner.tick();
    expect(calls.sort()).toEqual(["agent-a", "agent-b"]);
    expect(runner.getLastProbeText("agent-a")).toContain("state-for-agent-a");
    expect(runner.getLastProbeText("agent-b")).toContain("state-for-agent-b");
  });
});
