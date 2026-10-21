import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { handleBrowserToolCall } from "../../browser/daemon-handler.js";
import { BrowserManager } from "../../browser/manager.js";
import type { BrowserDriver, BrowserLike } from "../../browser/manager.js";
import type { BrowserContext } from "../../browser/types.js";
import type { BrowserConfig } from "../../config/schema.js";
import type { ResolvedAgentConfig } from "../../shared/types.js";
import type { IpcBrowserToolCallParams } from "../types.js";

/**
 * Phase 70 Plan 03 — `browser-tool-call` IPC handler tests.
 *
 * These tests run the real `handleBrowserToolCall` against a real
 * `BrowserManager` instance whose driver seam is filled with a mock
 * Chromium. No real browser, no real IPC socket — the handler's
 * forward-to-tools.ts dispatch, agent-resolution, lazy-warm branch,
 * and saveAgentState-on-write behavior are all exercised in-process.
 */

// --- mock driver + page/context fakes ------------------------------------

function makeFakePage(overrides: Record<string, unknown> = {}) {
  const locator = {
    click: vi.fn(async () => undefined),
    fill: vi.fn(async () => undefined),
    textContent: vi.fn(async () => "text"),
    innerHTML: vi.fn(async () => "<p>text</p>"),
    first: vi.fn(() => locator),
    waitFor: vi.fn(async () => undefined),
  };
  return {
    url: vi.fn(() => "http://localhost/test"),
    title: vi.fn(async () => "Test Page"),
    content: vi.fn(async () => "<html><body>Hi</body></html>"),
    goto: vi.fn(async () => ({ status: () => 200 })),
    screenshot: vi.fn(async () => Buffer.from("png-bytes")),
    locator: vi.fn(() => locator),
    waitForURL: vi.fn(async () => undefined),
    waitForLoadState: vi.fn(async () => undefined),
    ...overrides,
  };
}

function makeFakeContext(page: ReturnType<typeof makeFakePage>) {
  return {
    pages: () => [page],
    newPage: async () => page,
    storageState: async () => ({ cookies: [], origins: [] }),
    close: vi.fn(async () => undefined),
    on: vi.fn(),
  } as unknown as BrowserContext;
}

function makeMockDriver(
  pages: Array<ReturnType<typeof makeFakePage>>,
): BrowserDriver {
  let callCount = 0;
  const browser: BrowserLike = {
    newContext: vi.fn(async () => {
      // The manager's probe calls newContext() once before any agent
      // getContext; give that a trivial fake so probe passes.
      if (callCount === 0) {
        callCount++;
        return makeFakeContext(makeFakePage());
      }
      const page = pages[callCount - 1] ?? makeFakePage();
      callCount++;
      return makeFakeContext(page);
    }),
    close: vi.fn(async () => undefined),
  };
  return { launch: vi.fn(async () => browser) };
}

// --- shared builders ------------------------------------------------------

const BROWSER_CONFIG_ENABLED: BrowserConfig = {
  enabled: true,
  headless: true,
  warmOnBoot: true,
  navigationTimeoutMs: 30000,
  actionTimeoutMs: 10000,
  viewport: { width: 1280, height: 720 },
  userAgent: null,
  maxScreenshotInlineBytes: 524288,
};

function makeAgent(name: string, workspace: string): ResolvedAgentConfig {
  return {
    name,
    workspace,
    channels: [],
    model: "sonnet",
    effort: "low",
    skills: [],
    memory: {
      compactionThreshold: 0.75,
      searchTopK: 10,
      consolidation: { enabled: true, weeklyThreshold: 7, monthlyThreshold: 4, schedule: "0 3 * * *" },
      decay: { halfLifeDays: 30, semanticWeight: 0.7, decayWeight: 0.3 },
      deduplication: { enabled: true, similarityThreshold: 0.85 },
      tiers: { hotAccessThreshold: 3, hotAccessWindowDays: 7, hotDemotionDays: 7, coldRelevanceThreshold: 0.05, hotBudget: 20 },
      episodes: { archivalAgeDays: 90 },
    },
    skillsPath: "/tmp/skills",
    heartbeat: {
      enabled: true,
      intervalSeconds: 60,
      checkTimeoutSeconds: 10,
      contextFill: { warningThreshold: 0.6, criticalThreshold: 0.75, zoneThresholds: { yellow: 0.5, orange: 0.7, red: 0.85 } },
    },
    schedules: [],
    admin: false,
    threads: { idleTimeoutMinutes: 1440, maxThreadSessions: 10 },
    reactions: true,
    mcpServers: [],
    slashCommands: [],
  } as unknown as ResolvedAgentConfig;
}

describe("handleBrowserToolCall (Phase 70 Plan 03)", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "browser-tool-call-test-"));
  });

  async function cleanup() {
    await rm(tmpDir, { recursive: true, force: true });
  }

  it("routes browser_navigate to the pure handler and returns a success envelope", async () => {
    const page = makeFakePage();
    const driver = makeMockDriver([page]);
    const manager = new BrowserManager({ driver });
    await manager.warm();

    const agent = makeAgent("clawdy", tmpDir);
    const params: IpcBrowserToolCallParams = {
      agent: "clawdy",
      toolName: "browser_navigate",
      args: { url: "http://localhost/test" },
    };
    const outcome = await handleBrowserToolCall(
      { browserManager: manager, resolvedAgents: [agent], browserConfig: BROWSER_CONFIG_ENABLED },
      params,
    );
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.data).toMatchObject({
        url: "http://localhost/test",
        title: "Test Page",
        status: 200,
      });
    }
    await manager.close();
    await cleanup();
  });

  it("triggers saveAgentState on navigate (write-producing tool)", async () => {
    const page = makeFakePage();
    const driver = makeMockDriver([page]);
    const manager = new BrowserManager({ driver });
    await manager.warm();

    const saveSpy = vi.spyOn(manager, "saveAgentState");
    const agent = makeAgent("clawdy", tmpDir);

    await handleBrowserToolCall(
      { browserManager: manager, resolvedAgents: [agent], browserConfig: BROWSER_CONFIG_ENABLED },
      { agent: "clawdy", toolName: "browser_navigate", args: { url: "http://localhost/test" } },
    );
    expect(saveSpy).toHaveBeenCalledTimes(1);
    expect(saveSpy).toHaveBeenCalledWith("clawdy");
    await manager.close();
    await cleanup();
  });

  it("does NOT trigger saveAgentState on screenshot (read-only tool)", async () => {
    const page = makeFakePage();
    const driver = makeMockDriver([page]);
    const manager = new BrowserManager({ driver });
    await manager.warm();

    const saveSpy = vi.spyOn(manager, "saveAgentState");
    const agent = makeAgent("clawdy", tmpDir);

    const outcome = await handleBrowserToolCall(
      { browserManager: manager, resolvedAgents: [agent], browserConfig: BROWSER_CONFIG_ENABLED },
      { agent: "clawdy", toolName: "browser_screenshot", args: { fullPage: false } },
    );
    expect(outcome.ok).toBe(true);
    expect(saveSpy).not.toHaveBeenCalled();
    await manager.close();
    await cleanup();
  });

  it("does NOT trigger saveAgentState on extract or wait_for (read-only tools)", async () => {
    const page = makeFakePage();
    const driver = makeMockDriver([page]);
    const manager = new BrowserManager({ driver });
    await manager.warm();

    const saveSpy = vi.spyOn(manager, "saveAgentState");
    const agent = makeAgent("clawdy", tmpDir);

    await handleBrowserToolCall(
      { browserManager: manager, resolvedAgents: [agent], browserConfig: BROWSER_CONFIG_ENABLED },
      { agent: "clawdy", toolName: "browser_extract", args: { mode: "selector", selector: "body" } },
    );
    await handleBrowserToolCall(
      { browserManager: manager, resolvedAgents: [agent], browserConfig: BROWSER_CONFIG_ENABLED },
      { agent: "clawdy", toolName: "browser_wait_for", args: { selector: "body", timeoutMs: 100 } },
    );
    expect(saveSpy).not.toHaveBeenCalled();
    await manager.close();
    await cleanup();
  });

  it("triggers saveAgentState on click + fill (write-producing tools)", async () => {
    const page = makeFakePage();
    const driver = makeMockDriver([page]);
    const manager = new BrowserManager({ driver });
    await manager.warm();

    const saveSpy = vi.spyOn(manager, "saveAgentState");
    const agent = makeAgent("clawdy", tmpDir);

    await handleBrowserToolCall(
      { browserManager: manager, resolvedAgents: [agent], browserConfig: BROWSER_CONFIG_ENABLED },
      { agent: "clawdy", toolName: "browser_click", args: { selector: "#btn" } },
    );
    await handleBrowserToolCall(
      { browserManager: manager, resolvedAgents: [agent], browserConfig: BROWSER_CONFIG_ENABLED },
      { agent: "clawdy", toolName: "browser_fill", args: { selector: "#in", value: "hi" } },
    );
    expect(saveSpy).toHaveBeenCalledTimes(2);
    await manager.close();
    await cleanup();
  });

  it("returns invalid_argument when the agent is unknown", async () => {
    const driver = makeMockDriver([]);
    const manager = new BrowserManager({ driver });
    await manager.warm();

    const outcome = await handleBrowserToolCall(
      { browserManager: manager, resolvedAgents: [makeAgent("clawdy", tmpDir)], browserConfig: BROWSER_CONFIG_ENABLED },
      { agent: "ghost", toolName: "browser_navigate", args: { url: "http://x.test" } },
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error.type).toBe("invalid_argument");
      expect(outcome.error.message).toContain("ghost");
    }
    await manager.close();
    await cleanup();
  });

  it("returns internal error with reason when browser is disabled", async () => {
    const driver = makeMockDriver([]);
    const manager = new BrowserManager({ driver });
    // NOT warmed — disabled short-circuits BEFORE touching the manager.

    const disabledCfg: BrowserConfig = { ...BROWSER_CONFIG_ENABLED, enabled: false };
    const outcome = await handleBrowserToolCall(
      { browserManager: manager, resolvedAgents: [makeAgent("clawdy", tmpDir)], browserConfig: disabledCfg },
      { agent: "clawdy", toolName: "browser_navigate", args: { url: "http://x.test" } },
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error.type).toBe("internal");
      expect(outcome.error.message).toMatch(/disabled/i);
      expect(outcome.error.message).toMatch(/browser\.enabled/i);
    }
    await cleanup();
  });

  it("lazy-warms on first call when warmOnBoot is false", async () => {
    const page = makeFakePage();
    const driver = makeMockDriver([page]);
    const manager = new BrowserManager({ driver });
    // Do NOT call warm() — simulate warmOnBoot=false path.
    expect(manager.isReady()).toBe(false);

    const outcome = await handleBrowserToolCall(
      { browserManager: manager, resolvedAgents: [makeAgent("clawdy", tmpDir)], browserConfig: { ...BROWSER_CONFIG_ENABLED, warmOnBoot: false } },
      { agent: "clawdy", toolName: "browser_navigate", args: { url: "http://localhost/test" } },
    );
    expect(outcome.ok).toBe(true);
    expect(manager.isReady()).toBe(true);
    await manager.close();
    await cleanup();
  });

  it("returns launch_failed when the lazy-warm fails", async () => {
    const brokenDriver: BrowserDriver = {
      launch: vi.fn(async () => {
        throw new Error("chromium binary not found");
      }),
    };
    const manager = new BrowserManager({ driver: brokenDriver });
    const outcome = await handleBrowserToolCall(
      { browserManager: manager, resolvedAgents: [makeAgent("clawdy", tmpDir)], browserConfig: { ...BROWSER_CONFIG_ENABLED, warmOnBoot: false } },
      { agent: "clawdy", toolName: "browser_navigate", args: { url: "http://localhost/test" } },
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error.type).toBe("launch_failed");
      expect(outcome.error.message).toMatch(/chromium binary not found/);
    }
    await cleanup();
  });

  it("returns invalid_argument for an unknown toolName", async () => {
    const page = makeFakePage();
    const driver = makeMockDriver([page]);
    const manager = new BrowserManager({ driver });
    await manager.warm();

    const outcome = await handleBrowserToolCall(
      { browserManager: manager, resolvedAgents: [makeAgent("clawdy", tmpDir)], browserConfig: BROWSER_CONFIG_ENABLED },
      { agent: "clawdy", toolName: "browser_explode" as unknown as "browser_navigate", args: {} },
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error.type).toBe("invalid_argument");
      expect(outcome.error.message).toContain("browser_explode");
    }
    await manager.close();
    await cleanup();
  });

  it("screenshotDir is rooted under <workspace>/browser/screenshots", async () => {
    const page = makeFakePage();
    const driver = makeMockDriver([page]);
    const manager = new BrowserManager({ driver });
    await manager.warm();

    const agent = makeAgent("clawdy", tmpDir);
    const outcome = await handleBrowserToolCall(
      { browserManager: manager, resolvedAgents: [agent], browserConfig: BROWSER_CONFIG_ENABLED },
      { agent: "clawdy", toolName: "browser_screenshot", args: { fullPage: false } },
    );
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      const data = outcome.data as { path: string; bytes: number };
      expect(data.path.startsWith(join(tmpDir, "browser", "screenshots"))).toBe(true);
      // Sanity: the file was actually written where the handler said it was.
      const contents = await readFile(data.path);
      expect(contents.length).toBeGreaterThan(0);
    }
    await manager.close();
    await cleanup();
  });
});
