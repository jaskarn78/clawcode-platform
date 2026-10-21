/**
 * Phase 138 Plan 05 T-02 — `llmRuntime.failoverChain` schema +
 * loader-cascade + RELOADABLE classification.
 *
 * Proves:
 *   - `failoverChain` parses cleanly with known backend IDs at both the
 *     defaults and per-agent override levels.
 *   - `"portable-fork"` is REJECTED at parse time — it is not in the
 *     Phase 137 `llmRuntimeBackendSchema` enum (scaffold-only backend).
 *   - A config with no `failoverChain` still parses — default `[]`.
 *   - The loader cascade resolves per-agent over defaults.
 *   - `llmRuntime.failoverChain` is classified RELOADABLE by the differ
 *     (planner extension to CONTEXT D4) even though the broader
 *     `agents.*.llmRuntime` prefix is NON_RELOADABLE — the more-specific
 *     leaf pattern wins.
 *
 * See:
 *   - `src/config/schema.ts` — llmRuntimeConfigSchema / agentLlmRuntimeOverrideSchema
 *   - `src/config/loader.ts` — failoverChain resolver cascade
 *   - `src/config/types.ts` — RELOADABLE_FIELDS
 */
import { describe, it, expect } from "vitest";
import {
  configSchema,
  llmRuntimeConfigSchema,
  agentLlmRuntimeOverrideSchema,
} from "../schema.js";
import { resolveAllAgents } from "../loader.js";
import { RELOADABLE_FIELDS, NON_RELOADABLE_FIELDS } from "../types.js";

describe("Phase 138 T-02 — llmRuntime.failoverChain schema", () => {
  it("(a) accepts a chain of known backend IDs", () => {
    const parsed = llmRuntimeConfigSchema.parse({
      backend: "anthropic-agent-sdk",
      failoverChain: ["codex-cli"],
    });
    expect(parsed.failoverChain).toEqual(["codex-cli"]);
  });

  it("(a') accepts a multi-entry chain", () => {
    const parsed = llmRuntimeConfigSchema.parse({
      failoverChain: ["anthropic-agent-sdk", "codex-cli"],
    });
    expect(parsed.failoverChain).toEqual([
      "anthropic-agent-sdk",
      "codex-cli",
    ]);
  });

  it("(b) REJECTS portable-fork — scaffold-only backend not in the enum", () => {
    expect(() =>
      llmRuntimeConfigSchema.parse({ failoverChain: ["portable-fork"] }),
    ).toThrow();
    // Also rejected in the per-agent override schema.
    expect(() =>
      agentLlmRuntimeOverrideSchema.parse({
        failoverChain: ["portable-fork"],
      }),
    ).toThrow();
    // A bogus arbitrary string is likewise rejected.
    expect(() =>
      llmRuntimeConfigSchema.parse({ failoverChain: ["openrouter"] }),
    ).toThrow();
  });

  it("(c) missing failoverChain defaults to an empty array", () => {
    const parsed = llmRuntimeConfigSchema.parse({
      backend: "anthropic-agent-sdk",
    });
    expect(parsed.failoverChain).toEqual([]);
  });

  it("(c') per-agent override failoverChain is optional", () => {
    const parsed = agentLlmRuntimeOverrideSchema.parse({
      backend: "codex-cli",
    });
    expect(parsed.failoverChain).toBeUndefined();
  });

  it("(d) loader cascade — per-agent override wins over defaults", () => {
    const config = configSchema.parse({
      version: 1,
      defaults: {
        llmRuntime: {
          backend: "anthropic-agent-sdk",
          failoverChain: ["codex-cli"],
        },
      },
      agents: [
        // Inherits the defaults chain.
        { name: "inheritor", workspace: "/tmp/i", model: "sonnet" },
        // Overrides with its own (empty) chain.
        {
          name: "overrider",
          workspace: "/tmp/o",
          model: "sonnet",
          llmRuntime: { failoverChain: [] },
        },
      ],
    });
    const resolved = resolveAllAgents(config);
    const inheritor = resolved.find((a) => a.name === "inheritor");
    const overrider = resolved.find((a) => a.name === "overrider");
    expect(inheritor?.llmRuntime?.failoverChain).toEqual(["codex-cli"]);
    expect(overrider?.llmRuntime?.failoverChain).toEqual([]);
  });

  it("(d') loader cascade — no chain anywhere resolves to []", () => {
    const config = configSchema.parse({
      version: 1,
      agents: [{ name: "bare", workspace: "/tmp/bare", model: "sonnet" }],
    });
    const resolved = resolveAllAgents(config);
    expect(resolved[0]?.llmRuntime?.failoverChain).toEqual([]);
  });

  it("failoverChain is classified RELOADABLE (leaf beats NON_RELOADABLE prefix)", () => {
    expect(RELOADABLE_FIELDS.has("agents.*.llmRuntime.failoverChain")).toBe(
      true,
    );
    expect(RELOADABLE_FIELDS.has("defaults.llmRuntime.failoverChain")).toBe(
      true,
    );
    // The broader llmRuntime prefix stays NON_RELOADABLE — the
    // more-specific failoverChain leaf is the carve-out.
    expect(NON_RELOADABLE_FIELDS.has("agents.*.llmRuntime")).toBe(true);
    expect(
      NON_RELOADABLE_FIELDS.has("agents.*.llmRuntime.failoverChain"),
    ).toBe(false);
  });
});
