/**
 * Phase 999.169 SC-2 — a new `sdk.query` call site with NO pin code of its own
 * still spawns the fleet binary, because the chokepoint wraps `query`.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const received: unknown[] = [];
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: (params: unknown) => {
    received.push(params);
    return { fake: true };
  },
  forkSession: vi.fn(),
}));

import {
  __resetCachedModuleForTests,
  loadAnthropicAgentSdkModule,
  withPinnedClaudeBinary,
} from "../anthropic-agent-sdk.js";
import type { LlmRuntimeSdkModule } from "../../types.js";

afterEach(() => {
  received.length = 0;
  __resetCachedModuleForTests();
  vi.unstubAllEnvs();
});

describe("withPinnedClaudeBinary", () => {
  const fakeSdk = () => {
    const calls: Array<{ prompt: unknown; options?: Record<string, unknown> }> = [];
    const sdk = {
      query: (p: { prompt: unknown; options?: Record<string, unknown> }) => {
        calls.push(p);
        return {};
      },
      forkSession: vi.fn(),
      other: "kept",
    } as unknown as LlmRuntimeSdkModule;
    return { sdk, calls };
  };

  it("injects the resolved binary when the caller omits it (options absent)", () => {
    const { sdk, calls } = fakeSdk();
    withPinnedClaudeBinary(sdk, () => "/fleet/claude").query({ prompt: "hi" });
    expect(calls[0]?.prompt).toBe("hi");
    expect(calls[0]?.options?.pathToClaudeCodeExecutable).toBe("/fleet/claude");
  });

  it("injects without dropping the caller's other options", () => {
    const { sdk, calls } = fakeSdk();
    withPinnedClaudeBinary(sdk, () => "/fleet/claude").query({ prompt: "hi", options: { model: "opus", cwd: "/w" } });
    expect(calls[0]?.options).toMatchObject({ model: "opus", cwd: "/w", pathToClaudeCodeExecutable: "/fleet/claude" });
  });

  it("an explicit path wins and the resolver is not consulted", () => {
    const { sdk, calls } = fakeSdk();
    const resolve = vi.fn(() => "/fleet/claude");
    withPinnedClaudeBinary(sdk, resolve).query({ prompt: "hi", options: { pathToClaudeCodeExecutable: "/explicit" } });
    expect(calls[0]?.options?.pathToClaudeCodeExecutable).toBe("/explicit");
    expect(resolve).not.toHaveBeenCalled();
  });

  it("a resolver failure surfaces at the spawn (no silent fallback)", () => {
    const { sdk } = fakeSdk();
    const wrapped = withPinnedClaudeBinary(sdk, () => {
      throw new Error("bundled binary missing");
    });
    expect(() => wrapped.query({ prompt: "hi" })).toThrow("bundled binary missing");
  });

  it("claude.ai connectors: an explicit opt-in (\"true\") passes through untouched", () => {
    const { sdk, calls } = fakeSdk();
    const env = { PATH: "/p", ENABLE_CLAUDEAI_MCP_SERVERS: "true" };
    withPinnedClaudeBinary(sdk, () => "/fleet/claude").query({ prompt: "hi", options: { env } });
    expect(calls[0]?.options?.env).toEqual({ PATH: "/p", ENABLE_CLAUDEAI_MCP_SERVERS: "true" });
  });

  it("claude.ai connectors: an explicit \"false\" is also left as the caller set it", () => {
    const { sdk, calls } = fakeSdk();
    withPinnedClaudeBinary(sdk, () => "/fleet/claude").query({
      prompt: "hi",
      options: { env: { ENABLE_CLAUDEAI_MCP_SERVERS: "false", HOME: "/h" } },
    });
    expect(calls[0]?.options?.env).toEqual({ ENABLE_CLAUDEAI_MCP_SERVERS: "false", HOME: "/h" });
  });

  it("claude.ai connectors: key absent from a provided env → forced \"false\", env otherwise kept whole", () => {
    const { sdk, calls } = fakeSdk();
    withPinnedClaudeBinary(sdk, () => "/fleet/claude").query({
      prompt: "hi",
      options: { env: { PATH: "/p", HOME: "/h" } },
    });
    expect(calls[0]?.options?.env).toEqual({ PATH: "/p", HOME: "/h", ENABLE_CLAUDEAI_MCP_SERVERS: "false" });
  });

  it("claude.ai connectors: env undefined → process.env plus \"false\" (nothing stripped)", () => {
    vi.stubEnv("CLAWCODE_SMOKE_MARKER", "kept");
    vi.stubEnv("ENABLE_CLAUDEAI_MCP_SERVERS", "true"); // the daemon's own env does not opt a session in
    const { sdk, calls } = fakeSdk();
    withPinnedClaudeBinary(sdk, () => "/fleet/claude").query({ prompt: "hi" });
    const env = calls[0]?.options?.env as Record<string, string>;
    expect(env.ENABLE_CLAUDEAI_MCP_SERVERS).toBe("false");
    expect(env.CLAWCODE_SMOKE_MARKER).toBe("kept");
    expect(env.PATH).toBe(process.env.PATH);
    expect(process.env.ENABLE_CLAUDEAI_MCP_SERVERS).toBe("true"); // the daemon's own env is untouched
  });

  it("keeps the module's other exports", () => {
    const { sdk } = fakeSdk();
    expect((withPinnedClaudeBinary(sdk) as unknown as { other: string }).other).toBe("kept");
  });
});

describe("loadAnthropicAgentSdkModule (SC-2)", () => {
  it("a bare query({prompt}) through the chokepoint arrives pinned to the fleet binary", async () => {
    vi.stubEnv("CLAWCODE_CLAUDE_BIN", "/opt/clawcode/claude-pin/claude");
    const sdk = await loadAnthropicAgentSdkModule();
    sdk.query({ prompt: "Session initialized." });
    const got = received[0] as { prompt: string; options: { pathToClaudeCodeExecutable: string; env: Record<string, string> } };
    expect(got.prompt).toBe("Session initialized.");
    expect(got.options.pathToClaudeCodeExecutable).toBe("/opt/clawcode/claude-pin/claude");
    expect(got.options.env.ENABLE_CLAUDEAI_MCP_SERVERS).toBe("false");
  });

  it("without an override the pin is the SDK's own bundled binary", async () => {
    vi.stubEnv("CLAWCODE_CLAUDE_BIN", "");
    const sdk = await loadAnthropicAgentSdkModule();
    sdk.query({ prompt: "x" });
    const opts = (received[0] as { options: { pathToClaudeCodeExecutable: string } }).options;
    expect(opts.pathToClaudeCodeExecutable).toMatch(/@anthropic-ai\/claude-agent-sdk-[a-z0-9-]+\/claude$/);
  });
});
