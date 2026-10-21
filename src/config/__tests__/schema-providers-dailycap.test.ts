/**
 * Phase 138 Plan 01 T-03 — `providers.<name>.dailyCapUsd` schema +
 * loader-cascade pinning.
 *
 * Proves:
 *   - `providers.openai.dailyCapUsd` + `providers.anthropic.dailyCapUsd`
 *     parse cleanly at both `defaults` and per-agent levels.
 *   - A negative / zero cap is rejected (`z.number().positive()`).
 *   - The field is optional — pre-Phase-138 configs with no
 *     `providers` block still parse.
 *   - The loader cascade resolves per-agent over defaults, per knob.
 *
 * See:
 *   - `src/config/schema.ts` — openAiProviderSchema / anthropicProviderSchema
 *   - `src/config/loader.ts` — providers resolver cascade
 *   - `.planning/phases/138-.../138-01-PLAN.md` T-03 <behavior>
 */
import { describe, it, expect } from "vitest";
import {
  configSchema,
  anthropicProviderSchema,
  openAiProviderSchema,
} from "../schema.js";
import { resolveAllAgents } from "../loader.js";

describe("Phase 138 T-03 — providers.dailyCapUsd schema", () => {
  it("openAiProviderSchema accepts a positive dailyCapUsd", () => {
    const parsed = openAiProviderSchema.parse({ dailyCapUsd: 12.5 });
    expect(parsed.dailyCapUsd).toBe(12.5);
  });

  it("anthropicProviderSchema accepts a positive dailyCapUsd", () => {
    const parsed = anthropicProviderSchema.parse({ dailyCapUsd: 6.67 });
    expect(parsed.dailyCapUsd).toBe(6.67);
  });

  it("anthropicProviderSchema has no apiKeyPath field", () => {
    // OAuth surface is owned elsewhere — passing apiKeyPath is stripped
    // (Zod object strips unknown keys by default).
    const parsed = anthropicProviderSchema.parse({
      dailyCapUsd: 5,
      apiKeyPath: "should-be-stripped",
    } as Record<string, unknown>);
    expect("apiKeyPath" in parsed).toBe(false);
  });

  it("rejects a zero or negative dailyCapUsd", () => {
    expect(() => openAiProviderSchema.parse({ dailyCapUsd: 0 })).toThrow();
    expect(() => openAiProviderSchema.parse({ dailyCapUsd: -1 })).toThrow();
    expect(() => anthropicProviderSchema.parse({ dailyCapUsd: 0 })).toThrow();
  });

  it("dailyCapUsd is optional — an empty provider block parses", () => {
    expect(() => openAiProviderSchema.parse({})).not.toThrow();
    expect(() => anthropicProviderSchema.parse({})).not.toThrow();
  });

  it("a full config with provider caps at defaults + agent parses", () => {
    const raw = {
      version: 1,
      defaults: {
        providers: {
          openai: { dailyCapUsd: 8 },
          anthropic: { dailyCapUsd: 6.67 },
        },
      },
      agents: [
        {
          name: "trial-agent",
          workspace: "/tmp/trial",
          model: "sonnet",
          providers: {
            openai: { dailyCapUsd: 20 },
          },
        },
      ],
    };
    expect(() => configSchema.parse(raw)).not.toThrow();
  });

  it("a pre-Phase-138 config with no providers block still parses", () => {
    const raw = {
      version: 1,
      defaults: {},
      agents: [
        { name: "legacy-agent", workspace: "/tmp/legacy", model: "sonnet" },
      ],
    };
    expect(() => configSchema.parse(raw)).not.toThrow();
  });
});

describe("Phase 138 T-03 — loader cascade for dailyCapUsd", () => {
  it("resolves per-agent dailyCapUsd over defaults (per knob)", () => {
    const config = configSchema.parse({
      version: 1,
      defaults: {
        providers: {
          openai: { dailyCapUsd: 8 },
          anthropic: { dailyCapUsd: 6.67 },
        },
      },
      agents: [
        {
          name: "trial-agent",
          workspace: "/tmp/trial",
          model: "sonnet",
          providers: { openai: { dailyCapUsd: 20 } },
        },
      ],
    });
    const resolved = resolveAllAgents(config);
    const agent = resolved.find((a) => a.name === "trial-agent");
    expect(agent?.providers?.openai?.dailyCapUsd).toBe(20);
    // anthropic cap falls through to the defaults value.
    expect(agent?.providers?.anthropic?.dailyCapUsd).toBe(6.67);
  });

  it("propagates a defaults-only cap when the agent has no override", () => {
    const config = configSchema.parse({
      version: 1,
      defaults: { providers: { openai: { dailyCapUsd: 9 } } },
      agents: [
        { name: "plain-agent", workspace: "/tmp/plain", model: "sonnet" },
      ],
    });
    const resolved = resolveAllAgents(config);
    const agent = resolved.find((a) => a.name === "plain-agent");
    expect(agent?.providers?.openai?.dailyCapUsd).toBe(9);
  });

  it("leaves providers undefined when neither caps nor credentials are set", () => {
    const config = configSchema.parse({
      version: 1,
      defaults: {},
      agents: [
        { name: "bare-agent", workspace: "/tmp/bare", model: "sonnet" },
      ],
    });
    const resolved = resolveAllAgents(config);
    const agent = resolved.find((a) => a.name === "bare-agent");
    expect(agent?.providers).toBeUndefined();
  });
});
