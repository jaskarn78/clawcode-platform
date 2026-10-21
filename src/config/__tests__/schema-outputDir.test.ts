/**
 * Phase 96 Plan 04 Task 2 — outputDir Zod schema tests (11th additive-
 * optional application) + DEFAULT_SYSTEM_PROMPT_DIRECTIVES['file-sharing']
 * D-10 text extension.
 *
 * Schema additions:
 *   - agentSchema.outputDir: optional string
 *   - defaultsSchema.outputDir: default-bearing string ('outputs/{date}/')
 *   - DEFAULT_SYSTEM_PROMPT_DIRECTIVES['file-sharing'].text — extended with
 *     BOTH the D-10 auto-upload heuristic block AND the OpenClaw-fallback
 *     prohibition block (verbatim from CONTEXT.md D-10 expanded 2026-04-25)
 *
 * Token resolution at runtime (NOT loader) — loader returns the literal
 * template string; runtime resolveOutputDir expands tokens with fresh ctx.
 *
 * Tests pin:
 *   SCHOD-1   additive-optional regression — v2.5 fixtures parse unchanged
 *   SCHOD-2   default applied — defaults.outputDir defaults to 'outputs/{date}/'
 *   SCHOD-3   per-agent override + token preservation (loader does NOT expand)
 *   SCHOD-4   directive text — BOTH D-10 verbatim substrings present
 */
import { describe, it, expect } from "vitest";

import {
  agentSchema,
  defaultsSchema,
  configSchema,
  DEFAULT_SYSTEM_PROMPT_DIRECTIVES,
  DEFAULT_OUTPUT_DIR,
} from "../schema.js";

describe("Phase 96 D-09 — outputDir Zod schema (11th additive-optional)", () => {
  it("SCHOD-1: additive-optional regression — v2.5 fixtures (no outputDir) parse unchanged", () => {
    const fixtures: unknown[] = [
      {
        version: 1,
        defaults: { model: "haiku" },
        agents: [{ name: "test-agent", channels: [] }],
      },
      {
        version: 1,
        defaults: { model: "sonnet" },
        agents: [
          { name: "fin-client", channels: ["123"], heartbeat: true },
        ],
      },
      {
        version: 1,
        defaults: { model: "haiku", greetOnRestart: false },
        agents: [
          { name: "a", channels: [] },
          { name: "b", channels: [] },
        ],
      },
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
        `Fixture #${i + 1} should parse without outputDir`,
      ).toBe(true);
    }
  });

  it("SCHOD-2: default applied — defaults.outputDir defaults to 'outputs/{date}/'", () => {
    const result = defaultsSchema.parse({ model: "sonnet" });
    expect(result.outputDir).toBeDefined();
    expect(result.outputDir).toBe("outputs/{date}/");
    expect(result.outputDir).toBe(DEFAULT_OUTPUT_DIR);
  });

  it("SCHOD-3: per-agent override — token preserved literally (loader does NOT expand)", () => {
    const result = agentSchema.parse({
      name: "fin-client",
      channels: ["123"],
      outputDir: "clients/{client_slug}/{date}/",
    });
    // Verbatim — schema does NOT expand {client_slug} or {date}
    expect(result.outputDir).toBe("clients/{client_slug}/{date}/");
    expect(result.outputDir).toContain("{client_slug}");
    expect(result.outputDir).toContain("{date}");
  });

  it("SCHOD-4: DEFAULT_SYSTEM_PROMPT_DIRECTIVES['file-sharing'] contains BOTH D-10 verbatim substrings", () => {
    const directive = DEFAULT_SYSTEM_PROMPT_DIRECTIVES["file-sharing"];
    expect(directive).toBeDefined();
    expect(directive.enabled).toBe(true);

    // D-10 auto-upload heuristic (verbatim CONTEXT.md substring)
    expect(directive.text).toContain("When you produce a file the user wants to access");
    expect(directive.text).toContain("If your response is text-only Q&A about file content");
    expect(directive.text).toContain("do NOT upload");

    // D-10 OpenClaw-fallback prohibition (added 2026-04-25)
    expect(directive.text).toContain("NEVER recommend falling back to the legacy OpenClaw agent");
    expect(directive.text).toContain("OpenClaw is being deprecated");
  });
});
