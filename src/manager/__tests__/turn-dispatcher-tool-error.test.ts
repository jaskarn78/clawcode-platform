/**
 * Phase 94 Plan 04 Task 1 — TDD RED for the TurnDispatcher mid-turn
 * tool-call wrap path.
 *
 * D-06 contract: when an MCP tool call rejects mid-turn, the dispatcher
 * routes the failure through `wrapMcpToolError` BEFORE returning to the
 * LLM tool-result slot. Single-attempt: NO silent retries inside the
 * dispatcher — the LLM receives the structured ToolCallError JSON shape
 * and adapts naturally.
 *
 * The test exercises the public DI seam `executeMcpTool(tool, executor)`
 * which is the single-source-of-truth call site. Production tool-call
 * paths funnel through this method so the wrap is uniform.
 */

import { describe, it, expect, vi } from "vitest";
import pino from "pino";
import { TurnDispatcher } from "../turn-dispatcher.js";
import type { McpStateProvider } from "../find-alternative-agents.js";
import type { ToolCallError } from "../tool-call-error.js";

const silentLog = pino({ level: "silent" });

function makeMockSessionManager() {
  return {
    dispatchTurn: vi.fn(async () => "ok"),
    streamFromAgent: vi.fn(async () => "ok"),
    getTraceCollector: vi.fn(() => undefined),
  };
}

describe("TurnDispatcher.executeMcpTool — D-06 wrap-on-rejection", () => {
  it("TD-NO-RETRY: rejected MCP tool call is wrapped exactly once (no silent retry)", async () => {
    const sm = makeMockSessionManager();
    const dispatcher = new TurnDispatcher({
      sessionManager: sm as never,
      log: silentLog,
    });

    const executor = vi.fn().mockRejectedValueOnce(new Error("ECONNRESET"));
    const result = await dispatcher.executeMcpTool("browser_snapshot", executor);

    // Single attempt — no silent retry inside the dispatcher.
    expect(executor).toHaveBeenCalledTimes(1);

    // Result is the structured ToolCallError JSON shape, NOT a raw exception.
    const parsed = JSON.parse(result.content) as ToolCallError;
    expect(parsed.kind).toBe("ToolCallError");
    expect(parsed.tool).toBe("browser_snapshot");
    expect(parsed.errorClass).toBe("transient");
    expect(parsed.message).toBe("ECONNRESET");
    expect(result.isError).toBe(true);
  });

  it("TD-PASS-THROUGH: successful tool call returns content unchanged", async () => {
    const sm = makeMockSessionManager();
    const dispatcher = new TurnDispatcher({
      sessionManager: sm as never,
      log: silentLog,
    });
    const executor = vi.fn().mockResolvedValue("snapshot-base64-data");
    const result = await dispatcher.executeMcpTool("browser_snapshot", executor);
    expect(executor).toHaveBeenCalledTimes(1);
    expect(result.content).toBe("snapshot-base64-data");
    expect(result.isError).toBe(false);
  });

  it("TD-ALTERNATIVES: rejected call surfaces alternative agents from mcpStateProvider", async () => {
    const sm = makeMockSessionManager();
    const provider: McpStateProvider = {
      listAgents: () => ["fin-client", "general"],
      getStateFor: () =>
        new Map([
          [
            "browser",
            {
              name: "browser",
              status: "ready",
              failureCount: 0,
              optional: false,
              capabilityProbe: {
                lastRunAt: "2026-04-25T00:00:00.000Z",
                status: "ready",
              },
            } as never,
          ],
        ]),
      toolToServer: () => "browser",
    };
    const dispatcher = new TurnDispatcher({
      sessionManager: sm as never,
      log: silentLog,
      mcpStateProvider: provider,
    });
    const executor = vi.fn().mockRejectedValueOnce(new Error("HTTP 429 rate limit"));
    const result = await dispatcher.executeMcpTool("browser_snapshot", executor);
    const parsed = JSON.parse(result.content) as ToolCallError;
    expect(parsed.errorClass).toBe("quota");
    expect(parsed.alternatives).toEqual(["fin-client", "general"]);
  });

  it("TD-VERBATIM: dispatcher preserves the verbatim Playwright error in wrapped.message", async () => {
    const sm = makeMockSessionManager();
    const dispatcher = new TurnDispatcher({
      sessionManager: sm as never,
      log: silentLog,
    });
    const playwrightErr = new Error(
      "Executable doesn't exist at /home/clawcode/.cache/ms-playwright/chromium-1187/chrome-linux/chrome",
    );
    const executor = vi.fn().mockRejectedValueOnce(playwrightErr);
    const result = await dispatcher.executeMcpTool("browser_snapshot", executor);
    const parsed = JSON.parse(result.content) as ToolCallError;
    expect(parsed.message).toContain(
      "Executable doesn't exist at /home/clawcode/.cache/ms-playwright",
    );
  });
});
