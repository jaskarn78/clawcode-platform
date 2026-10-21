/**
 * Phase 124 Plan 02 T-04 — schema validation + resolver fall-through for
 * the `auto-compact-at` per-agent YAML knob (D-06).
 *
 * Four cases pinned per the plan:
 *   A — YAML with no `auto-compact-at` → resolved agent config has 0.7.
 *   B — `defaults['auto-compact-at']: 0.6`, no per-agent override → 0.6.
 *   C — `defaults['auto-compact-at']: 0.6`, per-agent 0.8 → 0.8.
 *   D — invalid value (1.5) → schema parse throws.
 *
 * Plus YAML round-trip (via the `yaml` lib the loader already uses) and a
 * `loadConfig`-from-disk pin so the field flows through the config-reload
 * path (`watcher.ts` re-invokes `loadConfig` on file change — the new field
 * is automatically picked up because it lives on the same schemas the
 * watcher already parses).
 *
 * Pattern reference: `loader-advisor.test.ts` (Phase 117 Plan 06).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { defaultsSchema, agentSchema, configSchema } from "../schema.js";
import { loadConfig, resolveAgentConfig, resolveAutoCompactAt } from "../loader.js";

describe("resolveAutoCompactAt — Phase 124 Plan 02 D-06 fall-through", () => {
  it("A: returns hardcoded baseline 0.7 when both inputs undefined", () => {
    expect(resolveAutoCompactAt(undefined, undefined)).toBe(0.7);
  });

  it("B: defaults applies when per-agent omitted", () => {
    expect(
      resolveAutoCompactAt(undefined, { "auto-compact-at": 0.6 }),
    ).toBe(0.6);
  });

  it("C: per-agent override beats defaults", () => {
    expect(
      resolveAutoCompactAt(
        { "auto-compact-at": 0.8 },
        { "auto-compact-at": 0.6 },
      ),
    ).toBe(0.8);
  });

  it("falls through to baseline when both objects present but field unset", () => {
    expect(resolveAutoCompactAt({}, {})).toBe(0.7);
  });
});

describe("defaultsSchema['auto-compact-at'] — schema validation", () => {
  it("populates default 0.7 when omitted", () => {
    const parsed = defaultsSchema.parse({});
    expect(parsed["auto-compact-at"]).toBe(0.7);
  });

  it("accepts explicit 0", () => {
    const parsed = defaultsSchema.parse({ "auto-compact-at": 0 });
    expect(parsed["auto-compact-at"]).toBe(0);
  });

  it("accepts explicit 1", () => {
    const parsed = defaultsSchema.parse({ "auto-compact-at": 1 });
    expect(parsed["auto-compact-at"]).toBe(1);
  });

  it("D: REJECTS values above 1 (e.g. 1.5)", () => {
    const result = defaultsSchema.safeParse({ "auto-compact-at": 1.5 });
    expect(result.success).toBe(false);
  });

  it("REJECTS negative values", () => {
    const result = defaultsSchema.safeParse({ "auto-compact-at": -0.1 });
    expect(result.success).toBe(false);
  });
});

describe("agentSchema['auto-compact-at'] — per-agent override validation", () => {
  it("accepts an omitted per-agent override (cascade falls through)", () => {
    const parsed = agentSchema.parse({ name: "test-agent" });
    expect(parsed["auto-compact-at"]).toBeUndefined();
  });

  it("accepts a per-agent override in range", () => {
    const parsed = agentSchema.parse({
      name: "test-agent",
      "auto-compact-at": 0.85,
    });
    expect(parsed["auto-compact-at"]).toBe(0.85);
  });

  it("REJECTS a per-agent override out of range", () => {
    const result = agentSchema.safeParse({
      name: "test-agent",
      "auto-compact-at": 2,
    });
    expect(result.success).toBe(false);
  });
});

describe("resolveAgentConfig — autoCompactAt propagated to ResolvedAgentConfig", () => {
  const baseDefaults = defaultsSchema.parse({});

  it("populates ResolvedAgentConfig.autoCompactAt from defaults when agent omits the field", () => {
    const agent = agentSchema.parse({
      name: "test-agent",
      workspace: "/tmp/test-agent",
    });
    const resolved = resolveAgentConfig(agent, baseDefaults);
    expect(resolved.autoCompactAt).toBe(0.7);
  });

  it("populates ResolvedAgentConfig.autoCompactAt from per-agent override", () => {
    const agent = agentSchema.parse({
      name: "test-agent",
      workspace: "/tmp/test-agent",
      "auto-compact-at": 0.9,
    });
    const resolved = resolveAgentConfig(agent, baseDefaults);
    expect(resolved.autoCompactAt).toBe(0.9);
  });

  it("respects defaults override when both schemas are operator-supplied", () => {
    const customDefaults = defaultsSchema.parse({ "auto-compact-at": 0.55 });
    const agent = agentSchema.parse({
      name: "test-agent",
      workspace: "/tmp/test-agent",
    });
    const resolved = resolveAgentConfig(agent, customDefaults);
    expect(resolved.autoCompactAt).toBe(0.55);
  });
});

describe("YAML round-trip — auto-compact-at survives parse → resolve → serialise", () => {
  it("round-trips defaults + per-agent override through yaml lib", () => {
    const sourceYaml = stringifyYaml({
      version: 1,
      defaults: { "auto-compact-at": 0.6 },
      agents: [
        {
          name: "agent-a",
          workspace: "/tmp/agent-a",
          "auto-compact-at": 0.85,
        },
        { name: "agent-b", workspace: "/tmp/agent-b" },
      ],
    });

    const parsed = configSchema.parse(parseYaml(sourceYaml));
    expect(parsed.defaults["auto-compact-at"]).toBe(0.6);
    expect(parsed.agents[0]["auto-compact-at"]).toBe(0.85);
    expect(parsed.agents[1]["auto-compact-at"]).toBeUndefined();

    const resolvedA = resolveAgentConfig(parsed.agents[0], parsed.defaults);
    const resolvedB = resolveAgentConfig(parsed.agents[1], parsed.defaults);
    expect(resolvedA.autoCompactAt).toBe(0.85); // per-agent wins
    expect(resolvedB.autoCompactAt).toBe(0.6);  // falls through to defaults
  });
});

describe("loadConfig — reload integration (re-parse picks up edits)", () => {
  let tmpDir: string;
  let configPath: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "auto-compact-at-test-"));
    configPath = join(tmpDir, "clawcode.yaml");
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("loadConfig surfaces defaults['auto-compact-at'] on re-read (reload path)", async () => {
    const v1 = stringifyYaml({
      version: 1,
      defaults: { "auto-compact-at": 0.6 },
      agents: [{ name: "agent-a", workspace: tmpDir }],
    });
    await writeFile(configPath, v1, "utf8");
    const first = await loadConfig(configPath);
    expect(first.defaults["auto-compact-at"]).toBe(0.6);

    const v2 = stringifyYaml({
      version: 1,
      defaults: { "auto-compact-at": 0.8 },
      agents: [{ name: "agent-a", workspace: tmpDir }],
    });
    await writeFile(configPath, v2, "utf8");
    const second = await loadConfig(configPath);
    expect(second.defaults["auto-compact-at"]).toBe(0.8);

    // Resolved agent picks up the new defaults on the second load — this is
    // the watcher-reload contract: re-parse + re-resolve yields the new value
    // without a daemon restart.
    const resolved = resolveAgentConfig(second.agents[0], second.defaults);
    expect(resolved.autoCompactAt).toBe(0.8);
  });
});
