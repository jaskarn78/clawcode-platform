/**
 * Security hotfix — every spawned `claude` env disables the auto-load of the
 * logged-in claude.ai account's connectors (`mcp__claude_ai_*` tools), which
 * otherwise appear in every fleet session regardless of `settingSources: []`.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildAnthropicSafeEnv } from "../spawn-env.js";
import { buildCleanEnv } from "../session-adapter.js";
import { buildIsolatedEnv } from "../../account/oauth-cli.js";
import { buildV3SpawnEnv } from "../../llm-runtime/backends/claude-code-interactive.js";
import {
  ALLOW_CLAUDEAI_CONNECTORS_ENV_KEY,
  CLAUDEAI_CONNECTORS_DISABLED_ENV,
} from "../../shared/claudeai-connectors.js";

const KEY = "ENABLE_CLAUDEAI_MCP_SERVERS";

describe("claude.ai connectors are disabled in every spawn env", () => {
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = {
      [KEY]: process.env[KEY],
      [ALLOW_CLAUDEAI_CONNECTORS_ENV_KEY]: process.env[ALLOW_CLAUDEAI_CONNECTORS_ENV_KEY],
    };
    delete process.env[KEY];
    delete process.env[ALLOW_CLAUDEAI_CONNECTORS_ENV_KEY];
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("the constant is the defined-falsy value the CLI checks", () => {
    expect(CLAUDEAI_CONNECTORS_DISABLED_ENV).toEqual({ [KEY]: "false" });
  });

  it("buildAnthropicSafeEnv sets it by default", () => {
    expect(buildAnthropicSafeEnv()[KEY]).toBe("false");
  });

  it("an ambient daemon value cannot re-enable connectors", () => {
    process.env[KEY] = "true";
    expect(buildAnthropicSafeEnv()[KEY]).toBe("false");
  });

  it("an extraEnv value (e.g. yaml MCP server env) cannot re-enable connectors", () => {
    expect(buildAnthropicSafeEnv({ [KEY]: "true" })[KEY]).toBe("false");
  });

  it("extraEnv passthrough is otherwise preserved (spread-last contract intact)", () => {
    const env = buildAnthropicSafeEnv({ ANTHROPIC_API_KEY: "sk-test-placeholder.invalid" });
    expect(env.ANTHROPIC_API_KEY).toBe("sk-test-placeholder.invalid");
    expect(env[KEY]).toBe("false");
  });

  it("the named daemon rollback switch stops the forced disable", () => {
    process.env[ALLOW_CLAUDEAI_CONNECTORS_ENV_KEY] = "1";
    expect(buildAnthropicSafeEnv()[KEY]).toBeUndefined();
    process.env[KEY] = "true";
    expect(buildAnthropicSafeEnv()[KEY]).toBe("true");
  });

  it("only the exact value \"1\" counts as the rollback switch", () => {
    process.env[ALLOW_CLAUDEAI_CONNECTORS_ENV_KEY] = "true";
    expect(buildAnthropicSafeEnv()[KEY]).toBe("false");
  });

  it("buildCleanEnv (agent SDK sessions) carries it", () => {
    expect(buildCleanEnv()[KEY]).toBe("false");
    expect(buildCleanEnv("true")[KEY]).toBe("false");
  });

  it("the v3 PTY spawn env keeps it (its CLAUDE* strip does not touch the key)", () => {
    expect(buildV3SpawnEnv("/tmp/v3-state", "agent-x")[KEY]).toBe("false");
  });

  it("an ENTITLED session gets an explicit enable that ambient/extraEnv cannot flip", () => {
    expect(buildAnthropicSafeEnv(undefined, { claudeAiConnectors: true })[KEY]).toBe("true");
    process.env[KEY] = "false";
    expect(buildAnthropicSafeEnv({ [KEY]: "false" }, { claudeAiConnectors: true })[KEY]).toBe("true");
  });

  it("claudeAiConnectors: false (or omitted) keeps the forced disable", () => {
    expect(buildAnthropicSafeEnv(undefined, { claudeAiConnectors: false })[KEY]).toBe("false");
  });

  it("buildCleanEnv passes the loader-derived entitlement through", () => {
    // (toolSearch, promptSuggestions, claudeAiConnectors)
    expect(buildCleanEnv(undefined, false, true)[KEY]).toBe("true");
    expect(buildCleanEnv(undefined, false, false)[KEY]).toBe("false");
    expect(buildCleanEnv(undefined, true, false)[KEY]).toBe("false");
  });

  it("the account preflight's isolated env carries it", () => {
    expect(buildIsolatedEnv("/tmp/h", "/tmp/c")[KEY]).toBe("false");
  });
});
