import { join } from "node:path";

import {
  browserNavigate,
  browserScreenshot,
  browserClick,
  browserFill,
  browserExtract,
  browserWaitFor,
  type BrowserToolConfig,
} from "./tools.js";
import type { BrowserManager } from "./manager.js";
import type { BrowserToolOutcome } from "./types.js";
import type { BrowserConfig } from "../config/schema.js";
import type { ResolvedAgentConfig } from "../shared/types.js";
import type { IpcBrowserToolCallParams } from "../ipc/types.js";

/**
 * Phase 70 Plan 03 — daemon-side handler for the `browser-tool-call` IPC
 * method. Extracted to its own module so:
 *
 *   1. `src/manager/daemon.ts` stays off the critical-path for browser
 *      changes — daemon just dispatches into this handler.
 *   2. Unit tests (`src/ipc/__tests__/browser-tool-call.test.ts`) can
 *      drive the handler against a mock `BrowserManager` with no real
 *      Chromium and no real IPC transport.
 *
 * Contract:
 *   - Resolves the agent's workspace via the resolvedAgents list.
 *   - Returns `invalid_argument` if the agent is unknown.
 *   - Returns `internal` error when browser MCP is globally disabled.
 *   - Lazy-warms the BrowserManager on first call when `warmOnBoot=false`.
 *   - Dispatches on `toolName` to the matching pure handler in tools.ts.
 *   - Triggers `saveAgentState(agent)` ONLY on write-producing tools
 *     (navigate / click / fill) — screenshot / extract / wait_for are
 *     read-only and do not need a state flush.
 *
 * The handler NEVER throws — all error paths return a structured
 * `BrowserToolOutcome` so the IPC layer can ship it back verbatim.
 */

export interface BrowserDaemonHandlerDeps {
  readonly browserManager: BrowserManager;
  readonly resolvedAgents: readonly ResolvedAgentConfig[];
  readonly browserConfig: BrowserConfig;
}

/**
 * Set of tool names whose successful execution mutates browser storage
 * state (cookies / localStorage / IndexedDB) and therefore warrants a
 * debounced save. Read-only tools are deliberately absent.
 */
const WRITE_PRODUCING_TOOLS = new Set([
  "browser_navigate",
  "browser_click",
  "browser_fill",
]);

export async function handleBrowserToolCall(
  deps: BrowserDaemonHandlerDeps,
  params: IpcBrowserToolCallParams,
): Promise<BrowserToolOutcome> {
  const { browserManager, resolvedAgents, browserConfig } = deps;
  const { agent, toolName, args } = params;

  if (!browserConfig.enabled) {
    return Object.freeze({
      ok: false as const,
      error: Object.freeze({
        type: "internal" as const,
        message:
          "browser MCP disabled (defaults.browser.enabled=false); set it to true to use browser tools",
      }),
    });
  }

  const resolvedAgent = resolvedAgents.find((a) => a.name === agent);
  if (!resolvedAgent) {
    return Object.freeze({
      ok: false as const,
      error: Object.freeze({
        type: "invalid_argument" as const,
        message: `unknown agent: ${agent}`,
      }),
    });
  }

  // Lazy warm path — only triggered when defaults.browser.warmOnBoot=false
  // (daemon did not warm at boot). Failure surfaces as launch_failed to
  // the agent, no daemon crash.
  if (!browserManager.isReady()) {
    try {
      await browserManager.warm();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return Object.freeze({
        ok: false as const,
        error: Object.freeze({
          type: "launch_failed" as const,
          message,
        }),
      });
    }
  }

  const ctx = await browserManager.getContext(agent, resolvedAgent.workspace);
  const toolCfg: BrowserToolConfig = {
    navigationTimeoutMs: browserConfig.navigationTimeoutMs,
    actionTimeoutMs: browserConfig.actionTimeoutMs,
    maxScreenshotInlineBytes: browserConfig.maxScreenshotInlineBytes,
    screenshotDir: join(resolvedAgent.workspace, "browser", "screenshots"),
  };

  let outcome: BrowserToolOutcome;
  switch (toolName) {
    case "browser_navigate":
      outcome = await browserNavigate(
        ctx,
        args as Parameters<typeof browserNavigate>[1],
        toolCfg,
      );
      break;
    case "browser_screenshot":
      outcome = await browserScreenshot(
        ctx,
        args as Parameters<typeof browserScreenshot>[1],
        toolCfg,
      );
      break;
    case "browser_click":
      outcome = await browserClick(
        ctx,
        args as Parameters<typeof browserClick>[1],
        toolCfg,
      );
      break;
    case "browser_fill":
      outcome = await browserFill(
        ctx,
        args as Parameters<typeof browserFill>[1],
        toolCfg,
      );
      break;
    case "browser_extract":
      outcome = await browserExtract(
        ctx,
        args as Parameters<typeof browserExtract>[1],
        toolCfg,
      );
      break;
    case "browser_wait_for":
      outcome = await browserWaitFor(
        ctx,
        args as Parameters<typeof browserWaitFor>[1],
        toolCfg,
      );
      break;
    default: {
      const unknown: string = toolName;
      return Object.freeze({
        ok: false as const,
        error: Object.freeze({
          type: "invalid_argument" as const,
          message: `unknown browser tool: ${unknown}`,
        }),
      });
    }
  }

  // Trigger debounced save on write-producing tools only. Read-only
  // tools (screenshot / extract / wait_for) do not mutate state and
  // do not need a save.
  if (outcome.ok && WRITE_PRODUCING_TOOLS.has(toolName)) {
    browserManager.saveAgentState(agent);
  }

  return outcome;
}
