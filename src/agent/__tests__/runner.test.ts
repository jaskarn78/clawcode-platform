import { describe, it, expect, vi, beforeEach } from "vitest";
import { AgentRunner } from "../runner.js";
import { MockSessionAdapter, MockSessionHandle } from "../../manager/session-adapter.js";
import type { AgentSessionConfig } from "../../manager/types.js";

const makeSessionConfig = (): AgentSessionConfig => ({
  name: "test-agent",
  model: "sonnet",
  effort: "low",
  workspace: "/tmp/test",
  systemPrompt: "Be helpful.",
  channels: ["123456"],
});

const noopBridge = {
  start: vi.fn().mockResolvedValue(undefined),
  stop: vi.fn().mockResolvedValue(undefined),
};

describe("AgentRunner", () => {
  let adapter: MockSessionAdapter;
  let sessionConfig: AgentSessionConfig;

  beforeEach(() => {
    adapter = new MockSessionAdapter();
    sessionConfig = makeSessionConfig();
    vi.clearAllMocks();
  });

  describe("start()", () => {
    it("creates a session via the adapter", async () => {
      const runner = new AgentRunner({
        sessionConfig,
        sessionAdapter: adapter,
        discordBridge: noopBridge,
      });

      await runner.start();

      expect(adapter.sessions.size).toBe(1);
      await runner.stop();
    });

    it("calls discordBridge.start()", async () => {
      const bridge = { start: vi.fn().mockResolvedValue(undefined), stop: vi.fn().mockResolvedValue(undefined) };
      const runner = new AgentRunner({ sessionConfig, sessionAdapter: adapter, discordBridge: bridge });

      await runner.start();

      expect(bridge.start).toHaveBeenCalledOnce();
      await runner.stop();
    });

    it("throws if already running", async () => {
      const runner = new AgentRunner({ sessionConfig, sessionAdapter: adapter, discordBridge: noopBridge });
      await runner.start();

      await expect(runner.start()).rejects.toThrow("already running");
      await runner.stop();
    });
  });

  describe("stop()", () => {
    it("closes the session", async () => {
      const runner = new AgentRunner({ sessionConfig, sessionAdapter: adapter, discordBridge: noopBridge });
      await runner.start();

      const [handle] = [...adapter.sessions.values()];
      const closeSpy = vi.spyOn(handle, "close");

      await runner.stop();

      expect(closeSpy).toHaveBeenCalledOnce();
    });

    it("calls discordBridge.stop()", async () => {
      const bridge = { start: vi.fn().mockResolvedValue(undefined), stop: vi.fn().mockResolvedValue(undefined) };
      const runner = new AgentRunner({ sessionConfig, sessionAdapter: adapter, discordBridge: bridge });
      await runner.start();
      await runner.stop();

      expect(bridge.stop).toHaveBeenCalledOnce();
    });

    it("is a no-op if not running", async () => {
      const runner = new AgentRunner({ sessionConfig, sessionAdapter: adapter, discordBridge: noopBridge });
      await expect(runner.stop()).resolves.not.toThrow();
    });
  });

  describe("crash recovery", () => {
    it("restarts session on crash within maxRestarts", async () => {
      const runner = new AgentRunner({
        sessionConfig,
        sessionAdapter: adapter,
        discordBridge: noopBridge,
        maxRestarts: 2,
        backoffBaseMs: 0,
      });

      await runner.start();
      const firstHandle = [...adapter.sessions.values()][0] as MockSessionHandle;

      // Simulate crash
      firstHandle.simulateCrash();

      // Wait for restart
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(adapter.sessions.size).toBeGreaterThan(1);
      await runner.stop();
    });

    it("stops after maxRestarts exceeded", async () => {
      const onExhausted = vi.fn();
      const runner = new AgentRunner({
        sessionConfig,
        sessionAdapter: adapter,
        discordBridge: noopBridge,
        maxRestarts: 1,
        backoffBaseMs: 0,
        onExhausted,
      });

      await runner.start();

      // Crash N+1 times to exhaust restarts
      for (let i = 0; i <= 2; i++) {
        const handles = [...adapter.sessions.values()];
        const last = handles[handles.length - 1] as MockSessionHandle;
        last.simulateCrash();
        await new Promise((resolve) => setTimeout(resolve, 20));
      }

      expect(onExhausted).toHaveBeenCalled();
    });
  });
});
