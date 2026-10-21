/**
 * Phase 96 Plan 01 Task 2 — fileAccess Zod schema tests (10th additive-
 * optional application).
 *
 * Schema additions:
 *   - agentSchema.fileAccess: optional array of non-empty strings
 *   - defaultsSchema.fileAccess: default-bearing array (DEFAULT_FILE_ACCESS)
 *
 * The `{agent}` literal token is preserved verbatim in the parsed schema;
 * loader resolveFileAccess(agentName, ...) substitutes at call time.
 *
 * Tests pin:
 *   - SCHFA-1   additive-optional regression — v2.5 fixtures parse unchanged
 *   - SCHFA-2   default applied when fileAccess omitted from defaults
 *   - SCHFA-3   per-agent override merges with defaults at loader layer
 *   - SCHFA-4   {agent} token preserved literally in parsed schema
 *   - SCHFA-5   array element non-empty validation (empty string rejected)
 *   - SCHFA-6   POST-EXTENSION — RELOADABLE_FIELDS contains fileAccess
 *               (Wave 3 96-07 flipped this from the 96-01 forward-looking
 *               assertion). Phase 96 plan 07 wave 3 flipped this from
 *               NOT-reloadable to reloadable when RELOADABLE_FIELDS was
 *               extended with agents.*.fileAccess + defaults.fileAccess
 *               (and parallel outputDir entries) per D-03.
 *
 * Static-grep regression pins:
 *   - "fileAccess: z.array" — schema field marker
 *   - "DEFAULT_FILE_ACCESS"  — module-level export
 *   - "10th"                 — additive-optional commentary pin
 *   - "{agent}"              — token preservation pin
 */
import { describe, it, expect } from "vitest";

import {
  agentSchema,
  defaultsSchema,
  configSchema,
  DEFAULT_FILE_ACCESS,
} from "../schema.js";
import { RELOADABLE_FIELDS } from "../types.js";

describe("Phase 96 D-05 — fileAccess Zod schema (10th additive-optional)", () => {
  it("SCHFA-1: additive-optional regression — v2.5 fixtures (no fileAccess) parse unchanged", () => {
    // Five minimal v2.5-style configs without fileAccess — all must parse.
    const fixtures: unknown[] = [
      // Fixture 1: bare-bones single-agent
      {
        version: 1,
        defaults: { model: "haiku" },
        agents: [{ name: "test-agent", channels: [] }],
      },
      // Fixture 2: fin-client style without fileAccess
      {
        version: 1,
        defaults: { model: "sonnet" },
        agents: [
          {
            name: "fin-client",
            channels: ["123456"],
            model: "sonnet",
            heartbeat: true,
          },
        ],
      },
      // Fixture 3: defaults + multiple agents
      {
        version: 1,
        defaults: { model: "haiku", greetOnRestart: false },
        agents: [
          { name: "a", channels: [] },
          { name: "b", channels: [] },
        ],
      },
      // Fixture 4: agent with allowedModels + memoryAutoLoad (v2.2/v2.3 surface)
      {
        version: 1,
        defaults: { model: "haiku" },
        agents: [
          {
            name: "clawdy",
            channels: [],
            allowedModels: ["haiku", "sonnet"],
            memoryAutoLoad: true,
          },
        ],
      },
      // Fixture 5: full v2.6 surface (skills + dream + heartbeat object)
      {
        version: 1,
        defaults: { model: "haiku", dream: { enabled: false } },
        agents: [
          {
            name: "x",
            channels: [],
            skills: ["s1"],
            heartbeat: { enabled: true, every: "60s" },
          },
        ],
      },
    ];

    for (const [i, raw] of fixtures.entries()) {
      const result = configSchema.safeParse(raw);
      expect(
        result.success,
        `Fixture #${i + 1} should parse without fileAccess`,
      ).toBe(true);
    }
  });

  it("SCHFA-2: default applied — defaults.fileAccess defaults to DEFAULT_FILE_ACCESS when omitted", () => {
    const result = defaultsSchema.parse({ model: "sonnet" });
    expect(result.fileAccess).toBeDefined();
    expect(result.fileAccess).toEqual([...DEFAULT_FILE_ACCESS]);
    // Default contains the canonical agent-workspace template
    expect(result.fileAccess).toContain("/home/clawcode/.clawcode/agents/{agent}/");
  });

  it("SCHFA-3: per-agent override — agents.fin-client.fileAccess preserved unchanged", () => {
    const result = agentSchema.parse({
      name: "fin-client",
      channels: ["123"],
      fileAccess: ["/home/example-user/.openclaw/workspace-acme/"],
    });
    expect(result.fileAccess).toEqual([
      "/home/example-user/.openclaw/workspace-acme/",
    ]);

    // Defaults.fileAccess remains unchanged when an agent overrides
    const defaultsResult = defaultsSchema.parse({
      model: "haiku",
      fileAccess: ["/some/different/default/"],
    });
    expect(defaultsResult.fileAccess).toEqual(["/some/different/default/"]);
  });

  it("SCHFA-4: {agent} token preserved literally — schema does NOT expand", () => {
    const result = defaultsSchema.parse({
      model: "haiku",
      fileAccess: ["/home/clawcode/.clawcode/agents/{agent}/"],
    });
    // Literal {agent} substring preserved verbatim post-parse
    expect(result.fileAccess[0]).toContain("{agent}");
    expect(result.fileAccess[0]).toBe("/home/clawcode/.clawcode/agents/{agent}/");

    // Same invariant for the default factory output
    const fromDefault = defaultsSchema.parse({ model: "haiku" });
    expect(fromDefault.fileAccess[0]).toContain("{agent}");
  });

  it("SCHFA-5: array element non-empty validation", () => {
    // Empty string rejected
    const empty = defaultsSchema.safeParse({
      model: "haiku",
      fileAccess: [""],
    });
    expect(empty.success).toBe(false);

    // Empty array allowed (explicit no-access fleet config)
    const emptyArr = defaultsSchema.safeParse({
      model: "haiku",
      fileAccess: [],
    });
    expect(emptyArr.success).toBe(true);

    // agents.*.fileAccess: same shape
    const agentEmpty = agentSchema.safeParse({
      name: "x",
      channels: [],
      fileAccess: [""],
    });
    expect(agentEmpty.success).toBe(false);
  });

  it("SCHFA-6: POST-EXTENSION — RELOADABLE_FIELDS contains fileAccess (Phase 96 plan 07 wave 3 flipped this from NOT-reloadable to reloadable)", () => {
    // Wave 1 (96-01) authored this as forward-looking asserting `false` —
    // RELOADABLE_FIELDS did NOT yet contain fileAccess at 96-01 wave-1 time.
    // Wave 3 (96-07) extended RELOADABLE_FIELDS with agents.*.fileAccess +
    // defaults.fileAccess (D-03) AND agents.*.outputDir + defaults.outputDir
    // (D-09). This assertion now reflects the post-extension reality.
    expect(RELOADABLE_FIELDS.has("agents.*.fileAccess")).toBe(true);
    expect(RELOADABLE_FIELDS.has("defaults.fileAccess")).toBe(true);
    // Sanity: existing reloadable fields still classified correctly
    expect(RELOADABLE_FIELDS.has("agents.*.allowedModels")).toBe(true);
  });
});
