/**
 * Phase 999.100 — steering config cascade (loadConfig → resolveAgentConfig).
 *
 * Pins:
 *   1. Baseline when neither agents[].steering nor defaults.steering exist:
 *      autoClassify=false (feature OFF), stopIntent=true, cap=3,
 *      minConfidence=0.75, stopMinConfidence=0.85, timeout=4000.
 *   2. Per-field cascade — a per-agent block overrides ONLY the fields it
 *      sets; the rest fall through to defaults.steering, then baseline.
 *   3. The resolved block is ALWAYS emitted on ResolvedAgentConfig (the
 *      bridge gate reads one final struct — no derived-resolution drop, per
 *      the 2026-06-26 advisor lesson).
 *   4. schema bounds reject out-of-range knobs (e.g. minConfidence > 1).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { loadConfig, resolveAgentConfig } from "../loader.js";

describe("steering cascade — Phase 999.100", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "clawcode-999100-"));
  });
  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  async function load(yamlLines: string[]): Promise<{
    agents: Parameters<typeof resolveAgentConfig>[0][];
    defaults: Parameters<typeof resolveAgentConfig>[1];
  }> {
    const cfgPath = join(tmpDir, "clawcode.yaml");
    await writeFile(cfgPath, yamlLines.join("\n"), "utf-8");
    const loaded = await loadConfig(cfgPath);
    return loaded as unknown as {
      agents: Parameters<typeof resolveAgentConfig>[0][];
      defaults: Parameters<typeof resolveAgentConfig>[1];
    };
  }

  it("no steering anywhere → resolved baseline with autoClassify OFF", async () => {
    const { agents, defaults } = await load([
      "version: 1",
      "agents:",
      "  - name: fixture-a",
      "",
    ]);
    const resolved = resolveAgentConfig(agents[0]!, defaults);
    expect(resolved.steering).toEqual({
      autoClassify: false,
      stopIntent: true,
      maxInjectionsPerTurn: 3,
      minConfidence: 0.75,
      stopMinConfidence: 0.85,
      classifierTimeoutMs: 12_000,
    });
  });

  it("defaults.steering applies fleet-wide; per-agent overrides per-field", async () => {
    const { agents, defaults } = await load([
      "version: 1",
      "defaults:",
      "  steering:",
      "    autoClassify: true",
      "    minConfidence: 0.6",
      "agents:",
      "  - name: fixture-a",
      "  - name: fixture-b",
      "    steering:",
      "      autoClassify: false",
      "      classifierTimeoutMs: 2000",
      "",
    ]);

    // fixture-a: pure defaults (+ zod fills of the defaults block).
    const a = resolveAgentConfig(agents[0]!, defaults);
    expect(a.steering?.autoClassify).toBe(true);
    expect(a.steering?.minConfidence).toBe(0.6);
    expect(a.steering?.stopIntent).toBe(true);
    expect(a.steering?.classifierTimeoutMs).toBe(12_000);

    // fixture-b: per-agent wins ONLY on the fields it sets.
    const b = resolveAgentConfig(agents[1]!, defaults);
    expect(b.steering?.autoClassify).toBe(false);
    expect(b.steering?.classifierTimeoutMs).toBe(2000);
    expect(b.steering?.minConfidence).toBe(0.6); // falls to defaults
    expect(b.steering?.maxInjectionsPerTurn).toBe(3); // falls to baseline
  });

  it("canary shape — per-agent autoClassify:true over silent defaults", async () => {
    const { agents, defaults } = await load([
      "version: 1",
      "agents:",
      "  - name: test-agent",
      "    steering:",
      "      autoClassify: true",
      "",
    ]);
    const resolved = resolveAgentConfig(agents[0]!, defaults);
    expect(resolved.steering?.autoClassify).toBe(true);
    // Everything else at baseline.
    expect(resolved.steering?.stopMinConfidence).toBe(0.85);
  });

  it("rejects out-of-range knobs at parse time", async () => {
    const cfgPath = join(tmpDir, "clawcode.yaml");
    await writeFile(
      cfgPath,
      [
        "version: 1",
        "defaults:",
        "  steering:",
        "    minConfidence: 1.5",
        "agents:",
        "  - name: fixture-a",
        "",
      ].join("\n"),
      "utf-8",
    );
    await expect(loadConfig(cfgPath)).rejects.toThrow();
  });

  // 2026-08-02 — the schema default and the midturn-intent frozen baseline
  // are two sources for the same number; this pin fires if they drift.
  it("STEERING_BASELINE.classifierTimeoutMs stays in lockstep with the schema default", async () => {
    const { STEERING_BASELINE } = await import(
      "../../manager/midturn-intent.js"
    );
    const { steeringConfigSchema } = await import("../schema.js");
    expect(steeringConfigSchema.parse({}).classifierTimeoutMs).toBe(
      STEERING_BASELINE.classifierTimeoutMs,
    );
  });
});
