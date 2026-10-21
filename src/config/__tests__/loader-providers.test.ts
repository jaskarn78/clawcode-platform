/**
 * Phase 137 Plan 04 T-01 — loader cascade for the `providers.openai.apiKeyPath`
 * field.
 *
 * Pins the per-agent-over-defaults cascade pattern from the Plan 04
 * `<action>` block:
 *
 *   agents[].providers.openai.apiKeyPath
 *     ?? defaults.providers.openai.apiKeyPath
 *     ?? undefined
 *
 * The loader does NOT do whole-block fall-through (operators can
 * override one knob at a time). Mirrors the Phase 117 advisor
 * cascade pattern (see `loader-advisor.test.ts`).
 *
 * Three cases:
 *   A. Both unset → resolved.providers undefined (lazy-fail path).
 *   B. Defaults set, agent unset → resolved.providers.openai.apiKeyPath
 *      equals the defaults value.
 *   C. Both set → per-agent value wins.
 *
 * NO secret resolution exercised here — the loader does NOT resolve
 * the `op://` URI to a value; resolution is lazy at first spawn inside
 * `OpenAiCredentialsResolver` (T-02). This test only pins the field
 * cascade.
 */
import { describe, it, expect } from "vitest";
import { resolveAllAgents } from "../loader.js";
import { configSchema } from "../schema.js";
import type { Config } from "../schema.js";

/**
 * Minimal config builder — parses a YAML-shape object through the
 * canonical Zod schema so every default field is populated. This keeps
 * the test fixture in lock-step with schema changes; we only override
 * the fields the cascade test actually depends on.
 */
function buildConfig(opts: {
  defaultsApiKeyPath?: string;
  agentApiKeyPath?: string;
}): Config {
  const raw: Record<string, unknown> = {
    version: 1,
    defaults: {
      ...(opts.defaultsApiKeyPath
        ? {
            providers: {
              openai: { apiKeyPath: opts.defaultsApiKeyPath },
            },
          }
        : {}),
    },
    agents: [
      {
        name: "trial-agent",
        workspace: "~/test-ws",
        memoryPath: "~/test-ws/trial-agent",
        channels: [],
        skills: [],
        effort: "low",
        heartbeat: true,
        schedules: [],
        admin: false,
        slashCommands: [],
        reactions: true,
        mcpServers: [],
        ...(opts.agentApiKeyPath
          ? {
              providers: {
                openai: { apiKeyPath: opts.agentApiKeyPath },
              },
            }
          : {}),
      },
    ],
    mcpServers: {},
  };
  return configSchema.parse(raw);
}

describe("loader cascade — providers.openai.apiKeyPath (Phase 137 Plan 04)", () => {
  it("A: both unset → resolved.providers is undefined (lazy-fail path)", () => {
    const config = buildConfig({});
    const resolved = resolveAllAgents(config);
    const agent = resolved.find((a) => a.name === "trial-agent");
    expect(agent).toBeDefined();
    expect(agent!.providers).toBeUndefined();
  });

  it("B: defaults set, agent unset → resolved value equals defaults", () => {
    const config = buildConfig({
      defaultsApiKeyPath: "op://example-vault-9/openai-trial/credential",
    });
    const resolved = resolveAllAgents(config);
    const agent = resolved.find((a) => a.name === "trial-agent")!;
    expect(agent.providers?.openai?.apiKeyPath).toBe(
      "op://example-vault-9/openai-trial/credential",
    );
  });

  it("C: both set → per-agent value wins", () => {
    const config = buildConfig({
      defaultsApiKeyPath: "op://example-vault-9/openai-default/credential",
      agentApiKeyPath: "op://example-vault-9/openai-agent-specific/credential",
    });
    const resolved = resolveAllAgents(config);
    const agent = resolved.find((a) => a.name === "trial-agent")!;
    expect(agent.providers?.openai?.apiKeyPath).toBe(
      "op://example-vault-9/openai-agent-specific/credential",
    );
  });

  it("D: agent-only set (no defaults) → resolved equals agent value", () => {
    const config = buildConfig({
      agentApiKeyPath: "sk-plaintext-test-only",
    });
    const resolved = resolveAllAgents(config);
    const agent = resolved.find((a) => a.name === "trial-agent")!;
    expect(agent.providers?.openai?.apiKeyPath).toBe("sk-plaintext-test-only");
  });
});
