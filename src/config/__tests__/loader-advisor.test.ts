/**
 * Phase 117 Plan 06 — loader resolver fall-through + YAML round-trip for
 * the `advisor` block.
 *
 * Pins three behaviors the SDK call sites in Plans 117-04/07/08 depend on:
 *
 *   1. Resolver fall-through order: per-agent.advisor → defaults.advisor
 *      → hardcoded baseline. Each resolver is independent (loader does
 *      NOT do whole-block fall-through — operators can override one knob
 *      at a time).
 *   2. Caching is resolved PER-FIELD (enabled and ttl independently).
 *   3. YAML round-trip: a yaml string with `defaults.advisor` + one agent
 *      override parses, runs through the resolvers, serialises back, and
 *      deep-equals on a re-parse. Pins that `js-yaml`/`yaml` does not
 *      coerce string enums to numbers and that the schema's
 *      `.optional()` boundary survives a serialise round-trip.
 *
 * Pattern reference: `loader.test.ts` (top of file) for the
 * loadConfig + tmpdir yaml-on-disk flow.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import {
  loadConfig,
  resolveAdvisorBackend,
  resolveAdvisorModel,
  resolveAdvisorMaxUsesPerRequest,
  resolveAdvisorCaching,
} from "../loader.js";

describe("resolveAdvisorBackend — Phase 117 Plan 06 fall-through", () => {
  it("A: returns `\"native\"` baseline when both inputs undefined", () => {
    expect(resolveAdvisorBackend(undefined, undefined)).toBe("native");
  });

  it("B: per-agent override beats defaults (`fork` wins over `native`)", () => {
    expect(
      resolveAdvisorBackend(
        { advisor: { backend: "fork" } },
        { advisor: { backend: "native" } },
      ),
    ).toBe("fork");
  });

  it("C: defaults applies when per-agent omitted (no per-agent advisor block)", () => {
    expect(
      resolveAdvisorBackend(undefined, { advisor: { backend: "native" } }),
    ).toBe("native");
  });

  it("falls through to baseline `\"native\"` when both blocks present but backend unset", () => {
    expect(resolveAdvisorBackend({ advisor: {} }, { advisor: {} })).toBe(
      "native",
    );
  });

  it("defensively narrows an unknown backend string to `\"native\"`", () => {
    // The schema rejects this at parse time, but the resolver's defensive
    // type-guard catches any future drift between BackendId and the
    // schema enum. Locked behavior: anything that isn't \"fork\" → \"native\".
    expect(
      resolveAdvisorBackend(
        { advisor: { backend: "portable-fork" } },
        undefined,
      ),
    ).toBe("native");
  });
});

describe("resolveAdvisorModel — Phase 117 Plan 06 fall-through", () => {
  it("D: per-agent override beats absent defaults (`sonnet` wins)", () => {
    expect(
      resolveAdvisorModel({ advisor: { model: "sonnet" } }, undefined),
    ).toBe("sonnet");
  });

  it("baseline `\"opus\"` when both undefined", () => {
    expect(resolveAdvisorModel(undefined, undefined)).toBe("opus");
  });

  it("defaults applies when per-agent omitted", () => {
    expect(
      resolveAdvisorModel(undefined, { advisor: { model: "haiku" } }),
    ).toBe("haiku");
  });

  it("stores operator string verbatim (no canonicalisation here)", () => {
    // Plan 117-02 resolveAdvisorModel in model-resolver.ts canonicalises
    // \"opus\" → \"claude-opus-4-8\" at the SDK call site. The loader
    // resolver returns the raw alias unchanged so the canonical-id
    // resolver is the single source of truth.
    expect(
      resolveAdvisorModel(
        { advisor: { model: "claude-opus-4-8" } },
        undefined,
      ),
    ).toBe("claude-opus-4-8");
  });
});

describe("resolveAdvisorMaxUsesPerRequest — Phase 117 Plan 06 fall-through", () => {
  it("E: defaults applies when per-agent omits the field (5 wins over baseline 3)", () => {
    expect(
      resolveAdvisorMaxUsesPerRequest(
        {},
        { advisor: { maxUsesPerRequest: 5 } },
      ),
    ).toBe(5);
  });

  it("baseline 3 when both undefined", () => {
    expect(resolveAdvisorMaxUsesPerRequest(undefined, undefined)).toBe(3);
  });

  it("per-agent override beats defaults", () => {
    expect(
      resolveAdvisorMaxUsesPerRequest(
        { advisor: { maxUsesPerRequest: 7 } },
        { advisor: { maxUsesPerRequest: 2 } },
      ),
    ).toBe(7);
  });
});

describe("resolveAdvisorCaching — Phase 117 Plan 06 fall-through", () => {
  it("F: baseline `{enabled:true, ttl:\"5m\"}` when both inputs undefined", () => {
    expect(resolveAdvisorCaching(undefined, undefined)).toEqual({
      enabled: true,
      ttl: "5m",
    });
  });

  it("per-field independence — agent disables, defaults still wins ttl", () => {
    // Operator wants caching off for this one agent but accepts the
    // fleet ttl. The per-field fall-through is what makes this work.
    expect(
      resolveAdvisorCaching(
        { advisor: { caching: { enabled: false } } },
        { advisor: { caching: { enabled: true, ttl: "1h" } } },
      ),
    ).toEqual({ enabled: false, ttl: "1h" });
  });

  it("per-field independence — agent overrides ttl, baseline `enabled:true` applies", () => {
    expect(
      resolveAdvisorCaching(
        { advisor: { caching: { ttl: "1h" } } },
        undefined,
      ),
    ).toEqual({ enabled: true, ttl: "1h" });
  });

  it("defaults applies wholesale when per-agent omitted", () => {
    expect(
      resolveAdvisorCaching(undefined, {
        advisor: { caching: { enabled: false, ttl: "1h" } },
      }),
    ).toEqual({ enabled: false, ttl: "1h" });
  });
});

// ---------------------------------------------------------------------------
// YAML round-trip — loadConfig path + serialise/re-parse identity check.
// ---------------------------------------------------------------------------
describe("YAML round-trip for the advisor block", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "clawcode-117-06-"));
  });
  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("parses a yaml with defaults.advisor + agents[0].advisor and resolvers fire end-to-end", async () => {
    const yamlText = [
      "version: 1",
      "defaults:",
      "  advisor:",
      "    backend: native",
      "    model: opus",
      "    maxUsesPerRequest: 3",
      "    caching:",
      "      enabled: true",
      "      ttl: 5m",
      "agents:",
      "  - name: phase-117-06-fixture",
      "    advisor:",
      "      backend: fork",
      "",
    ].join("\n");

    const cfgPath = join(tmpDir, "clawcode.yaml");
    await writeFile(cfgPath, yamlText, "utf-8");

    const loaded = await loadConfig(cfgPath);

    // Per-agent override beats defaults at the resolver boundary.
    expect(
      resolveAdvisorBackend(loaded.agents[0], loaded.defaults),
    ).toBe("fork");
    // Defaults still applies for fields the per-agent block didn't set.
    expect(resolveAdvisorModel(loaded.agents[0], loaded.defaults)).toBe(
      "opus",
    );
    expect(
      resolveAdvisorMaxUsesPerRequest(loaded.agents[0], loaded.defaults),
    ).toBe(3);
    expect(
      resolveAdvisorCaching(loaded.agents[0], loaded.defaults),
    ).toEqual({ enabled: true, ttl: "5m" });
  });

  it("serialise → re-parse → deep-equal (no enum coercion, no field drift)", () => {
    // Pure in-memory yaml round-trip. Does NOT call loadConfig because the
    // raw structure (pre-schema) is what we want to pin survives the
    // `yaml` package's stringify/parse without losing the advisor block.
    const cfg = {
      version: 1,
      defaults: {
        advisor: {
          backend: "fork",
          model: "sonnet",
          maxUsesPerRequest: 7,
          caching: { enabled: false, ttl: "1h" },
        },
      },
      agents: [
        {
          name: "phase-117-06-roundtrip",
          channels: [],
          advisor: { backend: "native", model: "opus" },
        },
      ],
    };

    const serialised = stringifyYaml(cfg);
    const reparsed = parseYaml(serialised) as typeof cfg;

    expect(reparsed).toEqual(cfg);
    // Spot-check the enum survived as a string (yaml does NOT coerce
    // "5m" to a duration or "fork" to anything weird).
    expect(typeof reparsed.defaults.advisor.backend).toBe("string");
    expect(typeof reparsed.defaults.advisor.caching.ttl).toBe("string");
  });

  it("loadConfig → yaml stringify → loadConfig parses identically (full round-trip)", async () => {
    const yamlText = [
      "version: 1",
      "defaults:",
      "  advisor:",
      "    backend: fork",
      "    model: opus",
      "    maxUsesPerRequest: 5",
      "    caching:",
      "      enabled: true",
      "      ttl: 1h",
      "agents:",
      "  - name: phase-117-06-loop",
      "    advisor:",
      "      model: sonnet",
      "      caching:",
      "        enabled: false",
      "",
    ].join("\n");

    const cfgPath1 = join(tmpDir, "first.yaml");
    await writeFile(cfgPath1, yamlText, "utf-8");
    const loaded1 = await loadConfig(cfgPath1);

    // Re-stringify the loaded config and reload — both passes must yield
    // the same parsed shape. This catches schema mutations that round-
    // trip through serialise but lose the per-agent override.
    const cfgPath2 = join(tmpDir, "second.yaml");
    await writeFile(cfgPath2, stringifyYaml(loaded1), "utf-8");
    const loaded2 = await loadConfig(cfgPath2);

    expect(loaded2.defaults.advisor).toEqual(loaded1.defaults.advisor);
    expect(loaded2.agents[0].advisor).toEqual(loaded1.agents[0].advisor);

    // Resolvers fire identically on both loads.
    expect(
      resolveAdvisorBackend(loaded2.agents[0], loaded2.defaults),
    ).toBe(resolveAdvisorBackend(loaded1.agents[0], loaded1.defaults));
    expect(
      resolveAdvisorCaching(loaded2.agents[0], loaded2.defaults),
    ).toEqual(resolveAdvisorCaching(loaded1.agents[0], loaded1.defaults));
  });

  it("yaml with no advisor block at all parses and resolvers return baselines", async () => {
    // Phase 117 back-compat — pre-117 yaml. Every existing operator yaml
    // must keep parsing unchanged AND the resolvers must yield the
    // hardcoded baseline without any defaults.advisor population.
    const yamlText = [
      "version: 1",
      "agents:",
      "  - name: phase-117-06-backcompat",
      "",
    ].join("\n");

    const cfgPath = join(tmpDir, "no-advisor.yaml");
    await writeFile(cfgPath, yamlText, "utf-8");
    const loaded = await loadConfig(cfgPath);

    expect(loaded.defaults.advisor).toBeUndefined();
    expect(loaded.agents[0].advisor).toBeUndefined();

    expect(
      resolveAdvisorBackend(loaded.agents[0], loaded.defaults),
    ).toBe("native");
    expect(resolveAdvisorModel(loaded.agents[0], loaded.defaults)).toBe(
      "opus",
    );
    expect(
      resolveAdvisorMaxUsesPerRequest(loaded.agents[0], loaded.defaults),
    ).toBe(3);
    expect(
      resolveAdvisorCaching(loaded.agents[0], loaded.defaults),
    ).toEqual({ enabled: true, ttl: "5m" });
  });
});
