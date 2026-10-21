/**
 * Phase 124 Plan 02 T-03 — static-grep regression for CONTEXT D-05.
 *
 * Reads `clawcode.example.yaml` (the canonical checked-in config; the runtime
 * `clawcode.yaml` is gitignored per commit 0278e6f) and asserts no agent's
 * heartbeat prompt block conflates auto-reset disablement with auto-compaction
 * permission under a single `##` header.
 *
 * Pattern reuses the anti-pattern enforcement shape from
 * `src/manager/__tests__/auto-upload-heuristic.test.ts` (Phase 90 D-10
 * OpenClaw-fallback detector).
 *
 * Failure mode: any single `##`-delimited block in any heartbeat prompt that
 * contains BOTH `AUTO-RESET: DISABLED` AND `auto-compact` (case-insensitive)
 * fails the test. Decoupled state — those tokens in DIFFERENT `##` blocks —
 * passes.
 *
 * NOTE: this file deliberately avoids the regex shape `## ⚠️ AUTO-RESET:
 * DISABLED` and `auto-compact` co-occurring under one `##` heading in its own
 * source — the test reads `clawcode.example.yaml` only, not its own source,
 * but the rule still bears repeating (self-invalidating grep gate anti-
 * pattern, called out in plan operator notes).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

interface AgentLike {
  name?: string;
  heartbeat?: { prompt?: string };
  systemPrompt?: string;
}

interface ConfigLike {
  agents?: AgentLike[];
}

const CONFIG_PATH = join(process.cwd(), "clawcode.example.yaml");
const RESET_PATTERN = /AUTO-RESET:\s*DISABLED/;
const COMPACT_PATTERN = /auto-compact/i;

describe("Phase 124 D-05 — heartbeat policy decoupling regression", () => {
  it("loads clawcode.example.yaml and finds at least one agent with a heartbeat prompt", () => {
    const raw = readFileSync(CONFIG_PATH, "utf8");
    const config = parseYaml(raw) as ConfigLike;
    expect(Array.isArray(config.agents)).toBe(true);
    const withHeartbeat = (config.agents ?? []).filter(
      (a) => typeof a.heartbeat?.prompt === "string",
    );
    expect(withHeartbeat.length).toBeGreaterThan(0);
  });

  it("no heartbeat `##` block contains both AUTO-RESET: DISABLED and auto-compact", () => {
    const raw = readFileSync(CONFIG_PATH, "utf8");
    const config = parseYaml(raw) as ConfigLike;
    const violations: string[] = [];

    for (const agent of config.agents ?? []) {
      const prompt = agent.heartbeat?.prompt ?? agent.systemPrompt ?? "";
      if (typeof prompt !== "string" || prompt.length === 0) continue;

      // Split on `## ` at line start — each chunk is a header-delimited block.
      const blocks = prompt.split(/^##\s/m);

      for (const block of blocks) {
        const hasReset = RESET_PATTERN.test(block);
        const hasCompact = COMPACT_PATTERN.test(block);
        if (hasReset && hasCompact) {
          const preview = block.slice(0, 120).replace(/\s+/g, " ").trim();
          violations.push(`${agent.name ?? "<unnamed>"}: ${preview}`);
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it("decoupled state holds: AUTO-RESET and AUTO-COMPACT appear in distinct blocks for general", () => {
    const raw = readFileSync(CONFIG_PATH, "utf8");
    const config = parseYaml(raw) as ConfigLike;
    const fin = (config.agents ?? []).find((a) => a.name === "general");
    expect(fin).toBeDefined();
    const prompt = fin?.heartbeat?.prompt ?? "";
    expect(prompt).toContain("AUTO-RESET: DISABLED");
    expect(prompt).toContain("AUTO-COMPACT: ALLOWED");

    const blocks = prompt.split(/^##\s/m);
    const resetBlock = blocks.find((b) => RESET_PATTERN.test(b));
    const compactBlock = blocks.find((b) => /AUTO-COMPACT:\s*ALLOWED/.test(b));
    expect(resetBlock).toBeDefined();
    expect(compactBlock).toBeDefined();
    // Distinct objects — re-conflation would collapse them into one.
    expect(resetBlock).not.toBe(compactBlock);
  });
});
